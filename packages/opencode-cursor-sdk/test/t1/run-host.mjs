#!/usr/bin/env node
// T1 real-host smoke: runs the pinned OpenCode CLI binaries with the built plugin and a
// scripted fake Cursor source. Isolated HOME/XDG under .fixtures, `env -i`, macOS sandbox
// denying non-loopback network and reads of real agent config dirs. Fails closed.
//
// Usage: node test/t1/run-host.mjs [2.0.0] [2.2.5]
// Binaries: <repo>/.fixtures/inspect/bin-<v>/package/bin/opencode (npm pack of @opencode/cli-darwin-arm64).
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareIsolatedBase, realHome, requireBinaryVersion, requireIsolationTools, sandboxed } from "../isolation.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "../..");
const repo = resolve(pkg, "../..");
const versions = process.argv.slice(2).length ? process.argv.slice(2) : ["2.0.0", "2.2.5"];

const die = (message) => {
  console.error(`T1 FAIL-CLOSED: ${message}`);
  process.exit(2);
};
requireIsolationTools(die);
if (!existsSync(join(pkg, "dist/plugin/create.js"))) die("dist missing; run npm run build first");

function runVersion(version) {
  const bin = join(repo, ".fixtures/inspect", `bin-${version}`, "package/bin/opencode");
  if (!existsSync(bin)) die(`missing pinned binary ${bin}`);
  const base = join(repo, ".fixtures/t1", version);
  // Isolation self-check: the sandbox must positively deny (EPERM) a non-loopback connect and
  // reads of a denied path. DNS failures, timeouts or ENOENT are not proof. Fail closed otherwise.
  prepareIsolatedBase(base, version, die);
  const sentinel = join(base, "project/SENTINEL");
  writeFileSync(join(base, "oc/opencode.json"), JSON.stringify({ plugins: [{ package: join(here, "fixture-plugin"), options: { sentinel } }] }, null, 2));
  const reported = requireBinaryVersion(base, bin, version, die);

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
