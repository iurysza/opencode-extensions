import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { modelContextDir } from "../../src/files.js";
import type { ModelContextHost, VendorRequest } from "../../src/host.js";
import type { SystemPart } from "../../src/inject.js";
import { createModelContextPlugin, DEFAULT_SKIP_PROVIDERS, HOOK_NAMES } from "../../src/server.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "model-context-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function writeMap(dir: string, map: unknown, files: Record<string, string> = {}): void {
  writeFileSync(join(dir, "map.json"), JSON.stringify(map));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
}

const sample = {
  skipProviders: ["claude-code"],
  models: { "gpt-6.2-sol": "gpt-6.2-sol.md", "claude-opus-5-5": "claude-opus-5-5.md" },
  families: [{ pattern: "gpt-|openai", file: "gpt.md" }],
};

interface Harness {
  hooks: Map<string, (event: VendorRequest) => Promise<void> | void>;
  ctx: ModelContextHost;
}

function harness(dir: string, system = "", skipProviders?: string[]): Harness {
  const hooks = new Map<string, (event: VendorRequest) => Promise<void> | void>();
  const ctx: ModelContextHost = {
    options: skipProviders ? { dir, skipProviders } : { dir },
    agent: { get: async () => ({ data: system ? { system } : {} }) },
    session: {
      hook: async (name, callback) => {
        hooks.set(name, callback);
        return { dispose: async () => { hooks.delete(name); } };
      },
    },
  };
  return { hooks, ctx };
}

async function load(dir: string, system = "", skipProviders?: string[]): Promise<Harness> {
  const host = harness(dir, system, skipProviders);
  await createModelContextPlugin().setup(host.ctx);
  return host;
}

function request(id: string, providerID = "openai", agent = "build"): { system: SystemPart[]; event: VendorRequest } {
  const system: SystemPart[] = [
    { type: "text", text: "base" },
    { type: "text", text: "instructions AGENTS.md" },
  ];
  return { system, event: { sessionID: "ses", agent, model: { id, providerID }, system } };
}

test("dir option beats the env var, which beats ~/.agents/model-context", () => {
  expect(modelContextDir({ dir: " /opt/map " }, { OPENCODE_MODEL_CONTEXT_DIR: "/env" }, () => "/home/user")).toBe("/opt/map");
  expect(modelContextDir({}, { OPENCODE_MODEL_CONTEXT_DIR: " /env/map " }, () => "/home/user")).toBe("/env/map");
  expect(modelContextDir({}, {}, () => "/home/user")).toBe("/home/user/.agents/model-context");
  expect(modelContextDir({ dir: "   " }, {}, () => "")).toBeUndefined();
});

test("registers context, compaction, and generate", async () => {
  const dir = tempDir();
  writeMap(dir, sample, { "gpt-6.2-sol.md": "exact gpt" });
  const host = await load(dir);
  expect([...host.hooks.keys()]).toEqual([...HOOK_NAMES]);
});

test("exact id, family, and no match", async () => {
  const dir = tempDir();
  writeMap(dir, sample, { "gpt-6.2-sol.md": "exact gpt", "gpt.md": "family gpt" });
  const host = await load(dir);

  const exact = request("gpt-6.2-sol");
  await host.hooks.get("context")?.(exact.event);
  expect(exact.system.map((part) => part.text)).toEqual(["base", "exact gpt", "instructions AGENTS.md"]);
  expect(exact.system[1]?.metadata).toEqual({ modelContext: true, file: "gpt-6.2-sol.md" });

  const family = request("gpt-9-unknown");
  await host.hooks.get("compaction")?.(family.event);
  expect(family.system[1]?.text).toBe("family gpt");

  const none = request("mystery-1", "modelctx");
  await host.hooks.get("generate")?.(none.event);
  expect(none.system.some((part) => part.metadata?.modelContext === true)).toBe(false);
});

test("a missing map, a missing prompt file, and an empty prompt file do nothing", async () => {
  const missingMap = tempDir();
  const host = await load(missingMap);
  const first = request("gpt-6.2-sol");
  await host.hooks.get("context")?.(first.event);
  expect(first.system).toHaveLength(2);

  const missingFile = tempDir();
  writeMap(missingFile, sample);
  const secondHost = await load(missingFile);
  const second = request("gpt-6.2-sol");
  await secondHost.hooks.get("context")?.(second.event);
  expect(second.system).toHaveLength(2);

  const emptyFile = tempDir();
  writeMap(emptyFile, sample, { "gpt-6.2-sol.md": "  \n" });
  const thirdHost = await load(emptyFile);
  const third = request("gpt-6.2-sol");
  await thirdHost.hooks.get("context")?.(third.event);
  expect(third.system).toHaveLength(2);
});

test("skips the map provider, the default provider, and an extra option", async () => {
  const dir = tempDir();
  writeMap(dir, sample, { "claude-opus-5-5.md": "claude", "gpt-6.2-sol.md": "gpt" });
  const host = await load(dir, "", ["other-bridge"]);

  for (const providerID of ["claude-code", ...DEFAULT_SKIP_PROVIDERS, "other-bridge"]) {
    const turn = request("claude-opus-5-5", providerID);
    await host.hooks.get("context")?.(turn.event);
    expect(turn.system.some((part) => part.metadata?.modelContext === true), providerID).toBe(false);
  }

  const kept = request("gpt-6.2-sol", "cursor");
  await host.hooks.get("context")?.(kept.event);
  expect(kept.system[1]?.text).toBe("gpt");
});

test("skips an agent that has its own system", async () => {
  const dir = tempDir();
  writeMap(dir, sample, { "gpt-6.2-sol.md": "gpt" });
  const host = await load(dir, "custom system");
  const turn = request("gpt-6.2-sol");
  await host.hooks.get("context")?.(turn.event);
  expect(turn.system).toHaveLength(2);
});

test("invalid JSON does not throw and does not insert a part", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "map.json"), "{");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const host = await load(dir);
  const turn = request("gpt-6.2-sol");
  await expect(host.hooks.get("context")?.(turn.event)).resolves.toBeUndefined();
  await host.hooks.get("context")?.(turn.event);
  expect(turn.system).toHaveLength(2);
  expect(error).toHaveBeenCalledTimes(1);
  expect(String(error.mock.calls[0]?.[0])).toContain("model-context:");
});

test("a host without session.hook disables itself with one line", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const ctx = { agent: { get: async () => ({ data: {} }) }, session: {} } as unknown as ModelContextHost;
  const cleanup = await createModelContextPlugin().setup(ctx);
  await cleanup();
  expect(error).toHaveBeenCalledTimes(1);
  expect(error.mock.calls[0]?.[0]).toBe("model-context: disabled, this host has no session.hook");
});

test("a rejected hook name is logged once and the others still register", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const hooks = new Map<string, (event: VendorRequest) => Promise<void> | void>();
  const ctx: ModelContextHost = {
    agent: { get: async () => ({ data: {} }) },
    session: {
      hook: async (name, callback) => {
        if (name === "generate") throw new Error("no generate");
        hooks.set(name, callback);
        return { dispose: async () => undefined };
      },
    },
  };
  await createModelContextPlugin().setup(ctx);
  expect([...hooks.keys()]).toEqual(["context", "compaction"]);
  expect(error).toHaveBeenCalledTimes(1);
  expect(String(error.mock.calls[0]?.[0])).toContain("hook generate is unavailable");
});
