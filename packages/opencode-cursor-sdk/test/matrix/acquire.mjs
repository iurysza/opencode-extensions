#!/usr/bin/env node
// Fixture acquisition for the T1 matrix. NETWORK ALLOWED; never run inside the probe sandbox.
// Runtime probes (run-matrix.mjs, run-host.mjs, run-requests.mjs) are loopback-only and only
// read what this script leaves in .fixtures.
//
// For each declared version, plus the registry's highest stable 2.x at run time (deduplicated;
// picked from the full `versions` list, not dist-tags, so a 3.x release does not drop it):
//   npm pack @opencode/cli-darwin-arm64@<v> --ignore-scripts  ->  .fixtures/inspect/cli-<v>/
//   extract                                                   ->  .fixtures/inspect/bin-<v>/package/
//   metadata (version, tarball, integrity, sha512 of tarball) ->  .fixtures/inspect/bin-<v>/acquired.json
// The tarball's sha512 must equal the registry `dist.integrity`. No install, no lockfile, no
// global state. An existing binary is reused only when its tarball still matches the registry.
// Writes .fixtures/matrix/versions.json, the version list the runtime matrix reads.
//
// Usage: node test/matrix/acquire.mjs [version ...]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DECLARED_VERSIONS, PACKAGE, binPath, latestStable2x, matrixVersions } from "./versions.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const inspect = join(repo, ".fixtures/inspect");

const die = (message) => {
  console.error(`ACQUIRE FAIL: ${message}`);
  process.exit(2);
};

function npm(args, cwd) {
  const r = spawnSync("npm", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) die(`npm ${args.join(" ")} exited ${r.status}: ${(r.stderr ?? "").slice(-400)}`);
  return r.stdout;
}

const sri = (file) => `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;

function acquire(version, dist) {
  const cliDir = join(inspect, `cli-${version}`);
  const binDir = join(inspect, `bin-${version}`);
  const tgz = join(cliDir, `opencode-cli-darwin-arm64-${version}.tgz`);
  const metaFile = join(binDir, "acquired.json");
  const meta = { package: PACKAGE, version, tarball: dist.tarball, integrity: dist.integrity, file: tgz.replace(repo, ".") };
  if (existsSync(binPath(repo, version)) && existsSync(tgz) && sri(tgz) === dist.integrity) {
    if (!existsSync(metaFile)) writeFileSync(metaFile, JSON.stringify({ ...meta, acquiredAt: "reused-existing" }, null, 2));
    return { version, action: "reused", integrity: dist.integrity };
  }
  mkdirSync(cliDir, { recursive: true });
  rmSync(tgz, { force: true });
  // cwd is the fixture dir, so npm sees no project and writes no lockfile.
  npm(["pack", `${PACKAGE}@${version}`, "--ignore-scripts", "--pack-destination", cliDir], cliDir);
  if (!existsSync(tgz)) die(`npm pack did not produce ${tgz}`);
  const actual = sri(tgz);
  if (actual !== dist.integrity) die(`${version}: tarball integrity ${actual} != registry ${dist.integrity}`);
  rmSync(binDir, { recursive: true, force: true });
  mkdirSync(binDir, { recursive: true });
  const x = spawnSync("/usr/bin/tar", ["-xzf", tgz, "-C", binDir], { encoding: "utf8" });
  if (x.status !== 0) die(`${version}: tar failed: ${x.stderr}`);
  if (!existsSync(binPath(repo, version))) die(`${version}: binary missing after extract`);
  writeFileSync(metaFile, JSON.stringify({ ...meta, acquiredAt: new Date().toISOString() }, null, 2));
  return { version, action: "fetched", integrity: dist.integrity };
}

/**
 * Creates the fixture dir (npm's cwd, so it must exist first; a fresh clone has no .fixtures),
 * then returns the highest stable 2.x from the registry version list. `npm(args, cwd)` returns
 * stdout. Throws when the registry has no stable 2.x.
 */
export function resolveLatest2x(inspectDir, npmFn) {
  mkdirSync(inspectDir, { recursive: true });
  const listed = JSON.parse(npmFn(["view", PACKAGE, "versions", "--json"], inspectDir));
  const latest = latestStable2x(Array.isArray(listed) ? listed : [listed]);
  if (!latest) throw new Error("registry lists no stable 2.x; matrix needs a human decision");
  return latest;
}

function main() {
  const requested = process.argv.slice(2);
  let latest;
  try {
    latest = resolveLatest2x(inspect, npm);
  } catch (error) {
    die(error.message);
  }
  const versions = requested.length ? requested : matrixVersions(latest);
  const results = versions.map((v) => acquire(v, JSON.parse(npm(["view", `${PACKAGE}@${v}`, "dist", "--json"], inspect))));
  mkdirSync(join(repo, ".fixtures/matrix"), { recursive: true });
  if (!requested.length) {
    writeFileSync(join(repo, ".fixtures/matrix/versions.json"), JSON.stringify({ declared: DECLARED_VERSIONS, latestAtAcquisition: latest, versions, acquired: results }, null, 2));
  }
  // Forbidden by AGENTS.md: a lockfile anywhere under the fixture tree would mean npm installed.
  const stray = readdirSync(inspect, { recursive: true }).filter((p) => String(p).endsWith("package-lock.json"));
  if (stray.length) die(`lockfile created under .fixtures/inspect: ${stray.join(", ")}`);
  console.log(JSON.stringify({ latest, results }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
