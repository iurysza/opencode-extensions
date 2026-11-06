// T1 compatibility matrix (plan.md "T1 compatibility matrix"). Shared by acquisition and runtime.
import { join } from "node:path";

const CLI_PACKAGES = Object.freeze({
  "darwin-arm64": "@opencode/cli-darwin-arm64",
  "linux-x64": "@opencode/cli-linux-x64",
  "linux-arm64": "@opencode/cli-linux-arm64",
});

/** Explicit supported targets, confirmed in @opencode/cli's public endpoint metadata. */
export function cliTarget(platform = process.platform, arch = process.arch) {
  const packageName = CLI_PACKAGES[`${platform}-${arch}`];
  if (!packageName) throw new Error(`unsupported CLI fixture target ${platform}/${arch}; supported: darwin/arm64, linux/x64, linux/arm64`);
  return Object.freeze({ platform, arch, package: packageName });
}
export const DECLARED_VERSIONS = ["2.0.0", "2.0.3", "2.0.4", "2.0.20", "2.0.21", "2.0.32", "2.1.0", "2.2.0", "2.2.3", "2.2.5"];

/** Declared versions plus the latest stable 2.x, deduplicated, in declared order. */
export const matrixVersions = (latest) => [...new Set([...DECLARED_VERSIONS, latest])];

/**
 * Highest stable 2.x (plain X.Y.Z, no prerelease) from the registry's full version list, or
 * undefined when none exists. Independent of dist-tags, so a 3.x release does not hide 2.x.
 */
export function latestStable2x(versions) {
  const stable = versions
    .map((v) => /^2\.(\d+)\.(\d+)$/.exec(String(v)))
    .filter((m) => m !== null)
    .map((m) => ({ v: m[0], minor: Number(m[1]), patch: Number(m[2]) }));
  stable.sort((a, b) => b.minor - a.minor || b.patch - a.patch);
  return stable[0]?.v;
}

export const binPath = (repo, version) => join(repo, ".fixtures/inspect", `bin-${version}`, "package/bin/opencode");
