import { parseRequestContext, type RequestContext } from "../core/request-context.js";
import { err, type Result } from "../core/result.js";

/**
 * Private header carrying our request stamp from the public `session.hook("model.request")`
 * to `LanguageModelV3.doStream(options.headers)` (F-14). The provider reads only this header,
 * never host headers such as `X-Session-Id`.
 */
export const STAMP_HEADER = "x-iurysza-cursor-request";
const STAMP_VERSION = 1;

export type StampFailure = "missing" | "duplicate" | "malformed" | "unknown-kind";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const stampKeys = (headers: Record<string, unknown>) =>
  Object.keys(headers).filter((key) => key.toLowerCase() === STAMP_HEADER);

/**
 * `model.request` callback body. Only touches requests for `providerID`. Removes any existing
 * stamp (spoofed or stale) and writes a fresh one from the public event fields. If the event
 * fields do not parse, it writes nothing, so the provider rejects the request as unstamped.
 */
export function stampModelRequest(event: unknown, providerID: string): void {
  if (!isRecord(event) || !isRecord(event.model) || event.model.providerID !== providerID) return;
  const headers = event.headers;
  if (!isRecord(headers)) return;
  for (const key of stampKeys(headers)) delete headers[key];
  const context = parseRequestContext({ kind: event.kind, sessionID: event.sessionID, agent: event.agent, model: event.model });
  if (context._tag === "err") return;
  headers[STAMP_HEADER] = JSON.stringify({ v: STAMP_VERSION, ...context.value });
}

/** Reads the stamp from `doStream` headers. Header names compare case-insensitively. */
export function readRequestStamp(headers: unknown): Result<RequestContext, StampFailure> {
  if (!isRecord(headers)) return err("missing");
  const keys = stampKeys(headers);
  if (keys.length === 0) return err("missing");
  if (keys.length > 1) return err("duplicate");
  const raw = headers[keys[0] as string];
  if (typeof raw !== "string") return err("malformed");
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return err("malformed");
  }
  if (!isRecord(decoded) || decoded.v !== STAMP_VERSION) return err("malformed");
  return parseRequestContext(decoded);
}
