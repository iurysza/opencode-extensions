import { afterEach, describe, expect, it } from "vitest";
import type { LocalAgentStore, RunResult, SendOptions } from "@cursor/sdk";
import { diffBlock, nativeCall, nativeResult } from "../../src/provider/native-tools.js";
import { createLocalRuntime, type LocalSdkPort } from "../../src/provider/local-runtime.js";
import type { CursorTurnEvent, CursorTurnRequest } from "../../src/core/turn-events.js";
import { translateTurn } from "../../src/core/stream.js";
import { DEFAULT_LOCAL_RUN_OPTIONS } from "../../src/core/local-settings.js";

const ok = (value: unknown) => ({ status: "success", value });
const diff = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const b = 2;\n+const b = 3;\n";

describe("native tool mapping (F-06)", () => {
  it.each([
    ["shell", { command: "ls", workingDirectory: "/p", timeout: 5 }, "shell", { command: "ls", workdir: "/p", timeout: 5 }],
    ["read", { path: "/p/a.ts" }, "read", { path: "/p/a.ts" }],
    ["write", { path: "/p/a.ts", fileText: "x" }, "write", { path: "/p/a.ts", content: "x" }],
    ["edit", { path: "/p/a.ts" }, "edit", { path: "/p/a.ts" }],
    ["grep", { pattern: "foo", path: "/p", glob: "*.ts" }, "grep", { pattern: "foo", path: "/p", include: "*.ts" }],
    ["glob", { globPattern: "**/*.ts", targetDirectory: "/p" }, "glob", { pattern: "**/*.ts", path: "/p" }],
    ["updateTodos", { todos: [{ content: "a", status: "inProgress" }, { content: "b", status: "completed" }] }, "todowrite",
      { todos: [{ content: "a", status: "in_progress" }, { content: "b", status: "completed" }] }],
  ])("maps %s to the built-in name and input", (type, args, name, input) => {
    expect(nativeCall(type, args)).toEqual({ name, input, live: true });
  });
  it("keeps cursor_<type> for unmapped tools", () => {
    expect(nativeCall("semSearch", { query: "x" })).toEqual({ name: "cursor_semSearch", input: { query: "x" }, live: false });
    expect(nativeCall("mcp.x-y", {}).name).toBe("cursor_mcp_x_y");
  });
});

describe("schema-invalid input keeps cursor_<type> (F-09)", () => {
  it.each([
    ["shell", { command: "" }], ["shell", { command: "ls", workingDirectory: 3 }], ["shell", { command: "ls", timeout: -1 }],
    ["read", {}], ["read", { path: "a\0b" }], ["write", { path: "/a" }], ["write", { not: "a valid OpenCode write schema" }],
    ["edit", { path: "" }], ["grep", { path: "/p" }], ["glob", { targetDirectory: "/p" }],
    ["updateTodos", { todos: [{ content: "a", status: "doing" }] }], ["updateTodos", { todos: "x" }], ["read", "not an object"],
  ])("%s %j", (type, args) => {
    const call = nativeCall(type, args);
    expect(call.name).toBe(`cursor_${type}`);
    expect(call.input).toEqual(args);
  });
});

describe("readable results", () => {
  it("shell joins stdout, stderr and a nonzero exit code", () => {
    expect(nativeResult("shell", {}, ok({ stdout: "out\n", stderr: "err\n", exitCode: 2 })).text).toBe("out\n\nerr\n\nExit code: 2");
    expect(nativeResult("shell", {}, ok({ stdout: "", stderr: "", exitCode: 0 })).text).toBe("(no output)");
  });
  it("read and write are short summaries, not file content", () => {
    expect(nativeResult("read", { path: "a.ts" }, ok({ content: "SECRET BODY", totalLines: 2, fileSize: 26 })).text).toBe("Read a.ts (2 lines, 26 bytes)");
    expect(nativeResult("write", { path: "a.ts" }, ok({ path: "a.ts", linesCreated: 1 })).text).toBe("Wrote a.ts (1 line)");
  });
  it("grep and glob list matches and truncate", () => {
    const grep = ok({ workspaceResults: { "/p": { type: "content", output: { matches: [{ file: "a.ts", lineNumber: 3, line: "foo()" }], totalMatches: 1 } } } });
    expect(nativeResult("grep", {}, grep).text).toBe("a.ts:3: foo()");
    expect(nativeResult("grep", {}, ok({ totalMatches: 0 })).text).toBe("No matches found");
    const files = Array.from({ length: 150 }, (_, i) => `f${i}.ts`);
    const text = nativeResult("glob", {}, ok({ files, totalFiles: 150 })).text;
    expect(text.split("\n")).toHaveLength(101);
    expect(text).toContain("... (50 more files)");
    expect(nativeResult("glob", {}, ok({ files: [] })).text).toBe("No files found");
  });
  it("edit carries a unified diff in text and as a separate diff", () => {
    const result = nativeResult("edit", { path: "src/a.ts" }, ok({ linesAdded: 1, linesRemoved: 1, diffString: diff }));
    expect(result.text).toBe(`Edited src/a.ts (+1 -1)\n\n${diff.trimEnd()}`);
    expect(result.diff).toBe(diff.trimEnd());
    expect(diffBlock(result.diff!)).toContain("```diff\n--- a/src/a.ts");
  });
  it("todos and errors are concise", () => {
    expect(nativeResult("updateTodos", { todos: [{ content: "a", status: "completed" }, { content: "b", status: "pending" }] }, ok({})).text).toBe("Todos updated: 1/2 completed");
    expect(nativeResult("read", {}, { status: "error", error: { message: "nope" } })).toEqual({ text: "Error: nope", isError: true });
  });
});

const request = (): CursorTurnRequest => ({
  modelId: "fake", context: { sessionID: "ses_1", kind: "primary", agent: "build", model: { id: "fake", providerID: "cursor" } },
  prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [],
});
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((fn) => fn())); });
function runtime(drive: (options: SendOptions, gate: Promise<void>) => Promise<void>, tools: "native" | "both" = "native") {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const sdk: LocalSdkPort = {
    create: async () => ({ close() {}, send: async (_text, options) => {
      const wait = (async (): Promise<RunResult> => { await drive(options, gate); return { id: "run", status: "finished" }; })();
      void wait.catch(() => {});
      return { cancel: async () => {}, wait: () => wait };
    } }),
    openStore: async () => ({ store: {} as LocalAgentStore, dispose: async () => {} }),
    models: async () => [{ id: "fake", displayName: "Fake" }],
  };
  const r = createLocalRuntime({ cwd: "/p", stateRoot: "/p/state", getApiKey: async () => "fake-key", inspectSession: async () => ({ info: { id: "ses_1" }, messages: [] }),
    loadSdk: async () => sdk, getOptions: async () => ({ ...DEFAULT_LOCAL_RUN_OPTIONS, tools }) });
  cleanup.push(r.controls.dispose);
  return { ...r, open };
}
const delta = (options: SendOptions, update: unknown) => options.onDelta?.({ update } as never);

describe("runtime emission", () => {
  it("emits a leaf call at start, its result at completion, with one stable name", async () => {
    const r = runtime(async (options, gate) => {
      const started = { type: "shell", args: { command: "ls", workingDirectory: "/p" } };
      await delta(options, { type: "tool-call-started", callId: "c1", toolCall: started });
      await gate;
      await delta(options, { type: "tool-call-completed", callId: "c1", toolCall: { ...started, result: ok({ stdout: "a\n", stderr: "", exitCode: 0 }) } });
      await options.onStep?.({ step: { type: "toolCall", message: { ...started, result: ok({ stdout: "a\n", exitCode: 0 }) } } } as never);
    });
    const iterator = r.source(request())[Symbol.asyncIterator]();
    const first = (await iterator.next()).value as CursorTurnEvent;
    // The call reaches the host before Cursor finishes the tool: the card shows its running state.
    expect(first).toMatchObject({ type: "native-tool-call", toolName: "shell", input: { command: "ls", workdir: "/p" } });
    r.open();
    const rest: CursorTurnEvent[] = [];
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) rest.push(next.value);
    expect(rest).toEqual([
      { type: "native-tool-result", callId: (first as { callId: string }).callId, toolName: "shell", result: "a", isError: false },
      { type: "done", reason: "stop" },
    ]);
  });
  it("appends a diff block after an edit and passes the V3 stream contract", async () => {
    const r = runtime(async (options) => {
      r.open();
      const edit = { type: "edit", args: { path: "/p/src/a.ts" } };
      await delta(options, { type: "tool-call-started", callId: "e1", toolCall: edit });
      await delta(options, { type: "tool-call-completed", callId: "e1", toolCall: { ...edit, result: ok({ diffString: diff }) } });
      await delta(options, { type: "tool-call-completed", callId: "x1", toolCall: { type: "write", args: { bogus: 1 }, result: ok({}) } });
    });
    const parts: { type: string; toolName?: string; delta?: string }[] = [];
    for await (const part of translateTurn(r.source(request()))) parts.push(part as never);
    const names = parts.filter((p) => p.toolName).map((p) => `${p.type}:${p.toolName}`);
    expect(names).toEqual(["tool-input-start:edit", "tool-call:edit", "tool-result:edit", "tool-input-start:cursor_write", "tool-call:cursor_write", "tool-result:cursor_write"]);
    expect(parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("")).toContain("```diff\n--- a/src/a.ts");
    expect(parts.at(-1)?.type).toBe("finish");
  });
  it("holds a bridge split until every open native call has its result", async () => {
    let mcp: Promise<unknown> | undefined;
    const r = runtime(async (options) => {
      const shell = { type: "shell", args: { command: "sleep 1" } };
      await delta(options, { type: "tool-call-started", callId: "s1", toolCall: shell });
      const url = (Object.values(options.mcpServers ?? {})[0] as { url: string }).url;
      const rpc = async (method: string, params?: unknown) => (await (await fetch(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json() as { result: unknown }).result;
      const listed = await rpc("tools/list") as { tools: { name: string }[] };
      mcp = rpc("tools/call", { name: listed.tools[0]!.name, arguments: {} });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await delta(options, { type: "tool-call-completed", callId: "s1", toolCall: { ...shell, result: ok({ stdout: "", stderr: "", exitCode: 0 }) } });
    }, "both");
    const events: CursorTurnEvent[] = [];
    for await (const event of r.source({ ...request(), tools: [{ type: "function", name: "probe", inputSchema: { type: "object", properties: {} } }] })) events.push(event);
    expect(events.map((e) => e.type)).toEqual(["native-tool-call", "native-tool-result", "bridge-tool-call", "done"]);
    expect(events.at(-1)).toEqual({ type: "done", reason: "tool-calls" });
    expect(r.controls.status("ses_1").pending).toBe(true);
    void mcp;
  });
});
