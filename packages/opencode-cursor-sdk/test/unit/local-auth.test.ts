import type { Plugin } from "@opencode/plugin";
import { describe, expect, it, vi } from "vitest";
import { resolveHostKey } from "../../src/plugin/local.js";

function host({ key, activeEnv = false, resolved = true }: { key?: string; activeEnv?: boolean; resolved?: boolean } = {}) {
  const connection = { type: "credential", id: "cred_fake", method: "key", label: "fake" };
  const resolve = vi.fn(async () => resolved ? { type: "key", key } : undefined);
  // Structural stand-in for the public 2.0.0/2.2.5 integration methods only.
  return { context: { integration: {
    get: async () => ({ data: { connections: key === undefined ? [] : [connection] } }),
    connection: { active: async () => activeEnv ? { type: "env", names: ["CURSOR_API_KEY"] } : key === undefined ? undefined : connection, resolve },
  } } as unknown as Pick<Plugin.Context, "integration">, resolve };
}
describe("local auth port", () => {
  it("prefers the host key to env", async () => {
    const f = host({ key: "host-fake" });
    expect(await resolveHostKey(f.context, { CURSOR_API_KEY: "env-fake" })).toBe("host-fake");
    expect(f.resolve).toHaveBeenCalledOnce();
  });
  it("still prefers a stored key when the host active connection is env", async () => {
    const f = host({ key: "host-fake", activeEnv: true });
    expect(await resolveHostKey(f.context, { CURSOR_API_KEY: "env-fake" })).toBe("host-fake");
  });
  it("uses only explicit env when no stored key exists", async () => {
    const f = host();
    expect(await resolveHostKey(f.context, { CURSOR_API_KEY: "env-fake" })).toBe("env-fake");
    expect(await resolveHostKey(f.context, {})).toBeUndefined();
    expect(f.resolve).not.toHaveBeenCalled();
  });
  it("does not hide an invalid explicit host credential behind env", async () => {
    const f = host({ key: "host-fake", resolved: false });
    await expect(resolveHostKey(f.context, { CURSOR_API_KEY: "env-fake" })).rejects.toMatchObject({ code: "auth" });
  });
});
