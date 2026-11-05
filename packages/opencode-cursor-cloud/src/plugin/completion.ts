// Completion receipts on a public `@opencode/plugin` backend context (2.0.0 to 2.x).
// Structural on purpose: this module imports no host code. `test/types` proves both host
// context types satisfy `CompletionContext`. No `@cursor/sdk`, no SDK provider coupling.
import { messageIdFactory } from "../core/message-id.js";
import type { AdmitFailure } from "../core/receipt.js";
import { createReceiptService, type LookupFailure, type ReceiptHost, type ReceiptService, type ReceiptStore } from "../core/receipts.js";
import { err, ok } from "../core/result.js";

/** The public context members receipts use: storage, session and event. */
export interface CompletionContext {
  readonly storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: never): Promise<void>;
    scan(options: { readonly prefix: string; readonly after?: string }): Promise<{
      readonly entries: readonly { readonly key: string; readonly value: unknown }[];
      readonly next?: string;
    }>;
  };
  readonly session: {
    synthetic(input: {
      readonly sessionID: string;
      readonly id: string;
      readonly text: string;
      readonly metadata: Record<string, string>;
      readonly resume: boolean;
    }): Promise<unknown>;
    context(input: { readonly sessionID: string }): Promise<readonly unknown[]>;
    get(input: { readonly sessionID: string }): Promise<unknown>;
  };
  readonly event: {
    subscribe(options?: { readonly signal?: AbortSignal }): AsyncIterable<unknown>;
  };
}

export interface CompletionReceiptsOptions {
  readonly diagnostic?: (message: string, detail: Record<string, unknown>) => void;
  /** Test seam for deterministic IDs and clocks. Production uses the host-identical generator. */
  readonly mint?: () => string;
  readonly now?: () => number;
}

/** Collects error tags and messages through causes; host errors cross the promise boundary in several shapes. */
function describeError(cause: unknown, depth = 0): string {
  if (depth > 4 || cause === undefined || cause === null) return "";
  if (typeof cause !== "object") return String(cause);
  const c = cause as Record<string, unknown>;
  const parts = [c._tag, c.name, c.message, c.type].filter((p): p is string => typeof p === "string");
  return [...parts, describeError(c.cause, depth + 1), describeError(c.error, depth + 1)].filter(Boolean).join(" | ");
}

export function classifyAdmitFailure(cause: unknown): AdmitFailure {
  const detail = describeError(cause).slice(0, 300) || "unknown error";
  if (/SyntheticConflictError|LifecycleConflict/.test(detail)) return { _tag: "conflict", detail };
  if (/Session\.NotFoundError|\bNotFoundError\b/.test(detail)) return { _tag: "session-not-found", detail };
  return { _tag: "unknown", detail };
}

function classifyLookupFailure(cause: unknown): LookupFailure {
  const detail = describeError(cause).slice(0, 300) || "unknown error";
  return { _tag: /Session\.NotFoundError|\bNotFoundError\b/.test(detail) ? "session-not-found" : "unknown", detail };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function storageStore(storage: CompletionContext["storage"]): ReceiptStore {
  return {
    get: (key) => storage.get(key),
    // SAFETY: receipts are plain JSON objects built by `toJson`; the host types this as Schema.Json.
    set: (key, value) => storage.set(key, value as never),
    scan: (prefix, after) => storage.scan(after === undefined ? { prefix } : { prefix, after }),
  };
}

export function sessionHost(session: CompletionContext["session"]): ReceiptHost {
  return {
    admit: async (input) => {
      try {
        return ok(await session.synthetic(input));
      } catch (cause) {
        return err(classifyAdmitFailure(cause));
      }
    },
    promoted: async (sessionID) => {
      try {
        const rows = await session.context({ sessionID });
        const out = new Map<string, { text: string }>();
        for (const row of rows) {
          if (isRecord(row) && row.type === "synthetic" && typeof row.id === "string" && typeof row.text === "string") out.set(row.id, { text: row.text });
        }
        return ok(out);
      } catch (cause) {
        return err(classifyLookupFailure(cause));
      }
    },
    session: async (sessionID) => {
      try {
        const info = await session.get({ sessionID });
        return ok({ reverted: isRecord(info) && info.revert !== undefined && info.revert !== null });
      } catch (cause) {
        return err(classifyLookupFailure(cause));
      }
    },
  };
}

/** `session.inbox.delivered` payload, or undefined for any other event. */
export function parseDelivered(event: unknown): { sessionID: string; inboxID: string } | undefined {
  if (!isRecord(event) || event.type !== "session.inbox.delivered" || !isRecord(event.data)) return undefined;
  const { sessionID, inboxID } = event.data;
  return typeof sessionID === "string" && typeof inboxID === "string" ? { sessionID, inboxID } : undefined;
}

export interface CompletionReceipts {
  readonly service: ReceiptService;
  /** Resolves once the delivered-event subscription is open. */
  readonly ready: Promise<void>;
  readonly dispose: () => void;
}

/**
 * Wires receipts to the public context. Subscribes to `session.inbox.delivered` (filtered
 * client-side; 2.0.0 has no type filter). Recovery is explicit: call `service.recover()`.
 */
export function attachCompletionReceipts(context: CompletionContext, options: CompletionReceiptsOptions = {}): CompletionReceipts {
  const service = createReceiptService({
    store: storageStore(context.storage),
    host: sessionHost(context.session),
    mint: options.mint ?? messageIdFactory(),
    ...(options.now ? { now: options.now } : {}),
    ...(options.diagnostic ? { diagnostic: options.diagnostic } : {}),
  });
  const controller = new AbortController();
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => (markReady = resolve));
  void (async () => {
    try {
      const stream = context.event.subscribe({ signal: controller.signal });
      const iterator = stream[Symbol.asyncIterator]();
      markReady();
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        const delivered = parseDelivered(next.value);
        if (delivered) await service.delivered(delivered.sessionID, delivered.inboxID).catch((cause: unknown) => {
          options.diagnostic?.("delivered-event receipt update failed; persistence can be retried", { sessionID: delivered.sessionID, inboxID: delivered.inboxID, detail: describeError(cause).slice(0, 300) });
        });
      }
    } catch (cause) {
      if (!controller.signal.aborted) options.diagnostic?.("delivered-event subscription ended", { detail: describeError(cause).slice(0, 300) });
    } finally {
      markReady();
    }
  })();
  return { service, ready, dispose: () => controller.abort() };
}
