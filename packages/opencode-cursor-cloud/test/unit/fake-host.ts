// Test-only model of the source-read host rules (session.ts / inbox.ts at v2.0.0 and v2.2.5):
// admission matches on ID, session and type, ignores text, conflicts across sessions, and
// wakes unless resume:false or reverted. Unit tests only; real-host proof is in test/t1.
import type { ReceiptStore } from "../../src/core/receipts.js";
import type { CompletionContext } from "../../src/plugin/completion.js";

export function memoryStore() {
  const data = new Map<string, unknown>();
  let failSet: ((key: string, value: Record<string, unknown>) => boolean) | undefined;
  const store: ReceiptStore = {
    get: async (key) => structuredClone(data.get(key)),
    set: async (key, value) => {
      if (failSet?.(key, value)) throw new Error("storage set failed");
      data.set(key, structuredClone(value));
    },
    scan: async (prefix, after) => ({
      entries: [...data.keys()]
        .sort()
        .filter((k) => k.startsWith(prefix) && (after === undefined || k > after))
        .map((key) => ({ key, value: structuredClone(data.get(key)) })),
    }),
  };
  return { store, data, failSetWhen: (f: typeof failSet) => (failSet = f) };
}

type Row = { id: string; sessionID: string; text: string; promoted: boolean };

export function fakeHost() {
  const rows = new Map<string, Row>();
  const sessions = new Map<string, { reverted: boolean }>();
  const wakes: string[] = [];
  const calls: { id: string; sessionID: string; text: string; resume: boolean }[] = [];
  const listeners = new Set<(event: unknown) => void>();
  let beforeReturn: ((row: Row) => void) | undefined;
  let throwAfterAdmit = false;
  const emit = (event: unknown) => listeners.forEach((l) => l(event));
  const notFound = (sessionID: string) => Object.assign(new Error(`Session not found: ${sessionID}`), { _tag: "Session.NotFoundError" });

  const promote = (id: string) => {
    const row = rows.get(id);
    if (!row || row.promoted) return;
    row.promoted = true;
    emit({ type: "session.inbox.delivered", data: { sessionID: row.sessionID, inboxID: id } });
  };

  const session: CompletionContext["session"] = {
    synthetic: async (input) => {
      calls.push({ id: input.id, sessionID: input.sessionID, text: input.text, resume: input.resume });
      const s = sessions.get(input.sessionID);
      if (!s) throw notFound(input.sessionID);
      let row = rows.get(input.id);
      if (row && row.sessionID !== input.sessionID) {
        throw Object.assign(new Error("conflict"), { _tag: "Session.SyntheticConflictError" });
      }
      if (!row) {
        row = { id: input.id, sessionID: input.sessionID, text: input.text, promoted: false };
        rows.set(input.id, row);
      }
      if (input.resume !== false && !s.reverted) wakes.push(input.id);
      beforeReturn?.(row);
      if (throwAfterAdmit) throw new Error("connection reset");
      return { id: row.id, sessionID: row.sessionID, type: "synthetic", payload: { text: row.text }, delivery: "steer", time: { created: 1 } };
    },
    context: async ({ sessionID }) => {
      if (!sessions.has(sessionID)) throw notFound(sessionID);
      return [...rows.values()].filter((r) => r.sessionID === sessionID && r.promoted).map((r) => ({ id: r.id, type: "synthetic", text: r.text, time: { created: 1 } }));
    },
    get: async ({ sessionID }) => {
      const s = sessions.get(sessionID);
      if (!s) throw notFound(sessionID);
      return { id: sessionID, ...(s.reverted ? { revert: { messageID: "msg_x" } } : {}) };
    },
  };

  const event: CompletionContext["event"] = {
    subscribe: () => ({
      [Symbol.asyncIterator]() {
        const queue: unknown[] = [];
        let wake: (() => void) | undefined;
        const listener = (e: unknown) => {
          queue.push(e);
          wake?.();
        };
        listeners.add(listener);
        return {
          async next() {
            while (queue.length === 0) await new Promise<void>((r) => (wake = r));
            return { done: false, value: queue.shift() };
          },
          async return() {
            listeners.delete(listener);
            return { done: true, value: undefined };
          },
        };
      },
    }),
  };

  return {
    session,
    event,
    rows,
    sessions,
    wakes,
    calls,
    promote,
    emit,
    addSession: (id: string, reverted = false) => sessions.set(id, { reverted }),
    /** Injects a raw row, as if another caller had used this ID. */
    rawRow: (id: string, sessionID: string, text: string, promoted = false) => rows.set(id, { id, sessionID, text, promoted }),
    onBeforeReturn: (f: typeof beforeReturn) => (beforeReturn = f),
    setThrowAfterAdmit: (v: boolean) => (throwAfterAdmit = v),
  };
}

export function ids() {
  let n = 0;
  return () => `msg_${(++n).toString(16).padStart(12, "0")}AAAAAAAAAAAAAA`;
}
