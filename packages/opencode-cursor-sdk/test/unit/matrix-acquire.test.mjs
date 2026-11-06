// Matrix acquisition helpers. Fake npm only; no network, temp dirs only.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireFixture, resolveLatest2x, validatePackageMetadata } from "../matrix/acquire.mjs";
import { binPath, cliTarget, latestStable2x } from "../matrix/versions.mjs";

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
    expect(calls).toEqual([{ args: ["view", cliTarget().package, "versions", "--json"], cwd: inspect, cwdExisted: true }]);
  });

  it.each(["x64", "arm64"])("queries the injected Linux %s package", (arch) => {
    root = mkdtempSync(join(tmpdir(), "acquire-"));
    const target = cliTarget("linux", arch);
    const calls = [];
    expect(resolveLatest2x(root, (args) => { calls.push(args); return '["2.2.5"]'; }, target)).toBe("2.2.5");
    expect(calls).toEqual([["view", `@opencode/cli-linux-${arch}`, "versions", "--json"]]);
  });

  it("rejects a registry with no stable 2.x", () => {
    root = mkdtempSync(join(tmpdir(), "acquire-"));
    expect(() => resolveLatest2x(join(root, "inspect"), () => JSON.stringify(["3.0.0", "2.0.0-rc.1"]))).toThrow(/no stable 2\.x/);
  });
});

const version = "2.2.5";
const tarballBytes = Buffer.from("offline fixture tarball");
const integrity = `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}`;
const registryMetadata = (target, pinnedVersion = version) => ({
  name: target.package, version: pinnedVersion, os: [target.platform], cpu: [target.arch],
  dist: { integrity, tarball: `https://registry.npmjs.org/${target.package}/-/cli-${target.platform}-${target.arch}-${pinnedVersion}.tgz` },
});

describe("validatePackageMetadata", () => {
  const target = cliTarget("linux", "x64");
  it.each(["2.0.0", "2.2.5"])("accepts exact Linux endpoint %s identity, OS, CPU and sha512 metadata", (endpoint) => {
    const metadata = registryMetadata(target, endpoint);
    expect(validatePackageMetadata(metadata, endpoint, target)).toEqual(metadata.dist);
  });

  it.each([
    ["package", { name: "@opencode/cli-darwin-arm64" }, /package\/version mismatch/],
    ["version", { version: "2.0.0" }, /package\/version mismatch/],
    ["OS", { os: ["darwin"] }, /OS\/CPU mismatch/],
    ["CPU", { cpu: ["arm64"] }, /OS\/CPU mismatch/],
    ["negated OS", { os: ["linux", "!linux"] }, /OS\/CPU mismatch/],
    ["missing integrity", { dist: {} }, /sha512 integrity/],
    ["weak integrity", { dist: { integrity: "sha1-abc" } }, /sha512 integrity/],
    ["foreign tarball", { dist: { integrity, tarball: "https://example.invalid/cli.tgz" } }, /unexpected registry tarball/],
  ])("rejects mismatched %s before acquisition", (_, override, error) => {
    expect(() => validatePackageMetadata({ ...registryMetadata(target), ...override }, version, target)).toThrow(error);
  });

  it("rejects a target whose package disagrees with its OS and architecture", () => {
    expect(() => validatePackageMetadata(registryMetadata(target), version, { ...target, package: "@opencode/cli-darwin-arm64" })).toThrow(/target package/);
  });

  it.each(["latest", "2.2.5-beta.1", "3.0.0", "2.02.5", "2.2.05", "../../escape"])("rejects non-pinned version %s", (invalid) => {
    expect(() => validatePackageMetadata(registryMetadata(target), invalid, target)).toThrow(/exact stable 2.x/);
  });
});

describe("acquireFixture", () => {
  let root;
  let calls;
  let extractions;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
    calls = undefined;
    extractions = undefined;
  });

  function options(target = cliTarget("linux", "x64")) {
    root ??= mkdtempSync(join(tmpdir(), "fixture-acquire-"));
    calls ??= [];
    extractions ??= [];
    return {
      repo: root, version, target, metadata: registryMetadata(target),
      npmFn(args, cwd) {
        calls.push({ args, cwd });
        writeFileSync(join(cwd, `opencode-cli-${target.platform}-${target.arch}-${version}.tgz`), tarballBytes);
      },
      extractFn(tgz, binDir) {
        extractions.push({ tgz, binDir });
        mkdirSync(join(binDir, "package/bin"), { recursive: true });
        writeFileSync(binPath(root, version), `fake ${target.package} binary`);
        writeFileSync(join(binDir, "package/package.json"), JSON.stringify({ name: target.package, version }));
      },
    };
  }

  it.each([["darwin", "arm64"], ["linux", "x64"], ["linux", "arm64"]])("packs and reuses only a verified %s/%s fixture", (platform, arch) => {
    const input = options(cliTarget(platform, arch));
    expect(acquireFixture(input).action).toBe("fetched");
    const cliDir = join(root, ".fixtures/inspect", `cli-${version}`);
    expect(calls).toEqual([{ args: ["pack", `${input.target.package}@${version}`, "--ignore-scripts", "--pack-destination", cliDir], cwd: cliDir }]);
    const meta = JSON.parse(readFileSync(join(root, ".fixtures/inspect", `bin-${version}`, "acquired.json"), "utf8"));
    expect(meta).toMatchObject({ package: input.target.package, platform, arch, integrity, version });
    expect(acquireFixture(input).action).toBe("reused");
    expect(calls).toHaveLength(1);
    expect(extractions).toHaveLength(1);
  });

  it("never reuses a Darwin binary when acquiring Linux at the same legacy binary path", () => {
    acquireFixture(options(cliTarget("darwin", "arm64")));
    const input = options(cliTarget("linux", "x64"));
    expect(acquireFixture(input).action).toBe("fetched");
    expect(readFileSync(binPath(root, version), "utf8")).toBe("fake @opencode/cli-linux-x64 binary");
    expect(extractions).toHaveLength(2);
  });

  it.each([
    ["platform", "darwin"], ["arch", "arm64"], ["package", "@opencode/cli-darwin-arm64"],
    ["version", "2.0.0"], ["integrity", "sha512-wrong"], ["binaryIntegrity", "sha512-wrong"],
    ["tarball", "https://example.invalid/old.tgz"], ["file", "./foreign.tgz"],
  ])("rebuilds rather than reuses cached metadata with mismatched %s", (field, value) => {
    const input = options();
    acquireFixture(input);
    const metaFile = join(root, ".fixtures/inspect", `bin-${version}`, "acquired.json");
    const meta = JSON.parse(readFileSync(metaFile, "utf8"));
    writeFileSync(metaFile, JSON.stringify({ ...meta, [field]: value }));
    expect(acquireFixture(input).action).toBe("extracted");
    expect(calls).toHaveLength(1); // Verified target tarball can be used without another download.
    expect(extractions).toHaveLength(2);
  });

  it.each(["missing", "malformed"])("rebuilds a fixture with %s cache metadata", (kind) => {
    const input = options();
    acquireFixture(input);
    const metaFile = join(root, ".fixtures/inspect", `bin-${version}`, "acquired.json");
    if (kind === "missing") rmSync(metaFile); else writeFileSync(metaFile, "{");
    expect(acquireFixture(input).action).toBe("extracted");
  });

  it("re-extracts a modified cached binary from the verified tarball", () => {
    const input = options();
    acquireFixture(input);
    writeFileSync(binPath(root, version), "foreign binary");
    expect(acquireFixture(input).action).toBe("extracted");
    expect(readFileSync(binPath(root, version), "utf8")).toBe("fake @opencode/cli-linux-x64 binary");
  });

  it("redownloads a modified tarball instead of trusting cached metadata", () => {
    const input = options();
    acquireFixture(input);
    writeFileSync(extractions[0].tgz, "corrupt tarball");
    expect(acquireFixture(input).action).toBe("fetched");
    expect(calls).toHaveLength(2);
  });

  it("rejects a bad downloaded integrity before extracting anything", () => {
    const input = options();
    input.metadata.dist.integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
    expect(() => acquireFixture(input)).toThrow(/tarball integrity/);
    expect(extractions).toHaveLength(0);
  });

  it("validates registry identity even when a valid cached binary exists", () => {
    const input = options();
    acquireFixture(input);
    input.metadata.cpu = ["arm64"];
    expect(() => acquireFixture(input)).toThrow(/OS\/CPU mismatch/);
    expect(calls).toHaveLength(1);
  });

  it("rejects an extracted package with foreign identity", () => {
    const input = options();
    const extract = input.extractFn;
    input.extractFn = (...args) => {
      extract(...args);
      writeFileSync(join(args[1], "package/package.json"), JSON.stringify({ name: "@opencode/cli-darwin-arm64", version }));
    };
    expect(() => acquireFixture(input)).toThrow(/extracted package identity mismatch/);
    expect(existsSync(join(root, ".fixtures/inspect", `bin-${version}`, "acquired.json"))).toBe(false);
  });
});
