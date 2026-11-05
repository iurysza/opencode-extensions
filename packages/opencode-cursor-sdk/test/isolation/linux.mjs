import { spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, createServer } from "node:net";
import { bootstrapArgs, isolatedEnv, isWithin } from "./policy.mjs";

const bootstrap = fileURLToPath(new URL("./bootstrap.mjs", import.meta.url));
const remedy = "Install bubblewrap (Debian/Ubuntu: sudo apt install bubblewrap libc-bin). Ask an administrator to check unprivileged user/network/PID namespaces and the AppArmor bwrap userns policy. Do not weaken sysctls automatically.";
let context;
export function linuxFailure(message) { return new Error(`Linux isolation unavailable: ${message}. ${remedy}`); }
export function namespaceIds() {
  return { net: readlinkSync("/proc/self/ns/net"), pid: readlinkSync("/proc/self/ns/pid") };
}
const validNamespaceIds = ids => /^net:\[\d+\]$/u.test(ids.net) && /^pid:\[\d+\]$/u.test(ids.pid);
export function validateNamespaceEvidence({ original, actual, initPid, interfaces, routes, routes6 }) {
  if (!validNamespaceIds(original) || !validNamespaceIds(actual) || original.net === actual.net || original.pid === actual.pid) throw linuxFailure("bootstrap did not change network and PID namespaces");
  if (initPid !== actual.pid) throw linuxFailure("/proc is not private to the PID namespace");
  if (interfaces.length !== 1 || interfaces[0] !== "lo") throw linuxFailure("private network must contain only lo");
  if (routes.some(line => line.trim().split(/\s+/u)[0] !== "lo") || routes6.some(line => line.trim().split(/\s+/u).at(-1) !== "lo")) throw linuxFailure("private network has an egress route");
}
function connection(host, port) {
  return new Promise(resolve => {
    const socket = connect({ host, port });
    const end = code => { socket.destroy(); resolve(code); };
    socket.once("connect", () => end("CONNECTED")); socket.once("error", error => end(error.code));
    socket.setTimeout(2000, () => end("TIMEOUT"));
  });
}
export async function proveNetwork() {
  for (const host of ["127.0.0.1", "::1"]) {
    const server = createServer(socket => socket.end());
    try {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, host, resolve); });
      if (await connection(host, server.address().port) !== "CONNECTED") throw linuxFailure(`${host} loopback connection failed`);
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
  for (const host of ["192.0.2.1", "2001:db8::1"]) {
    const code = await connection(host, 80);
    if (!["ENETUNREACH", "EHOSTUNREACH", "EACCES", "EPERM"].includes(code)) throw linuxFailure(`external network denial was not positive (${host}: ${code})`);
  }
}

/** Called only by the dedicated bootstrap, before importing the trusted runner. */
export async function acceptBootstrap(payload) {
  if (context || payload?.guard !== "one-reexec" || typeof payload.originalHome !== "string" || !isAbsolute(payload.originalHome) || !Array.isArray(payload.argv) || payload.argv.length < 2 || payload.argv.some(arg => typeof arg !== "string") || !isAbsolute(payload.argv[1]) || payload.argv[1] === bootstrap || typeof payload.bwrap !== "string" || !isAbsolute(payload.bwrap)) throw linuxFailure("invalid or repeated bootstrap");
  // An environment variable is never evidence. These are inherited namespace descriptors,
  // not namespace IDs recomputed after reexec. Close both before any tested app can start.
  const original = { net: readlinkSync("/proc/self/fd/3"), pid: readlinkSync("/proc/self/fd/4") };
  if (!validNamespaceIds(original)) throw linuxFailure("bootstrap requires inherited original namespace descriptors");
  closeSync(3); closeSync(4);
  const actual = namespaceIds();
  const interfaces = readFileSync("/proc/self/net/dev", "utf8").split("\n").slice(2).filter(line => line.includes(":")).map(line => line.split(":")[0].trim());
  validateNamespaceEvidence({ original, actual, initPid: readlinkSync("/proc/1/ns/pid"), interfaces,
    routes: readFileSync("/proc/self/net/route", "utf8").trim().split("\n").slice(1).filter(Boolean),
    routes6: readFileSync("/proc/self/net/ipv6_route", "utf8").trim().split("\n").filter(Boolean) });
  await proveNetwork();
  context = { originalHome: payload.originalHome, namespace: actual, bwrap: payload.bwrap };
}
export function requirePrivateLinux() {
  if (!context) throw linuxFailure("no validated bootstrap; refusing host --share-net");
  const actual = namespaceIds();
  if (actual.net !== context.namespace.net || actual.pid !== context.namespace.pid) throw linuxFailure("namespace changed since validation");
  return context;
}
export function bootstrappedHome() { return context?.originalHome; }

export function ensureLinux(originalHome) {
  if (context) return requirePrivateLinux();
  const found = (process.env.PATH ?? "/usr/bin:/bin").split(":").filter(isAbsolute).map(dir => join(dir, "bwrap")).find(path => {
    try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
  });
  if (!found) throw linuxFailure("bwrap is missing");
  const bwrap = realpathSync(found);
  const root = mkdtempSync(join(tmpdir(), "opencode-isolation-bootstrap-"));
  for (const d of ["home", "config", "data", "cache", "state", "oc"]) mkdirSync(join(root, d));
  let net, pid, result;
  try {
    net = openSync("/proc/self/ns/net", "r"); pid = openSync("/proc/self/ns/pid", "r");
    const payload = { guard: "one-reexec", originalHome, argv: process.argv, bwrap };
    result = spawnSync(bwrap, bootstrapArgs(process.execPath, bootstrap, payload), {
      stdio: ["inherit", "inherit", "inherit", net, pid],
      // The trusted driver gets a clean HOME too. Preserve only local harness selectors.
      env: { ...isolatedEnv(root), PATH: process.env.PATH ?? "/usr/bin:/bin", ...(process.env.CONTROL_TOPOLOGY ? { CONTROL_TOPOLOGY: process.env.CONTROL_TOPOLOGY } : {}) },
    });
    if (result.error) throw linuxFailure(`bootstrap spawn failed (${result.error.code})`);
  } catch (error) {
    if (error.message.startsWith("Linux isolation unavailable:")) throw error;
    throw linuxFailure(`cannot establish namespace bootstrap (${error.code ?? "unknown capability error"})`);
  } finally {
    for (const fd of [net, pid]) if (fd !== undefined) closeSync(fd);
    rmSync(root, { recursive: true, force: true });
  }
  if (result.signal) process.kill(process.pid, result.signal);
  if (result.status !== 0) console.error(`Linux bootstrap/runner failed (${result.status ?? result.signal}). If namespace setup failed: ${remedy}`);
  process.exit(result.status ?? 2); // Only the validated reexec runs the rest of the entrypoint.
}

export function materializeMasks(base, policy) {
  base = realpathSync(base);
  const maskRoot = join(base, ".isolation-masks"); mkdirSync(maskRoot, { mode: 0o700 });
  const targets = new Map();
  for (const path of policy.readDenials) {
    if (!existsSync(path)) continue;
    const canonical = realpathSync(path);
    const kind = statSync(canonical).isDirectory() ? "directory" : "file";
    if (!statSync(canonical).isDirectory() && !statSync(canonical).isFile()) throw linuxFailure("read denial target must be a regular file or directory");
    // Mount canonical destinations; the original symlink resolves to the same mask.
    targets.set(canonical, kind);
  }
  const masks = [];
  for (const [target, kind] of [...targets].sort(([a], [b]) => a.length - b.length)) {
    if (isWithin(target, base)) throw linuxFailure("fixture base lies inside a read-denied directory");
    if (masks.some(mask => isWithin(mask.target, target))) continue;
    const source = join(maskRoot, String(masks.length));
    if (kind === "directory") mkdirSync(source); else writeFileSync(source, "");
    chmodSync(source, 0); masks.push({ source, target, kind });
  }
  return { masks, maskRoot };
}

export function nodeAliasFor(policy, base) {
  const source = realpathSync(process.execPath);
  if (!policy.readDenials.some(path => isWithin(path, source) || (existsSync(path) && isWithin(realpathSync(path), source)))) return undefined;
  const libs = spawnSync("/usr/bin/ldd", [source], { encoding: "utf8", timeout: 5000 });
  if (libs.error || libs.status !== 0 || `${libs.stdout}${libs.stderr}`.includes("not found")) throw linuxFailure("cannot inspect Node shared libraries; use a system Node executable");
  const paths = `${libs.stdout}${libs.stderr}`.match(/\/[^\s()]+/gu) ?? [];
  if (paths.some(path => !["/lib", "/lib64", "/usr/lib", "/usr/lib64"].some(dir => isWithin(dir, realpathSync(path))))) throw linuxFailure("Node uses non-system shared libraries under a denied directory; use a system Node executable");
  const target = join(realpathSync(base), ".isolation-node");
  writeFileSync(target, "", { mode: 0o700 });
  return { source, target };
}
