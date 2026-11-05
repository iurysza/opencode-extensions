import type { Plugin } from "@opencode/plugin";
import type { LocalAgentStore, Run } from "@cursor/sdk";
import { describe, expect, it } from "vitest";
import { composeRuntime, sessionSettingsKey, USER_SETTINGS_KEY } from "../../src/plugin/runtime.js";
import { REMOTE_ACK } from "../../src/control-contract.js";
import { selectLane } from "../../src/core/lanes.js";
import type { CursorTurnRequest } from "../../src/core/turn-events.js";
import type { LocalSdkPort } from "../../src/provider/local-runtime.js";

const request: CursorTurnRequest = { modelId: "composer-2.5", context: { sessionID: "ses_one", kind: "primary", agent: "build", model: { id: "composer-2.5", providerID: "cursor" } }, prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] };
const collect = async (source: AsyncIterable<unknown>) => { const values = []; for await (const v of source) values.push(v); return values; };
async function fixture(pendingCloud = false) {
  const data = new Map<string, unknown>(); const trace: string[] = []; let failWrite = false; let project: unknown = {};
  type Handler = (input: unknown, call: { signal: AbortSignal }) => Promise<{ code: string; snapshot?: unknown }>;
  let handlers: Record<string, Handler> = {};
  const ctx = {
    location: { directory: "/fixture" }, get options() { return project; },
    integration: { transform: async (f: (editor: unknown) => void) => { f({ update() {}, method: { update() {} } }); return { dispose: async () => {} }; }, get: async () => ({ data: { connections: [] } }), connection: { active: async () => undefined } },
    storage: { get: async (key: string) => structuredClone(data.get(key)), set: async (key: string, value: unknown) => { if (failWrite) throw new Error("storage failure"); data.set(key, structuredClone(value)); } },
    session: { get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, location: { directory: "/fixture" } }), context: async () => [] },
    rpc: { register: async (_contract: unknown, h: typeof handlers) => { handlers = h; return { events: { emit: async () => { trace.push("push"); } }, dispose: async () => { trace.push("rpc-dispose"); } }; } },
  } as unknown as Plugin.Context;
  const sdk: LocalSdkPort = { models: async () => [{ id: "composer-2.5", displayName: "Composer" }], openStore: async () => ({ store: {} as LocalAgentStore, dispose: async () => {} }), create: async () => { trace.push("local-create"); return { close() { trace.push("local-close"); }, send: async () => ({ wait: async () => ({ id: "local-run", status: "finished" }), cancel: async () => { trace.push("local-cancel"); } }) }; } };
  const runtime = await composeRuntime(ctx, { local: { loadSdk: async () => sdk, stateRoot: "/fixture/state", env: { CURSOR_API_KEY: "fake-personal" } }, foreground: {
    inspectLocalState: () => ({ insideGitRepo: true, dirty: false, comparison: "contains_head" }),
    loadAgentFactory: async () => ({ create: async () => { trace.push("cloud-create"); return { agentId: "bc-11111111-1111-4111-8111-111111111111", close() { trace.push("cloud-close"); }, send: async () => ({ id: "cloud-run", wait: async () => { trace.push("cloud-wait"); return pendingCloud ? new Promise<never>(() => {}) : { id: "cloud-run", status: "finished", result: "CLOUD" }; }, cancel: async () => { trace.push("cloud-cancel"); } }) as Run }; }, archive: async () => { trace.push("archive"); }, delete: async () => { trace.push("delete"); } }),
  } });
  const scope = { sessionID: "ses_one", location: { directory: "/fixture" } };
  const call = (method: string, input = {}) => handlers[method]!({ scope, ...input }, { signal: new AbortController().signal });
  return { runtime, data, trace, call, setFail: () => { failWrite = true; }, project: (value: unknown) => { project = value; } };
}
describe("production runtime composition", () => {
  it("keeps reads SDK-free, routes local then Cloud with durable acknowledgment, resets idle pool", async () => {
    const f = await fixture();
    expect((await f.call("status")).code).toBe("ok"); expect((await f.call("models")).code).toBe("ok"); expect(f.trace).toEqual([]);
    await collect(f.runtime.lanes.coding(request)); expect(f.runtime.controls.status("ses_one")).toMatchObject({ active: true, pending: false });
    expect((await f.call("runtime", { runtime: "cloud", acknowledgement: REMOTE_ACK })).code).toBe("ok");
    expect(f.data.get(sessionSettingsKey("ses_one"))).toMatchObject({ runtime: "cloud", cloud: { acknowledged: true } });
    await collect(f.runtime.lanes.coding(request)); expect(f.trace.filter(v => v.endsWith("create"))).toEqual(["local-create", "cloud-create"]);
    expect(f.trace).toContain("local-close"); expect(selectLane("title", f.runtime.lanes)._tag).toBe("err");
    await f.runtime.dispose(); expect(f.trace).not.toContain("cloud-cancel"); expect(f.trace).toContain("rpc-dispose");
  });
  it("detaches an active foreground run on disposal without remote cancellation", async () => {
    const f = await fixture(true);
    await f.call("runtime", { runtime: "cloud", acknowledgement: REMOTE_ACK });
    const running = collect(f.runtime.lanes.coding(request));
    for (let i = 0; i < 100 && !f.trace.includes("cloud-wait"); i++) await new Promise(resolve => setImmediate(resolve));
    expect(f.trace).toContain("cloud-wait");
    expect((await f.call("runtime", { runtime: "local" })).code).toBe("refused");
    await f.runtime.dispose(); await running;
    expect(f.trace).toContain("cloud-close"); expect(f.trace).not.toContain("cloud-cancel");
  });
  it("fails acknowledgment persistence before any SDK action and ignores project acknowledgment", async () => {
    const f = await fixture(); f.setFail();
    expect((await f.call("runtime", { runtime: "cloud", acknowledgement: REMOTE_ACK })).code).toBe("failed");
    expect(f.trace).toEqual([]); expect(f.data.size).toBe(0);
    f.project({ cursor: { runtime: "cloud", cloud: { acknowledged: true } } });
    await expect(collect(f.runtime.lanes.coding(request))).rejects.toThrow(); expect(f.trace.filter(v => v.endsWith("create"))).toEqual([]);
    await f.runtime.dispose();
  });
  it("rejects missing acknowledgment, cross-location RPC and unsupported controls", async () => {
    const f = await fixture();
    expect((await f.call("runtime", { runtime: "cloud" })).code).toBe("refused");
    expect((await f.call("status", { scope: { sessionID: "ses_one", location: { directory: "/other" } } })).code).toBe("refused");
    for (const [name, args] of [["fast", { enabled: true }], ["mode", { mode: "plan" }], ["refreshModels", {}]] as const) expect((await f.call(name, args)).code).toBe("not_implemented");
    f.data.set(USER_SETTINGS_KEY, { runtime: "cloud", cloud: { acknowledged: true } });
    await expect(collect(f.runtime.lanes.coding(request))).rejects.toThrow("acknowledgment");
    expect(f.trace.filter(v => v.endsWith("create"))).toEqual([]); await f.runtime.dispose();
  });
});
