// G4a/G3 real-host fixture. The built plugin with a TEST-ONLY helper lane, so every request
// kind reaches a recording source. Nothing here calls a hook by hand: the host drives every
// request. Public plugin API only. No @cursor/sdk, no network.
//
// Test-only additions, all through public hooks:
// - a `model.request` hook registered BEFORE the plugin writes a forged stamp, to prove the
//   plugin overwrites it on real hosts;
// - a `model.request` hook registered AFTER the plugin reads `ctx.session.get(...)` at request
//   time (G3 fork lineage and selected model);
// - an aisdk `language` hook registered AFTER the plugin wraps the model to report fake input
//   token usage on primary turns, so the host's automatic compaction triggers.
import { appendFileSync } from "node:fs";
import { createCursorPlugin } from "../../../dist/plugin/create.js";
import { STAMP_HEADER } from "../../../dist/compat/request-stamp.js";

const FORGED = JSON.stringify({ v: 1, kind: "primary", sessionID: "ses_forged", agent: "x", model: { providerID: "cursor", id: "forged" } });
let log = "/nonexistent/requests.jsonl";
let bigUsage = 0;
const record = (entry) => appendFileSync(log, `${JSON.stringify(entry)}\n`);

const textOf = (prompt) =>
  (Array.isArray(prompt) ? prompt : [])
    .flatMap((m) => (typeof m.content === "string" ? [m.content] : Array.isArray(m.content) ? m.content.map((p) => p.text ?? "") : []))
    .join("\n");

// Summary text that satisfies the 2.2.5 compaction template check.
const SUMMARY = "## Objective\n- req fixture\n\n## Requirements\n- (none)\n\n## Decisions\n- (none)\n\n## Work State\n### Completed\n- (none)\n\n### Active\n- (none)\n\n### Blocked\n- (none)\n\n## Next Move\n1. (none)\n\n## Relevant Files\n(none)\n\n## Important Context\n- (none)";

const source = (request) => {
  const text = textOf(request.prompt);
  record({
    at: "source",
    context: request.context,
    modelId: request.modelId,
    promptMessages: Array.isArray(request.prompt) ? request.prompt.length : -1,
    promptHasSummary: text.includes("## Objective\n- req fixture"),
    promptTail: text.slice(-160),
  });
  const reply =
    request.context.kind === "title" ? "Req fixture title" : request.context.kind === "compaction" ? SUMMARY : `${request.context.kind} reply`;
  return (async function* () {
    yield { type: "text", text: reply };
    yield { type: "done", reason: "stop" };
  })();
};

const inner = createCursorPlugin({
  lanes: { coding: source, helper: { _tag: "test-only", source } },
  models: [
    { id: "fake", name: "Cursor req fake", context: 200000, output: 32000 },
    { id: "fake2", name: "Cursor req fake 2", context: 200000, output: 32000 },
  ],
  onRefusal: (refusal) => console.error(`[cursor-req] refused: ${refusal.message}`),
});

export default {
  id: inner.id,
  async setup(ctx) {
    log = ctx.options?.log ?? log;
    bigUsage = Number(ctx.options?.bigUsage ?? 0);
    console.error(`[cursor-req] setup host=${ctx.app?.version}`);
    await ctx.session.hook("model.request", (event) => {
      event.headers[STAMP_HEADER] = FORGED;
    }, { providerID: "cursor" });
    await inner.setup(ctx);
    await ctx.session.hook("model.request", async (event) => {
      let info;
      try {
        info = await ctx.session.get({ sessionID: event.sessionID });
      } catch (error) {
        info = { error: String(error?.message ?? error).slice(0, 200) };
      }
      record({
        at: "model.request",
        kind: event.kind,
        sessionID: event.sessionID,
        agent: event.agent,
        model: event.model,
        stamp: event.headers[STAMP_HEADER] ?? null,
        hostSessionHeader: event.headers["X-Session-Id"] ?? null,
        session: { id: info.id, parentID: info.parentID ?? null, fork: info.fork ?? null, model: info.model ?? null, title: info.title ?? null, error: info.error },
      });
    }, { providerID: "cursor" });
    await ctx.aisdk.hook("language", (event) => {
      const model = event.language;
      if (!model || bigUsage <= 0) return;
      event.language = {
        ...model,
        async doStream(options) {
          const result = await model.doStream(options);
          const big = /"kind":"primary"/.test(options.headers?.[STAMP_HEADER] ?? "");
          const usage = (finish) => ({
            ...finish,
            usage: {
              inputTokens: { total: big ? bigUsage : 10, noCache: big ? bigUsage : 10, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 5, text: 5, reasoning: 0 },
            },
          });
          return {
            ...result,
            stream: result.stream.pipeThrough(new TransformStream({ transform: (part, c) => c.enqueue(part.type === "finish" ? usage(part) : part) })),
          };
        },
      };
    }, { providerID: "cursor" });
  },
};
