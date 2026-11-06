import { describe, expect, it } from "vitest";
import { controls, parse, displayText, type Scope } from "../../src/control-contract.js";
import { registerControls, type ControlContext } from "../../src/plugin/control-rpc.js";

const scope: Scope = { sessionID: "ses_test", location: { directory: "/fixture", workspaceID: undefined } };
function host(location = "/fixture", sessionLocation = "/fixture", workspaceID?: string) {
  let handlers: Record<string, (input: unknown, call: { signal: AbortSignal }) => Promise<unknown>> = {};
  const events: unknown[] = [];
  let disposed = false;
  const ctx = {
    location: { directory: location, workspaceID },
    session: { get: async ({ sessionID }: { sessionID: string }) => {
      if (sessionID === "ses_missing") throw new Error("not found");
      return { id: sessionID, location: { directory: sessionLocation } };
    } },
    rpc: { register: async (_definition: unknown, implementation: typeof handlers) => {
      handlers = implementation;
      return { dispose: async () => { disposed = true; }, events: { emit: async (...args: unknown[]) => { events.push(args); } } };
    } },
  } as unknown as ControlContext; // Deliberately minimal fake host, not real-host evidence.
  return { ctx, events, disposed: () => disposed,
    call: (method: string, input: unknown, signal = new AbortController().signal) => handlers[method]!(input, { signal }) };
}

describe("fixed controls", () => {
  it("has no arbitrary execution or credential method", () => {
    expect(Object.keys(controls.methods)).toEqual(["status", "models", "ledger", "archive", "delete", "runtime", "fast", "mode", "tools", "http", "resumeCleanup", "refreshModels", "refreshConfig"]);
    for (const method of Object.values(controls.methods)) {
      expect(() => parse(method.input, { scope, apiKey: "forbidden" })).toThrow();
      expect(() => parse(method.input, { scope: { ...scope, location: { directory: "relative" } } })).toThrow();
    }
    expect(displayText("\x1b[31mhello\x1b[0m\x07\u202etoken=not-for-display")).toBe("hello[redacted]");
  });
  it("fails closed on missing actions, sessions and location mismatches", async () => {
    const h = host(); const registration = await registerControls(h.ctx, {});
    expect(await h.call("status", { scope })).toMatchObject({ code: "not_implemented" });
    expect(await h.call("status", { scope: { ...scope, sessionID: "ses_missing" } })).toMatchObject({ code: "refused" });
    expect(await h.call("status", { scope: { ...scope, location: { directory: "/other" } } })).toMatchObject({ code: "refused" });
    expect(await h.call("status", { scope: { ...scope, location: { directory: "/fixture", workspaceID: "wrk_remote" } } })).toMatchObject({ code: "refused" });
    const moved = host("/fixture", "/other"); await registerControls(moved.ctx, { status: async () => ({ state: "running" }) });
    expect(await moved.call("status", { scope })).toMatchObject({ code: "refused" });
    const remote = host("/fixture", "/fixture", "wrk_remote"); await registerControls(remote.ctx, {});
    expect(await remote.call("status", { scope })).toMatchObject({ code: "refused" });
    await registration.dispose(); expect(h.disposed()).toBe(true);
  });
  it("projects replies and suppresses raw action exceptions and secret IDs", async () => {
    const h = host(); await registerControls(h.ctx, { status: async () => ({ state: "running", apiKey: "do-not-expose" }) });
    const reply = await h.call("status", { scope });
    expect(reply).toMatchObject({ code: "ok", snapshot: { state: "running" } });
    expect(JSON.stringify(reply)).not.toContain("do-not-expose");
    expect(h.events).toEqual([]); // A read never emits a mutation event.
    const bad = host(); await registerControls(bad.ctx, { status: async () => ({ items: [{ id: "sk-secretsecret123", state: "running" }] }) });
    expect(await bad.call("status", { scope })).toMatchObject({ code: "failed" });
    const error = host(); await registerControls(error.ctx, { status: async () => { throw new Error("apiKey=do-not-expose"); } });
    expect(await error.call("status", { scope })).toEqual({ code: "failed", snapshot: undefined });
  });
  it("keeps explicit action refusals honest and bounds replies", async () => {
    for (const [refused, code] of [["scope", "refused"], ["unavailable", "not_implemented"]] as const) {
      const h = host(); await registerControls(h.ctx, { status: async () => ({ refused }) });
      expect(await h.call("status", { scope })).toMatchObject({ code }); expect(h.events).toEqual([]);
    }
    const oversized = host(); await registerControls(oversized.ctx, { status: async () => ({ items: Array.from({ length: 101 }, () => ({ id: "fixture", state: "running" })) }) });
    expect(await oversized.call("status", { scope })).toMatchObject({ code: "failed" });
    const h = host(); let called = false;
    const registration = await registerControls(h.ctx, { status: async () => { called = true; } });
    await registration.dispose(); await registration.publish(scope);
    expect(await h.call("status", { scope })).toMatchObject({ code: "aborted" });
    expect(called).toBe(false); expect(h.events).toEqual([]);
  });
  it("propagates call abort and unload to in-flight actions", async () => {
    for (const unload of [false, true]) {
      const h = host(); let started!: () => void;
      const ready = new Promise<void>(resolve => { started = resolve; });
      let aborted = false;
      const registration = await registerControls(h.ctx, { status: async (_input, signal) => {
        started();
        await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
      } });
      const controller = new AbortController();
      const call = h.call("status", { scope }, controller.signal); await ready;
      if (unload) await registration.dispose(); else controller.abort();
      expect(await call).toMatchObject({ code: "aborted" }); expect(aborted).toBe(true); expect(h.events).toEqual([]);
    }
  });
  it("requires full Cloud acknowledgement and fixed destructive confirmation", async () => {
    const h = host(); const received: unknown[] = [];
    await registerControls(h.ctx, { runtime: async input => { received.push(input); return { runtime: input.runtime }; }, delete: async () => {}, archive: async () => {} });
    expect(await h.call("runtime", { scope, runtime: "cloud" })).toMatchObject({ code: "refused" });
    expect(received).toHaveLength(0);
    expect(await h.call("runtime", { scope, runtime: "cloud", acknowledgement: "remote-execution-billing-persistent-session-scope-v1" })).toMatchObject({ code: "ok" });
    expect(h.events).toEqual([["status", { scope, state: "changed" }]]);
    for (const method of ["archive", "delete"]) {
      expect(await h.call(method, { scope, id: "agent_1", confirmed: false })).toMatchObject({ code: "invalid_input" });
      expect(await h.call(method, { scope, id: "agent_1" })).toMatchObject({ code: "invalid_input" });
      expect(await h.call(method, { scope, id: "agent_1", confirmed: true })).toMatchObject({ code: "ok" });
    }
  });
});
