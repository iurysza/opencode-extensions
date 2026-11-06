import { err, ok, type Result } from "../core/result.js";

/** Fixed refusal messages (plan: "Fail closed at load"). */
export const RefusalMessage = {
  "unsupported-version":
    "Cursor SDK plugin disabled: OpenCode 2.x is required (supported: >=2.0.0 <3).",
  "missing-registration":
    "Cursor SDK plugin disabled: this OpenCode host has neither provider nor catalog registration.",
  "missing-aisdk": "Cursor SDK plugin disabled: this OpenCode host has no aisdk hook.",
  "missing-session-synthetic": "Cursor SDK plugin disabled: this OpenCode host has no session.synthetic.",
  "missing-session-hook": "Cursor SDK plugin disabled: this OpenCode host has no session.hook.",
  "missing-rpc": "Cursor SDK plugin disabled: this OpenCode host has no rpc.register.",
} as const;

export type RefusalReason = keyof typeof RefusalMessage;

export interface HostRefusal {
  readonly reason: RefusalReason;
  readonly message: string;
}

/** Provider registration path, detected by feature, not version (boundary 2.0.4). */
export type RegistrationApi =
  | { readonly _tag: "provider"; readonly transform: (callback: (editor: unknown) => void) => Promise<unknown>; readonly reload?: () => Promise<void> }
  | { readonly _tag: "catalog"; readonly transform: (callback: (editor: unknown) => void) => Promise<unknown>; readonly reload?: () => Promise<void> };

export type AisdkHook = (
  name: "sdk" | "language",
  callback: (event: Record<string, unknown>) => void | Promise<void>,
  options?: { readonly providerID?: string },
) => Promise<unknown>;

/** Public `session.hook`, used only for `model.request` (F-14). */
export type SessionHook = (
  name: "model.request",
  callback: (event: Record<string, unknown>) => void | Promise<void>,
  options?: { readonly providerID?: string },
) => Promise<unknown>;

export interface HostCapabilities {
  readonly version: string;
  readonly registration: RegistrationApi;
  readonly aisdkHook: AisdkHook;
  readonly sessionHook: SessionHook;
  /** Set when OpenCode runs in a remote workspace; the Cursor provider refuses then (F-60). */
  readonly workspaceID: string | undefined;
}

const refuse = (reason: RefusalReason): Result<never, HostRefusal> => err({ reason, message: RefusalMessage[reason] });

/** Host domains may be callables with members (2.x `rpc` is `client(definition)` plus `register`). */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  (typeof value === "object" && value !== null) || typeof value === "function";
const fn = (value: unknown): value is (...args: never[]) => unknown => typeof value === "function";
const prop = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

/**
 * Public `event.subscribe`, read structurally: 2.0.0 has no `types` filter option, 2.2.5 does.
 * Runs until `signal` aborts. Returns false when the host has no event domain.
 */
export function subscribeEvents(context: unknown, types: readonly string[], signal: AbortSignal, onEvent: (event: Record<string, unknown>) => void): boolean {
  const domain = prop(context, "event");
  const subscribe = prop(domain, "subscribe");
  if (!fn(subscribe)) return false;
  void (async () => {
    try {
      const stream = (subscribe as (options: unknown) => AsyncIterable<unknown>).call(domain, { types, signal });
      for await (const event of stream) {
        if (signal.aborted) return;
        const type = prop(event, "type");
        if (typeof type === "string" && types.includes(type)) onEvent(event as Record<string, unknown>);
      }
    } catch { /* Event loss only delays discovery until the next refresh or restart. */ }
  })();
  return true;
}

/** Major version of a host version string such as `2.0.0` or `2.2.5-beta.1`. */
export function hostMajor(version: string): number | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? Number(match[1]) : undefined;
}

/**
 * Parses an untrusted plugin setup context into the capabilities this package uses.
 * Refuses hosts outside 2.x and hosts missing a required public API.
 */
export function parseHost(context: unknown): Result<HostCapabilities, HostRefusal> {
  const version = prop(prop(context, "app"), "version");
  if (typeof version !== "string" || hostMajor(version) !== 2) return refuse("unsupported-version");

  const providerTransform = prop(prop(context, "provider"), "transform");
  const catalogTransform = prop(prop(context, "catalog"), "transform");
  // Public `provider.reload` / `catalog.reload` re-run every registered transform (replaces our model list).
  const reloadOf = (domain: string) => {
    const owner = prop(context, domain);
    const reload = prop(owner, "reload");
    return fn(reload) ? { reload: () => (reload as () => Promise<void>).call(owner) } : {};
  };
  const registration: RegistrationApi | undefined = fn(providerTransform)
    ? { _tag: "provider", transform: providerTransform as RegistrationApi["transform"], ...reloadOf("provider") }
    : fn(catalogTransform)
      ? { _tag: "catalog", transform: catalogTransform as RegistrationApi["transform"], ...reloadOf("catalog") }
      : undefined;
  if (!registration) return refuse("missing-registration");

  const hook = prop(prop(context, "aisdk"), "hook");
  if (!fn(hook)) return refuse("missing-aisdk");
  if (!fn(prop(prop(context, "session"), "synthetic"))) return refuse("missing-session-synthetic");
  const sessionHook = prop(prop(context, "session"), "hook");
  if (!fn(sessionHook)) return refuse("missing-session-hook");
  if (!fn(prop(prop(context, "rpc"), "register"))) return refuse("missing-rpc");

  const workspaceID = prop(prop(context, "location"), "workspaceID");
  return ok({
    version,
    registration,
    aisdkHook: hook as AisdkHook,
    sessionHook: sessionHook as SessionHook,
    workspaceID: typeof workspaceID === "string" && workspaceID.length > 0 ? workspaceID : undefined,
  });
}
