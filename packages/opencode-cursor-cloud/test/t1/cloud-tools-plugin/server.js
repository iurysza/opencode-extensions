// TEST ONLY. Real built Cloud plugin/tools/receipts, fake Cloud client and fake provider.
// No Cursor SDK import, credentials, remote calls, or generic tool-running RPC.
import { appendFileSync } from "node:fs";
import { createCursorPlugin } from "../../../../opencode-cursor-sdk/dist/plugin/create.js";
import { createCloudPlugin } from "../../../dist/plugin/create.js";

export default {
  id: "cursor-cloud-tools-fixture",
  async setup(ctx) {
    const log = ctx.options.log;
    const record = entry => appendFileSync(log, `${JSON.stringify(entry)}\n`);
    const stages = new Map();
    let finish;
    const result = new Promise(resolve => { finish = resolve; });
    const outcome = { type: "cancelled", result: { text: "FAKE_REMOTE_RESULT", durationMs: 10, branches: [] } };
    const client = {
      models: async () => [],
      async create(options) {
        record({ at: "create", repo: options.repo, ref: options.ref });
        return { id: "bc-host-tools", close: () => record({ at: "close" }), async send(_prompt, emit) {
          record({ at: "send" });
          emit({ type: "delta", activity: { type: "text", text: "fake activity" } });
          return { id: "run-host-tools", wait: () => result, async cancel() { record({ at: "cancel" }); finish(outcome); } };
        } };
      },
      delete: async () => record({ at: "delete" }),
    };
    const actions = [
      ["cursor_cloud_spawn", { prompt: "fake task", repo: "https://github.com/example/repo", ref: "main", name: "host-tools" }],
      ["cursor_cloud_send", { id: "host-tools", prompt: "must reject while active" }],
      ["cursor_cloud_status", { id: "host-tools" }],
      ["cursor_cloud_cancel", { id: "host-tools" }],
      ["cursor_cloud_status", { id: "host-tools" }],
    ];
    const source = request => (async function* () {
      if (request.context.kind !== "primary") {
        yield { type: "text", text: "Cloud tools fixture" }; yield { type: "done", reason: "stop" }; return;
      }
      const stage = stages.get(request.context.sessionID) ?? 0;
      stages.set(request.context.sessionID, stage + 1);
      record({ at: "source", stage, sessionID: request.context.sessionID });
      const action = actions[stage];
      if (action) {
        yield { type: "bridge-tool-call", callId: `cloud-${stage}`, toolName: action[0], input: action[1] };
        yield { type: "done", reason: "tool-calls" };
      } else {
        yield { type: "text", text: "CLOUD_HOST_COMPLETE" }; yield { type: "done", reason: "stop" };
      }
    })();
    const provider = createCursorPlugin({ lanes: { coding: source, helper: { _tag: "test-only", source } },
      models: [{ id: "fake", name: "Cloud tools fake", context: 200000, output: 32000 }], onRefusal: r => record({ at: "refusal", message: r.message }) });
    const providerCleanup = await provider.setup(ctx);
    await ctx.tool.hook("execute.after", event => {
      if (event.tool.startsWith("cursor_cloud_")) record({ at: "tool", tool: event.tool, status: event.status, sessionID: event.sessionID, result: event.status === "completed" ? event.result : "error" });
    });
    const plugin = createCloudPlugin({ client, diagnostic: message => record({ at: "diagnostic", message }) });
    const cleanup = await plugin.setup({ ...ctx, session: { ...ctx.session, synthetic: async input => {
      const response = await ctx.session.synthetic(input);
      record({ at: "synthetic", sessionID: input.sessionID, agentId: input.metadata.agentId, runId: input.metadata.runId, text: input.text });
      return response;
    } } });
    record({ at: "setup", version: ctx.app.version });
    return async () => { await cleanup(); await providerCleanup?.(); };
  },
};
