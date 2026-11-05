import { err, ok, type Result } from "./result.js";

/**
 * Why a request reaches the provider. Mirrors the public OpenCode 2.x `SessionRequestKind`.
 * Only `primary` is a coding turn. The others are helper requests (F-14, F-16).
 */
export const REQUEST_KINDS = ["primary", "title", "compaction", "generate"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];
export type HelperKind = Exclude<RequestKind, "primary">;

export interface ModelIdentity {
  readonly providerID: string;
  readonly id: string;
  readonly variant?: string;
}

/** Purpose and session identity of one provider request, taken from our private stamp only. */
export interface RequestContext {
  readonly kind: RequestKind;
  readonly sessionID: string;
  readonly agent: string;
  readonly model: ModelIdentity;
}

export type RequestContextFailure = "malformed" | "unknown-kind";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isKind = (value: unknown): value is RequestKind => (REQUEST_KINDS as readonly unknown[]).includes(value);

/** Parses an untrusted `{ kind, sessionID, agent, model }` value. Never guesses a missing kind. */
export function parseRequestContext(value: unknown): Result<RequestContext, RequestContextFailure> {
  if (!isRecord(value)) return err("malformed");
  const { kind, sessionID, agent, model } = value;
  if (!nonEmpty(sessionID) || !nonEmpty(agent) || !isRecord(model)) return err("malformed");
  if (!nonEmpty(model.providerID) || !nonEmpty(model.id)) return err("malformed");
  if (model.variant !== undefined && typeof model.variant !== "string") return err("malformed");
  if (!isKind(kind)) return err(kind === undefined ? "malformed" : "unknown-kind");
  return ok({
    kind,
    sessionID,
    agent,
    model: { providerID: model.providerID, id: model.id, ...(model.variant ? { variant: model.variant } : {}) },
  });
}
