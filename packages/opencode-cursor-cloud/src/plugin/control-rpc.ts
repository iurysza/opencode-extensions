import type { Plugin } from "@opencode/plugin";
import { controls, parse, snapshotSchema, scopeSchema, type ControlActions, type ControlResult, type Inputs, type MethodName, type Scope, type SnapshotInput } from "../control-contract.js";

export type ControlContext = Pick<Plugin.Context, "rpc" | "location" | "session">;
const reads = new Set<MethodName>(["status", "models", "ledger"]);

/** Public session lookup, never a caller-supplied filesystem lookup or location override. */
async function verify(ctx: ControlContext, scope: Scope, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted || ctx.location.workspaceID || scope.location.workspaceID ||
      ctx.location.directory !== scope.location.directory) return false;
  try {
    const session = await ctx.session.get({ sessionID: scope.sessionID }, { signal });
    return session.id === scope.sessionID && session.location.directory === ctx.location.directory &&
      !("workspaceID" in session.location && session.location.workspaceID) && !signal.aborted;
  } catch { return false; }
}

/** Project only known fields. Raw service replies, errors, URLs, prompts and credentials never cross RPC. */
function project(value: SnapshotInput | void) {
  if (!value) return undefined;
  if (value.items && value.items.length > 100) throw new Error("Control snapshot exceeds limit");
  return parse(snapshotSchema, {
    state: value.state, runtime: value.runtime,
    items: value.items?.map(item => ({ id: item.id, state: item.state })),
    fast: value.fast, mode: value.mode, tools: value.tools, http: value.http,
    resumeCleanup: value.resumeCleanup,
  });
}

export async function registerControls(ctx: ControlContext, actions: ControlActions) {
  const lifetime = new AbortController();
  const run = async <K extends MethodName>(name: K, raw: Inputs[K], call: { signal: AbortSignal }): Promise<ControlResult> => {
    const signal = AbortSignal.any([call.signal, lifetime.signal]);
    let input: Inputs[K];
    try {
      // The registry validates too; this guards direct callers and test adapters.
      input = parse(controls.methods[name].input, raw) as Inputs[K];
    } catch { return { code: "invalid_input", snapshot: undefined }; }
    if (signal.aborted) return { code: "aborted", snapshot: undefined };
    if (!await verify(ctx, input.scope, signal)) return { code: signal.aborted ? "aborted" : "refused", snapshot: undefined };

    const action = actions[name];
    if (!action) return { code: "not_implemented", snapshot: undefined };
    try {
      // Use only the server-verified scope; actions must enforce resource ownership within it.
      const outcome = await action(input, signal);
      if (outcome && "refused" in outcome) return { code: outcome.refused === "scope" ? "refused" : "not_implemented", snapshot: undefined };
      const snapshot = project(outcome);
      if (signal.aborted) return { code: "aborted", snapshot: undefined };
      if (!reads.has(name)) await publish(input.scope).catch(() => {});
      return { code: "ok", snapshot };
    } catch { return { code: signal.aborted ? "aborted" : "failed", snapshot: undefined }; }
  };
  const registration = await ctx.rpc.register(controls, {
    status: (input, call) => run("status", input, call),
    models: (input, call) => run("models", input, call),
    ledger: (input, call) => run("ledger", input, call),
    spawn: (input, call) => run("spawn", input, call),
    followup: (input, call) => run("followup", input, call),
    cancel: (input, call) => run("cancel", input, call),
    delete: (input, call) => run("delete", input, call)
  });
  async function publish(raw: Scope): Promise<void> {
    const scope = parse(scopeSchema, raw);
    if (await verify(ctx, scope, lifetime.signal)) await registration.events.emit("status", { scope, state: "changed" });
  }
  return {
    publish,
    async dispose() { lifetime.abort(); await registration.dispose(); },
  };
}
export const createControls = registerControls;
