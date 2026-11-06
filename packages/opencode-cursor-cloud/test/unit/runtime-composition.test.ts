import { expect, it } from "vitest";
import { createCloudPlugin, type CloudContext } from "../../src/plugin/create.js";
import type { CloudService } from "../../src/core/cloud-service.js";
import { fakeHost, memoryStore } from "./fake-host.js";
import { deferred, finished, until } from "./cloud-fakes.js";

type Handler = (input: unknown, call: { signal: AbortSignal }) => Promise<{ code: string; snapshot?: { items?: { id: string; state: string }[] } }>;
type ToolEditor = Parameters<Parameters<CloudContext["tool"]["transform"]>[0]>[0];
type Tool = Parameters<ToolEditor["add"]>[0];
it("binds fixed RPC and tools to one Cloud owner, with state pushes and durable completion receipts", async () => {
  const host = fakeHost(); host.addSession("ses_one"); host.addSession("ses_two");
  const memory = memoryStore(); const wait = deferred<typeof finished>(); const tools = new Map<string, Tool>(); const trace: string[] = [];
  let handlers: Record<string, Handler> = {}; let service: CloudService | undefined;
  const context = {
    app: { version: "2.2.5" }, location: { directory: "/fixture" },
    storage: { get: memory.store.get, set: memory.store.set, scan: (o: { prefix: string; after?: string }) => memory.store.scan(o.prefix, o.after) }, event: host.event,
    session: { ...host.session, get: async (input: { sessionID: string }) => { await host.session.get(input); return { id: input.sessionID, location: { directory: "/fixture" } }; } },
    rpc: { register: async (_contract: unknown, values: typeof handlers) => { handlers = values; return { events: { emit: async () => { trace.push("push"); } }, dispose: async () => { trace.push("rpc-dispose"); } }; } },
    tool: { transform: async (fn: (editor: unknown) => void) => { fn({ add: (tool: Tool) => tools.set(tool.name, tool) }); return { dispose: async () => {} }; } },
    command: { transform: async () => ({ dispose: async () => {} }) },
    integration: { transform: async () => ({ dispose: async () => {} }), connection: { active: async () => { throw new Error("read touched auth"); }, resolve: async () => undefined } },
  } as unknown as CloudContext;
  const dispose = await createCloudPlugin({ client: {
    models: async () => { trace.push("models-network"); return []; },
    create: async () => { trace.push("create"); return { id: "bc-one", close: () => { trace.push("close"); }, send: async () => ({ id: "run-one", wait: () => wait.promise, cancel: async () => { trace.push("cancel"); wait.resolve(finished); } }) }; }, delete: async () => { trace.push("delete"); },
  }, serviceReady: owner => { service = owner; } }).setup(context);
  const scope = { sessionID: "ses_one", location: { directory: "/fixture" } };
  const rpc = (name: string, input = {}) => handlers[name]!({ scope, ...input }, { signal: new AbortController().signal });
  expect((await rpc("models")).code).toBe("ok"); expect((await rpc("status")).code).toBe("ok"); expect(trace).toEqual([]);
  expect((await rpc("spawn", { prompt: "task", repository: "https://github.com/o/r" })).code).toBe("ok");
  await until(() => trace.includes("push"));
  expect((await service!.status("ses_one"))._tag).toBe("ok");
  const status = tools.get("cursor_cloud_status")!;
  const result = await status.execute({}, { sessionID: "ses_one", progress: async () => {} } as Parameters<Tool["execute"]>[1]);
  expect(result.content).toContain("one"); expect(trace.filter(v => v === "create")).toHaveLength(1);
  expect((await rpc("cancel", { scope: { ...scope, sessionID: "ses_two" }, id: "bc-one", confirmed: true })).code).toBe("refused");
  expect((await rpc("cancel", { id: "bc-one", confirmed: true })).code).toBe("ok");
  await until(() => host.calls.length === 1); expect(host.calls[0]?.sessionID).toBe("ses_one"); expect(memory.data.size).toBeGreaterThan(0);
  expect((await rpc("delete", { id: "bc-one", confirmed: true })).code).toBe("ok");
  await dispose(); expect(trace.filter(v => v === "cancel")).toHaveLength(1); expect(trace).toContain("rpc-dispose"); expect(trace).not.toContain("models-network");
});
