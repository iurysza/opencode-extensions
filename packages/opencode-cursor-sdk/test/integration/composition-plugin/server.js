// T1 only: actual production composition; fake SDK/factory at external boundaries.
import { appendFileSync } from "node:fs";
import { createCursorPlugin } from "../../../dist/plugin/create.js";
import { sessionSettingsKey } from "../../../dist/plugin/runtime.js";
import { createCloudPlugin } from "../../../../opencode-cursor-cloud/dist/plugin/create.js";
export default { id: "composition-proof", async setup(ctx) {
  const log = e => appendFileSync(ctx.options.log, JSON.stringify(e) + "\n");
  const sdk = {
    models: async () => [{ id: "composer-2.5", displayName: "Composer" }],
    openStore: async () => ({ store: {}, dispose: async () => log({ at: "local-store-dispose" }) }),
    create: async options => { log({ at: "local-create", mode: options.mode, tools: options.tools ?? "standard", openCodeMcp: Object.keys(options.mcpServers ?? {}).some(name => name.startsWith("opencode_")) }); return { close: () => log({ at: "local-close" }), send: async (_text, options) => {
      log({ at: "local-send", mode: options.mode, openCodeMcp: Object.keys(options.mcpServers ?? {}).some(name => name.startsWith("opencode_")) }); await options.onDelta?.({ update: { type: "text-delta", text: "LOCAL_COMPOSED" } });
      return { wait: async () => ({ id: "local-run", status: "finished" }), cancel: async () => log({ at: "local-cancel" }) };
    } }; },
  };
  let cloudN = 0;
  const foreground = { inspectLocalState: () => ({ insideGitRepo: true, dirty: false, comparison: "contains_head" }),
    loadAgentFactory: async () => ({ create: async () => { const n = ++cloudN; log({ at: "foreground-create" }); return {
      agentId: `bc-11111111-1111-4111-8111-${String(n).padStart(12, "0")}`, close: () => log({ at: "foreground-close" }),
      send: async () => ({ id: `foreground-${n}`, wait: async () => ({ id: `foreground-${n}`, status: "finished", result: "FOREGROUND_COMPOSED" }), cancel: async () => log({ at: "foreground-cancel" }) }),
    }; }, archive: async id => log({ at: "foreground-archive", id }), delete: async id => log({ at: "foreground-delete", id }) }),
  };
  let failedKey;
  const sdkContext = { ...ctx, session: { ...ctx.session, get: async (...args) => { const value = await ctx.session.get(...args); if (value.title === "composition-fail") failedKey = sessionSettingsKey(value.id); return value; } }, storage: { ...ctx.storage, set: async (key, value) => {
    if (key.startsWith("settings:session:")) {
      // Scope binding is still real. Only the external persistence failure is injected.
      if (key === failedKey) { log({ at: "ack-write-failed" }); throw new Error("injected storage failure"); }
    }
    return ctx.storage.set(key, value);
  } } };
  const providerCleanup = await createCursorPlugin({ local: { loadSdk: async () => sdk, env: { CURSOR_API_KEY: "composition-fake-key" }, stateRoot: `${ctx.options.log}.state` }, foreground }).setup(sdkContext);
  // Observe real host requests, never replace the provider or composition handlers.
  await ctx.session.hook("model.request", e => log({ at: "request", kind: e.kind, sessionID: e.sessionID }), { providerID: "cursor" });
  await ctx.aisdk.hook("language", e => { const language = e.language; e.language = { ...language, async doStream(options) { try { return await language.doStream(options); } catch (error) { log({ at: "stream-error", code: error.code, message: error.message }); throw error; } } }; }, { providerID: "cursor" });
  let n = 0;
  const client = { models: async () => { throw new Error("status/models must not call SDK"); }, create: async () => {
    const id = `bc-background-${++n}`; log({ at: "background-create", id });
    return { id, close: () => log({ at: "background-close", id }), send: async () => {
      log({ at: "background-send", id });
      let finish;
      const completed = new Promise(resolve => { finish = resolve; });
      // Explicit RPC cancel settles the fake remote, exercising the real receipt pipeline.
      return { id: `background-run-${n}`, wait: () => completed, cancel: async () => { log({ at: "background-cancel", id }); finish({ type: "cancelled", result: { text: "BACKGROUND_COMPOSED", durationMs: 1, branches: [] } }); } };
    } };
  }, delete: async id => log({ at: "background-delete", id }) };
  const cloudCleanup = await createCloudPlugin({ client, diagnostic: () => log({ at: "cloud-diagnostic" }), serviceReady: service => {
    // Observation of the same backend service owner, no secondary client.
    const original = service.status; service.status = async (...args) => { log({ at: "backend-status", sessionID: args[0] }); return original(...args); };
  } }).setup({ ...ctx, session: { ...ctx.session, synthetic: async input => {
    const result = await ctx.session.synthetic(input); log({ at: "receipt", sessionID: input.sessionID, id: input.id, runId: input.metadata?.runId }); return result;
  } } });
  log({ at: "setup", version: ctx.app.version });
  return async () => { await cloudCleanup(); await providerCleanup?.(); log({ at: "disposed" }); };
} };
