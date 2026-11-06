import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentOptions, LocalAgentStore, SendOptions, RunResult } from "@cursor/sdk";
import { createLocalRuntime, type LocalSdkPort } from "../../src/provider/local-runtime.js";
import type { CursorTurnEvent, CursorTurnRequest } from "../../src/core/turn-events.js";
import { translateTurn } from "../../src/core/stream.js";
import { parseToolOutput } from "../../src/core/bridge.js";
import { DEFAULT_LOCAL_RUN_OPTIONS, type LocalRunOptions } from "../../src/core/local-settings.js";

const initial = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
const request = (overrides: Partial<CursorTurnRequest> = {}): CursorTurnRequest => ({
  modelId: "fake", context: { sessionID: "ses_1", kind: "primary", agent: "build", model: { id: "fake", providerID: "cursor" } },
  prompt: initial, tools: [{ type: "function", name: "write", inputSchema: { type: "object", properties: {} } }], ...overrides,
});
const collect = async (events: AsyncIterable<CursorTurnEvent>) => { const result = []; for await (const event of events) result.push(event); return result; };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((fn) => fn())); });

function fixture({ bridge = true, error = false, runOptions = undefined as LocalRunOptions | undefined } = {}) {
  let lastOptions: SendOptions | undefined;
  let endpoint = "";
  let mcpResult: unknown;
  let compact: unknown[] = [];
  let info: unknown = { id: "ses_1" };
  const close = vi.fn();
  const dispose = vi.fn(async () => {});
  const cancel = vi.fn(async () => {});
  const created: AgentOptions[] = [];
  const rpc = async (method: string, params?: unknown) => {
    const response = await fetch(endpoint, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return (await response.json() as { result: unknown }).result;
  };
  const send = vi.fn(async (_text: string, options: SendOptions) => {
    lastOptions = options;
    endpoint = String(Object.values(options.mcpServers ?? {})[0] && (Object.values(options.mcpServers ?? {})[0] as { url: string }).url);
    const wait = (async (): Promise<RunResult> => {
      if (error) throw new Error("network failed Bearer fake-key https://user:password@host");
      await options.onDelta?.({ update: { type: "thinking-delta", text: "reasoning" } });
      const native = { type: "write", args: { deliberately: "invalid host schema" }, result: { status: "success", value: { by: "cursor" } } };
      await options.onDelta?.({ update: { type: "tool-call-completed", callId: "same-id", toolCall: native } } as never);
      await options.onStep?.({ step: { type: "toolCall", message: native } } as never);
      if (bridge) {
        const listed = await rpc("tools/list") as { tools: { name: string }[] };
        const toolName = listed.tools[0]!.name;
        // SDK IDs and host names are intentionally unrelated to the minted bridge ID.
        await options.onDelta?.({ update: { type: "tool-call-started", callId: "same-id", toolCall: { type: "mcp", args: { toolName, args: {} } } } } as never);
        mcpResult = await rpc("tools/call", { name: toolName, arguments: {} });
        await options.onDelta?.({ update: { type: "tool-call-completed", callId: "same-id", toolCall: { type: "mcp", args: { toolName, args: {} }, result: { status: "success", value: mcpResult } } } } as never);
      }
      await options.onDelta?.({ update: { type: "text-delta", text: "done fake-key\u001b[31m" } });
      return { id: "run-fake", status: "finished" };
    })();
    // Suppress unhandled rejection between send() and runtime attaching wait().
    void wait.catch(() => {});
    return { cancel, wait: () => wait };
  });
  const sdk: LocalSdkPort = {
    create: async (options) => { created.push(options); return { close, send }; },
    openStore: async () => ({ store: {} as LocalAgentStore, dispose }),
    models: async () => [{ id: "fake", displayName: "Fake", parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true" }] }],
      variants: [{ displayName: "slow", params: [{ id: "fast", value: "false" }], isDefault: true }, { displayName: "fast", params: [{ id: "fast", value: "true" }] }] }],
  };
  const loadSdk = vi.fn(async () => sdk);
  const runtime = createLocalRuntime({ cwd: "/fake", stateRoot: "/fake/state", getApiKey: async () => "fake-key", inspectSession: async () => ({ info, messages: compact }), loadSdk, ...(runOptions ? { getOptions: async () => runOptions } : {}) });
  cleanup.push(runtime.controls.dispose);
  return { ...runtime, send, created, close, cancel, dispose, loadSdk, get mcpResult() { return mcpResult; }, get endpoint() { return endpoint; }, get options() { return lastOptions; }, setCompact: (value: unknown[]) => { compact = value; }, setInfo: (value: unknown) => { info = value; } };
}
function continuation(events: CursorTurnEvent[], output: unknown = { type: "text", value: "" }, base: unknown[] = initial) {
  const call = events.find((e) => e.type === "bridge-tool-call");
  if (!call || call.type !== "bridge-tool-call") throw new Error("No bridge call");
  return [...base as typeof initial, { role: "assistant", content: [{ type: "tool-call", toolCallId: call.callId, toolName: call.toolName, input: {} }] }, { role: "tool", content: [{ type: "tool-result", toolCallId: call.callId, toolName: call.toolName, output }] }];
}

describe("local SDK execution and MCP continuation", () => {
  it("stays lazy until the first request", () => { const f = fixture(); expect(f.loadSdk).not.toHaveBeenCalled(); });
  it("reports native tools once, keeps MCP open, reenters the same run and accepts empty results", async () => {
    const f = fixture();
    const first = await collect(f.source(request()));
    expect(first.map((e) => e.type)).toEqual(["thinking", "native-tool-call", "native-tool-result", "bridge-tool-call", "done"]);
    expect(first.at(-1)).toEqual({ type: "done", reason: "tool-calls" });
    expect(first.find((e) => e.type === "native-tool-call")).toMatchObject({ toolName: "cursor_write" });
    expect(f.controls.status("ses_1").pending).toBe(true);
    const second = await collect(f.source(request({ prompt: continuation(first) })));
    expect(second.filter((event) => event.type === "text").map((event) => event.text).join("")).toBe("done [redacted]");
    expect(second.at(-1)).toEqual({ type: "done", reason: "stop" });
    expect(f.mcpResult).toEqual({ content: [{ type: "text", text: "" }], isError: false });
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.created[0]).toMatchObject({ apiKey: "fake-key", model: { id: "fake" }, local: { cwd: "/fake", settingSources: [] } });
    expect(f.created[0]?.cloud).toBeUndefined();
    expect(f.controls.status("ses_1").pending).toBe(false);
  });
  it.each([{ type: "execution-denied" }, { type: "error-text", value: "denied" }])("sends explicit host denial/error to MCP: %j", async (output) => {
    const f = fixture(); const first = await collect(f.source(request()));
    await collect(f.source(request({ prompt: continuation(first, output) })));
    expect(f.mcpResult).toMatchObject({ isError: true });
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, { type: "text" }, { type: "bogus", value: "" }, { type: "content", value: [{}] }])("fails closed on malformed output %j", async (output) => {
    const f = fixture(); const first = await collect(f.source(request()));
    const prompt = continuation(first, output);
    if (output === undefined) (prompt.at(-1)!.content[0] as Record<string, unknown>).output = undefined;
    await expect(collect(f.source(request({ prompt })))).rejects.toMatchObject({ code: "bridge" });
    expect(f.controls.status("ses_1").active).toBe(false);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it.each(["missing", "wrong-id", "wrong-name", "duplicate"])("rejects %s continuation without a new send", async (kind) => {
    const f = fixture(); const first = await collect(f.source(request()));
    const prompt = continuation(first);
    const tool = prompt.at(-1)!.content[0] as Record<string, unknown>;
    if (kind === "missing") prompt.pop();
    if (kind === "wrong-id") tool.toolCallId = "same-id";
    if (kind === "wrong-name") tool.toolName = "cursor_write";
    if (kind === "duplicate") prompt.at(-1)!.content.push(tool as never);
    await expect(collect(f.source(request({ prompt })))).rejects.toMatchObject({ code: "bridge" });
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("abort while MCP waits cancels it and abandons the agent", async () => {
    const f = fixture(); const controller = new AbortController();
    await collect(f.source(request({ abortSignal: controller.signal })));
    controller.abort();
    await vi.waitFor(() => expect(f.cancel).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledTimes(1));
    expect(f.controls.status("ses_1").active).toBe(false);
    expect(f.mcpResult).toMatchObject({ isError: true });
  });
  it("maps errors without leaking credentials or URLs", async () => {
    const f = fixture({ bridge: false, error: true });
    const parts = []; for await (const part of translateTurn(f.source(request()))) parts.push(part);
    expect(parts.at(-1)).toMatchObject({ type: "error", error: { code: "network" } });
    expect(String((parts.at(-1) as { error: Error }).error)).not.toMatch(/fake-key|Bearer|password/);
    expect(f.close).toHaveBeenCalled();
  });
  it("resets on compaction, fork and model changes and uses the selected variant on create/send", async () => {
    const f = fixture({ bridge: false });
    await collect(f.source(request()));
    f.setCompact([{ id: "msg_compact", type: "compaction", status: "completed" }]);
    await collect(f.source(request()));
    f.setInfo({ id: "ses_1", fork: { sessionID: "ses_parent", boundary: {} } });
    await collect(f.source(request()));
    await collect(f.source(request({ context: { ...request().context, model: { id: "fake", providerID: "cursor", variant: "fast" } } })));
    expect(f.created).toHaveLength(4);
    expect(f.created[3]?.model).toEqual({ id: "fake", params: [{ id: "fast", value: "true" }] });
    expect(f.options?.model).toEqual(f.created[3]?.model);
    expect(f.controls.status("ses_1").generation).toBe(3);
  });
  it("reuses one pooled agent across user turns and sends each turn's fresh bridge URL", async () => {
    const f = fixture();
    const first = await collect(f.source(request()));
    const afterFirst = continuation(first);
    await collect(f.source(request({ prompt: afterFirst })));
    const turn1Url = f.endpoint;
    expect(turn1Url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\//);
    // Turn 1 finished: its bridge must be closed before the next user turn.
    await expect(fetch(turn1Url, { method: "POST", body: "{}" }).then((r) => r.status)).rejects.toThrow();
    const nextTurn = [...afterFirst, { role: "assistant", content: [{ type: "text", text: "done" }] }, { role: "user", content: [{ type: "text", text: "again" }] }];
    const second = await collect(f.source(request({ prompt: nextTurn })));
    expect(second.map((e) => e.type)).toContain("bridge-tool-call");
    const secondEnd = await collect(f.source(request({ prompt: continuation(second, undefined, nextTurn) })));
    expect(secondEnd.at(-1)).toEqual({ type: "done", reason: "stop" });
    expect(f.mcpResult).toEqual({ content: [{ type: "text", text: "" }], isError: false });
    expect(f.created).toHaveLength(1);
    expect(f.send).toHaveBeenCalledTimes(2);
    const urls = f.send.mock.calls.map(([, options]) => Object.values(options.mcpServers ?? {}).map((server) => (server as { url: string }).url));
    expect(urls[0]).toEqual([turn1Url]);
    expect(urls[1]).toHaveLength(1);
    expect(urls[1]![0]).not.toBe(turn1Url);
    expect(urls[1]![0]).toBe(f.endpoint);
    // Turn 2 sends only the new user message, not turn 1 history.
    expect(JSON.parse(f.send.mock.calls[1]![0])).toEqual(nextTurn.slice(afterFirst.length));
  });
  it("native-only turns reuse the pooled agent and never pass mcpServers", async () => {
    const f = fixture({ bridge: false, runOptions: { ...DEFAULT_LOCAL_RUN_OPTIONS, tools: "native" } });
    await collect(f.source(request()));
    const nextTurn = [...initial, { role: "assistant", content: [{ type: "text", text: "done" }] }, { role: "user", content: [{ type: "text", text: "again" }] }];
    await collect(f.source(request({ prompt: nextTurn })));
    expect(f.created).toHaveLength(1);
    expect(f.created[0]).not.toHaveProperty("mcpServers");
    expect(f.created[0]).not.toHaveProperty("tools");
    expect(f.send).toHaveBeenCalledTimes(2);
    for (const [, options] of f.send.mock.calls) expect(options).not.toHaveProperty("mcpServers");
  });
  it("does not invent unsupported model parameters", async () => {
    const f = fixture({ bridge: false });
    await expect(collect(f.source(request({ providerOptions: { cursor: { params: { fast: "maybe" } } } })))).rejects.toMatchObject({ code: "configuration" });
    await expect(collect(f.source(request({ providerOptions: { cursor: { params: { context: "1m" } } } })))).rejects.toMatchObject({ code: "configuration" });
    expect(f.created).toHaveLength(0);
  });
});

describe("strict V3 result parser", () => {
  it("accepts empty content", () => expect(parseToolOutput({ type: "content", value: [] })).toEqual({ content: [] }));
  it("rejects null JSON omissions", () => expect(() => parseToolOutput({ type: "json" })).toThrow());
});
