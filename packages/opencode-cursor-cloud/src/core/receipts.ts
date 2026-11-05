// Receipt service: the imperative shell around `receipt.ts`. Host-neutral: it talks to the host
// only through the injected ports below. One serial queue per session; every write for a
// session goes through that queue, so this process is the single writer of its receipts.
import { keyedQueue } from "./keyed-queue.js";
import {
  applyAdmission,
  applyAdmitFailure,
  beginAttempt,
  hold,
  markDelivered,
  observe,
  parseObservation,
  parseReceipt,
  RECEIPT_PREFIX,
  receiptKey,
  sessionPrefix,
  reconcilePromoted,
  recoverInterrupted,
  toJson,
  view,
  type AdmitFailure,
  type ParseError,
  type Receipt,
  type ReceiptView,
  type Wake,
} from "./receipt.js";
import { err, ok, type Result } from "./result.js";

/** Durable key-value storage. Public `ctx.storage` satisfies it. `set` must be atomic per key. */
export interface ReceiptStore {
  readonly get: (key: string) => Promise<unknown>;
  readonly set: (key: string, value: Record<string, unknown>) => Promise<void>;
  readonly scan: (prefix: string, after?: string) => Promise<{ readonly entries: readonly { readonly key: string; readonly value: unknown }[]; readonly next?: string }>;
}

export type LookupFailure = { readonly _tag: "session-not-found" | "unknown"; readonly detail: string };

/** Host session operations, already parsed by the adapter. */
export interface ReceiptHost {
  readonly admit: (input: {
    readonly sessionID: string;
    readonly id: string;
    readonly text: string;
    readonly resume: boolean;
    readonly metadata: Record<string, string>;
  }) => Promise<Result<unknown, AdmitFailure>>;
  /** Promoted synthetic rows visible in public history (`session.context`). May omit compacted rows. */
  readonly promoted: (sessionID: string) => Promise<Result<ReadonlyMap<string, { readonly text: string }>, LookupFailure>>;
  readonly session: (sessionID: string) => Promise<Result<{ readonly reverted: boolean }, LookupFailure>>;
}

export interface ReceiptServiceOptions {
  readonly store: ReceiptStore;
  readonly host: ReceiptHost;
  readonly mint: () => string;
  readonly now?: () => number;
  /** Diagnostics for held or corrupt receipts. Never contains completion text. */
  readonly diagnostic?: (message: string, detail: Record<string, unknown>) => void;
}

export type SubmitOutcome =
  | { readonly _tag: "receipt"; readonly created: boolean; readonly receipt: ReceiptView }
  | { readonly _tag: "refused"; readonly reason: "payload-mismatch"; readonly receipt: ReceiptView }
  | { readonly _tag: "error"; readonly reason: "invalid-observation" | "storage" | "corrupt-receipt"; readonly detail: string };

export interface RecoveryReport {
  readonly loaded: number;
  readonly corrupt: readonly ParseError[];
  readonly dispatched: number;
  readonly heldUncertain: number;
  /** Receipts that could not be read or written during recovery. Reported, never dropped silently. */
  readonly failed: readonly { readonly key: string; readonly detail: string }[];
}

export function createReceiptService(options: ReceiptServiceOptions) {
  const { store, host, mint } = options;
  const now = options.now ?? (() => Date.now());
  const diagnostic = options.diagnostic ?? (() => {});
  const queue = keyedQueue();
  /** receipt message ID -> storage key, for delivered events that carry only the inbox ID. */
  const byId = new Map<string, string>();
  /**
   * Delivered events (session + inbox ID) not yet persisted. Events predating our intent and
   * events paired with invalid admissions are discarded. Eligible evidence survives failed
   * writes. `markDelivered` still requires a validated admission, never just an inbox ID.
   */
  const seenDelivered = new Set<string>();
  /** Validated admission awaiting a durable result write, kept eligible for racing delivery. */
  const pendingAdmissions = new Map<string, Extract<Receipt, { state: "admitted" }>>();
  const deliveredKey = (sessionID: string, id: string) => `${sessionID}\u0000${id}`;
  const sawDelivered = (r: Receipt) => seenDelivered.has(deliveredKey(r.sessionID, r.id));

  const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).slice(0, 300);

  async function load(key: string): Promise<Result<Receipt | undefined, ParseError | { _tag: "storage"; detail: string }>> {
    let raw: unknown;
    try {
      raw = await store.get(key);
    } catch (cause) {
      return err({ _tag: "storage", detail: errorText(cause) });
    }
    if (raw === undefined || raw === null) return ok(undefined);
    const parsed = parseReceipt(key, raw);
    if (parsed._tag === "err") {
      diagnostic("corrupt receipt; not dispatched", { key, detail: parsed.error.detail });
      return parsed;
    }
    byId.set(parsed.value.id, key);
    return ok(parsed.value);
  }

  async function save(r: Receipt): Promise<void> {
    await store.set(receiptKey(r), toJson(r));
    byId.set(r.id, receiptKey(r));
    if (r.state === "delivered") seenDelivered.delete(deliveredKey(r.sessionID, r.id));
    if (r.state === "admitted" || r.state === "delivered") pendingAdmissions.delete(deliveredKey(r.sessionID, r.id));
    if (r.state === "held") diagnostic(`receipt held: ${r.hold.reason}`, { id: r.id, sessionID: r.sessionID, agentId: r.agentId, runId: r.runId, detail: r.hold.detail });
  }

  function deliveryFromEvent(r: Receipt): Receipt {
    if (!sawDelivered(r)) return r;
    const pending = pendingAdmissions.get(deliveredKey(r.sessionID, r.id));
    // Only dispatch validated this cached result. It can repair its failed final write, but
    // cannot bless an unattempted receipt, another observation or a definite refusal.
    if (pending && receiptKey(pending) === receiptKey(r) && pending.textHash === r.textHash &&
      (r.state === "dispatching" || r.state === "admitted" || (r.state === "held" && r.hold.reason === "uncertain-attempt"))) return markDelivered(pending, "event", now());
    return markDelivered(r, "event", now());
  }

  /** Looks for host evidence of promotion. Delivered locally always wins. */
  async function reconcile(r: Receipt): Promise<Receipt> {
    if (r.state === "delivered") return r;
    const marked = deliveryFromEvent(r);
    if (marked !== r) return marked;
    const rows = await host.promoted(r.sessionID);
    if (rows._tag === "err") {
      return rows.error._tag === "session-not-found" && r.state !== "held" ? hold(r, "session-deleted", rows.error.detail, now()) : r;
    }
    return reconcilePromoted(r, rows.value.get(r.id), now());
  }

  /** Dispatches a definitely unattempted receipt. Runs inside the session queue. */
  async function dispatch(start: Receipt): Promise<Receipt> {
    let r = await reconcile(start);
    if (r !== start) await save(r);
    if (r.state !== "observed") return r;
    const session = await host.session(r.sessionID);
    if (session._tag === "err") {
      if (session.error._tag === "session-not-found") {
        r = hold(r, "session-deleted", session.error.detail, now());
        await save(r);
      }
      return r; // Unknown lookup failure: still observed, still definitely unattempted.
    }
    const wake: Wake = !r.resume ? "suppressed" : session.value.reverted ? "skipped-reverted" : "requested";
    const attempt = beginAttempt(r, now());
    if (attempt._tag === "err") return r;
    // Intent first: a crash after this line is representable and never replayed blindly.
    await save(attempt.value);
    // Only events that arrive from now on can describe our admission.
    seenDelivered.delete(deliveredKey(r.sessionID, r.id));
    const result = await host.admit({
      sessionID: r.sessionID,
      id: r.id,
      text: r.text,
      resume: r.resume,
      metadata: { source: "cursor-cloud", agentId: r.agentId, runId: r.runId },
    });
    // Validate the host's answer against the intent first. A delivered event that raced the call
    // proves only that some row with this ID was promoted, so it counts only after the host
    // returned our identity and text. Discard invalid evidence immediately so its queued
    // `delivered` task cannot upgrade a mismatching or failed admission. Keep validated
    // racing delivery until save succeeds, including its admission if the intent is all
    // that storage currently holds. Reconciliation can persist it without admitting again.
    const checked = result._tag === "ok" ? applyAdmission(attempt.value, result.value, wake, now()) : applyAdmitFailure(attempt.value, result.error, now());
    const raced = sawDelivered(r);
    const next = raced && checked.state === "admitted" ? markDelivered(checked, "event", now()) : checked;
    if (checked.state === "admitted") pendingAdmissions.set(deliveredKey(r.sessionID, r.id), checked);
    else seenDelivered.delete(deliveredKey(r.sessionID, r.id));
    try {
      await save(next);
    } catch (cause) {
      diagnostic("receipt admission result not persisted; not dispatched again", { id: r.id, sessionID: r.sessionID, deliveryPending: checked.state === "admitted" && sawDelivered(r), detail: errorText(cause) });
      throw cause;
    }
    return next;
  }

  async function submit(input: unknown): Promise<SubmitOutcome> {
    const parsed = parseObservation(input);
    if (parsed._tag === "err") return { _tag: "error", reason: "invalid-observation", detail: parsed.error.detail };
    const o = parsed.value;
    return queue.run(o.sessionID, async (): Promise<SubmitOutcome> => {
      const key = receiptKey(o);
      const existing = await load(key);
      if (existing._tag === "err") {
        return { _tag: "error", reason: existing.error._tag === "storage" ? "storage" : "corrupt-receipt", detail: existing.error.detail };
      }
      const decision = observe(existing.value, o, mint, now());
      if (decision._tag === "mismatch") {
        diagnostic("observation text differs from receipt; refused", { id: decision.receipt.id, sessionID: o.sessionID, agentId: o.agentId, runId: o.runId });
        return { _tag: "refused", reason: "payload-mismatch", receipt: view(decision.receipt) };
      }
      try {
        if (decision._tag === "create") await save(decision.receipt);
        const final = decision.receipt.state === "observed" ? await dispatch(decision.receipt) : decision.receipt;
        return { _tag: "receipt", created: decision._tag === "create", receipt: view(final) };
      } catch (cause) {
        return { _tag: "error", reason: "storage", detail: errorText(cause) };
      }
    });
  }

  /** `session.inbox.delivered`: the host promoted this inbox ID. Never admits anything. */
  function delivered(sessionID: string, inboxID: string): Promise<void> {
    seenDelivered.add(deliveredKey(sessionID, inboxID));
    return queue.run(sessionID, async () => {
      // Discarded by dispatch, or already durably recorded.
      if (!seenDelivered.has(deliveredKey(sessionID, inboxID))) return;
      const key = byId.get(inboxID);
      if (key === undefined) return;
      const loaded = await load(key);
      if (loaded._tag === "err") {
        if (loaded.error._tag === "storage") throw new Error(`receipt storage read failed: ${loaded.error.detail}`);
        return;
      }
      if (loaded.value === undefined || loaded.value.sessionID !== sessionID) return;
      // Definitely unattempted: the event cannot describe a row we never sent.
      if (loaded.value.state === "observed") return;
      const next = deliveryFromEvent(loaded.value);
      if (next !== loaded.value) await save(next);
      else seenDelivered.delete(deliveredKey(sessionID, inboxID));
    });
  }

  async function scanAll(prefix = RECEIPT_PREFIX): Promise<{ receipts: Receipt[]; corrupt: ParseError[] }> {
    const receipts: Receipt[] = [];
    const corrupt: ParseError[] = [];
    let after: string | undefined;
    do {
      const page = await store.scan(prefix, after);
      for (const entry of page.entries) {
        const parsed = parseReceipt(entry.key, entry.value);
        if (parsed._tag === "ok") {
          receipts.push(parsed.value);
          byId.set(parsed.value.id, entry.key);
        } else {
          corrupt.push(parsed.error);
          diagnostic("corrupt receipt; not dispatched", { key: entry.key, detail: parsed.error.detail });
        }
      }
      after = page.next;
    } while (after !== undefined);
    return { receipts, corrupt };
  }

  /**
   * Startup recovery over receipts this package persisted. Never lists, polls or adopts remote
   * agents. `dispatching` becomes a held diagnostic unless host evidence shows promotion;
   * only `observed` receipts are dispatched.
   */
  async function recover(): Promise<RecoveryReport> {
    // The scan only discovers keys. Each receipt is re-read inside its session queue, so a write
    // that landed after the scan (a submit, an event, a reconcile) is never overwritten.
    const { receipts: found, corrupt } = await scanAll();
    const failed: { key: string; detail: string }[] = [];
    let loaded = 0;
    let dispatched = 0;
    let heldUncertain = 0;
    await Promise.all(
      found.map((f) =>
        queue.run(f.sessionID, async () => {
          const key = receiptKey(f);
          try {
            const current = await load(key);
            if (current._tag === "err") {
              if (current.error._tag === "storage") failed.push({ key, detail: current.error.detail });
              else corrupt.push(current.error);
              return;
            }
            const stored = current.value;
            if (stored === undefined) return;
            loaded++;
            let r = stored.state === "dispatching" ? recoverInterrupted(stored, now()) : stored;
            if (r.state === "observed") {
              const out = await dispatch(r);
              if (out.state !== "observed") dispatched++;
              return;
            }
            if (r.state !== "delivered") r = await reconcile(r);
            if (r.state === "held" && r.hold.reason === "uncertain-attempt") heldUncertain++;
            if (r !== stored) await save(r);
          } catch (cause) {
            failed.push({ key, detail: errorText(cause) });
            diagnostic("receipt recovery failed; not dispatched", { key, detail: errorText(cause) });
          }
        }),
      ),
    );
    return { loaded, corrupt, dispatched, heldUncertain, failed };
  }

  /** Re-checks host history for one session's non-delivered receipts. Never admits. */
  async function reconcileSession(sessionID: string): Promise<readonly ReceiptView[]> {
    // Discovery only; the current record is re-read inside the queue before any transition.
    const { receipts: found } = await scanAll(sessionPrefix(sessionID));
    return queue.run(sessionID, async () => {
      const out: ReceiptView[] = [];
      for (const f of found) {
        const current = await load(receiptKey(f));
        // Corrupt records were reported by `load` and are skipped; unreadable storage fails the call.
        if (current._tag === "err") {
          if (current.error._tag === "storage") throw new Error(`receipt storage read failed: ${current.error.detail}`);
          continue;
        }
        const stored = current.value;
        if (stored === undefined) continue;
        const r = stored.state === "delivered" || stored.state === "observed" ? stored : await reconcile(stored);
        if (r !== stored) await save(r);
        out.push(view(r));
      }
      return out;
    });
  }

  async function list(): Promise<{ receipts: readonly ReceiptView[]; corrupt: readonly ParseError[] }> {
    const { receipts, corrupt } = await scanAll();
    return { receipts: receipts.map(view), corrupt };
  }

  return { submit, delivered, recover, reconcileSession, list };
}

export type ReceiptService = ReturnType<typeof createReceiptService>;
