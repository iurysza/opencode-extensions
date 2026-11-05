#!/usr/bin/env node
// T1 real-host smoke: runs the pinned OpenCode CLI binaries with the built plugin and a
// scripted fake Cursor source. Isolated HOME/XDG under .fixtures, `env -i`, macOS sandbox
// denying non-loopback network and reads of real agent config dirs. Fails closed.
//
// Usage: node test/t1/run-host.mjs [2.0.0] [2.2.5]
// Binaries: <repo>/.fixtures/inspect/bin-<v>/package/bin/opencode (npm pack of @opencode/cli-darwin-arm64).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "../..");
const repo = resolve(pkg, "../..");
const versions = process.argv.slice(2).length ? process.argv.slice(2) : ["2.0.0", "2.2.5"];

const die = (message) => {
  console.error(`T1 FAIL-CLOSED: ${message}`);
  process.exit(2);
};
if (platform() !== "darwin") die("sandbox-exec isolation is only implemented on macOS");
if (!existsSync("/usr/bin/sandbox-exec")) die("/usr/bin/sandbox-exec missing");
if (!existsSync("/usr/bin/perl")) die("/usr/bin/perl missing; needed to observe connect() errno");
if (!existsSync(join(pkg, "dist/plugin/create.js"))) die("dist missing; run npm run build first");

const realHome = homedir();
const DENIED = "Operation not permitted"; // macOS EPERM text from a sandbox denial
const TEST_NET = "192.0.2.1:80"; // RFC 5737 TEST-NET-1: reserved, no real service
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
function requireDenied(version, what, result) {
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error) die(`${version}: cannot prove ${what} is denied: spawn error ${result.error.message}`);
  if (result.status === 0) die(`${version}: sandbox allowed ${what}`);
  if (!out.includes(DENIED)) die(`${version}: cannot prove ${what} is denied: expected "${DENIED}", got exit ${result.status}: ${JSON.stringify(out.slice(0, 300))}`);
}

function env(base) {
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

function sandboxed(base, cmd, args, cwd) {
  return spawnSync("/usr/bin/env", ["-i", ...Object.entries(env(base)).map(([k, v]) => `${k}=${v}`), "/usr/bin/sandbox-exec", "-f", join(base, "sb.sb"), cmd, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 90_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function runVersion(version) {
  const bin = join(repo, ".fixtures/inspect", `bin-${version}`, "package/bin/opencode");
  if (!existsSync(bin)) die(`missing pinned binary ${bin}`);
  const base = join(repo, ".fixtures/t1", version);
  rmSync(base, { recursive: true, force: true });
  for (const d of ["home", "config", "data", "cache", "state", "project", "oc"]) mkdirSync(join(base, d), { recursive: true });
  const sentinel = join(base, "project/SENTINEL");
  writeFileSync(join(base, "oc/opencode.json"), JSON.stringify({ plugins: [{ package: join(here, "fixture-plugin"), options: { sentinel } }] }, null, 2));
  const deniedProbe = join(realpathSync(base), "denied-probe");
  writeFileSync(deniedProbe, "t1-denied-probe\n");
  if (readFileSync(deniedProbe, "utf8") !== "t1-denied-probe\n") die(`${version}: denied probe fixture unreadable outside sandbox`);
  writeFileSync(join(base, "sb.sb"), profile(deniedProbe));
  const reported = (sandboxed(base, bin, ["--version"], base).stdout ?? "").trim();
  if (reported.replace(/^opencode v?/, "") !== version) die(`binary reports ${JSON.stringify(reported)}, expected ${version}`);

  // Isolation self-check: the same sandbox must positively deny (EPERM) a non-loopback connect and
  // reads of a denied path. DNS failures, timeouts or ENOENT are not proof. Fail closed otherwise.
  // perl reports connect() errno; curl collapses it into "Couldn't connect".
  const connect = `use IO::Socket::INET; IO::Socket::INET->new(PeerAddr => "${TEST_NET}", Timeout => 5) or die "connect: $!\\n"; print "connected\\n"`;
  requireDenied(version, `network to ${TEST_NET}`, sandboxed(base, "/usr/bin/perl", ["-e", connect], base));
  requireDenied(version, "reading the denied probe fixture", sandboxed(base, "/bin/cat", [deniedProbe], base));
  if (existsSync(join(realHome, ".config"))) requireDenied(version, "reading ~/.config", sandboxed(base, "/bin/ls", [join(realHome, ".config")], base));

  const project = join(base, "project");
  const run = sandboxed(base, bin, ["run", "--standalone", "--print-logs", "--log-level", "warn", "-m", "cursor/fake", "--format", "json", "T1 smoke"], project);
  writeFileSync(join(base, "run.out"), run.stdout ?? "");
  writeFileSync(join(base, "run.err"), run.stderr ?? "");
  const events = (run.stdout ?? "").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const sessionID = events.find((e) => e.sessionID)?.sessionID;

  let exported;
  if (sessionID) {
    const exp = sandboxed(base, bin, ["session", "export", "--standalone", sessionID], project);
    writeFileSync(join(base, "export.json"), exp.stdout ?? "");
    writeFileSync(join(base, "export.err"), exp.stderr ?? "");
    try {
      exported = JSON.parse(exp.stdout.slice(exp.stdout.indexOf("{")));
    } catch {
      exported = undefined;
    }
  }

  const storedToolParts = exported ? toolParts(exported, "cursor-native-1").length : -1;
  const storedText = exported ? JSON.stringify(exported) : "";
  const checks = {
    exit0: run.status === 0,
    pluginSetup: (run.stderr ?? "").includes(`[cursor-t1] setup host=${version}`),
    noRefusal: !(run.stderr ?? "").includes("[cursor-t1] refused"),
    noErrorEvent: !events.some((e) => e.type === "error"),
    fakeTextStreamed: events.some((e) => e.type === "text" && e.part?.text === "T1 fake turn start."),
    nativeToolCompletedWithCursorResult: events.some(
      (e) => e.type === "tool_use" && e.part?.id === "cursor-native-1" && e.part?.state?.status === "completed" && String(e.part?.state?.output).includes('"by":"cursor"'),
    ),
    nativeToolEventOnce: events.filter((e) => e.type === "tool_use" && e.part?.id === "cursor-native-1").length === 1,
    // 2.0.0 `run --format json` emits no step_finish; stored state records the finish on both versions.
    storedFinishStop: /"finish":"stop"/.test(storedText),
    // Stored AssistantTool.executed (schema session-message.ts) = provider executed, from session.tool.called.
    storedProviderExecuted: exported !== undefined && toolParts(exported, "cursor-native-1").every((part) => part.executed === true),
    storedCursorResult: exported !== undefined && toolParts(exported, "cursor-native-1").some((part) => part.state?.status === "completed" && JSON.stringify(part.state).includes('\\"by\\":\\"cursor\\"')),
    sentinelNotWritten: !existsSync(sentinel),
    exported: exported !== undefined,
    storedToolPartOnce: storedToolParts === 1,
  };
  const pass = Object.values(checks).every(Boolean);
  const summary = { version, reported, sessionID, storedToolParts, checks, pass, evidence: base.replace(realHome, "~") };
  writeFileSync(join(base, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}

/** Stored tool parts whose call id is `callId`, across all messages of an exported session. */
function toolParts(value, callId) {
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === "object") {
      if (node.type === "tool" && node.id === callId) found.push(node);
      Object.values(node).forEach(walk);
    }
  };
  walk(value);
  return found;
}

const results = versions.map(runVersion);
for (const r of results) console.log(JSON.stringify(r, null, 2));
process.exit(results.every((r) => r.pass) ? 0 : 1);
