import { appendFileSync } from "node:fs";
import { createCursorPlugin } from "../../../dist/plugin/create.js";

export default {
  id: "cursor-bridge-fixture",
  async setup(ctx) {
    const { log, target, mode = "allow", deny = false } = ctx.options;
    const record = (event) => appendFileSync(log, `${JSON.stringify(event)}\n`);
    await ctx.permission.hook("evaluate", (event) => {
      if (event.action !== "read") return;
      record({ at: "permission", action: event.action, previous: event.effect, deny });
      event.effect = deny ? "deny" : "allow";
    });
    await ctx.tool.transform((editor) => {
      editor.add({ name: "cursor_write", description: "Must never execute native collision", input: { type: "object", properties: { required: { type: "string" } }, required: ["required"] }, options: { codemode: false }, async execute() { record({ at: "native-trap" }); throw new Error("Native tool executed locally"); } });
      editor.add({
        name: "bridge_probe", description: "Fixture tool returning empty output through host permissions.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: false, permission: "bridge_probe" },
        async execute(_input, tool) {
          record({ at: "execute", id: tool.id });
          if (mode === "abort") {
            setTimeout(() => { void ctx.session.interrupt({ sessionID: tool.sessionID }); }, 10);
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
          return { content: "" };
        },
      });
    });
    const fakeSdk = {
      models: async () => [{ id: "fake", displayName: "Fake" }],
      openStore: async (_cwd, path) => { record({ at: "store", path }); return { store: {}, dispose: async () => record({ at: "store-dispose" }) }; },
      create: async (options) => {
        record({ at: "create", local: !!options.local, settingSources: options.local.settingSources, explicitKey: options.apiKey === "bridge-fixture-key" });
        return {
          close: () => record({ at: "close" }),
          async send(_prompt, options) {
            record({ at: "send" });
            const task = (async () => {
              const native = { type: "write", args: { not: "a valid OpenCode write schema" }, result: { status: "success", value: { by: "cursor" } } };
              await options.onDelta({ update: { type: "tool-call-completed", callId: "sdk-native", toolCall: native } });
              await options.onStep({ step: { type: "toolCall", message: native } });
              const [serverName, server] = Object.entries(options.mcpServers)[0];
              const rpc = async (method, params) => {
                const response = await fetch(server.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
                if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
                return (await response.json()).result;
              };
              const list = await rpc("tools/list");
              const tool = list.tools.find((tool) => tool._meta?.opencodeToolName === "read");
              const emptyTool = list.tools.find((tool) => tool._meta?.opencodeToolName === "bridge_probe");
              record({ at: "offered", count: list.tools.length, found: !!tool });
              if (!tool) throw new Error("Active host tool missing from bridge");
              const echo = { type: "mcp", args: { providerIdentifier: serverName, toolName: tool.name, args: {} }, result: { status: "success", value: {} } };
              await options.onDelta({ update: { type: "tool-call-started", callId: "sdk-native", toolCall: echo } });
              const result = await rpc("tools/call", { name: tool.name, arguments: { path: target } });
              record({ at: "mcp-result", result });
              const emptyResult = await rpc("tools/call", { name: emptyTool.name, arguments: {} });
              record({ at: "empty-result", result: emptyResult });
              await options.onDelta({ update: { type: "tool-call-completed", callId: "sdk-native", toolCall: echo } });
              await options.onDelta({ update: { type: "text-delta", text: "BRIDGE_COMPLETE" } });
              return { id: "run-fake", status: "finished" };
            })();
            void task.catch((error) => record({ at: "driver-error", message: error.message }));
            return { wait: () => task, cancel: async () => record({ at: "cancel" }) };
          },
        };
      },
    };
    const plugin = createCursorPlugin({
      models: [{ id: "fake", name: "Bridge fake", context: 200000, output: 32000 }],
      local: { loadSdk: async () => fakeSdk, env: { CURSOR_API_KEY: "bridge-fixture-key", HOME: "/nonexistent" }, stateRoot: `${log}.state` },
    });
    const cleanup = await plugin.setup(ctx);
    await ctx.session.hook("model.request", (event) => record({ at: "request", kind: event.kind, model: event.model }), { providerID: "cursor" });
    await ctx.aisdk.hook("language", (event) => {
      const original = event.language;
      event.language = { ...original, async doStream(options) {
        record({ at: "stream", tools: options.tools?.map((tool) => tool.name), tail: options.prompt.at(-1) });
        if (options.prompt.at(-1)?.role === "tool") {
          if (mode === "missing") options = { ...options, prompt: options.prompt.slice(0, -1) };
          if (["wrong-id", "wrong-name"].includes(mode)) options = { ...options, prompt: [...options.prompt.slice(0, -1), { role: "tool", content: options.prompt.at(-1).content.map((part) => ({ ...part, ...(mode === "wrong-id" ? { toolCallId: "sdk-native" } : { toolName: "cursor_write" }) })) }] };
          if (mode === "malformed") options = { ...options, prompt: [...options.prompt.slice(0, -1), { role: "tool", content: options.prompt.at(-1).content.map((part) => ({ ...part, output: { type: "text" } })) }] };
        }
        return original.doStream(options);
      } };
    }, { providerID: "cursor" });
    return cleanup;
  },
};
