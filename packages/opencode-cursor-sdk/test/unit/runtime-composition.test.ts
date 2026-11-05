import type { Plugin } from "@opencode/plugin";
import type { AgentOptions, SendOptions, LocalAgentStore, Run } from "@cursor/sdk";
import { describe, expect, it } from "vitest";
import { composeRuntime, sessionSettingsKey, USER_SETTINGS_KEY } from "../../src/plugin/runtime.js";
import { REMOTE_ACK } from "../../src/control-contract.js";
import { selectLane } from "../../src/core/lanes.js";
import type { CursorTurnRequest } from "../../src/core/turn-events.js";
import type { LocalSdkPort } from "../../src/provider/local-runtime.js";

const request: CursorTurnRequest = { modelId: "composer-2.5", context: { sessionID: "ses_one", kind: "primary", agent: "build", model: { id: "composer-2.5", providerID: "cursor" } }, prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] };
const collect = async (source: AsyncIterable<unknown>) => { const values = []; for await (const v of source) values.push(v); return values; };
async function fixture(pendingCloud = false, env: Record<string, string | undefined> = {}, pendingLocal: boolean | "bridge" = false) {
  const data = new Map<string, unknown>(); const trace: string[] = []; let failWrite = false; let project: unknown = {};
  const created: AgentOptions[] = []; const sent: SendOptions[] = [];
  let readHook: (() => Promise<void>) | undefined;
  let writeHook: (() => Promise<void>) | undefined;
  type Handler = (input: unknown, call: { signal: AbortSignal }) => Promise<{ code: string; snapshot?: unknown }>;
  let handlers: Record<string, Handler> = {};
  const ctx = {
    location: { directory: "/fixture" }, get options() { return project; },
    integration: { transform: async (f: (editor: unknown) => void) => { f({ update() {}, method: { update() {} } }); return { dispose: async () => {} }; }, get: async () => ({ data: { connections: [] } }), connection: { active: async () => undefined } },
    storage: { get: async (key: string) => { await readHook?.(); return structuredClone(data.get(key)); }, set: async (key: string, value: unknown) => { await writeHook?.(); if (failWrite) throw new Error("storage failure"); data.set(key, structuredClone(value)); } },
    session: { get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, location: { directory: "/fixture" } }), context: async () => [] },
    rpc: { register: async (_contract: unknown, h: typeof handlers) => { handlers = h; return { events: { emit: async () => { trace.push("push"); } }, dispose: async () => { trace.push("rpc-dispose"); } }; } },
  } as unknown as Plugin.Context;
  const sdk: LocalSdkPort = {
    models: async () => [{ id: "composer-2.5", displayName: "Composer" }],
    openStore: async () => ({ store: {} as LocalAgentStore, dispose: async () => {} }),
    create: async options => {
      trace.push("local-create"); created.push(options);
      return { close() { trace.push("local-close"); }, send: async (_message, options) => {
        sent.push(options);
        const result = (async () => {
          if (pendingLocal === true) return new Promise<never>(() => {});
          if (pendingLocal === "bridge") {
            const endpoint = Object.values(options.mcpServers ?? {})[0];
            if (!endpoint || !("url" in endpoint)) throw new Error("Missing fake MCP endpoint");
            const rpc = async (method: string, params?: unknown) => {
              const response = await fetch(endpoint.url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
              return (await response.json() as { result: { tools: { name: string }[] } }).result;
            };
            const listed = await rpc("tools/list");
            await rpc("tools/call", { name: listed.tools[0]!.name, arguments: {} });
          }
          return { id: "local-run", status: "finished" as const };
        })();
        void result.catch(() => {});
        return { wait: () => result, cancel: async () => { trace.push("local-cancel"); } };
      } };
    },
  };
  const runtime = await composeRuntime(ctx, { local: { loadSdk: async () => sdk, stateRoot: "/fixture/state", env: { CURSOR_API_KEY: "fake-personal", ...env } }, foreground: {
    inspectLocalState: () => ({ insideGitRepo: true, dirty: false, comparison: "contains_head" }),
    loadAgentFactory: async () => ({ create: async () => { trace.push("cloud-create"); return { agentId: "bc-11111111-1111-4111-8111-111111111111", close() { trace.push("cloud-close"); }, send: async () => ({ id: "cloud-run", wait: async () => { trace.push("cloud-wait"); return pendingCloud ? new Promise<never>(() => {}) : { id: "cloud-run", status: "finished", result: "CLOUD" }; }, cancel: async () => { trace.push("cloud-cancel"); } }) as Run }; }, archive: async () => { trace.push("archive"); }, delete: async () => { trace.push("delete"); } }),
  } });
  const scope = { sessionID: "ses_one", location: { directory: "/fixture" } };
  const call = (method: string, input = {}, signal = new AbortController().signal) => handlers[method]!({ scope, ...input }, { signal });
  return { runtime, data, trace, created, sent, call, setFail: () => { failWrite = true; }, project: (value: unknown) => { project = value; },
    onRead: (hook?: () => Promise<void>) => { readHook = hook; }, onWrite: (hook?: () => Promise<void>) => { writeHook = hook; } };
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
    for (const [name, args] of [["fast", { enabled: true }], ["http", { http: "auto" }], ["http", { http: "http1" }], ["resumeCleanup", { enabled: true }], ["refreshModels", {}]] as const) expect((await f.call(name, args)).code).toBe("not_implemented");
    f.data.set(USER_SETTINGS_KEY, { runtime: "cloud", cloud: { acknowledged: true } });
    await expect(collect(f.runtime.lanes.coding(request))).rejects.toThrow("acknowledgment");
    expect(f.trace.filter(v => v.endsWith("create"))).toEqual([]); await f.runtime.dispose();
  });
  it("delivers mode/tools/safety to the SDK and resets an idle owner only after persistence", async () => {
    const f = await fixture(false, { PI_CURSOR_LOCAL_FORCE: "true", PI_CURSOR_SANDBOX: "true" });
    f.data.set(USER_SETTINGS_KEY, { local: { autoReview: true, resume: false } });
    try {
      expect(await f.runtime.getOptions("ses_one")).toMatchObject({ autoReview: true, sandboxEnabled: true, force: true, resume: false, tools: "both" });
      await collect(f.runtime.lanes.coding(request));
      expect(f.created[0]).toMatchObject({ mode: "agent", local: { autoReview: true, sandboxOptions: { enabled: true }, settingSources: [], enableAgentRetries: false } });
      expect(f.created[0]?.tools).toBeUndefined();
      expect(f.sent[0]).toMatchObject({ mode: "agent", local: { force: true } });
      expect((await f.call("mode", { mode: "plan" })).code).toBe("ok");
      expect(f.runtime.controls.status("ses_one").active).toBe(false);
      expect((await f.call("tools", { tools: "bridge" })).code).toBe("ok");
      await collect(f.runtime.lanes.coding(request));
      expect(f.created[1]).toMatchObject({ mode: "plan", tools: ["mcp"] });
      expect(f.sent[1]?.mode).toBe("plan");
      expect((await f.call("tools", { tools: "native" })).code).toBe("ok");
      await collect(f.runtime.lanes.coding({ ...request, tools: [{ type: "function", name: "write", inputSchema: { type: "object" } }] }));
      expect(f.created[2]?.mcpServers).toBeUndefined();
      expect(f.created[2]?.tools).toBeUndefined();
      expect(f.sent[2]?.mcpServers).toBeUndefined();
      expect(f.data.get(sessionSettingsKey("ses_one"))).toMatchObject({ local: { mode: "plan", tools: "native" } });
    } finally { await f.runtime.dispose(); }
  });
  it("keeps an idle owner for unchanged mode and tool policy", async () => {
    const f = await fixture();
    try {
      await collect(f.runtime.lanes.coding(request));
      expect((await f.call("mode", { mode: "agent" })).code).toBe("ok");
      expect((await f.call("tools", { tools: "both" })).code).toBe("ok");
      expect(f.runtime.controls.status("ses_one").active).toBe(true);
      expect(f.trace).not.toContain("local-close");
    } finally { await f.runtime.dispose(); }
  });
  it("preserves every validated session field across Cloud and local switches", async () => {
    const f = await fixture();
    const saved = { local: { mode: "plan", tools: "native" }, cloud: { acknowledged: false, branch: "main", contextHandoff: "never" } };
    f.data.set(sessionSettingsKey("ses_one"), saved);
    try {
      expect((await f.call("runtime", { runtime: "cloud", acknowledgement: REMOTE_ACK })).code).toBe("ok");
      expect(f.data.get(sessionSettingsKey("ses_one"))).toEqual({ ...saved, runtime: "cloud", cloud: { ...saved.cloud, acknowledged: true } });
      expect((await f.call("tools", { tools: "both" })).code).toBe("refused");
      expect((await f.call("runtime", { runtime: "local" })).code).toBe("ok");
      expect(await f.runtime.getOptions("ses_one")).toMatchObject(saved.local);
    } finally { await f.runtime.dispose(); }
  });
  it("keeps the idle owner and settings intact when validation or persistence fails", async () => {
    const f = await fixture();
    try {
      await collect(f.runtime.lanes.coding(request));
      expect((await f.call("tools", { tools: "unknown" })).code).toBe("invalid_input");
      f.setFail();
      expect((await f.call("mode", { mode: "plan" })).code).toBe("failed");
      expect(f.runtime.controls.status("ses_one").active).toBe(true);
      expect(f.trace).not.toContain("local-close");
      expect(f.data.size).toBe(0);
    } finally { await f.runtime.dispose(); }
  });
  it.each([false, true])("refuses setting changes while a %s Cloud run is held", async cloud => {
    const f = await fixture(cloud, {}, !cloud);
    const controller = new AbortController();
    try {
      if (cloud) await f.call("runtime", { runtime: "cloud", acknowledgement: REMOTE_ACK });
      const running = collect(f.runtime.lanes.coding({ ...request, abortSignal: controller.signal })).catch(error => error);
      for (let i = 0; i < 100 && !(cloud ? f.trace.includes("cloud-wait") : f.sent.length); i++) await new Promise(resolve => setImmediate(resolve));
      const saved = structuredClone([...f.data]);
      for (const [name, args] of [["mode", { mode: "plan" }], ["tools", { tools: "native" }], ["runtime", { runtime: "local" }]] as const) expect((await f.call(name, args)).code).toBe("refused");
      expect([...f.data]).toEqual(saved);
      controller.abort(); await f.runtime.dispose(); await running;
    } finally { controller.abort(); await f.runtime.dispose(); }
  });
  it("refuses settings with a pending MCP continuation even after the coding hold is released", async () => {
    const f = await fixture(false, {}, "bridge");
    try {
      const events = await collect(f.runtime.lanes.coding({ ...request, tools: [{ type: "function", name: "write", inputSchema: { type: "object" } }] }));
      expect(events.at(-1)).toEqual({ type: "done", reason: "tool-calls" });
      expect(f.runtime.controls.status("ses_one").pending).toBe(true);
      const saved = structuredClone([...f.data]);
      for (const [method, input] of [["mode", { mode: "plan" }], ["tools", { tools: "native" }], ["runtime", { runtime: "cloud", acknowledgement: REMOTE_ACK }]] as const) {
        expect((await f.call(method, input)).code).toBe("refused");
      }
      expect([...f.data]).toEqual(saved); expect(f.trace).not.toContain("local-close");
    } finally { await f.runtime.dispose(); }
  });
  it.each([["abort", 1], ["close", 1], ["abort", 2], ["close", 2]] as const)("does not save or start SDK work after %s during settings read %s", async (stop, read) => {
    const f = await fixture(); const controller = new AbortController();
    let release!: () => void; let entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let reads = 0;
    f.onRead(async () => { if (++reads === read) { entered(); await blocked; } });
    const action = f.call("mode", { mode: "plan" }, controller.signal);
    await started;
    if (stop === "abort") controller.abort(); else await f.runtime.dispose();
    release();
    expect((await action).code).toBe("aborted");
    expect(f.data.size).toBe(0); expect(f.trace).not.toContain("local-create");
    f.onRead(); await f.runtime.dispose();
  });
  it("never resets or starts SDK work after abort during persistence", async () => {
    const f = await fixture(); const controller = new AbortController();
    await collect(f.runtime.lanes.coding(request));
    f.onWrite(async () => { controller.abort(); });
    expect((await f.call("mode", { mode: "plan" }, controller.signal)).code).toBe("aborted");
    expect(f.trace).not.toContain("local-close");
    expect(f.created).toHaveLength(1);
    // Host storage cannot roll back an in-flight write; the next turn's identity resets it.
    await f.runtime.dispose();
  });
  it.each([
    { runtime: "local" }, { cloud: { repo: "https://github.com/o/r" } },
    { local: { mode: "plan" } }, { local: { tools: "native" } },
    { local: { autoReview: true } }, { local: { sandboxOptions: { enabled: true } } },
  ])("refuses project overrides before writes or SDK work: %j", async cursor => {
    const f = await fixture(); f.project({ cursor });
    try {
      expect((await f.call("mode", { mode: "plan" })).code).toBe("failed");
      await expect(collect(f.runtime.lanes.coding(request))).rejects.toThrow();
      expect(f.data.size).toBe(0); expect(f.trace).not.toContain("local-create");
    } finally { await f.runtime.dispose(); }
  });
});
