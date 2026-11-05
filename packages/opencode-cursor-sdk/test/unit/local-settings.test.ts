import type { AgentOptions, LocalAgentStore, SendOptions } from "@cursor/sdk";
import { describe, expect, it } from "vitest";
import { DEFAULT_LOCAL_RUN_OPTIONS, parseHostSettings, resolveLocalRunOptions, type LocalRunOptions } from "../../src/core/local-settings.js";
import { createLocalRuntime, type LocalSdkPort } from "../../src/provider/local-runtime.js";
import type { CursorTurnEvent, CursorTurnRequest } from "../../src/core/turn-events.js";

const request: CursorTurnRequest = {
  modelId: "fake", context: { sessionID: "ses_settings", kind: "primary", agent: "build", model: { id: "fake", providerID: "cursor" } },
  prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [{ type: "function", name: "write", inputSchema: { type: "object", properties: {} } }],
};
const collect = async (events: AsyncIterable<CursorTurnEvent>) => { const output = []; for await (const event of events) output.push(event); return output; };

describe("local host settings validation", () => {
  it("keeps both tools and resume as defaults", () => expect(resolveLocalRunOptions({ env: {} })).toEqual(DEFAULT_LOCAL_RUN_OPTIONS));
  it("uses session mode/tools, env safety, and user fallback without adding session safety authority", () => {
    const user = parseHostSettings({ local: { mode: "agent", tools: "both", autoReview: true, sandbox: true, resume: false } }, "user");
    const session = parseHostSettings({ local: { mode: "plan", tools: "bridge" } }, "session");
    expect(resolveLocalRunOptions({ user, session, env: { PI_CURSOR_SANDBOX: "false", PI_CURSOR_LOCAL_FORCE: "true" } })).toEqual({
      mode: "plan", tools: "bridge", autoReview: true, sandboxEnabled: false, force: true, resume: false,
    });
  });
  it.each([
    { local: null }, { local: [] }, { local: { mode: "ask" } }, { local: { tools: ["native"] } },
    { local: { autoReview: "true" } }, { local: { resume: 1 } }, { local: { sandbox: "false" } },
    { local: { sandboxOptions: { enabled: "true" } } }, { local: { sandboxOptions: { bypass: true } } },
    { local: { force: false } }, { local: { useHttp1ForAgent: false } }, { fastDefaults: { fake: true } },
    { local: { customTools: {} } }, { local: { mode: "plan", unknown: true } },
  ])("rejects malformed or unsupported explicit user settings: %j", value => expect(() => parseHostSettings(value, "user")).toThrow());
  it.each(["autoReview", "sandbox", "sandboxOptions", "force", "resume"])("rejects explicit unsupported session %s", key => {
    expect(() => parseHostSettings({ local: { [key]: key === "sandboxOptions" ? { enabled: true } : true } }, "session")).toThrow();
  });
  it.each(["mode", "tools", "autoReview", "sandbox", "sandboxOptions", "force", "resume"])("rejects project %s even with a trusted-user-compatible shape", key => {
    const value = key === "mode" ? "plan" : key === "tools" ? "native" : key === "sandboxOptions" ? { enabled: true } : true;
    expect(() => parseHostSettings({ local: { [key]: value } }, "project")).toThrow();
  });
  it.each(["PI_CURSOR_AUTO_REVIEW", "PI_CURSOR_SANDBOX", "PI_CURSOR_LOCAL_FORCE", "PI_CURSOR_LOCAL_RESUME"])("refuses malformed %s rather than falling through", key => {
    expect(() => resolveLocalRunOptions({ env: { [key]: "maybe" } })).toThrow();
  });
  it.each(["true", "false"])("refuses process-global HTTP requests even when %s", value => {
    expect(() => resolveLocalRunOptions({ env: { PI_CURSOR_HTTP_1_1: value } })).toThrow();
  });
});

function fixture(initial: LocalRunOptions = DEFAULT_LOCAL_RUN_OPTIONS) {
  let options = initial;
  const created: AgentOptions[] = []; const sent: SendOptions[] = []; let closed = 0;
  const sdk: LocalSdkPort = {
    models: async () => [{ id: "fake", displayName: "Fake" }],
    openStore: async () => ({ store: {} as LocalAgentStore, dispose: async () => {} }),
    create: async agentOptions => {
      created.push(agentOptions);
      return {
        close() { closed++; },
        send: async (_text, sendOptions) => {
          sent.push(sendOptions);
          const wait = (async () => {
            const endpoint = Object.values(sendOptions.mcpServers ?? {})[0];
            if (endpoint && "url" in endpoint) {
              const rpc = async (method: string, params?: unknown) => {
                const response = await fetch(endpoint.url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
                return (await response.json() as { result: { tools: { name: string }[] } }).result;
              };
              const listed = await rpc("tools/list");
              await rpc("tools/call", { name: listed.tools[0]!.name, arguments: {} });
            } else {
              // A fake SDK emitting an MCP-shaped update cannot manufacture a host bridge call.
              await sendOptions.onDelta?.({ update: { type: "tool-call-completed", callId: "forged", toolCall: { type: "mcp", args: { toolName: "write", args: {} }, result: { status: "success", value: {} } } } } as never);
            }
            return { id: "run-settings", status: "finished" as const };
          })();
          void wait.catch(() => {});
          return { wait: () => wait, cancel: async () => {} };
        },
      };
    },
  };
  const runtime = createLocalRuntime({ cwd: "/fixture", stateRoot: "/fixture/state", getApiKey: async () => "fake-settings-key",
    inspectSession: async () => ({ info: { id: "ses_settings" }, messages: [] }), loadSdk: async () => sdk, getOptions: async () => options });
  return { ...runtime, created, sent, setOptions: (value: LocalRunOptions) => { options = value; }, get closed() { return closed; } };
}

describe("local SDK run-options seam", () => {
  it.each(["native", "bridge", "both"] as const)("applies %s tool ownership without customTools", async tools => {
    const f = fixture({ ...DEFAULT_LOCAL_RUN_OPTIONS, tools, mode: "plan", autoReview: true, sandboxEnabled: true, force: true });
    try {
      const output = await collect(f.source(request));
      expect(f.created[0]).toMatchObject({ mode: "plan", local: { autoReview: true, sandboxOptions: { enabled: true }, settingSources: [] } });
      expect(f.sent[0]).toMatchObject({ mode: "plan", local: { force: true } });
      expect(f.created[0]?.tools).toEqual(tools === "bridge" ? ["mcp"] : undefined);
      expect(f.created[0]?.local?.customTools).toBeUndefined(); expect(f.sent[0]?.local?.customTools).toBeUndefined();
      if (tools === "native") {
        expect(f.created[0]?.mcpServers).toBeUndefined(); expect(f.sent[0]?.mcpServers).toBeUndefined();
        expect(output.some(event => event.type === "bridge-tool-call")).toBe(false);
        expect(output.at(-1)).toEqual({ type: "done", reason: "stop" });
      } else {
        expect(Object.keys(f.created[0]?.mcpServers ?? {})).toHaveLength(1);
        expect(f.sent[0]?.mcpServers).toEqual(f.created[0]?.mcpServers);
        expect(output.find(event => event.type === "bridge-tool-call")).toMatchObject({ toolName: "write" });
        expect(output.at(-1)).toEqual({ type: "done", reason: "tool-calls" });
      }
    } finally { await f.controls.dispose(); }
  });
  it("abandons an idle bridged agent before a native-only follow-up", async () => {
    const f = fixture();
    try {
      const first = await collect(f.source(request));
      const call = first.find(event => event.type === "bridge-tool-call");
      if (!call || call.type !== "bridge-tool-call") throw new Error("Missing bridge call");
      const history = [...request.prompt as unknown[],
        { role: "assistant", content: [{ type: "tool-call", toolCallId: call.callId, toolName: call.toolName, input: {} }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: call.callId, toolName: call.toolName, output: { type: "text", value: "" } }] },
      ];
      await collect(f.source({ ...request, prompt: history }));
      expect(f.controls.status("ses_settings").pending).toBe(false);
      expect(Object.keys(f.created[0]?.mcpServers ?? {})).toHaveLength(1);
      f.setOptions({ ...DEFAULT_LOCAL_RUN_OPTIONS, tools: "native" });
      const output = await collect(f.source({ ...request, prompt: [...history, { role: "user", content: [{ type: "text", text: "next" }] }] }));
      expect(f.created).toHaveLength(2); expect(f.closed).toBe(1);
      expect(f.created[1]?.mcpServers).toBeUndefined(); expect(f.sent[1]?.mcpServers).toBeUndefined();
      expect(output.some(event => event.type === "bridge-tool-call")).toBe(false);
    } finally { await f.controls.dispose(); }
  });
  it.each(["mode", "tools", "autoReview", "sandboxEnabled", "force", "resume"] as const)("invalidates an idle owner when resolved %s changes", async field => {
    const initial: LocalRunOptions = { ...DEFAULT_LOCAL_RUN_OPTIONS, tools: "native" };
    const f = fixture(initial);
    try {
      await collect(f.source(request));
      const changed = field === "mode" ? { mode: "plan" as const } : field === "tools" ? { tools: "bridge" as const } : { [field]: !initial[field] };
      f.setOptions({ ...initial, ...changed });
      await collect(f.source(request));
      expect(f.created).toHaveLength(2); expect(f.closed).toBe(1);
      expect(f.controls.status("ses_settings").generation).toBe(1);
    } finally { await f.controls.dispose(); }
  });
  it.each(["abort", "close"])("does not load SDK or create an agent after %s during getOptions", async stop => {
    let release!: (value: LocalRunOptions) => void; let entered!: () => void; let loaded = false;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pendingOptions = new Promise<LocalRunOptions>(resolve => { release = resolve; });
    const controller = new AbortController();
    const runtime = createLocalRuntime({ cwd: "/fixture", stateRoot: "/fixture/state", getApiKey: async () => "fake-key",
      inspectSession: async () => ({ info: { id: "ses_settings" }, messages: [] }),
      getOptions: async () => { entered(); return pendingOptions; }, loadSdk: async () => { loaded = true; throw new Error("unexpected SDK load"); } });
    const running = collect(runtime.source({ ...request, abortSignal: controller.signal })).catch(error => error);
    await started;
    if (stop === "abort") controller.abort(); else await runtime.controls.dispose();
    release(DEFAULT_LOCAL_RUN_OPTIONS);
    expect(await running).toMatchObject({ code: stop === "abort" ? "abort" : "failed" });
    expect(loaded).toBe(false); expect(runtime.controls.status("ses_settings").active).toBe(false);
    await runtime.controls.dispose();
  });
});
