#!/usr/bin/env node
// NETWORK ALLOWED: acquisition only, never run inside the probe sandbox.
// npm pack --ignore-scripts downloads the selected OS/architecture package. Verify registry
// identity and sha512 before extraction; keep bin-<version>/package/bin/opencode compatible.
// Cached binaries require matching target metadata plus tarball and binary integrity.
// Usage: node test/matrix/acquire.mjs [version ...]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DECLARED_VERSIONS, binPath, cliTarget, latestStable2x, matrixVersions } from "./versions.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const inspect = join(repo, ".fixtures/inspect");

function npm(args, cwd) {
  const r = spawnSync("npm", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`npm ${args.join(" ")} exited ${r.status}: ${(r.stderr ?? "").slice(-400)}`);
  return r.stdout;
}

const sri = (file) => `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;

function requireVersion(version) {
  if (!/^2\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error(`expected an exact stable 2.x fixture version, got ${version}`);
}

/** Validate registry data before trusting a tarball or an existing fixture. */
export function validatePackageMetadata(metadata, version, target = cliTarget()) {
  requireVersion(version);
  const supported = cliTarget(target.platform, target.arch);
  if (target.package !== supported.package) throw new Error("CLI target package does not match its OS/architecture");
  if (metadata?.name !== target.package || metadata?.version !== version) throw new Error(`${version}: registry package/version mismatch for ${target.package}`);
  if (!Array.isArray(metadata.os) || !metadata.os.includes(target.platform) || metadata.os.includes(`!${target.platform}`)
      || !Array.isArray(metadata.cpu) || !metadata.cpu.includes(target.arch) || metadata.cpu.includes(`!${target.arch}`)) {
    throw new Error(`${version}: registry OS/CPU mismatch for ${target.platform}/${target.arch}`);
  }
  const dist = metadata.dist;
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(dist?.integrity ?? "")) throw new Error(`${version}: registry lacks valid sha512 integrity`);
  const expectedTarball = `https://registry.npmjs.org/${target.package}/-/${target.package.split("/")[1]}-${version}.tgz`;
  if (dist.tarball !== expectedTarball) throw new Error(`${version}: unexpected registry tarball for ${target.package}`);
  return dist;
}

function extract(tgz, binDir) {
  const r = spawnSync("/usr/bin/tar", ["-xzf", tgz, "-C", binDir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tar failed: ${r.stderr ?? r.error?.message}`);
}

/** Inject npm/extraction for offline tests. This function never executes the acquired binary. */
export function acquireFixture({ repo, version, metadata, target = cliTarget(), npmFn = npm, extractFn = extract }) {
  const dist = validatePackageMetadata(metadata, version, target);
  const cliDir = join(repo, ".fixtures/inspect", `cli-${version}`);
  const binDir = join(repo, ".fixtures/inspect", `bin-${version}`);
  const tgz = join(cliDir, `${target.package.slice(1).replaceAll("/", "-")}-${version}.tgz`);
  const binary = binPath(repo, version);
  const metaFile = join(binDir, "acquired.json");
  const meta = { package: target.package, platform: target.platform, arch: target.arch, version, tarball: dist.tarball, integrity: dist.integrity, file: `./${relative(repo, tgz)}` };
  const verifiedTarball = existsSync(tgz) && sri(tgz) === dist.integrity;
  let cached;
  try { cached = JSON.parse(readFileSync(metaFile, "utf8")); } catch { /* Missing or invalid metadata requires fresh extraction. */ }
  if (verifiedTarball && existsSync(binary)
      && Object.entries(meta).every(([key, value]) => cached?.[key] === value)
      && cached.binaryIntegrity === sri(binary)) {
    return { version, action: "reused", package: target.package, integrity: dist.integrity };
  }
  mkdirSync(cliDir, { recursive: true });
  if (!verifiedTarball) {
    rmSync(tgz, { force: true });
    // cwd is the fixture dir, so npm sees no project and writes no lockfile.
    npmFn(["pack", `${target.package}@${version}`, "--ignore-scripts", "--pack-destination", cliDir], cliDir);
    if (!existsSync(tgz)) throw new Error(`npm pack did not produce ${tgz}`);
    if (sri(tgz) !== dist.integrity) throw new Error(`${version}: tarball integrity does not match registry`);
  }
  rmSync(binDir, { recursive: true, force: true });
  mkdirSync(binDir, { recursive: true });
  extractFn(tgz, binDir);
  if (!existsSync(binary)) throw new Error(`${version}: binary missing after extract`);
  const packed = JSON.parse(readFileSync(join(binDir, "package/package.json"), "utf8"));
  if (packed.name !== target.package || packed.version !== version) throw new Error(`${version}: extracted package identity mismatch`);
  writeFileSync(metaFile, JSON.stringify({ ...meta, binaryIntegrity: sri(binary), acquiredAt: new Date().toISOString() }, null, 2));
  return { version, action: verifiedTarball ? "extracted" : "fetched", package: target.package, integrity: dist.integrity };
}

/** Create npm's cwd before resolving the highest stable 2.x for this target. */
export function resolveLatest2x(inspectDir, npmFn, target = cliTarget()) {
  mkdirSync(inspectDir, { recursive: true });
  const listed = JSON.parse(npmFn(["view", target.package, "versions", "--json"], inspectDir));
  const latest = latestStable2x(Array.isArray(listed) ? listed : [listed]);
  if (!latest) throw new Error("registry lists no stable 2.x; matrix needs a human decision");
  return latest;
}

function main() {
  const target = cliTarget(); // Unsupported platforms fail before npm or fixture changes.
  const requested = process.argv.slice(2);
  requested.forEach(requireVersion);
  mkdirSync(inspect, { recursive: true });
  // Endpoint-only acquisition does not resolve or download a moving latest version.
  const latest = requested.length ? undefined : resolveLatest2x(inspect, npm, target);
  const versions = requested.length ? requested : matrixVersions(latest);
  const results = versions.map((version) => acquireFixture({ repo, version, target,
    metadata: JSON.parse(npm(["view", `${target.package}@${version}`, "name", "version", "os", "cpu", "dist", "--json"], inspect)),
  }));
  mkdirSync(join(repo, ".fixtures/matrix"), { recursive: true });
  if (!requested.length) {
    writeFileSync(join(repo, ".fixtures/matrix/versions.json"), JSON.stringify({ target, declared: DECLARED_VERSIONS, latestAtAcquisition: latest, versions, acquired: results }, null, 2));
  }
  // A lockfile under the fixture tree would mean npm installed, forbidden by AGENTS.md.
  const stray = readdirSync(inspect, { recursive: true }).filter((p) => String(p).endsWith("package-lock.json"));
  if (stray.length) throw new Error(`lockfile created under .fixtures/inspect: ${stray.join(", ")}`);
  console.log(JSON.stringify({ target, latest, results }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    console.error(`ACQUIRE FAIL: ${error.message}`);
    process.exitCode = 2;
  }
}
