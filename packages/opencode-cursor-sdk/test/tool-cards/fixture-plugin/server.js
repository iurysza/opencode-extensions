// Tool-card probe fixture: the real built plugin with a scripted Cursor turn source.
// No @cursor/sdk code, no network. Native calls target sentinel paths; the host must
// only record them. `shape` picks today's cursor_<type> parts or OpenCode built-in names.
import { createCursorPlugin } from "../../../dist/plugin/create.js";

let options = { shape: "today", project: "/nonexistent", delayMs: 0 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const diff = (path) => `--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n`;

/** Cursor SDK tool-call payloads as delivered by `tool-call-completed`. */
function cursorCalls(project) {
  const file = `${project}/src/sample.ts`;
  return [
    { id: "edit", tool: { type: "edit", args: { path: file }, result: { status: "success", value: { linesAdded: 1, linesRemoved: 1, diffString: diff("src/sample.ts") } } } },
    { id: "shell", tool: { type: "shell", args: { command: "echo probe && ls src", workingDirectory: project }, result: { status: "success", value: { exitCode: 0, signal: "", stdout: "probe\nsample.ts\n", stderr: "", executionTime: 12 } } } },
    { id: "read", tool: { type: "read", args: { path: file }, result: { status: "success", value: { content: "const a = 1;\nconst b = 3;\n", totalLines: 2, fileSize: 26 } } } },
  ];
}

/** Proposed built-in shape: OpenCode tool names, input fields and text output. */
function builtin(tool) {
  const value = tool.result.value;
  switch (tool.type) {
    case "edit": return { name: "edit", input: { path: tool.args.path }, result: value.diffString ?? "" };
    case "shell": return { name: "shell", input: { command: tool.args.command, workdir: tool.args.workingDirectory }, result: [value.stdout, value.stderr].filter(Boolean).join("") };
    case "read": return { name: "read", input: { path: tool.args.path }, result: value.content };
    default: throw new Error(`unmapped ${tool.type}`);
  }
}

const source = async function* (request) {
  // Live turns hold each call open so the TUI can be captured while it runs.
  const live = JSON.stringify(request.prompt).includes("probe live");
  yield { type: "text", text: `Probe ${options.shape} start.` };
  for (const { id, tool } of cursorCalls(options.project)) {
    const callId = `cursor-native-${id}`;
    const shaped = options.shape === "builtin" ? builtin(tool) : { name: `cursor_${tool.type}`, input: tool.args, result: JSON.stringify(tool.result) };
    yield { type: "native-tool-call", callId, toolName: shaped.name, input: shaped.input };
    if (live) await sleep(options.delayMs);
    yield { type: "native-tool-result", callId, toolName: shaped.name, result: shaped.result };
  }
  yield { type: "text", text: ` Probe ${options.shape} end.` };
  yield { type: "done", reason: "stop" };
};

/** Fake Cursor SDK for the `runtime` shape: the production local runtime maps names and results. */
const fakeSdk = {
  models: async () => [{ id: "fake", displayName: "Cursor tool-card fake" }],
  openStore: async () => ({ store: {}, dispose: async () => {} }),
  create: async () => ({
    close() {},
    async send(prompt, sendOptions) {
      const live = prompt.includes("probe live");
      const task = (async () => {
        await sendOptions.onDelta({ update: { type: "text-delta", text: `Probe ${options.shape} start.` } });
        const todos = { type: "updateTodos", args: { todos: [{ content: "Edit sample", status: "completed" }, { content: "Verify cards", status: "inProgress" }] }, result: { status: "success", value: {} } };
        const glob = { type: "glob", args: { globPattern: "**/*.ts", targetDirectory: options.project }, result: { status: "success", value: { files: ["src/sample.ts"], totalFiles: 1, clientTruncated: false, ripgrepTruncated: false } } };
        const invalid = { type: "write", args: { not: "a valid OpenCode write schema" }, result: { status: "success", value: { by: "cursor" } } };
        for (const { id, tool } of [...cursorCalls(options.project), { id: "todos", tool: todos }, { id: "glob", tool: glob }, { id: "invalid", tool: invalid }]) {
          const { result, ...started } = tool;
          await sendOptions.onDelta({ update: { type: "tool-call-started", callId: id, toolCall: started } });
          if (live) await sleep(options.delayMs / 2);
          await sendOptions.onDelta({ update: { type: "tool-call-completed", callId: id, toolCall: tool } });
        }
        await sendOptions.onDelta({ update: { type: "text-delta", text: ` Probe ${options.shape} end.` } });
        return { id: "run-fake", status: "finished" };
      })();
      void task.catch(() => {});
      return { wait: () => task, cancel: async () => {} };
    },
  }),
};

const models = [{ id: "fake", name: "Cursor tool-card fake", context: 200000, output: 32000 }];
const onRefusal = (refusal) => console.error(`[cursor-tool-cards] refused: ${refusal.message}`);
export default {
  id: "cursor",
  async setup(context) {
    options = { ...options, ...context.options };
    const inner = options.shape === "runtime"
      ? createCursorPlugin({ models, onRefusal, local: { loadSdk: async () => fakeSdk, env: { CURSOR_API_KEY: "tool-cards-fixture-key", HOME: "/nonexistent" }, stateRoot: `${options.project}/../cursor-state` } })
      : createCursorPlugin({ lanes: { coding: source, helper: { _tag: "unavailable" } }, models, onRefusal });
    return inner.setup(context);
  },
};
