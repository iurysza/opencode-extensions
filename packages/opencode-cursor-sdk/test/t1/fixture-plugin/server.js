// T1 fixture: the real built plugin with a scripted fake Cursor turn source.
// No @cursor/sdk code, no network. The native "write" call targets a sentinel
// path; if the host ever executed it locally, the sentinel file would appear.
import { createCursorPlugin } from "../../../dist/plugin/create.js";

let sentinel = "/nonexistent/sentinel";
const source = async function* () {
  yield { type: "text", text: "T1 fake turn start." };
  yield { type: "native-tool-call", callId: "cursor-native-1", toolName: "write", input: { path: sentinel, content: "executed locally" } };
  yield { type: "native-tool-result", callId: "cursor-native-1", toolName: "write", result: { ok: true, by: "cursor" } };
  yield { type: "text", text: " T1 fake turn end." };
  yield { type: "done", reason: "stop" };
};
const inner = createCursorPlugin({
  source,
  models: [{ id: "fake", name: "Cursor T1 fake", context: 200000, output: 32000 }],
  onRefusal: (refusal) => console.error(`[cursor-t1] refused: ${refusal.message}`),
});
export default {
  id: inner.id,
  async setup(context) {
    if (typeof context.options?.sentinel === "string") sentinel = context.options.sentinel;
    console.error(`[cursor-t1] setup host=${context.app?.version} registration=${context.provider ? "provider" : context.catalog ? "catalog" : "none"}`);
    return inner.setup(context);
  },
};
