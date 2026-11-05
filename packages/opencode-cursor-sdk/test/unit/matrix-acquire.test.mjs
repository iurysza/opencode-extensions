// Matrix acquisition helpers. Fake npm only; no network, temp dirs only.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLatest2x } from "../matrix/acquire.mjs";
import { latestStable2x } from "../matrix/versions.mjs";

describe("latestStable2x", () => {
  it("picks the highest stable 2.x numerically, ignoring prereleases and 3.x", () => {
    expect(latestStable2x(["0.0.0-dev-1", "1.9.9", "2.2.5", "2.10.0-beta.1", "2.9.10", "2.10.1", "2.2.40", "3.0.0", "3.1.0-rc.1"])).toBe("2.10.1");
  });

  it("returns undefined when no stable 2.x exists", () => {
    expect(latestStable2x(["1.0.0", "2.0.0-beta.1", "3.0.0"])).toBeUndefined();
    expect(latestStable2x([])).toBeUndefined();
  });
});

describe("resolveLatest2x", () => {
  let root;
  afterEach(() => root && rmSync(root, { recursive: true, force: true }));

  it("creates the fixture dir before the first npm call and reads the versions list", () => {
    root = mkdtempSync(join(tmpdir(), "acquire-"));
    const inspect = join(root, ".fixtures/inspect");
    const calls = [];
    const npm = (args, cwd) => {
      calls.push({ args, cwd, cwdExisted: existsSync(cwd) });
      return JSON.stringify(["2.2.5", "2.3.0", "3.0.0"]);
    };
    expect(resolveLatest2x(inspect, npm)).toBe("2.3.0");
    expect(calls).toEqual([{ args: ["view", "@opencode/cli-darwin-arm64", "versions", "--json"], cwd: inspect, cwdExisted: true }]);
  });

  it("rejects a registry with no stable 2.x", () => {
    root = mkdtempSync(join(tmpdir(), "acquire-"));
    expect(() => resolveLatest2x(join(root, "inspect"), () => JSON.stringify(["3.0.0", "2.0.0-rc.1"]))).toThrow(/no stable 2\.x/);
  });
});
