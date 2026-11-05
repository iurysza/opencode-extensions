#!/usr/bin/env node
// T1 runtime matrix. LOOPBACK ONLY: reads binaries left by acquire.mjs and never fetches.
// Runs each suite once per version in its own child process (run-host.mjs, run-requests.mjs
// keep their own isolation and fail-closed checks), so one version's failure or fail-closed
// exit cannot hide another. Every executed version is reported, pass or fail, with the
// evidence directory. A version with no acquired binary is reported as `missing`, never skipped.
//
// Usage: node test/matrix/run-matrix.mjs [--suite host|req]... [version ...]
// Default versions: .fixtures/matrix/versions.json (from acquire.mjs), else the declared list.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DECLARED_VERSIONS, binPath } from "./versions.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "../..");
const repo = resolve(pkg, "../..");
const SUITES = { host: { script: "test/t1/run-host.mjs", dir: "t1" }, req: { script: "test/req/run-requests.mjs", dir: "req" } };

const args = process.argv.slice(2);
const suites = args.flatMap((a, i) => (args[i - 1] === "--suite" ? [a] : []));
const explicit = args.filter((a, i) => a !== "--suite" && args[i - 1] !== "--suite");
const listed = join(repo, ".fixtures/matrix/versions.json");
const versions = explicit.length ? explicit : existsSync(listed) ? JSON.parse(readFileSync(listed, "utf8")).versions : DECLARED_VERSIONS;
const chosen = suites.length ? suites : Object.keys(SUITES);
for (const s of chosen) if (!SUITES[s]) throw new Error(`unknown suite ${s}`);

const rows = [];
for (const suite of chosen) {
  for (const version of versions) {
    if (!existsSync(binPath(repo, version))) {
      rows.push({ suite, version, outcome: "missing", detail: "binary not acquired; run test/matrix/acquire.mjs" });
      continue;
    }
    const r = spawnSync(process.execPath, [SUITES[suite].script, version], { cwd: pkg, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const summaryFile = join(repo, ".fixtures", SUITES[suite].dir, version, "summary.json");
    // Child exit 2 = fail-closed (isolation or setup); its summary.json may be stale, so ignore it.
    const summary = r.status !== 2 && existsSync(summaryFile) ? JSON.parse(readFileSync(summaryFile, "utf8")) : undefined;
    const failed = summary ? Object.entries(summary.checks).filter(([, ok]) => !ok).map(([k]) => k) : [];
    rows.push({
      suite,
      version,
      outcome: r.status === 0 && summary?.pass ? "pass" : r.status === 2 ? "fail-closed" : "fail",
      exit: r.status,
      reported: summary?.reported,
      failedChecks: failed,
      ...(suite === "req" && summary
        ? { kinds: summary.kinds, compactionRunningRowVisible: summary.compactionRunningRowVisible, regressionsNotApplicable: summary.regressionsNotApplicable }
        : {}),
      ...(r.status === 2 ? { detail: (r.stderr ?? "").trim().split("\n").slice(-3).join(" | ") } : {}),
      evidence: join(".fixtures", SUITES[suite].dir, version),
    });
    console.error(`[matrix] ${suite} ${version}: ${rows.at(-1).outcome}${failed.length ? ` (${failed.join(", ")})` : ""}`);
  }
}
mkdirSync(join(repo, ".fixtures/matrix"), { recursive: true });
const report = { versions, suites: chosen, rows, pass: rows.every((r) => r.outcome === "pass") };
writeFileSync(join(repo, ".fixtures/matrix/report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.pass ? 0 : 1);
