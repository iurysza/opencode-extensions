import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentOptions, LocalAgentStore, ModelListItem, ModelSelection, RunResult, SendOptions } from "@cursor/sdk";
import { compactionToken } from "../compat/compaction-token.js";
import { DEFAULT_LOCAL_RUN_OPTIONS, type LocalRunOptions } from "../core/local-settings.js";
import { ToolBridge, json, record } from "../core/bridge.js";
import type { CursorTurnEvent, CursorTurnRequest, CursorTurnSource } from "../core/turn-events.js";

export interface LocalRun { wait(): Promise<RunResult>; cancel(): Promise<void> }
export interface LocalAgent { send(message: string, options: SendOptions): Promise<LocalRun>; close(): void }
export interface LocalStore { readonly store: LocalAgentStore; dispose(): Promise<void> }
/** The only SDK execution boundary. Tests inject this port, never a real SDK. */
export interface LocalSdkPort {
  create(options: AgentOptions): Promise<LocalAgent>;
  openStore(cwd: string, stateRoot: string): Promise<LocalStore>;
  models(apiKey: string): Promise<ModelListItem[]>;
}
export async function loadLocalSdk(): Promise<LocalSdkPort> {
  const [{ Agent, Cursor }, { SqliteLocalAgentStore }] = await Promise.all([import("@cursor/sdk"), import("@cursor/sdk/sqlite")]);
  return {
    create: (options) => Agent.create(options),
    models: (apiKey) => Cursor.models.list({ apiKey }),
    openStore: async (cwd, stateRoot) => {
      await mkdir(stateRoot, { recursive: true, mode: 0o700 });
      const store = await SqliteLocalAgentStore.open({ workspaceRef: cwd, stateRoot });
      return { store, dispose: () => store.dispose() };
    },
  };
}

// Public model metadata from Pi's 1.0.23 snapshot. No generated SDK code.
export const FALLBACK_MODELS: readonly ModelListItem[] = [
  { id: "auto-smart", displayName: "Auto", parameters: [{ id: "optimize_for", values: [{ value: "intelligence" }, { value: "balanced" }, { value: "cost" }] }] },
  { id: "composer-2.5", displayName: "Composer 2.5" },
  { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
];
export const FALLBACK_SPECS = FALLBACK_MODELS.map((model) => ({ id: model.id, name: model.displayName, context: 200_000, output: 32_000 }));
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clean = (value: string): string => value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f]/g, "");

type Channel = "text" | "thinking";
interface Fragment { readonly type: Channel; text: string }

/** Holds only the suffix that could still become the configured key. Fragment
 * channels survive buffering so ordinary text and reasoning retain their order.
 * At a lifecycle boundary, an incomplete key prefix is masked, never released
 * where another slice or run could finish it in the host's joined transcript.
 */
class SecretStream {
  private readonly pending: Fragment[] = [];
  constructor(private readonly key: string, private readonly emit: (type: Channel, text: string) => void) {
    if (!key) throw new Error("Secret redaction requires a nonempty key");
  }
  private take(count: number, emit: boolean): void {
    while (count > 0) {
      const fragment = this.pending[0]!;
      const size = Math.min(count, fragment.text.length);
      if (emit) this.emit(fragment.type, fragment.text.slice(0, size));
      fragment.text = fragment.text.slice(size);
      if (!fragment.text) this.pending.shift();
      count -= size;
    }
  }
  push(type: Channel, text: string): void {
    if (!text) return;
    this.pending.push({ type, text });
    for (;;) {
      const buffered = this.pending.map((fragment) => fragment.text).join("");
      const match = buffered.indexOf(this.key);
      if (match >= 0) {
        this.take(match, true);
        const channel = this.pending[0]!.type;
        this.take(this.key.length, false);
        this.emit(channel, "[redacted]");
        continue;
      }
      let keep = Math.min(buffered.length, this.key.length - 1);
      while (keep && !this.key.startsWith(buffered.slice(-keep))) keep--;
      this.take(buffered.length - keep, true);
      return;
    }
  }
  flush(): void {
    if (!this.pending.length) return;
    const channel = this.pending[0]!.type;
    this.pending.length = 0;
    this.emit(channel, "[redacted]");
  }
}

/** No raw SDK exception is exposed: transports can embed auth headers and signed URLs. */
export class LocalTurnError extends Error {
  constructor(readonly code: "auth" | "abort" | "overflow" | "throttle" | "network" | "failed" | "bridge" | "configuration") {
    super({ configuration: "Unsupported Cursor model settings. Use only advertised model variants or cursor.params values.", auth: "Cursor API key is missing or invalid. Connect a personal Cursor API key or set CURSOR_API_KEY.", abort: "Cursor request aborted.", overflow: "Cursor context window exceeded.", throttle: "Cursor rate limit reached. Retry later.", network: "Cursor transport failed. Retry the turn.", failed: "Cursor local run failed.", bridge: "Cursor bridge result is missing or malformed." }[code]);
    this.name = code === "abort" ? "AbortError" : "LocalTurnError";
  }
}
const classify = (error: unknown): LocalTurnError => {
  if (error instanceof LocalTurnError) return error;
  const obj = record(error);
  const message = String(obj?.message ?? "").toLowerCase();
  const code = String(obj?.code ?? "").toLowerCase();
  if (/unauth|permission_denied|authentication|api.?key|team.?admin/.test(message + code)) return new LocalTurnError("auth");
  if (/rate.?limit|throttl|resource.?exhausted/.test(message + code)) return new LocalTurnError("throttle");
  if (/context.{0,15}(exceed|window|length)|token.{0,12}limit/.test(message)) return new LocalTurnError("overflow");
  if (/abort|cancel/.test(message + code)) return new LocalTurnError("abort");
  if (/network|unavailable|deadline|stall|timeout|connect/.test(message + code)) return new LocalTurnError("network");
  return new LocalTurnError("failed");
};

class EventQueue {
  private values: (CursorTurnEvent | Error)[] = [];
  private wake?: () => void;
  push(value: CursorTurnEvent | Error): void { this.values.push(value); this.wake?.(); this.wake = undefined; }
  async next(): Promise<CursorTurnEvent> {
    while (!this.values.length) await new Promise<void>((resolve) => { this.wake = resolve; });
    const value = this.values.shift()!;
    if (value instanceof Error) throw value;
    return value;
  }
}
interface Live {
  readonly queue: EventQueue;
  readonly bridge: ToolBridge;
  readonly redactor: SecretStream;
  run?: LocalRun;
  cancelled: boolean;
  finished: boolean;
  readonly listeners: (() => void)[];
  text: string;
}
interface Session {
  readonly signature: string;
  readonly generation: number;
  readonly agent: LocalAgent;
  readonly store: LocalStore;
  live?: Live;
  history: unknown[];
}
export interface LocalRuntimeDependencies {
  readonly cwd: string;
  readonly stateRoot: string;
  readonly getApiKey: () => Promise<string | undefined>;
  /** Evaluated on every request, including continuations; defaults preserve fake SDK ports. */
  readonly getOptions?: (request: CursorTurnRequest) => Promise<LocalRunOptions>;
  /** Public ctx.session.get/context, evaluated for every request, including continuations. */
  readonly inspectSession: (sessionID: string) => Promise<{ readonly info: unknown; readonly messages: unknown }>;
  readonly loadSdk?: () => Promise<LocalSdkPort>;
  readonly warn?: (message: string) => void;
}
export interface LocalControls {
  status(sessionID: string): { active: boolean; pending: boolean; generation: number };
  reset(sessionID: string): Promise<void>;
  dispose(): Promise<void>;
}
export function createLocalRuntime(deps: LocalRuntimeDependencies): { source: CursorTurnSource; controls: LocalControls } {
  const sessions = new Map<string, Session>();
  const locks = new Map<string, Promise<void>>();
  const generations = new Map<string, number>();
  const preparations = new Set<() => Promise<void>>();
  let sdkPromise: Promise<LocalSdkPort> | undefined;
  let disposed = false;
  const checkOpen = (request: CursorTurnRequest) => {
    if (request.abortSignal?.aborted) throw new LocalTurnError("abort");
    if (disposed) throw new LocalTurnError("failed");
  };
  const catalogs = new Map<string, ModelListItem[]>();
  const sdk = () => sdkPromise ??= (deps.loadSdk ?? loadLocalSdk)().catch((error) => { sdkPromise = undefined; throw error; });
  const disposeLive = async (live: Live, cancel: boolean) => {
    live.cancelled ||= cancel;
    live.listeners.splice(0).forEach((remove) => remove());
    live.redactor.flush();
    if (cancel) {
      live.queue.push(new LocalTurnError("abort"));
      void live.run?.cancel().catch(() => {});
    }
    await live.bridge.close(cancel ? "Cursor run cancelled" : "Cursor run completed");
  };
  const reset = async (id: string) => {
    const state = sessions.get(id);
    sessions.delete(id);
    if (!state) return;
    generations.set(id, (state?.generation ?? generations.get(id) ?? 0) + 1);
    if (state.live) await disposeLive(state.live, true);
    try { state.agent.close(); } finally { await state.store.dispose(); }
  };
  async function selection(apiKey: string, request: CursorTurnRequest): Promise<ModelSelection> {
    const key = hash(apiKey);
    let catalog = catalogs.get(key);
    if (!catalog) {
      try {
        const port = await sdk();
        checkOpen(request);
        catalog = await port.models(apiKey);
        checkOpen(request);
        if (!Array.isArray(catalog) || !catalog.length || catalog.some((m) => !m.id || !m.displayName)) throw new Error("Invalid catalog");
        catalogs.set(key, catalog);
      } catch {
        checkOpen(request);
        catalog = [...FALLBACK_MODELS];
        deps.warn?.("Cursor model discovery unavailable; using bundled fallback models.");
      }
    }
    const model = catalog.find((item) => item.id === request.modelId);
    const variant = request.context.model.variant;
    const provider = record(record(request.providerOptions)?.cursor);
    if (provider && (Object.keys(provider).some((key) => key !== "params") || (provider.params !== undefined && !record(provider.params)))) throw new LocalTurnError("configuration");
    const explicit = record(provider?.params);
    const variantParams = variant === "default" ? model?.variants?.find((item) => item.isDefault)?.params : variant ? model?.variants?.find((item) => item.displayName === variant)?.params : undefined;
    if (variant && variant !== "default" && !variantParams) throw new LocalTurnError("configuration");
    const params = explicit ? Object.entries(explicit).map(([id, value]) => {
      if (typeof value !== "string" || !model?.parameters?.some((p) => p.id === id && p.values.some((v) => v.value === value))) throw new LocalTurnError("configuration");
      return { id, value };
    }) : variantParams;
    return { id: request.modelId, ...(params?.length ? { params } : {}) };
  }
  function safeText(apiKey: string, text: string): string {
    return clean(text).split(apiKey).join("[redacted]").replace(/(Bearer\s+)[^\s"\\]+/gi, "$1[redacted]").replace(/(https?:\/\/)[^/\s@]+@/gi, "$1[redacted]@");
  }
  function safeValue(apiKey: string, value: unknown): unknown {
    if (typeof value === "string") return safeText(apiKey, value);
    if (Array.isArray(value)) return value.map((item) => safeValue(apiKey, item));
    const object = record(value);
    if (object) return Object.fromEntries(Object.entries(object).map(([key, item]) => [safeText(apiKey, key), safeValue(apiKey, item)]));
    return value;
  }
  function observe(live: Live, apiKey: string, value: unknown, native: Map<string, string>, completed: Set<string>): void {
    const update = record(value);
    if (!update || live.cancelled || live.finished) return;
    if (update.type === "text-delta" || update.type === "thinking-delta") {
      if (typeof update.text === "string") {
        const text = clean(update.text);
        // Keep private cumulative text in its original form for step/final echoes.
        // Only the redactor may emit text, including cumulative fallback suffixes.
        if (update.type === "text-delta") live.text += text;
        live.redactor.push(update.type === "text-delta" ? "text" : "thinking", text);
      }
      return;
    }
    if (update.type === "assistantMessage") {
      const raw = record(update.message)?.text;
      if (typeof raw === "string") {
        const text = clean(raw);
        if (text.startsWith(live.text)) {
          const suffix = text.slice(live.text.length);
          live.text = text;
          live.redactor.push("text", suffix);
        } else {
          // A replacement is not an append. Keep the existing no-duplicate policy,
          // but do not leave a possible credential prefix hanging across it.
          live.redactor.flush();
        }
      }
      return;
    }
    const rawTool = record(update.toolCall ?? (update.type === "toolCall" ? update.message : undefined));
    if (!rawTool || typeof rawTool.type !== "string" || live.bridge.isEcho(rawTool)) return;
    live.redactor.flush();
    const tool = record(safeValue(apiKey, rawTool))!;
    const fingerprint = hash([tool.type, tool.args]);
    const callId = typeof update.callId === "string" ? `cursor-native-${hash(update.callId).slice(0, 24)}` : native.get(fingerprint) ?? `cursor-native-${fingerprint.slice(0, 24)}`;
    native.set(fingerprint, callId);
    // Buffer until completion: a bridge split must never strand a native call.
    const result = record(tool.result);
    if (!result || completed.has(callId)) return;
    completed.add(callId);
    const name = safeText(apiKey, `cursor_${String(tool.type).replace(/[^a-zA-Z0-9_]/g, "_")}`);
    live.queue.push({ type: "native-tool-call", callId, toolName: name, input: json(tool.args) });
    live.queue.push({ type: "native-tool-result", callId, toolName: name, result: json(result) ?? "", isError: result.status === "error" });
  }
  const source: CursorTurnSource = async function* (request) {
    const id = request.context.sessionID;
    const previous = locks.get(id) ?? Promise.resolve();
    let unlock!: () => void;
    const lock = new Promise<void>((resolve) => { unlock = resolve; });
    const tail = previous.then(() => lock);
    locks.set(id, tail);
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new LocalTurnError("abort"));
        request.abortSignal?.addEventListener("abort", abort, { once: true });
        if (request.abortSignal?.aborted) abort();
        void previous.then(() => { request.abortSignal?.removeEventListener("abort", abort); resolve(); });
      });
    } catch (error) {
      unlock();
      void tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
      throw error;
    }
    let state: Session | undefined;
    let split = false;
    try {
      checkOpen(request);
      const apiKey = (await deps.getApiKey())?.trim();
      checkOpen(request);
      if (!apiKey) throw new LocalTurnError("auth");
      const snapshot = await deps.inspectSession(id);
      checkOpen(request);
      const info = record(snapshot.info);
      if (info?.id !== id) throw new LocalTurnError("failed");
      const compact = compactionToken(snapshot.messages);
      if (compact._tag === "err") throw new LocalTurnError("failed");
      const options = deps.getOptions ? await deps.getOptions(request) : DEFAULT_LOCAL_RUN_OPTIONS;
      checkOpen(request);
      const model = await selection(apiKey, request);
      checkOpen(request);
      const signature = hash([apiKey, deps.cwd, model, options, info.fork ?? null, compact.value]);
      state = sessions.get(id);
      const prompt = Array.isArray(request.prompt) ? request.prompt : [];
      // A strict prefix allows new user messages and tool results, not edited history.
      const diverged = state && (prompt.length < state.history.length || state.history.some((entry, index) => hash(entry) !== hash(prompt[index])));
      if (state && (state.signature !== signature || diverged)) { await reset(id); checkOpen(request); state = undefined; }
      checkOpen(request);
      if (state?.live) {
        try { state.live.bridge.ingest(request.prompt); } catch { throw new LocalTurnError("bridge"); }
      } else {
        // Unowned results are never a reason to send a new user prompt.
        if (record(prompt.at(-1))?.role !== "user") throw new LocalTurnError("bridge");
        const port = await sdk();
        checkOpen(request);
        const queue = new EventQueue();
        const redactor = new SecretStream(apiKey, (type, text) => queue.push({ type, text: safeText(apiKey, text) }));
        const bridge = new ToolBridge(options.tools === "native" ? [] : request.tools, (event) => {
          redactor.flush();
          queue.push({ ...event, ...(event.type === "bridge-tool-call" ? { toolName: safeText(apiKey, event.toolName), input: json(safeValue(apiKey, event.input)) } : {}) });
        });
        let preparationClose: Promise<void> | undefined;
        const closePreparation = () => preparationClose ??= bridge.close("Cursor request stopped before send");
        const abortPreparation = () => { void closePreparation().catch(() => {}); };
        const releasePreparation = () => {
          preparations.delete(closePreparation);
          request.abortSignal?.removeEventListener("abort", abortPreparation);
        };
        try {
          if (options.tools !== "native") await bridge.start();
          checkOpen(request);
          preparations.add(closePreparation);
          request.abortSignal?.addEventListener("abort", abortPreparation, { once: true });
          checkOpen(request);
          if (state && sessions.get(id) !== state) throw new LocalTurnError("failed");
          if (!state) {
            const generation = generations.get(id) ?? 0;
            const store = await port.openStore(deps.cwd, join(deps.stateRoot, hash(id), String(generation)));
            let agent: LocalAgent | undefined;
            try {
              checkOpen(request);
              agent = await port.create({ apiKey, model, mode: options.mode,
                ...(options.tools === "bridge" ? { tools: ["mcp"] } : {}),
                local: { cwd: deps.cwd, store: store.store, settingSources: [], enableAgentRetries: false,
                  autoReview: options.autoReview, sandboxOptions: { enabled: options.sandboxEnabled } },
                ...(bridge.url ? { mcpServers: { [bridge.serverName]: { type: "http", url: bridge.url } } } : {}) });
              checkOpen(request);
              state = { signature, generation, store, agent, history: [] };
              sessions.set(id, state);
            } catch (error) {
              try { agent?.close(); } finally { await store.dispose(); }
              throw error;
            }
          }
          checkOpen(request);
          const live: Live = { queue, bridge, redactor, cancelled: false, finished: false, listeners: [], text: "" };
          state.live = live;
          releasePreparation();
          const native = new Map<string, string>();
          const completed = new Set<string>();
          const text = state.history.length ? prompt.slice(state.history.length) : prompt;
          // Start in the background: SDK send may itself wait on an MCP callback.
          void state.agent.send(JSON.stringify(text), {
            model, mode: options.mode, local: { force: options.force },
            ...(options.tools !== "native" ? { mcpServers: bridge.url ? { [bridge.serverName]: { type: "http", url: bridge.url } } : {} } : {}),
            onDelta: ({ update }) => observe(live, apiKey, update, native, completed),
            onStep: ({ step }) => observe(live, apiKey, step, native, completed),
          }).then(async (run) => {
            if (live.cancelled || disposed || request.abortSignal?.aborted) { await run.cancel(); return; }
            live.run = run;
            const result = await run.wait();
            if (live.cancelled || disposed || request.abortSignal?.aborted) return;
            if (result.status !== "finished") throw result.status === "cancelled" ? new LocalTurnError("abort") : result.error;
            if ([...native.values()].some((callId) => !completed.has(callId))) throw new LocalTurnError("failed");
            if (typeof result.result === "string") observe(live, apiKey, { type: "assistantMessage", message: { text: result.result } }, native, completed);
            live.redactor.flush();
            live.finished = true;
            queue.push({ type: "done", reason: "stop" });
          }).catch((error) => {
            if (!live.cancelled) { live.redactor.flush(); queue.push(classify(error)); }
          });
        } catch (error) { await closePreparation(); throw error; }
        finally { releasePreparation(); }
      }
      state.history = prompt;
      const live = state.live!;
      const abort = () => { void reset(id).catch(() => {}); };
      if (request.abortSignal) {
        request.abortSignal.addEventListener("abort", abort, { once: true });
        live.listeners.push(() => request.abortSignal?.removeEventListener("abort", abort));
        if (request.abortSignal.aborted) abort();
      }
      for (;;) {
        const event = await live.queue.next();
        // Cancellation queues a final redacted prefix before its AbortError.
        // Drain that cleanup text, but never mutate state or touch the SDK here.
        if (live.cancelled && (event.type === "text" || event.type === "thinking")) { yield event; continue; }
        checkOpen(request);
        if (event.type === "bridge-tool-call") {
          live.bridge.markEmitted(event.callId);
          yield event;
          split = true;
          yield { type: "done", reason: "tool-calls" };
          return;
        }
        if (event.type === "done") {
          // V3 consumers may stop pulling immediately after finish. Commit cleanup
          // before yielding it, otherwise generator.return() abandons a healthy agent.
          await disposeLive(live, false);
          checkOpen(request);
          state.live = undefined;
          yield event;
          return;
        }
        yield event;
      }
    } catch (error) {
      await reset(id);
      throw classify(error);
    } finally {
      // Stream cancellation is not successful completion; invalidate the handle.
      if (!split && state?.live) await reset(id);
      unlock();
      if (locks.get(id) === tail) locks.delete(id);
    }
  };
  return { source, controls: {
    status: (id) => ({ active: sessions.has(id), pending: !!sessions.get(id)?.live, generation: sessions.get(id)?.generation ?? generations.get(id) ?? 0 }),
    reset,
    dispose: async () => {
      disposed = true;
      await Promise.all([...preparations].map((close) => close()).concat([...sessions.keys()].map(reset)));
    },
  } };
}
