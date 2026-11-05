// Shared isolation for real-host probes (T1, T2): `env -i`, isolated HOME/XDG under a fixture
// base, and a macOS sandbox that denies non-loopback network and reads of real agent config
// dirs. `prepareIsolatedBase` proves the denials positively (EPERM) or calls `die`. Fails closed.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const realHome = homedir();
const DENIED = "Operation not permitted"; // macOS EPERM text from a sandbox denial
const TEST_NET = "192.0.2.1:80"; // RFC 5737 TEST-NET-1: reserved, no real service

/** Fails closed unless the host tools needed to enforce and observe isolation exist. */
export function requireIsolationTools(die) {
  if (platform() !== "darwin") die("sandbox-exec isolation is only implemented on macOS");
  if (!existsSync("/usr/bin/sandbox-exec")) die("/usr/bin/sandbox-exec missing");
  if (!existsSync("/usr/bin/perl")) die("/usr/bin/perl missing; needed to observe connect() errno");
}

// `deniedProbe` is a fixture file inside the isolated base; the profile denies it by literal
// real path, so a successful denial proves file-read rules are enforced without touching HOME.
const profile = (deniedProbe) => `(version 1)
(allow default)
(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))
(allow network-outbound (remote unix-socket))
(deny file-read* ${[".config", ".pi", ".claude", ".agents", ".cursor", ".local", ".codex", ".ssh", ".npmrc"]
  .map((d) => `(subpath "${join(realHome, d)}")`)
  .join(" ")} (literal "${deniedProbe}"))
`;

/** Fails closed unless `result` failed with the sandbox EPERM text. Other errors are not proof. */
function requireDenied(die, label, what, result) {
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error) die(`${label}: cannot prove ${what} is denied: spawn error ${result.error.message}`);
  if (result.status === 0) die(`${label}: sandbox allowed ${what}`);
  if (!out.includes(DENIED)) die(`${label}: cannot prove ${what} is denied: expected "${DENIED}", got exit ${result.status}: ${JSON.stringify(out.slice(0, 300))}`);
}

function isolatedEnv(base) {
  return {
    HOME: join(base, "home"),
    XDG_CONFIG_HOME: join(base, "config"),
    XDG_DATA_HOME: join(base, "data"),
    XDG_CACHE_HOME: join(base, "cache"),
    XDG_STATE_HOME: join(base, "state"),
    PATH: "/usr/bin:/bin",
    OPENCODE_CONFIG: join(base, "oc/opencode.json"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
  };
}

/** Runs `cmd` under `env -i` with the isolated env and the base's sandbox profile. */
export function sandboxed(base, cmd, args, cwd) {
  return spawnSync("/usr/bin/env", ["-i", ...Object.entries(isolatedEnv(base)).map(([k, v]) => `${k}=${v}`), "/usr/bin/sandbox-exec", "-f", join(base, "sb.sb"), cmd, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 90_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Recreates `base` with isolated HOME/XDG/project/oc dirs, writes the sandbox profile and proves,
 * inside that sandbox, that a non-loopback connect, a denied fixture file and ~/.config all fail
 * with EPERM. Calls `die` otherwise.
 */
export function prepareIsolatedBase(base, label, die) {
  rmSync(base, { recursive: true, force: true });
  for (const d of ["home", "config", "data", "cache", "state", "project", "oc"]) mkdirSync(join(base, d), { recursive: true });
  const deniedProbe = join(realpathSync(base), "denied-probe");
  writeFileSync(deniedProbe, "denied-probe\n");
  if (readFileSync(deniedProbe, "utf8") !== "denied-probe\n") die(`${label}: denied probe fixture unreadable outside sandbox`);
  writeFileSync(join(base, "sb.sb"), profile(deniedProbe));
  // perl reports connect() errno; curl collapses it into "Couldn't connect".
  const connect = `use IO::Socket::INET; IO::Socket::INET->new(PeerAddr => "${TEST_NET}", Timeout => 5) or die "connect: $!\\n"; print "connected\\n"`;
  requireDenied(die, label, `network to ${TEST_NET}`, sandboxed(base, "/usr/bin/perl", ["-e", connect], base));
  requireDenied(die, label, "reading the denied probe fixture", sandboxed(base, "/bin/cat", [deniedProbe], base));
  if (existsSync(join(realHome, ".config"))) requireDenied(die, label, "reading ~/.config", sandboxed(base, "/bin/ls", [join(realHome, ".config")], base));
}

/** Fails closed unless the pinned binary at `bin` reports `version` inside the sandbox. */
export function requireBinaryVersion(base, bin, version, die) {
  if (!existsSync(bin)) die(`missing pinned binary ${bin}`);
  const reported = (sandboxed(base, bin, ["--version"], base).stdout ?? "").trim();
  if (reported.replace(/^opencode v?/, "") !== version) die(`binary reports ${JSON.stringify(reported)}, expected ${version}`);
  return reported;
}

export { realHome };
