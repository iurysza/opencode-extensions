import { createHash } from "node:crypto";
import type { Plugin } from "@opencode/plugin";
import { composeLocal, resolveHostKey, type LocalPluginOptions } from "./local.js";
import { registerControls } from "./control-rpc.js";
import { REMOTE_ACK, type Scope, type SnapshotInput } from "../control-contract.js";
import { FALLBACK_MODELS, FALLBACK_SPECS } from "../provider/local-runtime.js";
import { helperUnavailable } from "../core/lanes.js";
import type { CursorTurnSource } from "../core/turn-events.js";
import { createForegroundCloudSource, createHostForegroundCloudStore, resolveCursorSdkConfig,
  acknowledgeForegroundCloud, type CursorSdkConfig, type ForegroundCloudDependencies } from "./cloud-runtime.js";

export const USER_SETTINGS_KEY = "settings:user:v1";
export const sessionSettingsKey = (id: string) => `settings:session:v1:${createHash("sha256").update(id).digest("hex")}`;
export interface RuntimeOptions {
  readonly local?: LocalPluginOptions;
  /** External SDK boundary only. The production composition and ledger are unchanged. */
  readonly foreground?: Pick<ForegroundCloudDependencies, "loadAgentFactory" | "inspectLocalState" | "selection">;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function settings(value: unknown): CursorSdkConfig | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || Object.keys(value).some(k => !["runtime", "cloud", "local", "fastDefaults"].includes(k))) throw new Error("Invalid host Cursor settings.");
  // The pure resolver validates explicit Cloud values; local options have no adapter yet.
  if (value.local !== undefined || value.fastDefaults !== undefined) throw new Error("Local setting adapters are unavailable.");
  const config = value as CursorSdkConfig;
  resolveCursorSdkConfig({ user: config, env: {} });
  return config;
}
const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error("Cursor action aborted."); };

/** One backend owner for primary local/foreground Cloud turns, settings, and public RPC. */
export async function composeRuntime(ctx: Plugin.Context, options: RuntimeOptions = {}) {
  const local = await composeLocal(ctx, options.local);
  const env = { ...(options.local?.env ?? process.env) };
  // Acknowledgment is granted only by the verified RPC control and durable session record.
  delete env.PI_CURSOR_CLOUD_ACK;
  const held = new Set<string>();
  const cloudPending = new Set<string>();
  let closed = false;
  let rpc: Awaited<ReturnType<typeof registerControls>> | undefined;
  const scope = (sessionID: string): Scope => ({ sessionID, location: { directory: ctx.location.directory, workspaceID: undefined } });
  const publish = async (id: string) => { try { await rpc?.publish(scope(id)); } catch { /* A push failure never changes backend ownership. */ } };
  async function getConfig(sessionID: string) {
    const user = settings(await ctx.storage.get(USER_SETTINGS_KEY));
    const session = settings(await ctx.storage.get(sessionSettingsKey(sessionID)));
    // Plugin options may originate in a project. They cannot authorize safety overrides.
    const raw = ctx.options;
    const project = settings(record(raw) && record(raw.cursor) ? raw.cursor : record(raw) && ["runtime", "cloud", "local", "fastDefaults"].some(k => k in raw) ? raw : undefined);
    const layers = { env, user: user && { ...user, cloud: { ...user.cloud, acknowledged: false } },
      session: session && { ...session, cloud: { ...session.cloud, acknowledged: session.cloud?.acknowledged === true } }, project };
    resolveCursorSdkConfig(layers);
    return layers;
  }
  const cloud = createForegroundCloudSource({
    cwd: ctx.location.directory, getConfig, getApiKey: () => resolveHostKey(ctx, env),
    isLocalRunPending: id => local.controls.status(id).pending,
    store: createHostForegroundCloudStore(ctx, async sessionID => {
      const session = await ctx.session.get({ sessionID });
      return session.id === sessionID && session.location.directory === ctx.location.directory && !("workspaceID" in session.location && session.location.workspaceID);
    }), ...options.foreground,
    selection: options.foreground?.selection ?? (request => {
      const model = FALLBACK_MODELS.find(item => item.id === request.modelId);
      const variant = request.context.model.variant;
      const provider = record(request.providerOptions) ? request.providerOptions.cursor : undefined;
      if (!model || variant && variant !== "default" || provider !== undefined && (!record(provider) || Object.keys(provider).some(key => key !== "params"))) throw new Error("Unsupported Cloud model selection.");
      const explicit = record(provider) ? provider.params : undefined;
      if (explicit !== undefined && !record(explicit)) throw new Error("Unsupported Cloud model parameters.");
      const params = Object.entries(explicit ?? {}).map(([id, value]) => {
        const parameter = model.parameters?.find(item => item.id === id);
        if (typeof value !== "string" || !parameter?.values.some(item => item.value === value)) throw new Error("Unsupported Cloud model parameter.");
        return { id, value };
      });
      return { model: { id: model.id, ...(params.length ? { params } : {}) }, mode: "agent" as const };
    }),
  });
  async function status(id: string): Promise<SnapshotInput> {
    const config = resolveCursorSdkConfig(await getConfig(id));
    return { runtime: config.runtime.value, state: local.controls.status(id).pending || cloudPending.has(id) ? "running" : "idle" };
  }
  const coding: CursorTurnSource = async function* (request) {
    const id = request.context.sessionID;
    if (request.context.kind !== "primary") throw new Error("Cursor helpers are unavailable until G4b passes.");
    if (closed || held.has(id)) throw new Error("Cursor session is unavailable or busy.");
    held.add(id);
    try {
      checkAbort(request.abortSignal);
      const config = resolveCursorSdkConfig(await getConfig(id));
      checkAbort(request.abortSignal);
      if (closed) throw new Error("Cursor runtime has shut down.");
      if (config.runtime.value === "cloud") {
        if (!config.cloud.acknowledged.value) throw new Error("Cursor Cloud requires explicit session acknowledgment.");
        cloudPending.add(id);
      }
      await publish(id);
      yield* (config.runtime.value === "cloud" ? cloud : local.lanes.coding)(request);
    } finally { held.delete(id); cloudPending.delete(id); await publish(id); }
  };
  try {
    rpc = await registerControls(ctx, {
      status: ({ scope }) => status(scope.sessionID),
      models: async () => ({ items: FALLBACK_SPECS.slice(0, 100).map(model => ({ id: model.id, state: "unknown" as const })) }),
      ledger: async ({ scope }) => ({ items: (await cloud.list(scope.sessionID)).filter(item => item.agentID).slice(-100).map(item => ({
        id: item.agentID!, state: item.phase === "archived" ? "archived" as const : item.phase === "finished" ? "finished" as const : item.phase === "running" ? "running" as const : "unknown" as const,
      })) }),
      archive: async ({ scope, id, confirmed }, signal) => { checkAbort(signal); await cloud.cleanup(scope.sessionID, id, "archive", { confirmed }); return status(scope.sessionID); },
      delete: async ({ scope, id, confirmed }, signal) => { checkAbort(signal); await cloud.cleanup(scope.sessionID, id, "delete", { confirmed }); return status(scope.sessionID); },
      runtime: async ({ scope, runtime, acknowledgement }, signal) => {
        const id = scope.sessionID;
        if (held.has(id) || local.controls.status(id).pending) return { refused: "scope" };
        held.add(id);
        try {
          checkAbort(signal);
          const layers = await getConfig(id);
          const current: CursorSdkConfig = layers.session ?? {};
          const patch = runtime === "cloud" ? { ...current, runtime, cloud: { ...current.cloud, acknowledged: true } } : { ...current, runtime };
          const candidate = resolveCursorSdkConfig({ ...layers, session: patch });
          if (candidate.runtime.value !== runtime) return { refused: "scope" };
          const persist = async () => { checkAbort(signal); if (closed) throw new Error("Cursor runtime has shut down."); await ctx.storage.set(sessionSettingsKey(id), { runtime: patch.runtime, cloud: { acknowledged: patch.cloud?.acknowledged === true } }); };
          if (runtime === "cloud") {
            if (acknowledgement !== REMOTE_ACK) return { refused: "scope" };
            await acknowledgeForegroundCloud({ confirm: async () => true, persist });
          } else await persist();
          // Persistence failure above leaves the existing local owner untouched.
          await local.controls.reset(id);
          return status(id);
        } finally { held.delete(id); }
      },
      refreshConfig: ({ scope }) => status(scope.sessionID),
    });
  } catch (error) { await local.dispose(); await cloud.shutdown(); throw error; }
  return {
    lanes: { coding, helper: helperUnavailable }, controls: local.controls, foreground: cloud, getConfig,
    async dispose() { if (closed) return; closed = true; await Promise.all([local.dispose(), cloud.shutdown(), rpc!.dispose()]); },
  };
}
