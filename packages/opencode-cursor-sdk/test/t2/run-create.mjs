#!/usr/bin/env node
// T2 keyless Agent.create probe (approved: Inbox msg_redacted; see AGENTS.md).
// Loads test/t2/create-plugin inside the pinned OpenCode binaries under the shared isolation
// (env -i, isolated HOME/XDG under .fixtures/t2-create/<v>, loopback-only sandbox, positive EPERM
// self-check). No apiKey, no CURSOR_API_KEY, empty fixture HOME (no ~/.cursor/sdk/auth.json),
// local runtime only, never send/resume/prompt. Every outcome (resolved, rejected, stalled) is
// recorded. Discovery run (2026-11-05) observed both cases resolve and dispose on 2.0.0 and 2.2.5;
// those observed results are now qualified expectations: a rejected or stalled create, a dispose
// that is not resolved (including no public disposal method), or anything but 2 idle fixture rows
// fails the command. A host process that outlives the bounded timeout is a separate failure.
// Evidence: .fixtures/t2-create/<v>/{probe.json,summary.json,run.out,run.err}.
//
// Usage: node test/t2/run-create.mjs [2.0.0] [2.2.5]
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareIsolatedBase, realHome, requireBinaryVersion, requireIsolationTools, sandboxed } from "../isolation.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "../..");
const repo = resolve(pkg, "../..");
const versions = process.argv.slice(2).length ? process.argv.slice(2) : ["2.0.0", "2.2.5"];
const OUTCOMES = new Set(["resolved", "rejected", "stalled"]);

const die = (message) => {
  console.error(`T2-CREATE FAIL-CLOSED: ${message}`);
  process.exit(2);
};
requireIsolationTools(die);
if (!existsSync(join(pkg, "dist/plugin/create.js"))) die("dist missing; run npm run build first");
const sdkVersion = JSON.parse(readFileSync(join(repo, "node_modules/@cursor/sdk/package.json"), "utf8")).version;
if (sdkVersion !== "1.0.40") die(`@cursor/sdk is ${sdkVersion}, expected 1.0.40`);

/** Processes whose command line still references the fixture base after the run. */
function survivors(base) {
  const ps = spawnSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return (ps.stdout ?? "").split("\n").filter((l) => l.includes(base) && !l.includes("/bin/ps"));
}

function runVersion(version) {
  const bin = join(repo, ".fixtures/inspect", `bin-${version}`, "package/bin/opencode");
  const base = join(repo, ".fixtures/t2-create", version);
  prepareIsolatedBase(base, version, die);
  const reported = requireBinaryVersion(base, bin, version, die);
  if (readdirSync(join(base, "home")).length !== 0) die(`${version}: fixture HOME not empty`);
  const evidencePath = join(base, "probe.json");
  const project = join(base, "project");
  const options = { evidence: evidencePath, stateRoot: join(base, "state/cursor-sdk-create"), workspaceRef: project, fixtureBase: base };
  writeFileSync(join(base, "oc/opencode.json"), JSON.stringify({ plugins: [{ package: join(here, "create-plugin"), options }] }, null, 2));

  const run = sandboxed(base, bin, ["run", "--standalone", "--print-logs", "--log-level", "warn", "-m", "cursor/fake", "--format", "json", "T2 create probe"], project);
  writeFileSync(join(base, "run.out"), run.stdout ?? "");
  writeFileSync(join(base, "run.err"), run.stderr ?? "");
  const hostTimedOut = run.error?.code === "ETIMEDOUT" || run.signal === "SIGTERM";
  const orphans = survivors(base);
  let probe;
  try {
    probe = JSON.parse(readFileSync(evidencePath, "utf8"));
  } catch {
    probe = undefined;
  }
  const cases = probe?.cases ?? [];
  const raw = existsSync(evidencePath) ? readFileSync(evidencePath, "utf8") : "";
  const checks = {
    hostExited: !hostTimedOut && run.status === 0,
    noOrphanProcess: orphans.length === 0,
    probeWritten: probe?.ok === true,
    hostVersion: probe?.host === version,
    noEnvKey: probe?.env?.CURSOR_API_KEY === false,
    homeIsFixture: probe?.env?.homeIsFixture === true,
    everyCaseHasOutcome: cases.length === 2 && cases.every((c) => OUTCOMES.has(c.outcome)),
    // Qualified expectations from the discovery run (regression assertions).
    bothCasesResolved: cases.length === 2 && cases.every((c) => c.outcome === "resolved"),
    bothDisposed: cases.length === 2 && cases.every((c) => c.dispose?.outcome === "resolved"),
    twoIdleFixtureRows: probe?.storeAfter?.agents === 2 && probe.storeAfter.statuses?.length === 2 && probe.storeAfter.statuses.every((s) => s === "idle"),
    noRealHomeInEvidence: !raw.includes(realHome),
  };
  const summary = {
    version,
    reported,
    sdkVersion,
    hostTimedOut,
    orphans,
    checks,
    pass: Object.values(checks).every(Boolean),
    cases: cases.map(({ label, outcome, elapsedMs, error, handle, dispose }) => ({ label, outcome, elapsedMs, error, handle, dispose })),
    storeAfter: probe?.storeAfter,
    failure: probe?.ok === false ? probe.error : probe ? undefined : { runStderrTail: (run.stderr ?? "").slice(-1500).replaceAll(realHome, "~") },
    evidence: base.replace(realHome, "~"),
  };
  writeFileSync(join(base, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}

const results = versions.map(runVersion);
for (const r of results) console.log(JSON.stringify(r, null, 2));
process.exit(results.every((r) => r.pass) ? 0 : 1);
