// T2 keyless Agent.create probe (approved: Inbox msg_redacted). Inside the host
// OpenCode runtime it calls the real public `Agent.create` from @cursor/sdk 1.0.40 with local-only
// options, no apiKey, `tools: []`, no MCP, no custom tools, no agents, `settingSources: []`, a
// fixture cwd and a fixture SqliteLocalAgentStore. It never calls send, resume or prompt and
// never passes Cloud options. A returned handle is only disposed through its public API.
// Each case is bounded; a timer win is recorded as `stalled`, not as a rejection.
// TEST ONLY: production entries never import the SDK.
import { writeFileSync } from "node:fs";
import { createCursorPlugin } from "../../../dist/plugin/create.js";

const CASE_TIMEOUT_MS = 20_000;
const BUNDLED = /\/@cursor\/sdk\/dist\/bundled\//;

function redact(text, roots) {
  let out = String(text ?? "");
  for (const r of roots) if (r) out = out.replaceAll(r, "<root>");
  // Defensive: nothing key-like should ever appear, but never persist one if it does.
  return out.replace(/(key_|crsr_|sk-)[A-Za-z0-9_-]{8,}/g, "<redacted>").slice(0, 400);
}

function stackCategory(stack) {
  const frames = String(stack ?? "").split("\n").slice(1, 6);
  if (!frames.length) return "none";
  return frames.some((f) => BUNDLED.test(f)) ? "sdk-bundled" : frames.some((f) => f.includes("create-plugin")) ? "fixture" : "other";
}

function sanitize(error, sdk, roots) {
  const cls = (name) => (sdk?.[name] ? error instanceof sdk[name] : null);
  return {
    name: error?.name,
    code: error?.code ?? null,
    isRetryable: error?.isRetryable ?? null,
    status: error?.status ?? null,
    message: redact(error?.message ?? error, roots),
    instanceOf: {
      CursorSdkError: cls("CursorSdkError"),
      AuthenticationError: cls("AuthenticationError"),
      ConfigurationError: cls("ConfigurationError"),
      NetworkError: cls("NetworkError"),
    },
    causeName: error?.cause?.name ?? null,
    causeCode: error?.cause?.code ?? null,
    stackCategory: stackCategory(error?.stack),
  };
}

async function bounded(promise) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ outcome: "stalled", afterMs: CASE_TIMEOUT_MS }), CASE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise.then((value) => ({ outcome: "resolved", value }), (error) => ({ outcome: "rejected", error })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runCase(sdk, store, project, roots, label, extra) {
  /** @type {import("@cursor/sdk").AgentOptions} */
  const options = {
    name: `t2-${label}`,
    tools: [],
    local: { cwd: project, store, settingSources: [] },
    ...extra,
  };
  const shape = { ...options, local: { ...options.local, cwd: "<project>", store: "<fixture SqliteLocalAgentStore>" } };
  const started = Date.now();
  const r = await bounded(sdk.Agent.create(options));
  const result = { label, callShape: shape, outcome: r.outcome, elapsedMs: Date.now() - started };
  if (r.outcome === "rejected") result.error = sanitize(r.error, sdk, roots);
  if (r.outcome === "stalled") result.afterMs = r.afterMs;
  if (r.outcome === "resolved") {
    const agent = r.value;
    result.handle = { agentIdPrefix: String(agent?.agentId ?? "").slice(0, 6), hasSend: typeof agent?.send === "function", model: agent?.model ?? null };
    // Only a public disposal method counts as cleanup. Missing both is recorded, never assumed done.
    const dispose = typeof agent?.[Symbol.asyncDispose] === "function" ? () => agent[Symbol.asyncDispose]() : typeof agent?.close === "function" ? async () => agent.close() : undefined;
    if (!dispose) {
      result.dispose = { outcome: "unavailable" };
    } else {
      const disposed = await bounded(Promise.resolve().then(dispose));
      result.dispose = { outcome: disposed.outcome, ...(disposed.outcome === "rejected" ? { error: sanitize(disposed.error, sdk, roots) } : {}) };
    }
  }
  return result;
}

async function probe(stateRoot, project, roots) {
  const evidence = { runtime: { bun: globalThis.Bun?.version ?? null }, env: { CURSOR_API_KEY: process.env.CURSOR_API_KEY !== undefined, homeIsFixture: (process.env.HOME ?? "").startsWith(roots[0] ?? "\0") } };
  const sdk = await import("@cursor/sdk");
  const { SqliteLocalAgentStore } = await import("@cursor/sdk/sqlite");
  const store = await SqliteLocalAgentStore.open({ workspaceRef: project, stateRoot });
  evidence.cases = [];
  // Case A: no model (published docs say model is required for local agents).
  evidence.cases.push(await runCase(sdk, store, project, roots, "no-model", {}));
  // Case B: a model selection by public shape. The id is not validated offline by us.
  evidence.cases.push(await runCase(sdk, store, project, roots, "with-model", { model: { id: "composer-1" } }));
  const listed = await bounded(store.agents.list({ filter: {} }));
  evidence.storeAfter = listed.outcome === "resolved" ? { agents: listed.value.items.length, statuses: listed.value.items.map((a) => a.status) } : { outcome: listed.outcome };
  await store.dispose();
  return evidence;
}

const inner = createCursorPlugin({
  lanes: {
    coding: async function* () {
      yield { type: "text", text: "T2 create probe done." };
      yield { type: "done", reason: "stop" };
    },
    helper: { _tag: "unavailable" },
  },
  models: [{ id: "fake", name: "Cursor T2 fake", context: 200000, output: 32000 }],
  onRefusal: (refusal) => console.error(`[cursor-t2-create] refused: ${refusal.message}`),
});

export default {
  id: inner.id,
  async setup(context) {
    const { evidence: out, stateRoot, workspaceRef, fixtureBase } = context.options ?? {};
    if ([out, stateRoot, workspaceRef, fixtureBase].some((v) => typeof v !== "string")) throw new Error("[cursor-t2-create] options.evidence, stateRoot, workspaceRef and fixtureBase are required");
    let evidence;
    try {
      evidence = { host: context.app?.version ?? null, ok: true, ...(await probe(stateRoot, workspaceRef, [fixtureBase])) };
    } catch (error) {
      evidence = { host: context.app?.version ?? null, ok: false, error: { name: error?.name, message: redact(error?.message, [fixtureBase]) } };
    }
    writeFileSync(out, JSON.stringify(evidence, null, 2));
    console.error(`[cursor-t2-create] probe written host=${evidence.host}`);
    return inner.setup(context);
  },
};
