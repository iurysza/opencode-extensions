// Fake action owners only. This module never imports Cursor or the real provider.
import { appendFileSync } from "node:fs";
import { registerControls as sdkControls } from "../../../../../.fixtures/control-build/sdk/plugin/control-rpc.js";
import { registerControls as cloudControls } from "../../../../../.fixtures/control-build/cloud/plugin/control-rpc.js";
export default { id: "cursor-controls-fixture", async setup(ctx) {
  const log = record => appendFileSync(ctx.options.log, JSON.stringify(record) + "\n");
  const ledger = new Map();
  let state = "idle";
  const sdk = await sdkControls(ctx, {
    status: async ({ scope }, signal) => {
      const session = await ctx.session.get({ sessionID: scope.sessionID });
      if (session.title === "control-abort") {
        log({ at: "started", sessionID: scope.sessionID });
        await new Promise(resolve => {
          const done = () => { log({ at: "aborted", sessionID: scope.sessionID }); resolve(); };
          if (signal.aborted) done(); else signal.addEventListener("abort", done, { once: true });
        });
      }
      return { state, apiKey: "fixture-secret-never-return" };
    },
    models: async () => ({ items: [{ id: "fixture-model", state: "unknown" }] }),
    ledger: async () => ({ items: [{ id: "foreground-fixture", state: "finished" }] }),
    fast: async input => { state = input.enabled ? "running" : "idle"; log({ at: "fast", sessionID: input.scope.sessionID }); return { fast: input.enabled }; },
    runtime: async input => { log({at:"runtime",runtime:input.runtime,sessionID:input.scope.sessionID});return { runtime: input.runtime }; },
  });
  const cloud = await cloudControls(ctx, {
    status: async () => ({ state: "idle" }),
    ledger: async ({ scope }) => { if (!ledger.size) ledger.set("bc-fixture", scope.sessionID); return { items: [...ledger].filter(([, sid]) => sid === scope.sessionID).map(([id]) => ({ id, state: "running" })) }; },
    spawn: async ({ scope }) => { const id = "bc-fixture-" + (ledger.size + 1); ledger.set(id, scope.sessionID); return { items: [{ id, state: "running" }] }; },
    cancel: async ({ scope, id }) => ledger.get(id) !== scope.sessionID ? { refused: "scope" } : { items: [{ id, state: "cancelled" }] },
    delete: async ({ scope, id }) => { if (ledger.get(id) !== scope.sessionID) return { refused: "scope" }; ledger.delete(id); },
  });
  log({ at: "setup", directory: ctx.location.directory });
  return async () => { await sdk.dispose(); await cloud.dispose(); };
} };
