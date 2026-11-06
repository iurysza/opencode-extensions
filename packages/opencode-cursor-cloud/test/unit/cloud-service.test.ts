import { describe, expect, it } from "vitest";
import type { CloudClient, CloudHandle, CloudRun, Completion, StreamEvent } from "../../src/core/cloud-client.js";
import { createCloudService, type CloudResponse, type CloudServiceOptions } from "../../src/core/cloud-service.js";
import { createReceiptService } from "../../src/core/receipts.js";
import { sessionHost } from "../../src/plugin/completion.js";
import { reduce, type CloudAgent } from "../../src/core/state.js";
import { fakeHost, ids, memoryStore } from "./fake-host.js";

import { deferred, finished, until } from "./cloud-fakes.js";

function value(result: CloudResponse) { if (result._tag !== "ok") throw new Error(result.error.message); return result.value; }
function rig(extra: Partial<CloudServiceOptions> = {}) {
  const host = fakeHost(); host.addSession("s1"); host.addSession("s2");
  const memory = memoryStore();
  const receipts = createReceiptService({ store: memory.store, host: sessionHost(host.session), mint: ids() });
  const created: string[] = [], sent: string[] = [], cancelled: string[] = [], closed: string[] = [], deleted: string[] = [];
  const runs: { done: ReturnType<typeof deferred<Completion>>; ready: ReturnType<typeof deferred<CloudRun>>; emit: (event: StreamEvent) => void; run: CloudRun }[] = [];
  let autoReady = true;
  const deletion = deferred<void>();
  let blockDelete = false;
  const handles: CloudHandle[] = [];
  const client: CloudClient = {
    models: async () => [],
    create: async () => {
      const id = `bc-agent-${created.length + 1}`; created.push(id);
      const handle: CloudHandle = { id, close: () => { closed.push(id); }, send: async (prompt, emit) => {
        sent.push(prompt);
        const done = deferred<Completion>(), ready = deferred<CloudRun>();
        const run = { id: `run-${runs.length + 1}`, wait: () => done.promise, cancel: async () => { cancelled.push(id); } };
        runs.push({ done, ready, emit, run });
        if (autoReady) ready.resolve(run);
        return ready.promise;
      } };
      handles.push(handle); return handle;
    },
    delete: async id => { deleted.push(id); if (blockDelete) await deletion.promise; },
  };
  const service = createCloudService({ client, receipts, location: { directory: "/fake" }, repo: async () => ({ repo: "https://github.com/o/r", ref: "main" }), ...extra });
  return { service, host, memory, receipts, created, sent, cancelled, closed, deleted, handles, runs,
    pendingSend: () => { autoReady = false; }, blockDeletion: () => { blockDelete = true; }, deletion };
}
const spawn = (r: ReturnType<typeof rig>, sessionID = "s1") => r.service.spawn(sessionID, { prompt: "implement" });

describe("production Cloud lifecycle with injected clients", () => {
  it("returns before send finishes, reserves starting, and completes through durable receipts only", async () => {
    const r = rig(); r.pendingSend();
    const launched = value(await spawn(r));
    expect(launched.text).toContain("not local, uncommitted or unpushed commits");
    expect(launched.agents[0]?.status.type).toBe("starting");
    expect((await r.service.send("s1", "agent-1", "race"))._tag).toBe("err");
    expect(r.host.calls).toHaveLength(0);
    await until(() => r.runs.length === 1);
    r.runs[0]!.ready.resolve(r.runs[0]!.run);
    await until(async () => value(await r.service.status("s1")).agents[0]?.status.type === "running");
    expect((await r.service.send("s1", "agent-1", "busy"))._tag).toBe("err");
    r.runs[0]!.emit({ type: "delta", activity: { type: "text", text: "streamed" } });
    r.runs[0]!.done.resolve(finished);
    await until(() => r.host.calls.length === 1);
    const rows = (await r.receipts.list()).receipts;
    expect(rows[0]).toMatchObject({ sessionID: "s1", agentId: "bc-agent-1", runId: "run-1", state: "admitted", answer: "unknown" });
    expect(r.memory.data.size).toBe(1);
    expect(r.host.calls[0]?.sessionID).toBe("s1");
    expect(r.host.calls[0]?.text).toContain("remote result");
    r.runs[0]!.done.resolve(finished);
    r.runs[0]!.emit({ type: "delta", activity: { type: "text", text: "LATE" } });
    expect(value(await r.service.status("s1")).agents[0]?.text).toBe("streamed");
    expect(r.host.calls).toHaveLength(1);
    await r.service.dispose();
  });

  it("binds all reads and mutations to the originating session; no cross-session prefix discovery", async () => {
    const r = rig(); await spawn(r); await spawn(r, "s2");
    expect(value(await r.service.status("s1")).agents.map(a => a.id)).toEqual(["bc-agent-1"]);
    for (const result of [await r.service.status("s2", "agent-1"), await r.service.send("s2", "agent-1", "bad"), await r.service.cancel("s2", "agent-1"), await r.service.delete("s2", "agent-1", true)]) expect(result._tag).toBe("err");
    expect(r.cancelled).toEqual([]); expect(r.deleted).toEqual([]);
    r.runs[0]!.done.resolve(finished); r.runs[1]!.done.resolve(finished);
    await until(() => r.host.calls.length === 2);
    expect(r.host.calls.map(c => c.sessionID).sort()).toEqual(["s1", "s2"]);
    await r.service.dispose();
  });

  it("reserves follow-ups synchronously and rejects stale callbacks from the old run", async () => {
    const r = rig(); await spawn(r); r.runs[0]!.done.resolve(finished); await until(() => r.host.calls.length === 1);
    const first = r.service.send("s1", "agent-1", "next");
    const second = r.service.send("s1", "agent-1", "racing");
    expect((await first)._tag).toBe("ok"); expect((await second)._tag).toBe("err");
    r.runs[0]!.emit({ type: "delta", activity: { type: "text", text: "stale" } });
    expect(value(await r.service.status("s1")).agents[0]?.text).toBe("");
    r.runs[1]!.done.resolve(finished); await until(() => r.host.calls.length === 2);
    expect((await r.receipts.list()).receipts.map(r => r.runId).sort()).toEqual(["run-1", "run-2"]);
    await r.service.dispose();
  });

  it("cancel during starting awaits the run, but never cancels after shutdown", async () => {
    const r = rig(); r.pendingSend(); await spawn(r);
    const cancel = r.service.cancel("s1", "agent-1");
    expect(r.cancelled).toEqual([]);
    await r.service.dispose();
    r.runs[0]!.ready.resolve(r.runs[0]!.run);
    expect((await cancel)._tag).toBe("err");
    expect(r.cancelled).toEqual([]); expect(r.closed).toEqual(["bc-agent-1"]);
    r.runs[0]!.done.resolve(finished);
    expect(r.host.calls).toHaveLength(0);
    expect((await spawn(r))._tag).toBe("err");
  });

  it("explicit cancel requests cancellation of its owned run only", async () => {
    const r = rig(); r.pendingSend(); await spawn(r);
    const cancel = r.service.cancel("s1", "agent-1");
    r.runs[0]!.ready.resolve(r.runs[0]!.run);
    expect((await cancel)._tag).toBe("ok"); expect(r.cancelled).toEqual(["bc-agent-1"]);
    r.runs[0]!.done.resolve({ ...finished, type: "cancelled" }); await until(() => r.host.calls.length === 1);
    expect(value(await r.service.status("s1")).agents[0]?.status.type).toBe("cancelled");
    await r.service.cancel("s1", "agent-1"); expect(r.cancelled).toHaveLength(1);
    await r.service.dispose();
  });

  it("shutdown during create detaches the eventual handle and never sends/cancels/deletes", async () => {
    const create = deferred<CloudHandle>(); let closed = false, sent = false;
    const r = rig({ client: { models: async () => [], create: () => create.promise, delete: async () => { throw new Error("unexpected delete"); } } });
    const pending = spawn(r); await Promise.resolve(); await r.service.dispose();
    create.resolve({ id: "bc-late", close: () => { closed = true; }, send: async () => { sent = true; throw new Error(); } });
    expect((await pending)._tag).toBe("err"); expect(closed).toBe(true); expect(sent).toBe(false);
  });

  it("delete requires confirmation and inactivity, and blocks concurrent send/delete", async () => {
    const r = rig(); await spawn(r);
    expect((await r.service.delete("s1", "agent-1", true))._tag).toBe("err");
    r.runs[0]!.done.resolve(finished); await until(() => r.host.calls.length === 1);
    expect((await r.service.delete("s1", "agent-1", false))._tag).toBe("err");
    r.blockDeletion(); const removal = r.service.delete("s1", "agent-1", true);
    expect((await r.service.send("s1", "agent-1", "no"))._tag).toBe("err");
    expect((await r.service.delete("s1", "agent-1", true))._tag).toBe("err");
    r.deletion.resolve(); expect((await removal)._tag).toBe("ok");
    expect(value(await r.service.status("s1")).agents).toEqual([]); expect(r.closed).toEqual(["bc-agent-1"]);
    await r.service.dispose();
  });

  it("receipt failure leaves a result and diagnostic, without inventing a completion", async () => {
    const r = rig(); r.memory.failSetWhen(() => true); await spawn(r);
    r.runs[0]!.done.resolve(finished);
    await until(async () => value(await r.service.status("s1")).receiptIssues.length === 1);
    const status = value(await r.service.status("s1"));
    expect(status.text).toContain("remote result"); expect(status.agents[0]?.status.type).toBe("idle");
    expect(r.host.calls).toHaveLength(0);
    await r.service.dispose();
  });

  it("awaits receipt submission, tolerates receipt rejection and preserves the next run", async () => {
    const submit = deferred<never>();
    const r = rig({ receipts: { submit: () => submit.promise } }); await spawn(r);
    r.runs[0]!.done.resolve(finished); await until(async () => value(await r.service.status("s1")).agents[0]?.status.type === "idle");
    expect(value(await r.service.status("s1")).receiptIssues).toEqual([]);
    expect((await r.service.send("s1", "agent-1", "new"))._tag).toBe("ok");
    submit.reject(new Error("SECRET SDK serialization"));
    await until(async () => value(await r.service.status("s1")).receiptIssues.length === 1);
    expect(JSON.stringify(await r.service.status("s1"))).not.toContain("SECRET");
    expect(value(await r.service.status("s2")).receiptIssues).toEqual([]);
    await r.service.dispose();
  });

  it("refuses changed locations, remote workspaces and unknown/ambiguous IDs", async () => {
    let directory = "/fake";
    const r = rig({ currentLocation: () => ({ directory }) }); await spawn(r); await spawn(r);
    expect((await r.service.status("s1", "agent"))._tag).toBe("err");
    expect((await r.service.cancel("s1", "external"))._tag).toBe("err");
    directory = "/different";
    expect((await r.service.status("s1"))._tag).toBe("err"); expect((await spawn(r))._tag).toBe("err");
    await r.service.dispose();
    const remote = rig({ location: { directory: "/fake", workspaceID: "remote" } });
    expect((await spawn(remote))._tag).toBe("err"); expect(remote.created).toEqual([]); await remote.service.dispose();
  });

  it("a failed first send marks the agent never created, drops its link and refuses follow-ups", async () => {
    const r = rig(); r.pendingSend(); await spawn(r);
    await until(() => r.runs.length === 1);
    r.runs[0]!.ready.reject(new Error("first send failed"));
    await until(() => r.host.calls.length === 1);
    const status = value(await r.service.status("s1"));
    expect(status.agents[0]).toMatchObject({ remote: "never", status: { type: "failed" } });
    expect(status.text).toContain("not created");
    expect(status.text).toContain("This agent was never created on Cursor. Start a new agent.");
    expect(status.text).not.toContain("cursor.com/agents");
    // The receipt reports the observed failure without a dead link.
    expect(r.host.calls[0]?.text).toContain("not created on Cursor");
    expect(r.host.calls[0]?.text).not.toContain("cursor.com/agents");
    const refused = await r.service.send("s1", "agent-1", "again");
    expect(refused).toEqual({ _tag: "err", error: { message: "This agent was never created on Cursor. Start a new agent." } });
    expect(r.sent).toEqual(["implement"]);
    await r.service.dispose();
  });

  it("a failed follow-up after a created run keeps the agent and its link", async () => {
    const r = rig(); await spawn(r);
    r.runs[0]!.done.resolve(finished); await until(() => r.host.calls.length === 1);
    expect(r.host.calls[0]?.text).toContain("Open: https://cursor.com/agents/bc-agent-1");
    r.pendingSend(); expect((await r.service.send("s1", "agent-1", "next"))._tag).toBe("ok");
    await until(() => r.runs.length === 2);
    r.runs[1]!.ready.reject(new Error("send failed"));
    await until(() => r.host.calls.length === 2);
    const status = value(await r.service.status("s1"));
    expect(status.agents[0]).toMatchObject({ remote: "created", status: { type: "failed" } });
    expect(status.text).toContain("https://cursor.com/agents/bc-agent-1");
    expect(status.text).not.toContain("not created");
    await r.service.dispose();
  });

  it("sanitizes unexpected client errors and returns immutable snapshots", async () => {
    const r = rig(); await spawn(r);
    value(await r.service.status("s1")).agents[0]!.name = "mutated";
    expect(value(await r.service.status("s1")).agents[0]?.name).not.toBe("mutated");
    r.runs[0]!.done.reject(new Error("Authorization: Bearer SECRET serializedClient"));
    await until(() => r.host.calls.length === 1);
    expect(JSON.stringify(await r.service.status("s1"))).not.toMatch(/SECRET|serializedClient|Authorization/);
    expect(value(await r.service.status("s1")).agents[0]?.status.type).toBe("failed");
    await r.service.dispose();
  });
});

it("ported reducer deduplicates terminal and tool events", () => {
  const agent: CloudAgent = { id: "bc-a", remote: "pending", name: "a", description: "p", repo: "r", ref: "main", model: "m", startedAt: 0, status: { type: "starting" }, text: "", tools: 0, toolCallIds: [], activity: "" };
  let state = reduce([], { type: "spawned", agent });
  const tool = { type: "delta" as const, id: "bc-a", activity: { type: "tool" as const, callId: "x", activity: "shell" } };
  state = reduce(reduce(state, tool), tool); expect(state[0]?.tools).toBe(1);
  state = reduce(state, { type: "finished", id: "bc-a", result: finished.result, now: 1 });
  expect(reduce(state, { type: "error", id: "bc-a", result: finished.result, error: "late", now: 2 })).toEqual(state);
  expect(reduce(state, tool)).toEqual(state);
});
