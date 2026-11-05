import { expect, it } from "vitest";
import type { Plugin as Latest } from "@opencode/plugin";
import type { Plugin as Minimum } from "opencode-plugin-min";
import { createCloudPlugin, type CloudContext } from "../../src/plugin/create.js";
import type { CloudService } from "../../src/core/cloud-service.js";
import type { CloudClient, CloudRun } from "../../src/core/cloud-client.js";
import { fakeHost, memoryStore } from "./fake-host.js";
import { deferred, finished, until } from "./cloud-fakes.js";

// Compile-time proofs, not a cast to a pretend host contract.
const latestContext = (context: Latest.Context): CloudContext => context;
const minimumContext = (context: Minimum.Context): CloudContext => context;
const latestPlugin: Latest.Plugin = createCloudPlugin();
const minimumPlugin: Minimum.Plugin = createCloudPlugin();
void [latestContext, minimumContext, latestPlugin, minimumPlugin];

type ToolEditor = Parameters<Parameters<CloudContext["tool"]["transform"]>[0]>[0];
type Tool = Parameters<ToolEditor["add"]>[0];
type CommandEditor = Parameters<Parameters<CloudContext["command"]["transform"]>[0]>[0];
type Command = Parameters<CommandEditor["add"]>[0];

function fixture(version = "2.2.5", workspaceID?: string) {
  const host = fakeHost(); host.addSession("ses_one"); host.addSession("ses_two");
  const memory = memoryStore(); const tools = new Map<string, Tool>(), commands = new Map<string, Command>();
  let authReads = 0, creates = 0, closes = 0, deletes = 0, disposals = 0;
  const wait = deferred<typeof finished>();
  const run: CloudRun = { id: "run-host", wait: () => wait.promise, cancel: async () => {} };
  const client: CloudClient = { models: async () => [], create: async () => { creates++; return { id: "bc-host", close: () => { closes++; }, send: async () => run }; }, delete: async () => { deletes++; } };
  let service: CloudService | undefined;
  const registration = { dispose: async () => { disposals++; } };
  // Test-only host editor implementations. Production uses the real public editors.
  const context = {
    app: { version }, location: { directory: "/nonexistent/cloud-fixture", workspaceID },
    storage: { get: memory.store.get, set: memory.store.set, scan: (o: { prefix: string; after?: string }) => memory.store.scan(o.prefix, o.after) },
    session: host.session, event: host.event, rpc: { register: async () => registration },
    tool: { transform: async (callback: (editor: unknown) => void) => { callback({ add: (tool: Tool) => tools.set(tool.name, tool) }); return registration; } },
    command: { transform: async (callback: (editor: unknown) => void) => { callback({ add: (command: Command) => commands.set(command.name, command) }); return registration; } },
    integration: { transform: async (callback: (editor: unknown) => void) => { callback({ method: { update: () => {} } }); return registration; }, connection: { active: async () => { authReads++; return undefined; }, resolve: async () => undefined } },
  } as unknown as CloudContext;
  const diagnostics: string[] = [];
  const plugin = createCloudPlugin({ client, serviceReady: s => { service = s; }, diagnostic: m => diagnostics.push(m) });
  async function execute(name: string, input: unknown, sessionID = "ses_one") {
    const tool = tools.get(name); if (!tool) throw new Error("missing tool");
    const updates: unknown[] = [];
    const ctx = { sessionID, progress: async (update: unknown) => { updates.push(update); } } as Parameters<Tool["execute"]>[1];
    return { result: await tool.execute(input, ctx), updates };
  }
  return { context, plugin, tools, commands, execute, wait, host, diagnostics, service: () => service, creates: () => creates, authReads: () => authReads, closes: () => closes, deletes: () => deletes, disposals: () => disposals };
}

for (const version of ["2.0.0", "2.2.5"]) it(`registers four real tools and command with public ${version} contracts and captures tool origin`, async () => {
  const r = fixture(version); const dispose = await r.plugin.setup(r.context);
  expect([...r.tools.keys()]).toEqual(["cursor_cloud_spawn", "cursor_cloud_send", "cursor_cloud_status", "cursor_cloud_cancel"]);
  expect(r.creates()).toBe(0); expect(r.authReads()).toBe(0);
  const spawn = await r.execute("cursor_cloud_spawn", { prompt: "task", repo: "https://github.com/o/r", ref: "main" });
  expect(spawn.updates).toHaveLength(1); expect(spawn.result.content).toContain("background");
  expect((await r.execute("cursor_cloud_send", { id: "host", prompt: "busy" })).result.metadata).toMatchObject({ isError: true });
  expect((await r.execute("cursor_cloud_status", { id: "host" }, "ses_two")).result.metadata).toMatchObject({ isError: true });
  r.wait.resolve(finished); await until(() => r.host.calls.length === 1);
  expect(r.host.calls[0]?.sessionID).toBe("ses_one");
  const cmd = r.commands.get("cloud-delete")!;
  const invoke = (text: string) => cmd.execute({ sessionID: "ses_one", prompt: { text }, delivery: "steer" } as Parameters<Command["execute"]>[0]);
  await invoke("host"); expect(r.deletes()).toBe(0);
  await invoke("host --confirm"); expect(r.deletes()).toBe(1);
  expect(r.host.calls.at(-1)?.resume).toBe(false);
  await dispose(); expect(r.closes()).toBe(1); expect(r.disposals()).toBe(4);
});

it("fails closed on remote workspaces or unsupported hosts without SDK/auth or registration", async () => {
  for (const r of [fixture("2.2.5", "remote"), fixture("1.9.0"), fixture("3.0.0")]) {
    const dispose = await r.plugin.setup(r.context);
    expect(r.tools.size).toBe(0); expect(r.creates()).toBe(0); expect(r.authReads()).toBe(0);
    expect(r.diagnostics.length).toBe(1); await dispose();
  }
});

it("rejects unknown input keys rather than routing arbitrary tool methods", async () => {
  const r = fixture(); const dispose = await r.plugin.setup(r.context);
  const result = await r.execute("cursor_cloud_spawn", { prompt: "x", method: "delete", env: { TOKEN: "test" } });
  expect(result.result.metadata).toMatchObject({ isError: true }); expect(r.creates()).toBe(0);
  await dispose();
});
