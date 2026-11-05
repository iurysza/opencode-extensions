// T2 fixture: imports the real @cursor/sdk 1.0.37 inside the host OpenCode runtime (its Bun),
// opens a fixture SqliteLocalAgentStore, writes, closes, reopens and reads back, and records
// offline public error-class shapes. Never calls Agent.create/resume/send, never reads a real
// store, uses no key. Writes evidence JSON to `options.evidence`, then serves the fake model so
// `opencode run` has something to complete. TEST ONLY: production entries never import the SDK.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCursorPlugin } from "../../../dist/plugin/create.js";

const REQUIRED_MAIN = ["Agent", "Cursor", "CursorSdkError", "CursorAgentError", "AuthenticationError", "RateLimitError", "ConfigurationError", "NetworkError", "convertConnectError", "convertError", "wrapSdkError"];
const sanitize = (error) => ({ name: error?.name, message: String(error?.message ?? error).slice(0, 500), code: error?.code });

async function step(evidence, key, fn) {
  try {
    evidence[key] = { ok: true, ...(await fn()) };
  } catch (error) {
    evidence[key] = { ok: false, error: sanitize(error) };
  }
}

async function probe(stateRoot, workspaceRef) {
  const evidence = {
    runtime: { bun: globalThis.Bun?.version ?? null, bunRevision: globalThis.Bun?.revision ?? null, node: process.versions.node, hasDeno: typeof globalThis.Deno !== "undefined" },
  };
  await step(evidence, "resolve", async () => ({
    main: import.meta.resolve("@cursor/sdk"),
    sqlite: import.meta.resolve("@cursor/sdk/sqlite"),
    connectWeb: import.meta.resolve("@connectrpc/connect-web"),
  }));
  let sdk;
  await step(evidence, "importMain", async () => {
    sdk = await import("@cursor/sdk");
    const missing = REQUIRED_MAIN.filter((name) => sdk[name] === undefined);
    if (missing.length) throw new Error(`missing exports: ${missing.join(", ")}`);
    return { exportCount: Object.keys(sdk).length, required: REQUIRED_MAIN };
  });
  await step(evidence, "sqliteStore", async () => {
    const { SqliteLocalAgentStore } = await import("@cursor/sdk/sqlite");
    const now = 1_700_000_000_000;
    const agent = { agentId: "t2-agent", cwd: workspaceRef, status: "idle", name: "t2", createdAt: now, updatedAt: now, sdkMetadata: { probe: "t2" } };
    const blob = new TextEncoder().encode("t2-checkpoint");
    // Checkpoints are content-addressed: the store decodes blobId as hex.
    const blobId = createHash("sha256").update(blob).digest("hex");
    const first = await SqliteLocalAgentStore.open({ workspaceRef, stateRoot });
    await first.agents.create({ agent });
    await first.checkpoints.create({ agentId: agent.agentId, blobId, data: blob });
    const appended = await first.runEvents.append({ runId: "t2-run", eventType: "t2.probe", payload: { n: 1 } });
    await first.dispose();
    const files = readdirSync(stateRoot, { recursive: true }).map(String).sort();
    const second = await SqliteLocalAgentStore.open({ workspaceRef, stateRoot });
    const readAgent = await second.agents.get({ agentId: agent.agentId });
    const readBlob = await second.checkpoints.get({ agentId: agent.agentId, blobId });
    const readEvents = await second.runEvents.list({ runId: "t2-run" });
    await second.dispose();
    return {
      files,
      agentRoundTrip: readAgent?.agentId === agent.agentId && readAgent?.cwd === workspaceRef && readAgent?.sdkMetadata?.probe === "t2",
      blobRoundTrip: readBlob !== null && new TextDecoder().decode(readBlob) === "t2-checkpoint",
      eventRoundTrip: readEvents.items.length === 1 && readEvents.items[0]?.eventType === "t2.probe" && readEvents.items[0]?.payload?.n === 1 && readEvents.items[0]?.seq === appended.seq,
    };
  });
  // Manufactured, offline error shapes only. They show public class wiring under this runtime;
  // they do not qualify transport behaviour (auth/network/stall/abort from real RPCs).
  await step(evidence, "errorShapes", async () => {
    if (!sdk) throw new Error("main import failed");
    const { ConnectError, Code } = await import("@connectrpc/connect");
    const net = new sdk.NetworkError("t2 offline", { code: "t2", isRetryable: true });
    const map = (code) => {
      const converted = sdk.convertConnectError(new ConnectError("t2 manufactured", code));
      return { name: converted.name, isRetryable: converted.isRetryable, isCursorSdkError: converted instanceof sdk.CursorSdkError };
    };
    return {
      networkError: { name: net.name, isRetryable: net.isRetryable, instanceOfCursorSdkError: net instanceof sdk.CursorSdkError, json: net.toJSON() },
      connectUnauthenticated: map(Code.Unauthenticated),
      connectUnavailable: map(Code.Unavailable),
      connectDeadlineExceeded: map(Code.DeadlineExceeded),
      connectResourceExhausted: map(Code.ResourceExhausted),
    };
  });
  return evidence;
}

const inner = createCursorPlugin({
  lanes: {
    coding: async function* () {
      yield { type: "text", text: "T2 probe done." };
      yield { type: "done", reason: "stop" };
    },
    helper: { _tag: "unavailable" },
  },
  models: [{ id: "fake", name: "Cursor T2 fake", context: 200000, output: 32000 }],
  onRefusal: (refusal) => console.error(`[cursor-t2] refused: ${refusal.message}`),
});

export default {
  id: inner.id,
  async setup(context) {
    const { evidence: out, stateRoot, workspaceRef } = context.options ?? {};
    if (typeof out !== "string" || typeof stateRoot !== "string" || typeof workspaceRef !== "string") throw new Error("[cursor-t2] options.evidence, stateRoot and workspaceRef are required");
    if (existsSync(join(stateRoot, "index.db"))) throw new Error("[cursor-t2] refusing pre-existing store");
    const evidence = { host: context.app?.version ?? null, ...(await probe(stateRoot, workspaceRef)) };
    writeFileSync(out, JSON.stringify(evidence, null, 2));
    console.error(`[cursor-t2] probe written host=${evidence.host}`);
    return inner.setup(context);
  },
};
