// Review regressions for G5 (stale recovery snapshots, event evidence on unattempted receipts,
// racing delivery on invalid host answers). Deterministic: barriers, never sleeps.
import { describe, expect, it } from "vitest";
import { markDelivered, observe, receiptKey, toJson, type Receipt } from "../../src/core/receipt.js";
import { createReceiptService, type ReceiptStore } from "../../src/core/receipts.js";
import { sessionHost } from "../../src/plugin/completion.js";
import { fakeHost, ids, memoryStore } from "./fake-host.js";

const obs = (sessionID: string, runId = "run-1", text = `done ${runId}`) => ({ sessionID, agentId: "bc-agent-1", runId, text });

function barrier() {
  let open: () => void = () => {};
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}

/** Store whose scan returns, then waits at a barrier, so the caller holds a stale snapshot. */
function pausedScan(store: ReceiptStore) {
  const reached = barrier();
  const release = barrier();
  const wrapped: ReceiptStore = {
    ...store,
    scan: async (prefix, after) => {
      const page = await store.scan(prefix, after);
      reached.open();
      await release.opened;
      return page;
    },
  };
  return { store: wrapped, reached: reached.opened, release: release.open };
}

function setup() {
  const mem = memoryStore();
  const host = fakeHost();
  const make = (store: ReceiptStore = mem.store, mint = ids()) => createReceiptService({ store, host: sessionHost(host.session), mint, now: () => 1000 });
  return { mem, host, make };
}

const stateOf = (mem: ReturnType<typeof memoryStore>, r: Receipt) => (mem.data.get(receiptKey(r)) as Receipt | undefined)?.state;

describe("recovery re-reads inside the session queue", () => {
  it("a submit that dispatched after the scan is not dispatched again", async () => {
    const { mem, host, make } = setup();
    host.addSession("ses_a");
    const r = observe(undefined, obs("ses_a"), ids(), 1).receipt;
    mem.data.set(receiptKey(r), toJson(r));
    const paused = pausedScan(mem.store);
    const recovering = make(paused.store);
    const report = recovering.recover();
    await paused.reached;
    expect(await recovering.submit(obs("ses_a"))).toMatchObject({ receipt: { state: "admitted" } });
    paused.release();
    expect(await report).toMatchObject({ loaded: 1, dispatched: 0 });
    expect(host.calls).toHaveLength(1);
    expect(host.wakes).toHaveLength(1);
  });

  it("a dispatching snapshot does not overwrite a delivered record with held", async () => {
    const { mem, host, make } = setup();
    host.addSession("ses_a");
    const r = { ...observe(undefined, obs("ses_a"), ids(), 1).receipt, state: "dispatching", intentAt: 2 } as Receipt;
    mem.data.set(receiptKey(r), toJson(r));
    host.rawRow(r.id, "ses_a", r.text, true);
    const paused = pausedScan(mem.store);
    const recovering = make(paused.store);
    const report = recovering.recover();
    await paused.reached;
    expect(await make().reconcileSession("ses_a")).toMatchObject([{ state: "delivered" }]);
    host.rows.clear(); // compaction hides the promoted row
    paused.release();
    await report;
    expect(stateOf(mem, r)).toBe("delivered");
    expect(host.calls).toHaveLength(0);
  });

  it("reconcileSession does not transition a stale snapshot over a newer delivered record", async () => {
    const { mem, host, make } = setup();
    host.addSession("ses_a");
    const service = make();
    const out = await service.submit(obs("ses_a"));
    const id = out._tag === "receipt" ? out.receipt.id : "";
    const paused = pausedScan(mem.store);
    const reconciling = make(paused.store);
    const views = reconciling.reconcileSession("ses_a");
    await paused.reached;
    await service.delivered("ses_a", id);
    host.sessions.delete("ses_a"); // later lookups say session-not-found
    paused.release();
    expect(await views).toMatchObject([{ state: "delivered" }]);
    expect((mem.data.get([...mem.data.keys()][0]!) as Receipt).state).toBe("delivered");
  });

  it("reports unreadable receipts instead of dropping them", async () => {
    const { mem, host, make } = setup();
    host.addSession("ses_a");
    const r = observe(undefined, obs("ses_a"), ids(), 1).receipt;
    mem.data.set(receiptKey(r), toJson(r));
    const store: ReceiptStore = { ...mem.store, get: async () => { throw new Error("disk gone"); } };
    const report = await make(store).recover();
    expect(report).toMatchObject({ dispatched: 0, failed: [{ key: receiptKey(r), detail: "disk gone" }] });
    expect(host.calls).toHaveLength(0);
  });
});

describe("delivered events need a validated admission", () => {
  it("an event for a durable observed receipt never marks it delivered", async () => {
    const { mem, host, make } = setup();
    host.addSession("ses_a");
    const service = make();
    mem.failSetWhen((_, v) => v.state === "dispatching");
    const out = await service.submit(obs("ses_a"));
    expect(out).toMatchObject({ _tag: "error", reason: "storage" });
    mem.failSetWhen(undefined);
    const r = mem.data.get([...mem.data.keys()][0]!) as Receipt;
    expect(r.state).toBe("observed");
    await service.delivered("ses_a", r.id);
    expect(stateOf(mem, r)).toBe("observed");
    expect(await service.submit(obs("ses_a"))).toMatchObject({ receipt: { state: "admitted" } });
    expect(host.calls).toHaveLength(1);
  });

  it("markDelivered ignores event evidence without admission but accepts matching history", () => {
    const r = observe(undefined, obs("ses_a"), ids(), 1).receipt;
    expect(markDelivered(r, "event", 2)).toBe(r);
    expect(markDelivered(r, "context", 2).state).toBe("delivered");
  });

  it("an observed receipt whose matching row is already promoted reconciles without a host call", async () => {
    const { mem, host, make } = setup();
    host.addSession("ses_a");
    const r = observe(undefined, obs("ses_a"), ids(), 1).receipt;
    mem.data.set(receiptKey(r), toJson(r));
    host.rawRow(r.id, "ses_a", r.text, true);
    await make().recover();
    expect(stateOf(mem, r)).toBe("delivered");
    expect(host.calls).toHaveLength(0);
  });
});

describe("racing delivery applies only to a valid host answer", () => {
  /** Host call that records a delivered event for the ID before returning or throwing. */
  function racing(host: ReturnType<typeof fakeHost>, service: () => ReturnType<typeof createReceiptService>, after: (row: unknown) => unknown) {
    const original = host.session.synthetic;
    let pending: Promise<void> | undefined;
    host.session.synthetic = async (input) => {
      const row = await original(input);
      host.promote(input.id);
      pending = service().delivered(input.sessionID, input.id);
      return after(row);
    };
    return () => pending;
  }

  it("a pending row with different text stays a refused mismatch", async () => {
    const { mem, host, make } = setup();
    host.addSession("ses_a");
    const service = make();
    host.rawRow("msg_000000000001AAAAAAAAAAAAAA", "ses_a", "someone else's text");
    const pending = racing(host, () => service, (row) => row);
    const out = await service.submit(obs("ses_a"));
    await pending();
    expect(out).toMatchObject({ receipt: { state: "held", hold: { reason: "payload-mismatch" } } });
    expect((mem.data.get([...mem.data.keys()][0]!) as Receipt).state).toBe("held");
  });

  it("a response with another identity stays invalid", async () => {
    const { host, make } = setup();
    host.addSession("ses_a");
    const service = make();
    const pending = racing(host, () => service, (row) => ({ ...(row as object), id: "msg_ffffffffffffAAAAAAAAAAAAAA" }));
    const out = await service.submit(obs("ses_a"));
    await pending();
    expect(out).toMatchObject({ receipt: { state: "held", hold: { reason: "invalid-host-response" } } });
    expect((await service.list()).receipts[0]?.state).toBe("held");
  });

  it("an error return with a racing event stays uncertain", async () => {
    const { host, make } = setup();
    host.addSession("ses_a");
    const service = make();
    const pending = racing(host, () => service, () => {
      throw new Error("connection reset");
    });
    const out = await service.submit(obs("ses_a"));
    await pending();
    expect(out).toMatchObject({ receipt: { state: "held", hold: { reason: "uncertain-attempt" } } });
    expect((await service.list()).receipts[0]?.state).toBe("held");
    expect(host.calls).toHaveLength(1);
  });

  it.each(["reconcile", "recover"])("a validated racing event survives failed result and event writes until %s persists it", async (retry) => {
    const { mem, host } = setup();
    host.addSession("ses_a");
    const diagnostics: string[] = [];
    const service = createReceiptService({ store: mem.store, host: sessionHost(host.session), mint: ids(), now: () => 1000, diagnostic: (message) => diagnostics.push(message) });
    const original = host.session.synthetic;
    let eventTask: Promise<void> | undefined;
    let eventFailure: unknown;
    host.session.synthetic = async (input) => {
      const row = await original(input);
      host.promote(input.id);
      eventTask = service.delivered(input.sessionID, input.id).catch((cause: unknown) => { eventFailure = cause; });
      return row;
    };
    let failedWrites = 0;
    mem.failSetWhen((_, value) => {
      if (value.state !== "delivered") return false;
      failedWrites++;
      return true;
    });
    expect(await service.submit(obs("ses_a"))).toMatchObject({ _tag: "error", reason: "storage" });
    await eventTask;
    expect.soft(failedWrites).toBe(2);
    expect.soft(eventFailure).toBeInstanceOf(Error);
    expect.soft(diagnostics).toContain("receipt admission result not persisted; not dispatched again");
    expect((await service.list()).receipts[0]).toMatchObject({ state: "dispatching", admission: null, delivery: null });
    mem.failSetWhen(undefined);
    host.rows.clear();
    if (retry === "recover") expect(await service.recover()).toMatchObject({ failed: [], dispatched: 0, heldUncertain: 0 });
    else await service.reconcileSession("ses_a");
    expect((await service.list()).receipts[0]).toMatchObject({ state: "delivered", admission: { wake: "requested" }, delivery: { via: "event" }, answer: "unknown" });
    await service.submit(obs("ses_a"));
    expect(host.calls).toHaveLength(1);
    expect(host.wakes).toHaveLength(1);
  });

  it("delivery arriving during a failed final write keeps the already validated admission", async () => {
    const { mem, host } = setup();
    host.addSession("ses_a");
    let eventTask: Promise<void> | undefined;
    const store: ReceiptStore = {
      ...mem.store,
      set: async (key, value) => {
        if (value.state === "admitted") {
          host.promote(String(value.id));
          eventTask = service.delivered("ses_a", String(value.id)).catch(() => {});
          throw new Error("storage set failed");
        }
        await mem.store.set(key, value);
      },
    };
    const service = createReceiptService({ store, host: sessionHost(host.session), mint: ids(), now: () => 1000 });
    mem.failSetWhen((_, value) => value.state === "delivered");
    expect(await service.submit(obs("ses_a"))).toMatchObject({ _tag: "error", reason: "storage" });
    await eventTask;
    mem.failSetWhen(undefined);
    host.rows.clear();
    expect(await service.reconcileSession("ses_a")).toMatchObject([{ state: "delivered", admission: { wake: "requested" }, delivery: { via: "event" } }]);
    expect(host.calls).toHaveLength(1);
  });

  it.each(["mismatched", "invalid", "failed"])("a racing %s answer whose result write fails never retains validated event evidence", async (answer) => {
    const { mem, host, make } = setup();
    host.addSession("ses_a");
    const service = make();
    const pending = racing(host, () => service, (row) => {
      if (answer === "failed") throw new Error("connection reset");
      if (answer === "invalid") return { ...(row as object), id: "msg_ffffffffffffAAAAAAAAAAAAAA" };
      return { ...(row as object), payload: { text: "someone else's text" } };
    });
    mem.failSetWhen((_, value) => value.state === "held");
    expect(await service.submit(obs("ses_a"))).toMatchObject({ _tag: "error", reason: "storage" });
    await pending();
    mem.failSetWhen(undefined);
    host.rows.clear();
    expect(await service.recover()).toMatchObject({ heldUncertain: 1, dispatched: 0 });
    expect((await service.list()).receipts[0]).toMatchObject({ state: "held", hold: { reason: "uncertain-attempt" }, admission: null, delivery: null });
    expect(host.calls).toHaveLength(1);
  });

  it("a valid response with a racing event is delivered", async () => {
    const { host, make } = setup();
    host.addSession("ses_a");
    const service = make();
    const pending = racing(host, () => service, (row) => row);
    const out = await service.submit(obs("ses_a"));
    await pending();
    expect(out).toMatchObject({ receipt: { state: "delivered", admission: { wake: "requested" }, delivery: { via: "event" } } });
  });
});
