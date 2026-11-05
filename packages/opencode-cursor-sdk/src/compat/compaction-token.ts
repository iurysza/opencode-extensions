import { err, ok, type Result } from "../core/result.js";

/**
 * Durable observation token for a session's compaction state (G3 prerequisite for F-23).
 *
 * Input is the public `ctx.session.context({ sessionID })` output: `SessionMessage.Info[]`.
 * Both 2.0.0 and 2.2.5 schemas define compaction rows as `{ type: "compaction", status:
 * "running" | "completed" | "failed", id }`. The token is the message id of the newest
 * COMPLETED compaction row, in history order. Running or failed rows never advance it.
 * `none` means no completed compaction is visible.
 *
 * This is not a generation counter. A later session pool may bump its own persisted integer
 * generation only when this token changes. It is never derived from request counts, and never
 * from `metadata.keepID` or other stored metadata.
 */
export type CompactionToken = { readonly _tag: "none" } | { readonly _tag: "compaction"; readonly messageID: string };

export const NO_COMPACTION: CompactionToken = { _tag: "none" };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Parses untrusted host messages. Any compaction row without a string id is malformed. */
export function compactionToken(messages: unknown): Result<CompactionToken, "malformed"> {
  if (!Array.isArray(messages)) return err("malformed");
  let token: CompactionToken = NO_COMPACTION;
  for (const message of messages) {
    if (!isRecord(message)) return err("malformed");
    if (message.type !== "compaction") continue;
    if (typeof message.id !== "string" || message.id.length === 0) return err("malformed");
    if (message.status === "completed") token = { _tag: "compaction", messageID: message.id };
  }
  return ok(token);
}

export const sameCompactionToken = (a: CompactionToken, b: CompactionToken): boolean =>
  a._tag === b._tag && (a._tag === "none" || (b._tag === "compaction" && a.messageID === b.messageID));
