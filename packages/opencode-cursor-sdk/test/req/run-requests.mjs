#!/usr/bin/env node
// G4a and G3-prerequisite real-host probe. Runs the pinned OpenCode CLI binaries with the
// built plugin and a recording fixture (test/req/fixture-plugin). Same isolation as T1/T2:
// `env -i`, isolated HOME/XDG under .fixtures/req/<v>, loopback-only sandbox with positive
// EPERM self-checks. Every request is driven by a public host route:
//   1. `run`            primary turn; the host's automatic title request follows
//   2. `run -s`         second primary turn; reported usage over the limit makes the host
//                       compact automatically first
//   3. `api POST /api/session/<id>/generate`  public session.generate route
//   4. `run -s --fork`  fork; request-time `session.get` must show lineage
//   5. `run -s -m`      model change on the fork
// No hook is called by hand. Fails closed if isolation cannot be enforced.
//
// Usage: node test/req/run-requests.mjs [2.0.0] [2.2.5]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, regressions, runningRowVisible } from "./evidence.mjs";
import { prepareIsolatedBase, realHome, requireBinaryVersion, requireIsolationTools, sandboxed } from "../isolation.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "../..");
const repo = resolve(pkg, "../..");
const versions = process.argv.slice(2).length ? process.argv.slice(2) : ["2.0.0", "2.2.5"];

const die = (message) => {
  console.error(`REQ FAIL-CLOSED: ${message}`);
  process.exit(2);
};
requireIsolationTools(die);
if (!existsSync(join(pkg, "dist/compat/request-stamp.js"))) die("dist missing; run npm run build first");

const jsonLines = (text) =>
  (text ?? "")
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });

function runVersion(version) {
  const bin = join(repo, ".fixtures/inspect", `bin-${version}`, "package/bin/opencode");
  const base = join(repo, ".fixtures/req", version);
  prepareIsolatedBase(base, version, die);
  const log = join(base, "requests.jsonl");
  writeFileSync(log, "");
  writeFileSync(
    join(base, "oc/opencode.json"),
    JSON.stringify({ plugins: [{ package: join(here, "fixture-plugin"), options: { log, bigUsage: 199_000 } }] }, null, 2),
  );
  const reported = requireBinaryVersion(base, bin, version, die);
  const project = join(base, "project");
  const steps = [];
  const step = (name, args) => {
    // Log boundary around each CLI step, so evidence is attributed to the step that made it.
    const before = readFileSync(log, "utf8").length;
    const r = sandboxed(base, bin, args, project);
    const entries = jsonLines(readFileSync(log, "utf8").slice(before));
    writeFileSync(join(base, `${name}.out`), r.stdout ?? "");
    writeFileSync(join(base, `${name}.err`), r.stderr ?? "");
    const events = jsonLines(r.stdout);
    steps.push({ name, status: r.status, sessionID: events.find((e) => e.sessionID)?.sessionID, errors: events.filter((e) => e.type === "error").length, entries });
    return { r, events, sessionID: events.find((e) => e.sessionID)?.sessionID };
  };
  const run = (name, extra, text) => step(name, ["run", "--standalone", "--print-logs", "--log-level", "warn", "--format", "json", ...extra, text]);

  const first = run("1-primary", ["-m", "cursor/fake"], "req turn one");
  const sessionID = first.sessionID;
  if (sessionID) {
    run("2-autocompact", ["-s", sessionID, "-m", "cursor/fake"], "req turn two");
    step("3-generate", ["api", "--standalone", "POST", `/api/session/${sessionID}/generate`, "-d", JSON.stringify({ prompt: "req generate" })]);
  }
  const fork = sessionID ? run("4-fork", ["-s", sessionID, "--fork", "-m", "cursor/fake"], "req fork turn") : {};
  if (fork.sessionID) run("5-model-change", ["-s", fork.sessionID, "-m", "cursor/fake2"], "req model change");

  const entries = jsonLines(readFileSync(log, "utf8"));
  const sources = entries.filter((e) => e.at === "source");
  const hooks = entries.filter((e) => e.at === "model.request");
  const kindsAtSource = [...new Set(sources.map((e) => e.context.kind))];
  const forkSession = fork.sessionID;
  const forkHooks = hooks.filter((h) => h.sessionID === forkSession);
  const attributed = steps.reduce((n, s) => n + s.entries.length, 0);

  const input = { steps, sessionID, forkSessionID: forkSession };
  const { checks: evidence, kinds } = evaluate(input);
  const negative = regressions(input);
  const checks = {
    pluginSetup: readFileSync(join(base, "1-primary.err"), "utf8").includes(`[cursor-req] setup host=${version}`),
    everyLogLineAttributedToAStep: attributed === entries.length,
    ...evidence,
  };
  // Self-test: each known false positive must fail evidence validation on this real capture.
  // A regression that needs a host shape absent here is reported, never counted as a pass.
  const notApplicable = [];
  for (const [name, r] of Object.entries(negative)) {
    if (r.applicable) checks[`regression_${name}_rejected`] = r.failsValidation;
    else notApplicable.push(name);
  }
  const pass = Object.values(checks).every(Boolean);
  const compactionAfter = sources.filter((s) => s.context.sessionID === sessionID);
  const summary = {
    version,
    reported,
    sessionID,
    forkSessionID: forkSession,
    steps: steps.map(({ entries: e, ...s }) => ({ ...s, records: e.length })),
    kindsAtSource,
    kinds,
    forkHookSession: forkHooks[0]?.session,
    // Lineage of compaction: is our summary present in the next primary prompt? (G3 note)
    primaryAfterCompactionSeesSummary: compactionAfter.filter((s) => s.context.kind === "primary").map((s) => s.promptHasSummary),
    compactionRunningRowVisible: runningRowVisible(steps),
    regressionsNotApplicable: notApplicable,
    checks,
    pass,
    evidence: base.replace(realHome, "~"),
  };
  writeFileSync(join(base, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}

const results = versions.map(runVersion);
for (const r of results) console.log(JSON.stringify(r, null, 2));
process.exit(results.every((r) => r.pass) ? 0 : 1);
