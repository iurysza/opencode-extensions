// Fake SDK port and hand-written host contexts only. No real Cursor or network.
import type { ModelListItem } from "@cursor/sdk";
import { describe, expect, it, vi } from "vitest";
import { FALLBACK_MODELS, FALLBACK_SPECS, resolveModelSelection, thinkingLevels, toModelSpecs } from "../../src/provider/models.js";
import { createModelCatalog, DISCOVERY_FALLBACK_WARNING } from "../../src/plugin/catalog.js";
import { registerProvider } from "../../src/compat/provider-registration.js";
import { parseHost } from "../../src/compat/host.js";
import { createCursorPlugin, CONNECTION_EVENTS } from "../../src/plugin/create.js";
import type { LocalSdkPort } from "../../src/provider/local-runtime.js";

// Shape copied from the live Cursor catalog (public metadata): Grok 4.7.
const GROK: ModelListItem = {
  id: "grok-4.7", displayName: "Grok 4.7",
  parameters: [
    { id: "context", values: [{ value: "256k" }, { value: "500k" }] },
    { id: "reasoning_effort", values: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }] },
    { id: "fast", values: [{ value: "false" }, { value: "true" }] },
  ],
  variants: [
    { displayName: "Grok 4.7  High Fast", isDefault: true, params: [{ id: "context", value: "500k" }, { id: "reasoning_effort", value: "high" }, { id: "fast", value: "true" }] },
    { displayName: "Grok 4.7  Low", params: [{ id: "context", value: "500k" }, { id: "reasoning_effort", value: "low" }, { id: "fast", value: "false" }] },
  ],
};
const HAIKU: ModelListItem = { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5",
  parameters: [{ id: "thinking", values: [{ value: "false" }, { value: "true" }] }],
  variants: [{ displayName: "Claude Haiku 4.5", isDefault: true, params: [{ id: "thinking", value: "true" }] }] };
const GPT: ModelListItem = { id: "gpt-5.4-mini", displayName: "GPT-5.4 Mini",
  parameters: [{ id: "reasoning", values: ["none", "low", "medium", "high", "xhigh"].map((value) => ({ value })) }],
  variants: [{ displayName: "GPT-5.4 Mini", isDefault: true, params: [{ id: "reasoning", value: "medium" }] }] };
const PLAIN: ModelListItem = { id: "kimi-k2.7-code", displayName: "Kimi K2.7 Code" };

describe("Cursor catalog to OpenCode models", () => {
  it("splits context choices like Pi and maps thinking levels to variants with real context limits", () => {
    const specs = toModelSpecs([GROK, PLAIN]);
    expect(specs).toEqual([
      { id: "grok-4.7@256k", name: "Grok 4.7 @ 256k", context: 256_000, output: 32_000, variants: ["low", "medium", "high", "xhigh"] },
      { id: "grok-4.7@500k", name: "Grok 4.7 @ 500k", context: 500_000, output: 32_000, variants: ["low", "medium", "high", "xhigh"] },
      { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", context: 200_000, output: 32_000 },
    ]);
  });
  it("maps boolean thinking and none-able reasoning like Pi", () => {
    expect(thinkingLevels(HAIKU)).toEqual({ off: "false", high: "true" });
    expect(thinkingLevels(GPT)).toEqual({ off: "none", low: "low", medium: "medium", high: "high", xhigh: "xhigh" });
  });
  it("resolves grok-4.7@256k#high to the Pi selection", () => {
    expect(resolveModelSelection([GROK], "grok-4.7@256k", "high", undefined)).toEqual({ id: "grok-4.7",
      params: [{ id: "context", value: "256k" }, { id: "reasoning_effort", value: "high" }, { id: "fast", value: "true" }] });
    expect(resolveModelSelection([GROK], "grok-4.7@256k", "low", { cursor: { params: { fast: "false" } } })).toEqual({ id: "grok-4.7",
      params: [{ id: "context", value: "256k" }, { id: "reasoning_effort", value: "low" }, { id: "fast", value: "false" }] });
    expect(resolveModelSelection([GROK], "grok-4.7@500k", undefined, undefined)?.params).toContainEqual({ id: "context", value: "500k" });
    expect(resolveModelSelection([GROK], "grok-4.7", "Grok 4.7  Low", undefined)?.params).toContainEqual({ id: "reasoning_effort", value: "low" });
  });
  it("applies off and refuses unsupported settings", () => {
    expect(resolveModelSelection([HAIKU], "claude-haiku-4-5", "off", undefined)).toEqual({ id: "claude-haiku-4-5", params: [{ id: "thinking", value: "false" }] });
    expect(resolveModelSelection([GPT], "gpt-5.4-mini", "off", undefined)).toEqual({ id: "gpt-5.4-mini", params: [{ id: "reasoning", value: "none" }] });
    expect(resolveModelSelection([GROK], "grok-4.7@256k", "max", undefined)).toBeUndefined();
    expect(resolveModelSelection([GROK], "grok-4.7@256k", undefined, { cursor: { params: { fast: "maybe" } } })).toBeUndefined();
    expect(resolveModelSelection([GROK], "grok-4.7@256k", undefined, { cursor: { other: 1 } })).toBeUndefined();
    expect(resolveModelSelection([GROK], "grok-4.7@2m", undefined, undefined)).toEqual({ id: "grok-4.7@2m" });
  });
  it("keeps a small fallback with ids that are in the live catalog", () => {
    expect(FALLBACK_MODELS.map((m) => m.id)).toEqual(["auto-smart", "composer-2.5", "gpt-5.6-sol"]);
    expect(FALLBACK_SPECS.map((m) => m.id)).toEqual(["auto-smart", "composer-2.5", "gpt-5.6-sol@272k", "gpt-5.6-sol@1m"]);
    expect(FALLBACK_SPECS.find((m) => m.id === "gpt-5.6-sol@272k")).toMatchObject({ context: 272_000, variants: ["off", "low", "medium", "high"] });
    expect(resolveModelSelection(FALLBACK_MODELS, "gpt-5.6-sol@272k", "high", undefined)).toEqual({ id: "gpt-5.6-sol",
      params: [{ id: "context", value: "272k" }, { id: "reasoning", value: "high" }, { id: "fast", value: "false" }] });
  });
});

describe("model catalog state", () => {
  const setup = (key: string | undefined, list = vi.fn(async (_key: string, _force: boolean) => [GROK])) => {
    let current = key;
    const warn = vi.fn();
    const published: string[][] = [];
    const catalog = createModelCatalog({ getApiKey: async () => current, list, warn });
    catalog.attach(async (specs) => { published.push(specs.map((s) => s.id)); });
    return { catalog, list, warn, published, setKey: (next: string | undefined) => { current = next; } };
  };
  it("publishes the account catalog once per key and re-lists on force", async () => {
    const f = setup("key-a");
    expect(f.catalog.source()).toBe("fallback");
    await f.catalog.refresh();
    await f.catalog.refresh();
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(f.published).toEqual([["grok-4.7@256k", "grok-4.7@500k"]]);
    await f.catalog.refresh({ force: true });
    expect(f.list).toHaveBeenLastCalledWith("key-a", true);
    expect(f.published).toHaveLength(2);
  });
  it("re-lists when the key changes and reverts to fallback when it is removed", async () => {
    const f = setup("key-a");
    await f.catalog.refresh();
    f.setKey("key-b");
    await f.catalog.refresh();
    expect(f.list).toHaveBeenLastCalledWith("key-b", false);
    f.setKey(undefined);
    await expect(f.catalog.refresh()).rejects.toThrow();
    expect(f.catalog.source()).toBe("fallback");
    expect(f.published.at(-1)).toEqual(FALLBACK_SPECS.map((s) => s.id));
  });
  it("warns, keeps the fallback and publishes nothing when discovery fails", async () => {
    const f = setup("key-a", vi.fn(async () => { throw new Error("network Bearer key-a"); }));
    await expect(f.catalog.refresh()).rejects.toThrow();
    expect(f.warn).toHaveBeenCalledWith(DISCOVERY_FALLBACK_WARNING);
    expect(f.catalog.source()).toBe("fallback");
    expect(f.published).toEqual([]);
  });
  it("does not list or publish without a key", async () => {
    const f = setup(undefined);
    await expect(f.catalog.refresh()).resolves.toBe("fallback");
    await expect(f.catalog.refresh({ force: true })).rejects.toThrow("unavailable");
    expect(f.list).not.toHaveBeenCalled();
    expect(f.published).toEqual([]);
  });
});

describe("host registration replays the current list", () => {
  it("2.0.4+: provider.add on each replay reads the latest models, with variants", async () => {
    const added: { models: { id: string; variants: unknown[] }[] }[] = [];
    const transforms: ((editor: unknown) => void)[] = [];
    const api = { _tag: "provider" as const, transform: async (cb: (editor: unknown) => void) => { transforms.push(cb); cb({ add: (input: never) => added.push(input) }); } };
    let specs = toModelSpecs([PLAIN]);
    await registerProvider(api, { id: "cursor", name: "Cursor", package: "aisdk:x", models: () => specs });
    specs = toModelSpecs([GROK]);
    transforms[0]!({ add: (input: never) => added.push(input) });
    expect(added.map((a) => a.models.map((m) => m.id))).toEqual([["kimi-k2.7-code"], ["grok-4.7@256k", "grok-4.7@500k"]]);
    expect(added[1]!.models[0]!.variants).toEqual([{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }]);
  });
  it("parses public provider.reload and catalog.reload when present", () => {
    const base = { app: { version: "2.2.5" }, aisdk: { hook() {} }, session: { synthetic() {}, hook() {} }, rpc: { register() {} } };
    const reload = vi.fn(async () => {});
    const latest = parseHost({ ...base, provider: { transform() {}, reload } });
    const min = parseHost({ ...base, catalog: { transform() {}, reload } });
    const none = parseHost({ ...base, provider: { transform() {} } });
    expect(latest._tag === "ok" && typeof latest.value.registration.reload).toBe("function");
    expect(min._tag === "ok" && min.value.registration._tag === "catalog" && typeof min.value.registration.reload).toBe("function");
    expect(none._tag === "ok" && none.value.registration.reload).toBeUndefined();
  });
});

function pluginHost(options: { reload?: boolean } = {}) {
  let storedKey: string | undefined;
  const connection = { type: "credential", method: "key", id: "cred_fake" };
  const added: { models: { id: string }[] }[] = [];
  const transforms: ((editor: unknown) => void)[] = [];
  const editor = { add: (input: never) => added.push(input) };
  const reload = vi.fn(async () => { for (const cb of transforms) cb(editor); });
  const queue: Record<string, unknown>[] = [];
  let wake: (() => void) | undefined;
  const subscribed: unknown[] = [];
  const emit = (event: Record<string, unknown>) => { queue.push(event); wake?.(); };
  const ctx = {
    app: { version: "2.2.5" }, location: { directory: "/fixture" }, options: {},
    provider: { transform: async (cb: (e: unknown) => void) => { transforms.push(cb); cb(editor); return { dispose: async () => {} }; }, ...(options.reload === false ? {} : { reload }) },
    aisdk: { hook: async () => ({ dispose: async () => {} }) },
    session: { synthetic: async () => {}, hook: async () => ({ dispose: async () => {} }), get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, location: { directory: "/fixture" } }), context: async () => [] },
    rpc: { register: async () => ({ events: { emit: async () => {} }, dispose: async () => {} }) },
    storage: { get: async () => undefined, set: async () => {} },
    integration: { transform: async (f: (e: unknown) => void) => { f({ update() {}, method: { update() {} } }); return { dispose: async () => {} }; },
      get: async () => ({ data: { connections: [] } }),
      connection: { active: async () => (storedKey ? connection : undefined), resolve: async () => ({ type: "key", key: storedKey }) } },
    event: { subscribe: (input: { types?: string[]; signal: AbortSignal }) => { subscribed.push(input.types); return (async function* () {
      while (!input.signal.aborted) {
        if (!queue.length) await new Promise<void>((resolve) => { wake = resolve; input.signal.addEventListener("abort", () => resolve(), { once: true }); });
        while (queue.length) yield queue.shift()!;
      }
    })(); } },
  };
  return { ctx, added, reload, emit, subscribed, connect: (key: string) => { storedKey = key; } };
}
const port = (list: LocalSdkPort["models"]): LocalSdkPort => ({ models: list, create: async () => { throw new Error("no create in this test"); }, openStore: async () => { throw new Error("no store"); } });

describe("plugin discovery triggers", () => {
  it("registers the fallback, then discovers at setup and reloads the provider with the account catalog", async () => {
    const h = pluginHost();
    const models = vi.fn(async () => [GROK]);
    const env = { CURSOR_API_KEY: "fake-env-key" };
    const dispose = await createCursorPlugin({ local: { loadSdk: async () => port(models), env, stateRoot: "/fixture/state", warn: () => {} } }).setup(h.ctx);
    expect(h.added[0]!.models.map((m) => m.id)).toEqual(FALLBACK_SPECS.map((s) => s.id));
    await vi.waitFor(() => expect(h.reload).toHaveBeenCalledTimes(1));
    expect(models).toHaveBeenCalledWith("fake-env-key");
    expect(h.added.at(-1)!.models.map((m) => m.id)).toEqual(["grok-4.7@256k", "grok-4.7@500k"]);
    expect(h.subscribed).toEqual([[...CONNECTION_EVENTS]]);
    await dispose?.();
  });
  it("re-discovers on a connection event when the key changes", async () => {
    const h = pluginHost();
    const env: Record<string, string | undefined> = {};
    const models = vi.fn(async (key: string) => (key === "fake-new-key" ? [GROK] : [PLAIN]));
    const warn = vi.fn();
    const dispose = await createCursorPlugin({ local: { loadSdk: async () => port(models), env, stateRoot: "/fixture/state", warn } }).setup(h.ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(models).not.toHaveBeenCalled();
    expect(h.reload).not.toHaveBeenCalled();
    h.connect("fake-new-key");
    h.emit({ type: "credential.switched", data: { integrationID: "cursor", credentialID: null } });
    await vi.waitFor(() => expect(h.reload).toHaveBeenCalledTimes(1));
    expect(h.added.at(-1)!.models.map((m) => m.id)).toEqual(["grok-4.7@256k", "grok-4.7@500k"]);
    h.emit({ type: "session.idle" });
    h.emit({ type: "integration.updated", data: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(models).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    await dispose?.();
  });
  it("keeps the fallback with the warning when discovery fails, and never imports the SDK without a key", async () => {
    const h = pluginHost();
    const warn = vi.fn();
    const loadSdk = vi.fn(async () => port(async () => { throw new Error("offline"); }));
    const dispose = await createCursorPlugin({ local: { loadSdk, env: { CURSOR_API_KEY: "fake-env-key" }, stateRoot: "/fixture/state", warn } }).setup(h.ctx);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(DISCOVERY_FALLBACK_WARNING));
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.added).toHaveLength(1);
    await dispose?.();
    const keyless = pluginHost();
    const lazy = vi.fn(async () => port(async () => [GROK]));
    const stop = await createCursorPlugin({ local: { loadSdk: lazy, env: {}, stateRoot: "/fixture/state", warn } }).setup(keyless.ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lazy).not.toHaveBeenCalled();
    await stop?.();
  });
  it("does not discover when the host has no reload (list cannot be replaced)", async () => {
    const h = pluginHost({ reload: false });
    const loadSdk = vi.fn(async () => port(async () => [GROK]));
    const dispose = await createCursorPlugin({ local: { loadSdk, env: { CURSOR_API_KEY: "fake-env-key" }, stateRoot: "/fixture/state" } }).setup(h.ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(loadSdk).not.toHaveBeenCalled();
    await dispose?.();
  });
});
