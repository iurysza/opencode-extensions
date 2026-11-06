#!/usr/bin/env node
// T2 offline real-SDK probe: loads a test-only plugin that imports the real @cursor/sdk 1.0.40
// inside the pinned OpenCode CLI binaries (their own Bun runtimes) and exercises the
// @cursor/sdk/sqlite store on a fixture database. Same isolation as T1: `env -i`, isolated
// HOME/XDG under .fixtures/t2/<v>, loopback-only sandbox, positive EPERM self-check. No key, no
// Agent.create/resume/send. Evidence: .fixtures/t2/<v>/{probe.json,summary.json,run.out,run.err}.
//
// Usage: node test/t2/run-offline.mjs [2.0.0] [2.2.5]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareIsolatedBase, realHome, requireBinaryVersion, requireIsolationTools, sandboxed } from "../isolation.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "../..");
const repo = resolve(pkg, "../..");
const versions = process.argv.slice(2).length ? process.argv.slice(2) : ["2.0.0", "2.2.5"];
// Bun versions the plan pins for each host (plan, proof tiers).
const expectedBun = { "2.0.0": "1.4.2", "2.2.5": "1.4.4" };

const die = (message) => {
  console.error(`T2 FAIL-CLOSED: ${message}`);
  process.exit(2);
};
requireIsolationTools(die);
if (!existsSync(join(pkg, "dist/plugin/create.js"))) die("dist missing; run npm run build first");
const sdkPkg = join(repo, "node_modules/@cursor/sdk/package.json");
if (!existsSync(sdkPkg)) die("@cursor/sdk not installed; run npm ci --ignore-scripts");
const sdkVersion = JSON.parse(readFileSync(sdkPkg, "utf8")).version;
if (sdkVersion !== "1.0.40") die(`@cursor/sdk is ${sdkVersion}, expected 1.0.40`);
const rel = (p) => (typeof p === "string" ? p.replace(/^file:\/\//, "").replace(repo, "<repo>") : p);

function runVersion(version) {
  const bin = join(repo, ".fixtures/inspect", `bin-${version}`, "package/bin/opencode");
  if (!existsSync(bin)) die(`missing pinned binary ${bin}`);
  const base = join(repo, ".fixtures/t2", version);
  prepareIsolatedBase(base, version, die);
  const reported = requireBinaryVersion(base, bin, version, die);
  const evidencePath = join(base, "probe.json");
  const stateRoot = join(base, "state/cursor-sdk-fixture");
  const project = join(base, "project");
  const options = { evidence: evidencePath, stateRoot, workspaceRef: project };
  writeFileSync(join(base, "oc/opencode.json"), JSON.stringify({ plugins: [{ package: join(here, "fixture-plugin"), options }] }, null, 2));

  const run = sandboxed(base, bin, ["run", "--standalone", "--print-logs", "--log-level", "warn", "-m", "cursor/fake", "--format", "json", "T2 probe"], project);
  writeFileSync(join(base, "run.out"), run.stdout ?? "");
  writeFileSync(join(base, "run.err"), run.stderr ?? "");
  let probe;
  try {
    probe = JSON.parse(readFileSync(evidencePath, "utf8"));
  } catch {
    probe = undefined;
  }
  const store = probe?.sqliteStore;
  const errors = probe?.errorShapes;
  const checks = {
    exit0: run.status === 0,
    probeWritten: probe !== undefined,
    hostVersion: probe?.host === version,
    bunRuntime: probe?.runtime?.bun === expectedBun[version],
    notDeno: probe?.runtime?.hasDeno === false,
    // Bun takes the `bun` export condition: dist/bundled/*, not dist/esm.
    resolvedBundledMain: /\/@cursor\/sdk\/dist\/bundled\/index\.js$/.test(probe?.resolve?.main ?? ""),
    resolvedBundledSqlite: /\/@cursor\/sdk\/dist\/bundled\/sqlite\.js$/.test(probe?.resolve?.sqlite ?? ""),
    importMain: probe?.importMain?.ok === true,
    sqliteOpenWriteReopenRead: store?.ok === true && store.agentRoundTrip === true && store.blobRoundTrip === true && store.eventRoundTrip === true,
    sqliteFileInFixture: Array.isArray(store?.files) && store.files.includes("index.db"),
    errorShapesOffline: errors?.ok === true && errors.networkError?.instanceOfCursorSdkError === true,
  };
  const pass = Object.values(checks).every(Boolean);
  const summary = {
    version,
    reported,
    sdkVersion,
    runtime: probe?.runtime,
    resolved: probe?.resolve ? { main: rel(probe.resolve.main), sqlite: rel(probe.resolve.sqlite), connectWeb: rel(probe.resolve.connectWeb) } : undefined,
    checks,
    pass,
    failures: probe ? Object.fromEntries(Object.entries(probe).filter(([, v]) => v && typeof v === "object" && v.ok === false)) : { runStderrTail: (run.stderr ?? "").slice(-1500).replaceAll(realHome, "~") },
    evidence: base.replace(realHome, "~"),
  };
  writeFileSync(join(base, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}

const results = versions.map(runVersion);
for (const r of results) console.log(JSON.stringify(r, null, 2));
process.exit(results.every((r) => r.pass) ? 0 : 1);
