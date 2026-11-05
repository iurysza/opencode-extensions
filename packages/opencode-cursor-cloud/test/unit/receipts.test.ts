import { describe, expect, it } from "vitest";
import { isMintedMessageId, messageIdFactory } from "../../src/core/message-id.js";
import { hashText, observe, parseReceipt, receiptKey, recoverInterrupted, toJson, type Receipt } from "../../src/core/receipt.js";
import { createReceiptService } from "../../src/core/receipts.js";
import { attachCompletionReceipts, classifyAdmitFailure, sessionHost, storageStore } from "../../src/plugin/completion.js";
import { fakeHost, ids, memoryStore } from "./fake-host.js";

const obs = (sessionID: string, runId = "run-1", text = `done ${runId}`, extra: Record<string, unknown> = {}) => ({ sessionID, agentId: "bc-agent-1", runId, text, ...extra });

function setup() {
  const mem = memoryStore();
  const host = fakeHost();
  const diagnostics: string[] = [];
  const make = () =>
    createReceiptService({ store: mem.store, host: sessionHost(host.session), mint: ids(), now: () => 1000, diagnostic: (m) => diagnostics.push(m) });
  return { mem, host, diagnostics, make, service: make() };
}

describe("message IDs", () => {
  it("mints host-shaped ascending IDs and never derives from remote IDs", () => {
    const mint = messageIdFactory({ now: () => 0x123456789, random: (n) => new Uint8Array(n).fill(61) });
    const a = mint();
    const b = mint();
    expect(a).toBe("msg_123456789001zzzzzzzzzzzzzz");
    expect(b).toBe("msg_123456789002zzzzzzzzzzzzzz");
    expect(isMintedMessageId(a)).toBe(true);
    const real = messageIdFactory();
    expect(isMintedMessageId(real())).toBe(true);
  });
});

describe("receipt record", () => {
  it("is created once per observation key and refuses changed text", () => {
    const created = observe(undefined, obs("ses_a"), ids(), 1);
    expect(created._tag).toBe("create");
    expect(observe(created.receipt, obs("ses_a"), ids(), 2)._tag).toBe("duplicate");
    expect(observe(created.receipt, obs("ses_a", "run-1", "other"), ids(), 2)._tag).toBe("mismatch");
    expect(created.receipt.textHash).toBe(hashText("done run-1"));
  });

  it("rejects tampered, corrupt or misfiled stored records", () => {
    const r = observe(undefined, obs("ses_a"), ids(), 1).receipt;
    const key = receiptKey(r);
    expect(parseReceipt(key, toJson(r))._tag).toBe("ok");
    expect(parseReceipt(key, { ...toJson(r), text: "changed" })._tag).toBe("err");
    expect(parseReceipt(key, { ...toJson(r), id: "not-msg" })._tag).toBe("err");
    expect(parseReceipt(key, { ...toJson(r), state: "answered" })._tag).toBe("err");
    expect(parseReceipt(receiptKey(obs("ses_b")), toJson(r))._tag).toBe("err");
    expect(parseReceipt(key, "garbage")._tag).toBe("err");
  });

  it("turns an interrupted dispatch into a held diagnostic, not a retry", () => {
    const r: Receipt = { ...observe(undefined, obs("ses_a"), ids(), 1).receipt, state: "dispatching", intentAt: 2 } as Receipt;
    const recovered = recoverInterrupted(r, 3);
    expect(recovered.state).toBe("held");
  });
});

describe("receipt service", () => {
  it("admits once, records admission and delivery separately, answer unknown", async () => {
    const { host, service } = setup();
    host.addSession("ses_a");
    const first = await service.submit(obs("ses_a"));
    expect(first).toMatchObject({ _tag: "receipt", created: true, receipt: { state: "admitted", answer: "unknown", admission: { wake: "requested" }, delivery: null } });
    const id = first._tag === "receipt" ? first.receipt.id : "";
    host.promote(id);
    await service.delivered("ses_a", id);
    const dup = await service.submit(obs("ses_a"));
    expect(dup).toMatchObject({ _tag: "receipt", created: false, receipt: { state: "delivered", answer: "unknown" } });
    expect(host.calls).toHaveLength(1);
    expect(host.wakes).toEqual([id]);
  });

  it("duplicate terminal events before delivery do not call the host again", async () => {
    const { host, service } = setup();
    host.addSession("ses_a");
    await Promise.all([service.submit(obs("ses_a")), service.submit(obs("ses_a")), service.submit(obs("ses_a"))]);
    expect(host.calls).toHaveLength(1);
    expect(host.rows.size).toBe(1);
  });

  it("refuses a changed payload under an existing receipt", async () => {
    const { host, service } = setup();
    host.addSession("ses_a");
    await service.submit(obs("ses_a"));
    const changed = await service.submit(obs("ses_a", "run-1", "tampered"));
    expect(changed).toMatchObject({ _tag: "refused", reason: "payload-mismatch" });
    expect(host.calls).toHaveLength(1);
  });

  it("holds when the host already has our ID with different text", async () => {
    const { host, service } = setup();
    host.addSession("ses_a");
    host.rawRow("msg_000000000001AAAAAAAAAAAAAA", "ses_a", "someone else's text");
    const out = await service.submit(obs("ses_a"));
    expect(out).toMatchObject({ receipt: { state: "held", hold: { reason: "payload-mismatch" } } });
  });

  it("holds on a cross-session host conflict", async () => {
    const { host, service } = setup();
    host.addSession("ses_a");
    host.addSession("ses_b");
    host.rawRow("msg_000000000001AAAAAAAAAAAAAA", "ses_b", "done run-1");
    const out = await service.submit(obs("ses_a"));
    expect(out).toMatchObject({ receipt: { state: "held", hold: { reason: "host-conflict" } } });
    expect(host.rows.get("msg_000000000001AAAAAAAAAAAAAA")?.sessionID).toBe("ses_b");
  });

  it("separate sessions keep separate queues and receipts", async () => {
    const { host, service } = setup();
    host.addSession("ses_a");
    host.addSession("ses_b");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const original = host.session.synthetic;
    host.session.synthetic = async (input) => {
      if (input.sessionID === "ses_a") await gate;
      return original(input);
    };
    const a = service.submit(obs("ses_a"));
    const b = await service.submit(obs("ses_b"));
    expect(b).toMatchObject({ receipt: { state: "admitted", sessionID: "ses_b" } });
    release();
    expect(await a).toMatchObject({ receipt: { state: "admitted", sessionID: "ses_a" } });
  });

  it("two completions in one session get two IDs, serially", async () => {
    const { host, service } = setup();
    host.addSession("ses_a");
    const [x, y] = await Promise.all([service.submit(obs("ses_a", "run-1")), service.submit(obs("ses_a", "run-2"))]);
    expect(x._tag === "receipt" && y._tag === "receipt" && x.receipt.id !== y.receipt.id).toBe(true);
    expect(host.calls.map((c) => c.text)).toEqual(["done run-1", "done run-2"]);
  });

  it("promotion racing ahead of the host return never regresses delivered", async () => {
    const { host, mem, make } = setup();
    host.addSession("ses_a");
    const c = attachCompletionReceipts({ storage: { get: mem.store.get, set: mem.store.set as never, scan: ({ prefix, after }) => mem.store.scan(prefix, after) }, session: host.session, event: host.event }, { mint: ids(), now: () => 1 });
    await c.ready;
    host.onBeforeReturn((row) => host.promote(row.id));
    const out = await c.service.submit(obs("ses_a"));
    await new Promise((r) => setTimeout(r, 0));
    const listed = await c.service.list();
    expect(out._tag === "receipt" && ["admitted", "delivered"].includes(out.receipt.state)).toBe(true);
    expect(listed.receipts[0]).toMatchObject({ state: "delivered", admission: { wake: "requested" } });
    c.dispose();
    void make;
  });

  it("resume:false admits without wake; reverted admits without wake; deleted fails closed", async () => {
    const { host, service } = setup();
    host.addSession("ses_q");
    host.addSession("ses_r", true);
    const q = await service.submit(obs("ses_q", "run-1", "q", { resume: false }));
    const r = await service.submit(obs("ses_r"));
    const d = await service.submit(obs("ses_gone"));
    expect(q).toMatchObject({ receipt: { state: "admitted", admission: { wake: "suppressed" } } });
    expect(r).toMatchObject({ receipt: { state: "admitted", admission: { wake: "skipped-reverted" } } });
    expect(d).toMatchObject({ receipt: { state: "held", hold: { reason: "session-deleted" } } });
    expect(host.wakes).toEqual([]);
    expect(host.calls.map((c) => c.sessionID)).toEqual(["ses_q", "ses_r"]);
  });

  it("an unclassified host failure after the intent is held, and never retried", async () => {
    const { host, service, make } = setup();
    host.addSession("ses_a");
    host.setThrowAfterAdmit(true);
    const out = await service.submit(obs("ses_a"));
    expect(out).toMatchObject({ receipt: { state: "held", hold: { reason: "uncertain-attempt" } } });
    host.setThrowAfterAdmit(false);
    await make().recover();
    await service.submit(obs("ses_a"));
    expect(host.calls).toHaveLength(1);
  });

  it("storage failure before the intent leaves nothing dispatched", async () => {
    const { host, mem, service } = setup();
    host.addSession("ses_a");
    mem.failSetWhen(() => true);
    const out = await service.submit(obs("ses_a"));
    expect(out).toMatchObject({ _tag: "error", reason: "storage" });
    expect(host.calls).toHaveLength(0);
  });

  it("storage failure writing the intent never calls the host", async () => {
    const { host, mem, service, make } = setup();
    host.addSession("ses_a");
    mem.failSetWhen((_, v) => v.state === "dispatching");
    expect(await service.submit(obs("ses_a"))).toMatchObject({ _tag: "error", reason: "storage" });
    expect(host.calls).toHaveLength(0);
    mem.failSetWhen(undefined);
    // Still observed and definitely unattempted: recovery may dispatch it, once.
    expect(await make().recover()).toMatchObject({ loaded: 1, dispatched: 1 });
    expect(host.calls).toHaveLength(1);
  });

  it("recovery: observed dispatches, dispatching holds, promoted reconciles to delivered", async () => {
    const { host, mem, make } = setup();
    host.addSession("ses_a");
    const mint = ids();
    const put = (r: Receipt) => mem.data.set(receiptKey(r), toJson(r));
    const o1 = observe(undefined, obs("ses_a", "run-1"), mint, 1).receipt;
    const o2 = { ...observe(undefined, obs("ses_a", "run-2"), mint, 1).receipt, state: "dispatching", intentAt: 2 } as Receipt;
    const o3 = { ...observe(undefined, obs("ses_a", "run-3"), mint, 1).receipt, state: "dispatching", intentAt: 2 } as Receipt;
    put(o1);
    put(o2);
    put(o3);
    host.rawRow(o3.id, "ses_a", o3.text, true);
    mem.data.set("receipt/bad/x/y", { v: 1, id: "nope" });
    const report = await make().recover();
    expect(report).toMatchObject({ loaded: 3, dispatched: 1, heldUncertain: 1 });
    expect(report.corrupt).toHaveLength(1);
    const states = Object.fromEntries([...mem.data.entries()].filter(([k]) => !k.includes("bad")).map(([, v]) => [(v as Receipt).runId, (v as Receipt).state]));
    expect(states).toEqual({ "run-1": "admitted", "run-2": "held", "run-3": "delivered" });
    expect(host.calls.map((c) => c.id)).toEqual([o1.id]);
  });

  it("history hiding a delivered row (compaction) never reverts local delivered state", async () => {
    const { host, service } = setup();
    host.addSession("ses_a");
    const out = await service.submit(obs("ses_a"));
    const id = out._tag === "receipt" ? out.receipt.id : "";
    await service.delivered("ses_a", id);
    host.rows.clear();
    const views = await service.reconcileSession("ses_a");
    expect(views[0]?.state).toBe("delivered");
    await service.submit(obs("ses_a"));
    expect(host.calls).toHaveLength(1);
  });

  it("a delivered event never marks an unattempted receipt or another session's receipt", async () => {
    const { host, service } = setup();
    host.addSession("ses_a");
    host.addSession("ses_b");
    await service.delivered("ses_b", "msg_000000000001AAAAAAAAAAAAAA");
    await service.delivered("ses_a", "msg_000000000001AAAAAAAAAAAAAA");
    const out = await service.submit(obs("ses_a"));
    expect(out).toMatchObject({ receipt: { id: "msg_000000000001AAAAAAAAAAAAAA", state: "admitted" } });
    expect(host.calls).toHaveLength(1);
  });

  it("a delivered event for another session is ignored", async () => {
    const { host, service } = setup();
    host.addSession("ses_a");
    const out = await service.submit(obs("ses_a"));
    const id = out._tag === "receipt" ? out.receipt.id : "";
    await service.delivered("ses_other", id);
    expect((await service.list()).receipts[0]?.state).toBe("admitted");
  });

  it("classifies host errors through causes", () => {
    expect(classifyAdmitFailure({ cause: { _tag: "Session.SyntheticConflictError" } })._tag).toBe("conflict");
    expect(classifyAdmitFailure(new Error("Session.NotFoundError: ses_x"))._tag).toBe("session-not-found");
    expect(classifyAdmitFailure(new Error("socket hang up"))._tag).toBe("unknown");
    void storageStore;
  });
});
