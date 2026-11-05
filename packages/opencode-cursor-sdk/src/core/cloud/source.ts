import type { AgentModeOption, AgentOptions, ModelSelection, Run, SDKAgent } from "@cursor/sdk";
import type { CursorTurnEvent, CursorTurnRequest, CursorTurnSource } from "../turn-events.js";
import { assertNoCloudEnvironmentForwarding, resolveCursorSdkConfig, type ResolveCursorSdkConfigOptions } from "./config.js";
import { inspectCursorCloudLocalState, type CursorCloudLocalState } from "./local-state.js";
import { buildCursorCloudAgentOptions, preflightCursorCloudRuntime } from "./options.js";
import { CloudRuntimeError, pendingIntent, prepareCloudRecord, readCloudLedger, validCloudAgentID, writeCloudRecord,
  type CloudRecord, type ForegroundCloudStore } from "./ledger.js";
import { createCloudTextSanitizer, formatForegroundCloudReport } from "./reporting.js";

/** Deliberately exposes no attach, resume, list-remote, MCP, tools or SDK store. */
export interface ForegroundCloudAgentFactory {
  create(options: AgentOptions): Promise<Pick<SDKAgent, "agentId" | "send" | "close">>;
  archive(agentID: string, options: { apiKey: string }): Promise<void>;
  delete(agentID: string, options: { apiKey: string }): Promise<void>;
}
export interface ForegroundCloudDependencies {
  readonly cwd: string;
  readonly getConfig: (sessionID: string) => ResolveCursorSdkConfigOptions | Promise<ResolveCursorSdkConfigOptions>;
  readonly getApiKey: (sessionID: string) => string | undefined | Promise<string | undefined>;
  readonly store: ForegroundCloudStore;
  readonly loadAgentFactory?: () => Promise<ForegroundCloudAgentFactory>;
  readonly isLocalRunPending: (sessionID: string) => boolean | Promise<boolean>;
  readonly selection?: (request: CursorTurnRequest) => { model: ModelSelection; mode: AgentModeOption } | Promise<{ model: ModelSelection; mode: AgentModeOption }>;
  readonly inspectLocalState?: (cwd: string, target: { repo?: string; branch?: string }) => CursorCloudLocalState;
  readonly cancelTimeoutMs?: number;
}
export interface ForegroundCloudSource extends CursorTurnSource {
  list(sessionID: string): Promise<readonly CloudRecord[]>;
  cleanup(sessionID: string, agentID: string, action: "archive" | "delete", options: { confirmed: boolean }): Promise<void>;
  shutdown(): Promise<void>;
}

/** Called only from a billable/destructive action, never on module or plugin load. */
export async function loadPublicCloudAgentFactory(): Promise<ForegroundCloudAgentFactory> {
  const { Agent } = await import("@cursor/sdk");
  return { create: options => Agent.create(options), archive: (id, options) => Agent.archive(id, options),
    delete: (id, options) => Agent.delete(id, options) };
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(object).map(part => {
    if (part.type === "text" && typeof part.text === "string") return part.text;
    if (part.type === "tool-call" || part.type === "tool-result") return JSON.stringify(part);
    throw new CloudRuntimeError("cloud_prompt_unsupported", "Cursor Cloud text handoff does not support this content type.");
  }).join("\n");
}
export function foregroundCloudContext(prompt: unknown): { fresh: string; bootstrap: string; hasPriorContext: boolean } {
  if (!Array.isArray(prompt) || prompt.some(item => !object(item) || typeof item.role !== "string")) {
    throw new CloudRuntimeError("cloud_prompt_invalid", "Cursor Cloud requires a structured text prompt.");
  }
  const messages = prompt.filter(object);
  const last = [...messages].reverse().find(item => item.role === "user");
  const fresh = contentText(last?.content);
  if (!fresh.trim()) throw new CloudRuntimeError("cloud_prompt_invalid", "Cursor Cloud requires a user text message.");
  // Host skill catalogs and local bridge guidance are not Cloud capabilities.
  const removeLocalGuidance = (text: string) => text.replace(/<(?:skills|available_skills)>[\s\S]*?<\/(?:skills|available_skills)>/gi, "")
    .split("\n").filter(line => !/cursor_(?:ask_question|activate_skill)|local (?:MCP|tool bridge)/i.test(line)).join("\n");
  return { fresh, bootstrap: messages.map(item => `${item.role}: ${removeLocalGuidance(contentText(item.content))}`).join("\n\n"),
    hasPriorContext: messages.filter(item => item.role !== "system").length > 1 };
}
async function boundedCancel(run: Run, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([Promise.resolve().then(() => run.cancel()).catch(() => undefined),
    new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function safeError(error: unknown): Error {
  if (error instanceof CloudRuntimeError) return error;
  if (object(error) && typeof error.code === "string" && ["cloud_config_invalid", "env_forwarding_not_implemented", "project_settings_untrusted"].includes(error.code)) {
    return new CloudRuntimeError(error.code, "Cursor Cloud settings were refused. No prompt was sent.");
  }
  return new CloudRuntimeError("cloud_operation_failed", "Cursor Cloud operation failed. Inspect the durable ledger and Cursor dashboard before retrying.");
}

export function createForegroundCloudSource(deps: ForegroundCloudDependencies): ForegroundCloudSource {
  let closed = false;
  const busy = new Set<string>();
  const active = new Set<{ close(): void; stop(): void }>();
  const load = deps.loadAgentFactory ?? loadPublicCloudAgentFactory;
  const timeout = Math.max(1, Math.min(deps.cancelTimeoutMs ?? 5000, 30_000));
  const assertOpen = () => { if (closed) throw new CloudRuntimeError("cloud_shutdown", "Cursor Cloud runtime has shut down."); };
  async function key(sessionID: string): Promise<string> {
    const value = await deps.getApiKey(sessionID);
    if (!value?.trim() || /^(?:team|admin)[_-]/i.test(value)) throw new CloudRuntimeError("cloud_auth_required", "Cursor requires a personal API key, not a Team Admin key.");
    return value;
  }
  const source = (async function* (request: CursorTurnRequest): AsyncGenerator<CursorTurnEvent> {
    assertOpen();
    if (request.context.kind !== "primary") throw new CloudRuntimeError("cloud_helpers_disabled", "Cloud runtime does not serve helper requests.");
    const sessionID = request.context.sessionID;
    if (busy.has(sessionID)) throw new CloudRuntimeError("cloud_session_busy", "A Cursor Cloud action is already active in this session.");
    busy.add(sessionID);
    let agent: Pick<SDKAgent, "agentId" | "send" | "close"> | undefined;
    let run: Run | undefined;
    let entry: CloudRecord | undefined;
    let cancelled: Promise<void> | undefined;
    let detached = false;
    let interrupted = request.abortSignal?.aborted ?? false;
    let completed = false;
    let failure: Error | undefined;
    let wake: (() => void) | undefined;
    const events: CursorTurnEvent[] = [];
    const signal = () => { wake?.(); wake = undefined; };
    const cancel = () => { if (run) cancelled ??= boundedCancel(run, timeout); return cancelled; };
    let stopWaiting: () => void = () => {};
    const stopped = new Promise<undefined>(resolve => { stopWaiting = () => resolve(undefined); });
    const abort = () => { interrupted = true; void cancel(); stopWaiting(); signal(); };
    request.abortSignal?.addEventListener("abort", abort, { once: true });
    let handleClosed = false;
    const handle = { close: () => { try { if (agent && !handleClosed) { handleClosed = true; agent.close(); } } catch { /* local disposal must not expose SDK errors */ } },
      stop: () => { detached = true; stopWaiting(); signal(); } };
    active.add(handle);
    const emit = (event: CursorTurnEvent) => { if (!detached && !interrupted) { events.push(event); signal(); } };
    const task = (async () => {
      try {
        if (await deps.isLocalRunPending(sessionID)) throw new CloudRuntimeError("local_run_pending", "Finish the pending local Cursor run before starting Cloud.");
        assertNoCloudEnvironmentForwarding(request.providerOptions);
        const layers = await deps.getConfig(sessionID);
        const config = resolveCursorSdkConfig(layers);
        if (config.cloud.allowLocalState.value && config.cloud.allowLocalState.source === "environment" && layers.user?.cloud?.allowLocalState !== true) {
          throw new CloudRuntimeError("cloud_config_invalid", "Allowing omitted local state requires explicit user approval, not an ambient environment override.");
        }
        if (config.runtime.value !== "cloud") throw new CloudRuntimeError("cloud_disabled", "Cursor Cloud runtime is off.");
        const context = foregroundCloudContext(request.prompt);
        const localState = (deps.inspectLocalState ?? inspectCursorCloudLocalState)(deps.cwd, { repo: config.cloud.repo.value, branch: config.cloud.branch.value });
        const preflight = preflightCursorCloudRuntime({ resolvedConfig: config, localState, hasPriorContext: context.hasPriorContext });
        if (!preflight.ok) throw new CloudRuntimeError(preflight.issues[0]?.code ?? "cloud_preflight_failed", preflight.issues.map(issue => `${issue.code}: ${issue.message}`).join("\n"));
        const apiKey = await key(sessionID);
        if (interrupted || detached || closed) return;
        // Prepared durable write proves both session existence and ledger writability BEFORE create.
        entry = await prepareCloudRecord(deps.store, sessionID);
        const factory = await load();
        if (interrupted || detached || closed) return;
        if (!deps.selection && (request.context.model.variant || object(request.providerOptions) && object(request.providerOptions.cursor) && request.providerOptions.cursor.params)) {
          throw new CloudRuntimeError("cloud_model_selection_required", "Cloud model variants require the validated catalog selection adapter.");
        }
        const selection = await deps.selection?.(request) ?? { model: { id: request.modelId }, mode: "agent" as const };
        if (interrupted || detached || closed) return;
        agent = await factory.create(buildCursorCloudAgentOptions({ apiKey, modelSelection: selection.model, agentMode: selection.mode, resolvedConfig: config }));
        entry = { ...entry, agentID: agent.agentId, phase: "created" };
        try { await writeCloudRecord(deps.store, entry); }
        catch { throw new CloudRuntimeError("cloud_agent_record_failed", "Cloud agent ID could not be persisted. No run was started. Inspect the Cursor dashboard; the remote agent was not deleted."); }
        if (interrupted || detached || closed) return;
        const text = createCloudTextSanitizer(apiKey);
        const thinking = createCloudTextSanitizer(apiKey);
        let sawText = false;
        let textDeltaForStep = false;
        let thinkingDeltaForStep = false;
        run = await agent.send(config.cloud.contextHandoff.value === "bootstrap" ? context.bootstrap : context.fresh, {
          model: selection.model, mode: selection.mode,
          onDelta: ({ update }) => {
            if (update.type === "text-delta") { sawText = true; textDeltaForStep = true; const value = text.push(update.text); if (value) emit({ type: "text", text: value }); }
            if (update.type === "thinking-delta") { thinkingDeltaForStep = true; const value = thinking.push(update.text); if (value) emit({ type: "thinking", text: value }); }
            if (update.type === "tool-call-started") emit({ type: "thinking", text: "Cursor Cloud tool activity.\n" });
          },
          onStep: ({ step }) => {
            if (step.type === "assistantMessage") {
              if (!textDeltaForStep) { sawText = true; const value = text.push(step.message.text); if (value) emit({ type: "text", text: value }); }
              textDeltaForStep = false;
            }
            if (step.type === "thinkingMessage") {
              if (!thinkingDeltaForStep) { const value = thinking.push(step.message.text); if (value) emit({ type: "thinking", text: value }); }
              thinkingDeltaForStep = false;
            }
          },
        });
        entry = { ...entry, runID: run.id, phase: "running" };
        try { await writeCloudRecord(deps.store, entry); }
        catch {
          await cancel();
          throw new CloudRuntimeError("cloud_run_record_failed", "Cloud run ID could not be persisted. Bounded cancellation was attempted. Inspect the Cursor dashboard.");
        }
        if (interrupted) { await cancel(); return; }
        if (detached || closed) return;
        // Closing a local handle stops waiting without cancelling remote work.
        const result = await Promise.race([run.wait(), stopped]);
        if (!result) { if (interrupted) await cancel(); return; }
        await writeCloudRecord(deps.store, { ...entry, phase: result.status });
        if (result.status !== "finished") throw new CloudRuntimeError(`cloud_run_${result.status}`, "Cursor Cloud run did not finish. Inspect the Cursor dashboard.");
        const remainingThinking = thinking.finish(); if (remainingThinking) emit({ type: "thinking", text: remainingThinking });
        const remainingText = text.finish(); if (remainingText) emit({ type: "text", text: remainingText });
        if (!sawText && result.result) { const value = createCloudTextSanitizer(apiKey); const prefix = value.push(result.result); emit({ type: "text", text: prefix + value.finish() }); }
        emit({ type: "text", text: formatForegroundCloudReport(agent.agentId, result, apiKey) });
        emit({ type: "done", reason: "stop" });
      } catch (error) { failure = safeError(error); }
      finally { completed = true; handle.close(); signal(); }
    })();
    try {
      while ((!completed && !detached && !interrupted) || events.length > 0) {
        const event = events.shift();
        if (event) { yield event; continue; }
        await new Promise<void>(resolve => { wake = resolve; });
      }
      if (interrupted) { await cancel(); throw new CloudRuntimeError("cloud_aborted", "Cursor Cloud turn was aborted."); }
      if (failure) throw failure;
    } finally {
      if (!completed && !detached && !closed) { interrupted = true; stopWaiting(); await cancel(); }
      request.abortSignal?.removeEventListener("abort", abort);
      handle.close(); active.delete(handle);
      // A pending create/send still owns the session until its ID has been persisted.
      void task.finally(() => busy.delete(sessionID));
    }
  }) satisfies CursorTurnSource;
  const list = async (sessionID: string) => { try { return (await readCloudLedger(deps.store, sessionID)).records; } catch (error) { throw safeError(error); } };
  const cleanup = async (sessionID: string, agentID: string, action: "archive" | "delete", options: { confirmed: boolean }) => {
    assertOpen();
    if (action !== "archive" && action !== "delete") throw new CloudRuntimeError("cloud_action_invalid", "Unknown Cloud cleanup action.");
    if (!options.confirmed) throw new CloudRuntimeError("cloud_confirmation_required", "Cloud cleanup requires explicit confirmation.");
    if (!validCloudAgentID(agentID)) throw new CloudRuntimeError("cloud_id_invalid", "Only recorded Cloud agent IDs can be cleaned up.");
    if (busy.has(sessionID)) throw new CloudRuntimeError("cloud_session_busy", "A Cursor Cloud action is already active in this session.");
    busy.add(sessionID);
    try {
      if (!await deps.store.sessionExists(sessionID)) throw new CloudRuntimeError("session_not_persisted", "Cloud cleanup requires a persisted session.");
      const ledger = await readCloudLedger(deps.store, sessionID);
      const entry = ledger.records.find(item => item.agentID === agentID);
      if (!entry || entry.phase === "deleted") throw new CloudRuntimeError("cloud_agent_not_owned", "This session has no recorded Cloud agent with that ID.");
      if (ledger.records.some(pendingIntent)) throw new CloudRuntimeError("cleanup_pending", "An unresolved cleanup intent blocks retries. Inspect the Cursor dashboard.");
      if (action === "archive" && entry.phase === "archived") return;
      const apiKey = await key(sessionID);
      const factory = await load(); assertOpen();
      const intent: CloudRecord = { ...entry, phase: action === "archive" ? "archive_intent" : "delete_intent" };
      await writeCloudRecord(deps.store, intent);
      await factory[action](agentID, { apiKey });
      await writeCloudRecord(deps.store, { ...intent, phase: action === "archive" ? "archived" : "deleted" });
    } catch (error) { throw safeError(error); }
    finally { busy.delete(sessionID); }
  };
  const shutdown = async () => { closed = true; for (const handle of active) { handle.stop(); handle.close(); } };
  return Object.assign(source, { list, cleanup, shutdown });
}
