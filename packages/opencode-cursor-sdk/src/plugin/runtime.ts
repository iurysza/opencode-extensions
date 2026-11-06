import { createHash } from "node:crypto";
import type { Plugin } from "@opencode/plugin";
import { composeLocal, resolveHostKey, type LocalPluginOptions } from "./local.js";
import { registerControls } from "./control-rpc.js";
import { REMOTE_ACK, type Scope, type SnapshotInput } from "../control-contract.js";
import { findModel, resolveModelSelection } from "../provider/models.js";
import { createModelCatalog } from "./catalog.js";
import { helperUnavailable } from "../core/lanes.js";
import { json } from "../core/bridge.js";
import { parseHostSettings, resolveLocalRunOptions, type HostCursorSettings, type LocalRunOptions } from "../core/local-settings.js";
import type { CursorTurnSource } from "../core/turn-events.js";
import { createForegroundCloudSource, createHostForegroundCloudStore, resolveCursorSdkConfig,
  acknowledgeForegroundCloud, type ForegroundCloudDependencies } from "./cloud-runtime.js";

export const USER_SETTINGS_KEY = "settings:user:v1";
export const sessionSettingsKey = (id: string) => `settings:session:v1:${createHash("sha256").update(id).digest("hex")}`;
export interface RuntimeOptions {
  readonly local?: LocalPluginOptions;
  /** External SDK boundary only. The production composition and ledger are unchanged. */
  readonly foreground?: Pick<ForegroundCloudDependencies, "loadAgentFactory" | "inspectLocalState" | "selection">;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error("Cursor action aborted."); };

/** One backend owner for primary local/foreground Cloud turns, settings, and public RPC. */
export async function composeRuntime(ctx: Plugin.Context, options: RuntimeOptions = {}) {
  const env = { ...(options.local?.env ?? process.env) };
  // Acknowledgment is granted only by the verified RPC control and durable session record.
  delete env.PI_CURSOR_CLOUD_ACK;
  const held = new Set<string>();
  const cloudPending = new Set<string>();
  let closed = false;
  let rpc: Awaited<ReturnType<typeof registerControls>> | undefined;
  const scope = (sessionID: string): Scope => ({ sessionID, location: { directory: ctx.location.directory, workspaceID: undefined } });
  const publish = async (id: string) => { try { await rpc?.publish(scope(id)); } catch { /* A push failure never changes backend ownership. */ } };
  const checkOpen = (signal?: AbortSignal) => { checkAbort(signal); if (closed) throw new Error("Cursor runtime has shut down."); };
  async function getConfig(sessionID: string, signal?: AbortSignal) {
    checkOpen(signal);
    const rawUser = await ctx.storage.get(USER_SETTINGS_KEY);
    checkOpen(signal);
    const user = parseHostSettings(rawUser, "user");
    const rawSession = await ctx.storage.get(sessionSettingsKey(sessionID));
    checkOpen(signal);
    const session = parseHostSettings(rawSession, "session");
    // Plugin options may originate in a project. They cannot authorize safety overrides.
    const raw = ctx.options;
    const project = parseHostSettings(record(raw) && raw.cursor !== undefined ? raw.cursor : record(raw) && ["runtime", "cloud", "local", "fastDefaults"].some(k => k in raw) ? raw : undefined, "project");
    const layers = { env, user: user && { ...user, cloud: { ...user.cloud, acknowledged: false } },
      session: session && { ...session, cloud: { ...session.cloud, acknowledged: session.cloud?.acknowledged === true } }, project };
    resolveCursorSdkConfig(layers);
    resolveLocalRunOptions(layers);
    return layers;
  }
  const getOptions = async (sessionID: string, signal?: AbortSignal) => {
    const layers = await getConfig(sessionID, signal);
    checkOpen(signal);
    return resolveLocalRunOptions(layers);
  };
  const local = await composeLocal(ctx, { ...options.local, getOptions: request => getOptions(request.context.sessionID, request.abortSignal) });
  const catalog = createModelCatalog({ getApiKey: () => resolveHostKey(ctx, env), list: (key, force) => local.controls.models(key, { force }),
    warn: options.local?.warn ?? (message => console.warn(message)) });
  const cloud = createForegroundCloudSource({
    cwd: ctx.location.directory, getConfig, getApiKey: () => resolveHostKey(ctx, env),
    isLocalRunPending: id => local.controls.status(id).pending,
    store: createHostForegroundCloudStore(ctx, async sessionID => {
      const session = await ctx.session.get({ sessionID });
      return session.id === sessionID && session.location.directory === ctx.location.directory && !("workspaceID" in session.location && session.location.workspaceID);
    }), ...options.foreground,
    selection: options.foreground?.selection ?? (request => {
      // Cloud accepts only models in the current (account or fallback) catalog.
      const items = catalog.items();
      const model = findModel(items, request.modelId) && resolveModelSelection(items, request.modelId, request.context.model.variant, request.providerOptions);
      if (!model) throw new Error("Unsupported Cloud model selection.");
      return { model, mode: "agent" as const };
    }),
  });
  async function status(id: string): Promise<SnapshotInput> {
    const layers = await getConfig(id);
    checkOpen();
    const config = resolveCursorSdkConfig(layers);
    const localOptions = resolveLocalRunOptions(layers);
    return { runtime: config.runtime.value, mode: localOptions.mode, tools: localOptions.tools,
      state: local.controls.status(id).pending || cloudPending.has(id) ? "running" : "idle" };
  }
  const coding: CursorTurnSource = async function* (request) {
    const id = request.context.sessionID;
    if (request.context.kind !== "primary") throw new Error("Cursor helpers are unavailable until G4b passes.");
    if (closed || held.has(id)) throw new Error("Cursor session is unavailable or busy.");
    held.add(id);
    try {
      checkAbort(request.abortSignal);
      const config = resolveCursorSdkConfig(await getConfig(id, request.abortSignal));
      checkOpen(request.abortSignal);
      if (config.runtime.value === "cloud") {
        if (!config.cloud.acknowledged.value) throw new Error("Cursor Cloud requires explicit session acknowledgment.");
        cloudPending.add(id);
      }
      await publish(id);
      checkOpen(request.abortSignal);
      yield* (config.runtime.value === "cloud" ? cloud : local.lanes.coding)(request);
    } finally { held.delete(id); cloudPending.delete(id); await publish(id); }
  };
  async function updateLocalSettings(id: string, patch: Pick<Partial<LocalRunOptions>, "mode" | "tools">, signal?: AbortSignal): Promise<SnapshotInput | { refused: "scope" }> {
    checkOpen(signal);
    if (held.has(id) || cloudPending.has(id) || local.controls.status(id).pending) return { refused: "scope" };
    held.add(id);
    try {
      const layers = await getConfig(id, signal);
      checkOpen(signal);
      if (resolveCursorSdkConfig(layers).runtime.value !== "local") return { refused: "scope" };
      const current: HostCursorSettings = layers.session ?? {};
      const candidate = parseHostSettings({ ...current, local: { ...current.local, ...patch } }, "session");
      if (!candidate) throw new Error("Invalid host Cursor settings.");
      const before = resolveLocalRunOptions(layers);
      const after = resolveLocalRunOptions({ ...layers, session: candidate });
      checkOpen(signal);
      await ctx.storage.set(sessionSettingsKey(id), json(candidate));
      checkOpen(signal);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        await local.controls.reset(id);
        checkOpen(signal);
      }
      return await status(id);
    } finally { held.delete(id); }
  }
  try {
    rpc = await registerControls(ctx, {
      status: ({ scope }) => status(scope.sessionID),
      models: async () => ({ items: catalog.specs().slice(0, 100).map(model => ({ id: model.id, state: "unknown" as const })) }),
      refreshModels: async (_input, signal) => {
        checkOpen(signal);
        await catalog.refresh({ force: true });
        checkOpen(signal);
        return { items: catalog.specs().slice(0, 100).map(model => ({ id: model.id, state: "unknown" as const })) };
      },
      ledger: async ({ scope }) => ({ items: (await cloud.list(scope.sessionID)).filter(item => item.agentID).slice(-100).map(item => ({
        id: item.agentID!, state: item.phase === "archived" ? "archived" as const : item.phase === "finished" ? "finished" as const : item.phase === "running" ? "running" as const : "unknown" as const,
      })) }),
      archive: async ({ scope, id, confirmed }, signal) => { checkOpen(signal); await cloud.cleanup(scope.sessionID, id, "archive", { confirmed }); checkOpen(signal); return status(scope.sessionID); },
      delete: async ({ scope, id, confirmed }, signal) => { checkOpen(signal); await cloud.cleanup(scope.sessionID, id, "delete", { confirmed }); checkOpen(signal); return status(scope.sessionID); },
      runtime: async ({ scope, runtime, acknowledgement }, signal) => {
        checkOpen(signal);
        const id = scope.sessionID;
        if (held.has(id) || cloudPending.has(id) || local.controls.status(id).pending) return { refused: "scope" };
        held.add(id);
        try {
          checkOpen(signal);
          const layers = await getConfig(id, signal);
          checkOpen(signal);
          const current: HostCursorSettings = layers.session ?? {};
          const patch = runtime === "cloud" ? { ...current, runtime, cloud: { ...current.cloud, acknowledged: true } } : { ...current, runtime };
          const candidate = resolveCursorSdkConfig({ ...layers, session: patch });
          if (candidate.runtime.value !== runtime) return { refused: "scope" };
          parseHostSettings(patch, "session");
          const persist = async () => { checkOpen(signal); await ctx.storage.set(sessionSettingsKey(id), json(patch)); checkOpen(signal); };
          if (runtime === "cloud") {
            if (acknowledgement !== REMOTE_ACK) return { refused: "scope" };
            await acknowledgeForegroundCloud({ confirm: async () => true, persist });
          } else await persist();
          // Persistence failure above leaves the existing local owner untouched.
          checkOpen(signal);
          await local.controls.reset(id);
          checkOpen(signal);
          return status(id);
        } finally { held.delete(id); }
      },
      mode: ({ scope, mode }, signal) => updateLocalSettings(scope.sessionID, { mode }, signal),
      tools: ({ scope, tools }, signal) => updateLocalSettings(scope.sessionID, { tools }, signal),
      refreshConfig: ({ scope }) => status(scope.sessionID),
    });
  } catch (error) { await local.dispose(); await cloud.shutdown(); throw error; }
  return {
    lanes: { coding, helper: helperUnavailable }, controls: local.controls, foreground: cloud, getConfig, getOptions, catalog,
    async dispose() { if (closed) return; closed = true; catalog.close(); await Promise.all([local.dispose(), cloud.shutdown(), rpc!.dispose()]); },
  };
}
