import { expect, it } from "vitest";
import { attachCompletionReceipts, type CompletionContext } from "../../src/plugin/completion.js";
import { fakeHost, ids, memoryStore } from "./fake-host.js";

function barrier<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

it("the completion adapter reports a failed delivery write and reconciliation retries without history or readmission", async () => {
  const mem = memoryStore();
  const host = fakeHost();
  host.addSession("ses_a");
  const event = barrier<unknown>();
  const handled = barrier<void>();
  // Requesting the next event proves the adapter finished handling the first, even on failure.
  const events: CompletionContext["event"] = {
    async *subscribe({ signal } = {}) {
      yield await event.promise;
      handled.resolve();
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    },
  };
  const diagnostics: { message: string; detail: Record<string, unknown> }[] = [];
  const attached = attachCompletionReceipts({
    storage: { get: mem.store.get, set: mem.store.set as never, scan: ({ prefix, after }) => mem.store.scan(prefix, after) },
    session: host.session,
    event: events,
  }, { mint: ids(), now: () => 1000, diagnostic: (message, detail) => diagnostics.push({ message, detail }) });
  try {
    await attached.ready;
    const out = await attached.service.submit({ sessionID: "ses_a", agentId: "bc-agent-1", runId: "run-1", text: "private completion text" });
    expect(out).toMatchObject({ _tag: "receipt", receipt: { state: "admitted" } });
    if (out._tag !== "receipt") throw new Error("expected receipt");
    const id = out.receipt.id;
    host.promote(id);
    let failures = 0;
    mem.failSetWhen((_, value) => value.state === "delivered" && failures++ === 0);
    event.resolve({ type: "session.inbox.delivered", data: { sessionID: "ses_a", inboxID: id } });
    await handled.promise;
    expect(failures).toBe(1);
    expect((await attached.service.list()).receipts[0]).toMatchObject({ state: "admitted", delivery: null });
    expect.soft(diagnostics).toEqual([{ message: "delivered-event receipt update failed; persistence can be retried", detail: { sessionID: "ses_a", inboxID: id, detail: "Error | storage set failed" } }]);
    expect(JSON.stringify(diagnostics)).not.toContain("private completion text");
    mem.failSetWhen(undefined);
    host.rows.clear(); // Compaction removes the only other source of delivery evidence.
    expect(await attached.service.reconcileSession("ses_a")).toMatchObject([{ state: "delivered", admission: { wake: "requested" }, delivery: { via: "event" }, answer: "unknown" }]);
    expect((await attached.service.list()).receipts[0]?.state).toBe("delivered");
    await attached.service.submit({ sessionID: "ses_a", agentId: "bc-agent-1", runId: "run-1", text: "private completion text" });
    expect(host.calls).toHaveLength(1);
    expect(host.wakes).toEqual([id]);
  } finally {
    attached.dispose();
  }
});
