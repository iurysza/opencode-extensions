// Unit tests with hand-written fake host contexts. These are NOT real-host proof (see test/t1).
import { describe, expect, it, vi } from "vitest";
import { parseHost, RefusalMessage } from "../../src/compat/host.js";
import { registerProvider } from "../../src/compat/provider-registration.js";
import { createCursorPlugin } from "../../src/plugin/create.js";
import { codingOnly } from "../../src/provider/language-model.js";

const noop = async () => ({ dispose: async () => {} });

function catalogEditor() {
  // Mirrors 2.0.0 core semantics: update() creates a missing provider or model.
  const providers = new Map<string, { provider: Record<string, unknown>; models: Map<string, Record<string, unknown>> }>();
  const record = (id: string) => {
    let current = providers.get(id);
    if (!current) providers.set(id, (current = { provider: { id, name: id, activation: "auto", package: "" }, models: new Map() }));
    return current;
  };
  return {
    providers,
    editor: {
      provider: { update: (id: string, fn: (p: Record<string, unknown>) => void) => fn(record(id).provider) },
      model: {
        update: (pid: string, mid: string, fn: (m: Record<string, unknown>) => void) => {
          const r = record(pid);
          const model = r.models.get(mid) ?? {};
          r.models.set(mid, model);
          fn(model);
        },
      },
    },
  };
}

function context(overrides: { version?: string; provider?: boolean; catalog?: boolean; synthetic?: boolean; sessionHook?: boolean; rpc?: boolean; aisdk?: boolean; workspaceID?: string } = {}) {
  const catalog = catalogEditor();
  const added: unknown[] = [];
  const hooks: { name: string; providerID?: string }[] = [];
  const ctx: Record<string, unknown> = {
    app: { name: "opencode", version: overrides.version ?? "2.2.5", channel: "latest" },
    location: { directory: "/tmp", workspaceID: overrides.workspaceID },
    session: {
      ...(overrides.synthetic === false ? {} : { synthetic: noop }),
      ...(overrides.sessionHook === false
        ? {}
        : { hook: vi.fn(async (name: string, _cb: unknown, opts?: { providerID?: string }) => (hooks.push({ name: `session.${name}`, providerID: opts?.providerID }), { dispose: async () => {} })) }),
    },
    // Real 2.x hosts expose rpc as a callable client factory with `register` attached (found in T1).
    rpc: overrides.rpc === false ? {} : Object.assign(() => ({}), { register: noop }),
  };
  if (overrides.aisdk !== false)
    ctx.aisdk = { hook: vi.fn(async (name: string, _cb: unknown, opts?: { providerID?: string }) => (hooks.push({ name, providerID: opts?.providerID }), { dispose: async () => {} })) };
  if (overrides.provider) ctx.provider = { transform: async (cb: (e: unknown) => void) => cb({ add: (input: unknown) => added.push(input) }) };
  if (overrides.catalog) ctx.catalog = { transform: async (cb: (e: unknown) => void) => cb(catalog.editor) };
  return { ctx, added, catalog, hooks };
}

describe("host capability parsing (fail closed)", () => {
  it.each([
    ["1.18.33", "unsupported-version"],
    ["3.0.0", "unsupported-version"],
    ["garbage", "unsupported-version"],
  ] as const)("refuses host version %s", (version, reason) => {
    const result = parseHost(context({ version, provider: true }).ctx);
    expect(result).toEqual({ _tag: "err", error: { reason, message: RefusalMessage[reason] } });
  });

  it.each([
    [{ provider: false, catalog: false }, "missing-registration"],
    [{ provider: true, aisdk: false }, "missing-aisdk"],
    [{ provider: true, synthetic: false }, "missing-session-synthetic"],
    [{ provider: true, sessionHook: false }, "missing-session-hook"],
    [{ provider: true, rpc: false }, "missing-rpc"],
  ] as const)("refuses missing capability %o", (overrides, reason) => {
    const result = parseHost(context(overrides).ctx);
    expect(result._tag).toBe("err");
    if (result._tag === "err") expect(result.error.reason).toBe(reason);
  });

  it("prefers provider registration when both exist (2.0.4+)", () => {
    const result = parseHost(context({ provider: true, catalog: true }).ctx);
    expect(result._tag === "ok" && result.value.registration._tag).toBe("provider");
  });

  it("refused plugin registers nothing and reports the fixed message", async () => {
    const { ctx, added } = context({ version: "1.18.33", provider: true });
    const onRefusal = vi.fn();
    await createCursorPlugin({ lanes: codingOnly(() => [][Symbol.iterator]() as never), models: [], onRefusal }).setup(ctx);
    expect(onRefusal).toHaveBeenCalledWith({ reason: "unsupported-version", message: RefusalMessage["unsupported-version"] });
    expect(added).toEqual([]);
  });

  it("registers nothing in a remote workspace (F-60)", async () => {
    const { ctx, added, hooks } = context({ provider: true, workspaceID: "wrk_1" });
    await createCursorPlugin({ lanes: codingOnly(() => [][Symbol.iterator]() as never), models: [{ id: "m", name: "M", context: 1, output: 1 }] }).setup(ctx);
    expect(added).toEqual([]);
    expect(hooks).toEqual([]);
  });
});

describe("provider registration across the 2.0.4 boundary", () => {
  const spec = { id: "cursor", name: "Cursor", package: "aisdk:file:///x.js", models: [{ id: "m1", name: "M1", context: 10, output: 5 }] };

  it("2.0.0-2.0.3: catalog.provider.update and catalog.model.update create the provider and model", async () => {
    const { ctx, catalog } = context({ version: "2.0.3", catalog: true });
    const host = parseHost(ctx);
    if (host._tag !== "ok") throw new Error("expected ok");
    expect(host.value.registration._tag).toBe("catalog");
    await registerProvider(host.value.registration, spec);
    const record = catalog.providers.get("cursor");
    expect(record?.provider).toMatchObject({ id: "cursor", activation: "enabled", package: "aisdk:file:///x.js" });
    expect(record?.models.get("m1")).toMatchObject({ id: "m1", providerID: "cursor", limit: { context: 10, output: 5 } });
  });

  it("2.0.4+: provider.add registers info and models", async () => {
    const { ctx, added } = context({ version: "2.0.4", provider: true });
    const host = parseHost(ctx);
    if (host._tag !== "ok") throw new Error("expected ok");
    await registerProvider(host.value.registration, spec);
    expect(added).toEqual([
      {
        info: { id: "cursor", name: "Cursor", activation: "enabled", package: "aisdk:file:///x.js" },
        models: [expect.objectContaining({ id: "m1", modelID: "m1", providerID: "cursor" })],
      },
    ]);
  });

  it("plugin hooks only its own provider", async () => {
    const { ctx, hooks } = context({ provider: true });
    await createCursorPlugin({ lanes: codingOnly(() => [][Symbol.iterator]() as never), models: [] }).setup(ctx);
    expect(hooks).toEqual([
      { name: "session.model.request", providerID: "cursor" },
      { name: "sdk", providerID: "cursor" },
      { name: "language", providerID: "cursor" },
    ]);
  });
});
