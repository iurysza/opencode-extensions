import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createPolicy } from "../isolation/policy.mjs";
import { materializeMasks } from "../isolation/linux.mjs";

let root;
afterEach(() => {
  if (!root) return;
  const maskRoot = join(root, "base/.isolation-masks");
  // The creating test process owns these fixtures, not a sandboxed application.
  try { for (const name of ["0", "1", "2", "3"]) { try { chmodSync(join(maskRoot, name), 0o700); } catch {} } } catch {}
  rmSync(root, { recursive: true, force: true }); root = undefined;
});

describe("filesystem denial masks", () => {
  it("resolves symlinks, keeps file/directory types and uses mode 000, never /dev/null", () => {
    root = mkdtempSync(join(tmpdir(), "isolation-policy-"));
    const base = join(root, "base"); mkdirSync(base);
    const home = join(root, "original-home"); mkdirSync(join(home, ".config"), { recursive: true });
    const denied = join(base, "denied"); writeFileSync(denied, "fixture-only");
    const alias = join(root, "alias"); symlinkSync(join(home, ".config"), alias);
    const state = materializeMasks(base, createPolicy(home, denied, [alias]));
    expect(state.masks).toHaveLength(2);
    expect(state.masks.map(mask => mask.kind).sort()).toEqual(["directory", "file"]);
    expect(state.masks.some(mask => mask.target === alias)).toBe(false);
    for (const mask of state.masks) {
      expect(lstatSync(mask.source).mode & 0o777).toBe(0);
      expect(lstatSync(mask.source).isDirectory()).toBe(mask.kind === "directory");
      expect(mask.source).not.toBe("/dev/null");
    }
    expect(readFileSync(denied, "utf8")).toBe("fixture-only");
  });
  it("rejects a fixture base hidden beneath a read-denied target", () => {
    root = mkdtempSync(join(tmpdir(), "isolation-policy-"));
    const base = join(root, "base"); mkdirSync(base);
    expect(() => materializeMasks(base, createPolicy(root, root))).toThrow("fixture base lies inside a read-denied");
  });
});

const probe = fileURLToPath(new URL("../isolation/probe.mjs", import.meta.url));
it("standalone capability probe proves positive denials, clean env, IPv4/IPv6 driver and unix communication", () => {
  const result = spawnSync(process.execPath, [probe], { encoding: "utf8", timeout: 30000, env: { ...process.env, CURSOR_API_KEY: "fixture-not-a-key", ISOLATION_FAKE_MARKER: "1", OPENCODE_SANDBOX_BOOTSTRAPPED: "1" } });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const proof = JSON.parse(result.stdout.trim());
  expect(proof.pass).toBe(true);
  expect(proof.backend).toBe(process.platform === "linux" ? "bubblewrap" : "sandbox-exec");
  expect(proof.checks).toMatchObject({ filesystemReadDenial: true, symlinkDenial: true, extraPolicyDenial: true, driverIPv4: true, driverIPv6: true, unixSocket: true, externalIPv4Denied: true, externalIPv6Denied: true });
}, 35000);

it.skipIf(process.platform !== "linux")("Linux kernel capability proof: private proc, immutable masks, zero capabilities and no original namespace FDs; unavailable on Darwin kernel", () => {
  const result = spawnSync(process.execPath, [probe], { encoding: "utf8", timeout: 30000 });
  expect(result.status, result.stderr).toBe(0); // Missing bwrap/userns is a failure here, not a CI skip.
  expect(JSON.parse(result.stdout).checks).toMatchObject({ privateProc: true, immutableMasks: true, droppedCapabilities: true, bootstrapDescriptorsClosed: true });
}, 35000);
