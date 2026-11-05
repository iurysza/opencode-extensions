// G5 real-host fixture (TEST ONLY). The built Cloud receipts adapter on a real OpenCode host,
// with the SDK package's scripted fake provider so sessions can run turns without Cursor.
// The Cloud package itself never imports the SDK package; only this fixture does.
//
// Test-only additions:
// - RPC `iurysza.receipts-fixture` stands in for the future Cloud runtime's observed completion
//   and exposes list/recover/reconcile plus fault arming. It is not a production method.
// - Fault points kill this host process with SIGKILL at a chosen step for one run ID.
// - `nextId` overrides the next minted ID, only to stage host conflicts on purpose.
// - The fake turn source can block a session's next turn until `release`, so the runner can
//   observe a completion while the session is busy, with an explicit handshake in the log.
import { appendFileSync } from "node:fs";
import { createCursorPlugin } from "../../../../opencode-cursor-sdk/dist/plugin/create.js";
import { attachCompletionReceipts } from "../../../dist/plugin/completion.js";
import { messageIdFactory } from "../../../dist/core/message-id.js";

let log = "/nonexistent/receipts.jsonl";
const record = (entry) => appendFileSync(log, `${JSON.stringify({ t: Date.now(), pid: process.pid, ...entry })}\n`);

const armed = new Map(); // point -> runId
const holds = new Set(); // sessionIDs whose next primary turn blocks
const gates = new Map(); // sessionID -> release()
const markers = new Set(); // completion texts to look for in prompts
const nextIds = [];

function crash(point, runId) {
  if (armed.get(point) !== runId) return;
  record({ at: "crash", point, runId });
  process.kill(process.pid, "SIGKILL");
}

const textOf = (prompt) =>
  (Array.isArray(prompt) ? prompt : [])
    .flatMap((m) => (typeof m.content === "string" ? [m.content] : Array.isArray(m.content) ? m.content.map((p) => p.text ?? "") : []))
    .join("\n");

const source = (request) => {
  const sessionID = request.context.sessionID;
  const text = textOf(request.prompt);
  const seen = [...markers].filter((m) => text.includes(m));
  record({ at: "source", kind: request.context.kind, sessionID, seen });
  for (const m of seen) {
    const runId = /run=([\w-]+)/.exec(m)?.[1];
    if (runId) crash("turn-started", runId);
  }
  const block = request.context.kind === "primary" && holds.delete(sessionID);
  return (async function* () {
    if (request.context.kind === "title") {
      yield { type: "text", text: "Receipts fixture" };
      yield { type: "done", reason: "stop" };
      return;
    }
    yield { type: "text", text: `${request.context.kind} reply start.` };
    if (block) {
      await new Promise((resolve) => {
        gates.set(sessionID, resolve);
        record({ at: "blocked", sessionID });
      });
      record({ at: "released", sessionID });
    }
    yield { type: "text", text: " reply end." };
    yield { type: "done", reason: "stop" };
  })();
};

const provider = createCursorPlugin({
  lanes: { coding: source, helper: { _tag: "test-only", source } },
  models: [{ id: "fake", name: "Cursor receipts fake", context: 200000, output: 32000 }],
  onRefusal: (refusal) => record({ at: "refused", message: refusal.message }),
});

const json = { type: "object" };
const any = {};
const definition = {
  id: "iurysza.receipts-fixture",
  methods: Object.fromEntries(["observe", "list", "recover", "reconcile", "arm", "nextId", "hold", "release", "ping"].map((m) => [m, { input: json, output: any }])),
  events: {},
};

export default {
  id: "iurysza.cursor-cloud-receipts-fixture",
  async setup(ctx) {
    log = ctx.options?.log ?? log;
    record({ at: "setup", version: ctx.app?.version });
    await provider.setup(ctx);

    const realMint = messageIdFactory();
    const mint = () => nextIds.shift() ?? realMint();
    const runOf = (value) => (value && typeof value === "object" && typeof value.runId === "string" ? value.runId : undefined);
    // Fault injection wraps the public context; production passes the context unchanged.
    const storage = {
      get: (key) => ctx.storage.get(key),
      scan: (options) => ctx.storage.scan(options),
      set: async (key, value) => {
        const runId = runOf(value);
        if (value?.state === "delivered") crash("before-delivered-save", runId);
        await ctx.storage.set(key, value);
        record({ at: "store", key, state: value?.state, runId });
        if (value?.state === "observed") crash("observed-saved", runId);
        if (value?.state === "dispatching") crash("intent-saved", runId);
      },
    };
    const session = {
      get: (input) => ctx.session.get(input),
      context: (input) => ctx.session.context(input),
      synthetic: async (input) => {
        record({ at: "synthetic-call", id: input.id, sessionID: input.sessionID, runId: input.metadata?.runId, resume: input.resume });
        try {
          const out = await ctx.session.synthetic(input);
          record({ at: "synthetic-return", id: out?.id, sessionID: out?.sessionID, type: out?.type, text: out?.payload?.text });
          crash("host-admitted", input.metadata?.runId);
          return out;
        } catch (error) {
          record({ at: "synthetic-throw", id: input.id, error: String(error?._tag ?? error?.name ?? "") + ": " + String(error?.message ?? error).slice(0, 200) });
          throw error;
        }
      },
    };
    const event = {
      subscribe: (options) => {
        const stream = ctx.event.subscribe(options);
        return {
          async *[Symbol.asyncIterator]() {
            for await (const e of stream) {
              if (e?.type === "session.inbox.delivered") record({ at: "delivered-event", sessionID: e.data?.sessionID, inboxID: e.data?.inboxID });
              yield e;
            }
          },
        };
      },
    };
    const receipts = attachCompletionReceipts(
      { storage, session, event },
      { mint, diagnostic: (message, detail) => record({ at: "diagnostic", message, detail }) },
    );
    await receipts.ready;

    await ctx.rpc.register(definition, {
      ping: async () => ({ pid: process.pid, version: ctx.app?.version }),
      observe: async (input) => {
        markers.add(input.text);
        return receipts.service.submit(input);
      },
      list: async () => receipts.service.list(),
      recover: async () => receipts.service.recover(),
      reconcile: async (input) => ({ receipts: await receipts.service.reconcileSession(input.sessionID) }),
      arm: async (input) => {
        armed.set(input.point, input.runId);
        if (input.text) markers.add(input.text);
        return { armed: [...armed.entries()] };
      },
      nextId: async (input) => {
        nextIds.push(input.id);
        return { queued: nextIds.length };
      },
      hold: async (input) => {
        holds.add(input.sessionID);
        return {};
      },
      release: async (input) => {
        const release = gates.get(input.sessionID);
        gates.delete(input.sessionID);
        release?.();
        return { released: Boolean(release) };
      },
    });
    record({ at: "ready" });
    return () => receipts.dispose();
  },
};
