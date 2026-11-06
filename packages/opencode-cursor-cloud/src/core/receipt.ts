// Completion receipt: pure record, parser and transitions (F-30, F-31, F-58). No I/O, no host
// imports. The service in `receipts.ts` is the imperative shell around these functions.
//
// State: observed -> dispatching -> admitted -> delivered, plus `held` for diagnostics that are
// never retried blindly. Admission and delivery are recorded separately. Answer status is not
// stored: it is always `unknown`, because 2.x offers no direct evidence (F-58).
import { createHash } from "node:crypto";
import { isMintedMessageId } from "./message-id.js";
import { err, ok, type Result } from "./result.js";

export const RECEIPT_VERSION = 1;

/** What the host is expected to do after admission. The host decides; we record what we asked. */
export type Wake = "requested" | "suppressed" | "skipped-reverted";

export type HoldReason =
  /** Intent persisted, then no host evidence of admission. Never replayed. */
  | "uncertain-attempt"
  /** The host holds a row with our ID but different text, or the observation text changed. */
  | "payload-mismatch"
  /** The host refused our ID for this session (another session or type owns it). */
  | "host-conflict"
  /** The originating session no longer exists. Fails closed. */
  | "session-deleted"
  /** The host returned a row whose identity does not match the receipt. */
  | "invalid-host-response";

export type DeliveryEvidence = "event" | "context";

export interface Admission {
  readonly at: number;
  readonly wake: Wake;
}
export interface Delivery {
  readonly at: number;
  readonly via: DeliveryEvidence;
}
export interface Hold {
  readonly at: number;
  readonly reason: HoldReason;
  readonly detail: string;
}

interface Base {
  readonly v: typeof RECEIPT_VERSION;
  /** Host-valid `msg_` ID, minted once. Never derived from agent or run IDs. */
  readonly id: string;
  readonly sessionID: string;
  readonly agentId: string;
  readonly runId: string;
  readonly text: string;
  /** SHA-256 hex of `text`. Our check: the host does not compare text. */
  readonly textHash: string;
  readonly resume: boolean;
  readonly createdAt: number;
}

export type Receipt =
  | (Base & { readonly state: "observed" })
  | (Base & { readonly state: "dispatching"; readonly intentAt: number })
  | (Base & { readonly state: "admitted"; readonly intentAt: number; readonly admission: Admission })
  | (Base & { readonly state: "delivered"; readonly admission: Admission | null; readonly delivery: Delivery })
  | (Base & { readonly state: "held"; readonly admission: Admission | null; readonly hold: Hold });

export type ReceiptState = Receipt["state"];

export interface Observation {
  readonly sessionID: string;
  readonly agentId: string;
  readonly runId: string;
  readonly text: string;
  /** `false` admits without waking the session. Persisted so a later attempt cannot differ. */
  readonly resume?: boolean;
}

export const hashText = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Storage key: one receipt per observed completion, session, agent and run. */
export const receiptKey = (o: Pick<Observation, "sessionID" | "agentId" | "runId">): string =>
  `${sessionPrefix(o.sessionID)}${encodeURIComponent(o.agentId)}/${encodeURIComponent(o.runId)}`;
export const sessionPrefix = (sessionID: string): string => `receipt/${encodeURIComponent(sessionID)}/`;
export const RECEIPT_PREFIX = "receipt/";

export type ObserveDecision =
  | { readonly _tag: "create"; readonly receipt: Receipt }
  | { readonly _tag: "duplicate"; readonly receipt: Receipt }
  | { readonly _tag: "mismatch"; readonly receipt: Receipt };

export type ObservationError = { readonly _tag: "invalid-observation"; readonly detail: string };

export function parseObservation(input: unknown): Result<Observation, ObservationError> {
  if (typeof input !== "object" || input === null) return err({ _tag: "invalid-observation", detail: "not an object" });
  const o = input as Record<string, unknown>;
  for (const field of ["sessionID", "agentId", "runId", "text"] as const) {
    if (typeof o[field] !== "string" || o[field] === "") return err({ _tag: "invalid-observation", detail: `${field} must be a non-empty string` });
  }
  if (o.resume !== undefined && typeof o.resume !== "boolean") return err({ _tag: "invalid-observation", detail: "resume must be boolean" });
  return ok({
    sessionID: o.sessionID as string,
    agentId: o.agentId as string,
    runId: o.runId as string,
    text: o.text as string,
    ...(o.resume === undefined ? {} : { resume: o.resume as boolean }),
  });
}

/** Creates a receipt once. A repeat with the same text is a duplicate; changed text is refused. */
export function observe(existing: Receipt | undefined, o: Observation, mint: () => string, now: number): ObserveDecision {
  if (existing !== undefined) {
    return { _tag: existing.textHash === hashText(o.text) ? "duplicate" : "mismatch", receipt: existing };
  }
  return {
    _tag: "create",
    receipt: {
      v: RECEIPT_VERSION,
      id: mint(),
      sessionID: o.sessionID,
      agentId: o.agentId,
      runId: o.runId,
      text: o.text,
      textHash: hashText(o.text),
      resume: o.resume ?? true,
      createdAt: now,
      state: "observed",
    },
  };
}

const base = (r: Receipt): Base => ({
  v: r.v,
  id: r.id,
  sessionID: r.sessionID,
  agentId: r.agentId,
  runId: r.runId,
  text: r.text,
  textHash: r.textHash,
  resume: r.resume,
  createdAt: r.createdAt,
});
const admissionOf = (r: Receipt): Admission | null => ("admission" in r ? r.admission : null);

/** Only a definitely unattempted receipt may be dispatched. */
export function beginAttempt(r: Receipt, now: number): Result<Receipt, { readonly _tag: "not-dispatchable"; readonly state: ReceiptState }> {
  if (r.state !== "observed") return err({ _tag: "not-dispatchable", state: r.state });
  return ok({ ...base(r), state: "dispatching", intentAt: now });
}

/** Delivery evidence wins over attempted non-terminal states. Local delivered state never regresses. */
export function markDelivered(r: Receipt, via: DeliveryEvidence, now: number): Receipt {
  if (r.state === "delivered") return r;
  // An event names only an ID, not text. It counts only once the host's admission response
  // was validated against this receipt (identity and text). A matching history row
  // (`context`, text checked by `reconcilePromoted`) is accepted from any non-terminal state.
  if (via === "event" && admissionOf(r) === null) return r;
  if (r.state === "held" && r.hold.reason !== "uncertain-attempt") return r;
  return { ...base(r), state: "delivered", admission: admissionOf(r), delivery: { at: now, via } };
}

export function hold(r: Receipt, reason: HoldReason, detail: string, now: number): Receipt {
  if (r.state === "delivered") return r;
  if (r.state === "held" && r.hold.reason !== "uncertain-attempt") return r;
  return { ...base(r), state: "held", admission: admissionOf(r), hold: { at: now, reason, detail } };
}

/** Promoted row visible in public session history. Text must match, because the host ignores it. */
export function reconcilePromoted(r: Receipt, row: { readonly text: string } | undefined, now: number): Receipt {
  if (row === undefined) return r;
  if (hashText(row.text) !== r.textHash) return hold(r, "payload-mismatch", "host history row with this ID has different text", now);
  return markDelivered(r, "context", now);
}

/** After restart: an intent with no host evidence stays a diagnostic. Never replayed. */
export function recoverInterrupted(r: Receipt, now: number): Receipt {
  if (r.state !== "dispatching") return r;
  return hold(r, "uncertain-attempt", "process stopped after the dispatch intent; no host evidence of admission", now);
}

/** Minimal `SessionInbox.Synthetic` fields we validate. */
export interface AdmittedRow {
  readonly id: string;
  readonly sessionID: string;
  readonly text: string;
}

export function parseAdmittedRow(value: unknown): Result<AdmittedRow, string> {
  if (typeof value !== "object" || value === null) return err("response is not an object");
  const v = value as Record<string, unknown>;
  const payload = v.payload as Record<string, unknown> | undefined;
  if (typeof v.id !== "string" || typeof v.sessionID !== "string") return err("response lacks id or sessionID");
  if (v.type !== "synthetic") return err(`response type is ${JSON.stringify(v.type)}, not synthetic`);
  if (typeof payload !== "object" || payload === null || typeof payload.text !== "string") return err("response lacks payload.text");
  return ok({ id: v.id, sessionID: v.sessionID, text: payload.text });
}

/** Applies a host admission to the current stored receipt. A promotion that raced ahead wins. */
export function applyAdmission(current: Receipt, response: unknown, wake: Wake, now: number): Receipt {
  const row = parseAdmittedRow(response);
  if (row._tag === "err") return hold(current, "invalid-host-response", row.error, now);
  if (row.value.id !== current.id || row.value.sessionID !== current.sessionID) {
    return hold(current, "invalid-host-response", "host returned a different message or session ID", now);
  }
  if (hashText(row.value.text) !== current.textHash) {
    return hold(current, "payload-mismatch", "host already holds this ID with different text", now);
  }
  const admission: Admission = { at: now, wake };
  if (current.state === "dispatching") return { ...base(current), state: "admitted", intentAt: current.intentAt, admission };
  if (current.state === "delivered") return current.admission ? current : { ...current, admission };
  if (current.state === "held" && current.hold.reason === "uncertain-attempt") return { ...current, admission };
  return current;
}

export type AdmitFailure =
  | { readonly _tag: "conflict"; readonly detail: string }
  | { readonly _tag: "session-not-found"; readonly detail: string }
  | { readonly _tag: "unknown"; readonly detail: string };

/** A failed host call. Only a classified refusal is definite; anything else stays uncertain. */
export function applyAdmitFailure(current: Receipt, failure: AdmitFailure, now: number): Receipt {
  if (failure._tag === "conflict") return hold(current, "host-conflict", failure.detail, now);
  if (failure._tag === "session-not-found") return hold(current, "session-deleted", failure.detail, now);
  return hold(current, "uncertain-attempt", `host call failed: ${failure.detail}`, now);
}

export type ParseError = { readonly _tag: "corrupt-receipt"; readonly key: string; readonly detail: string };

const str = (v: unknown): v is string => typeof v === "string" && v !== "";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const WAKES: readonly string[] = ["requested", "suppressed", "skipped-reverted"];
const REASONS: readonly string[] = ["uncertain-attempt", "payload-mismatch", "host-conflict", "session-deleted", "invalid-host-response"];
const parseAdmission = (v: unknown): Admission | undefined => {
  const a = v as Record<string, unknown> | null;
  return a && num(a.at) && typeof a.wake === "string" && WAKES.includes(a.wake) ? { at: a.at, wake: a.wake as Wake } : undefined;
};

/** Validates a stored record. Corrupt or tampered records are reported, never dispatched. */
export function parseReceipt(key: string, value: unknown): Result<Receipt, ParseError> {
  const fail = (detail: string) => err({ _tag: "corrupt-receipt" as const, key, detail });
  if (typeof value !== "object" || value === null) return fail("not an object");
  const v = value as Record<string, unknown>;
  if (v.v !== RECEIPT_VERSION) return fail(`unsupported version ${JSON.stringify(v.v)}`);
  if (!isMintedMessageId(v.id)) return fail("id is not a minted msg_ ID");
  if (!str(v.sessionID) || !str(v.agentId) || !str(v.runId) || typeof v.text !== "string") return fail("missing identity or text");
  if (typeof v.textHash !== "string" || v.textHash !== hashText(v.text)) return fail("text hash mismatch");
  if (typeof v.resume !== "boolean" || !num(v.createdAt)) return fail("missing resume or createdAt");
  if (key !== receiptKey({ sessionID: v.sessionID, agentId: v.agentId, runId: v.runId })) return fail("key does not match receipt identity");
  const b: Base = {
    v: RECEIPT_VERSION,
    id: v.id,
    sessionID: v.sessionID,
    agentId: v.agentId,
    runId: v.runId,
    text: v.text,
    textHash: v.textHash,
    resume: v.resume,
    createdAt: v.createdAt,
  };
  const admission = v.admission === null || v.admission === undefined ? null : parseAdmission(v.admission);
  if (admission === undefined) return fail("invalid admission");
  switch (v.state) {
    case "observed":
      return ok({ ...b, state: "observed" });
    case "dispatching":
      return num(v.intentAt) ? ok({ ...b, state: "dispatching", intentAt: v.intentAt }) : fail("missing intentAt");
    case "admitted":
      return num(v.intentAt) && admission ? ok({ ...b, state: "admitted", intentAt: v.intentAt, admission }) : fail("admitted needs intentAt and admission");
    case "delivered": {
      const d = v.delivery as Record<string, unknown> | null;
      if (!d || !num(d.at) || (d.via !== "event" && d.via !== "context")) return fail("invalid delivery");
      return ok({ ...b, state: "delivered", admission, delivery: { at: d.at, via: d.via } });
    }
    case "held": {
      const h = v.hold as Record<string, unknown> | null;
      if (!h || !num(h.at) || typeof h.reason !== "string" || !REASONS.includes(h.reason) || typeof h.detail !== "string") return fail("invalid hold");
      return ok({ ...b, state: "held", admission, hold: { at: h.at, reason: h.reason as HoldReason, detail: h.detail } });
    }
    default:
      return fail(`unknown state ${JSON.stringify(v.state)}`);
  }
}

/** JSON form for storage. */
export const toJson = (r: Receipt): Record<string, unknown> => ({ ...r });

export interface ReceiptView {
  readonly id: string;
  readonly sessionID: string;
  readonly agentId: string;
  readonly runId: string;
  readonly state: ReceiptState;
  readonly admission: Admission | null;
  readonly delivery: Delivery | null;
  readonly hold: Hold | null;
  /** Always `unknown`: 2.x has no direct evidence that a reply answered this input (F-58). */
  readonly answer: "unknown";
}

export const view = (r: Receipt): ReceiptView => ({
  id: r.id,
  sessionID: r.sessionID,
  agentId: r.agentId,
  runId: r.runId,
  state: r.state,
  admission: admissionOf(r),
  delivery: r.state === "delivered" ? r.delivery : null,
  hold: r.state === "held" ? r.hold : null,
  answer: "unknown",
});
