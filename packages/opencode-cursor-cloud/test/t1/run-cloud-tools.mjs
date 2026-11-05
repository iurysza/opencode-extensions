// Real-host T1 only. Reuses isolation, never edits it; env -i and loopback-only sandbox.
// Runs the production Cloud tools with injected fake clients and the SDK fixture's fake source.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareIsolatedBase, requireBinaryVersion, requireIsolationTools, sandboxed } from "../../../opencode-cursor-sdk/test/isolation.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const die = message => { console.error(`CLOUD TOOLS FAIL-CLOSED: ${message}`); process.exit(2); };
requireIsolationTools(die);
const versions = process.argv.slice(2).length ? process.argv.slice(2) : ["2.0.0", "2.2.5"];
const reports = [];
const resultText = result => typeof result?.content === "string" ? result.content : (result?.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
const lines = text => text.split("\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {}; } });
for (const version of versions) {
  const base = join(repo, ".fixtures/cloud-tools", version);
  prepareIsolatedBase(base, version, die);
  const bin = join(repo, ".fixtures/inspect", `bin-${version}/package/bin/opencode`);
  requireBinaryVersion(base, bin, version, die);
  const log = join(base, "tools.jsonl");
  writeFileSync(log, "");
  // Local fixture directory, not an installable workspace package.
  writeFileSync(join(base, "oc/opencode.json"), JSON.stringify({ plugins: [{ package: join(here, "cloud-tools-plugin"), options: { log } }] }));
  const run = sandboxed(base, bin, ["run", "--standalone", "--print-logs", "--log-level", "warn", "-m", "cursor/fake", "--format", "json", "cloud tools fixture"], join(base, "project"));
  writeFileSync(join(base, "run.out"), run.stdout ?? "");
  writeFileSync(join(base, "run.err"), run.stderr ?? "");
  const events = lines(run.stdout ?? "");
  const evidence = lines(readFileSync(log, "utf8"));
  const tools = evidence.filter(e => e.at === "tool");
  const spawn = tools.find(e => e.tool === "cursor_cloud_spawn");
  const send = tools.find(e => e.tool === "cursor_cloud_send");
  const status = tools.filter(e => e.tool === "cursor_cloud_status");
  const synthetic = evidence.filter(e => e.at === "synthetic");
  const checks = {
    exit0: run.status === 0,
    setup: evidence.some(e => e.at === "setup" && e.version === version),
    noHostErrors: !events.some(e => e.type === "error"),
    complete: (run.stdout ?? "").includes("CLOUD_HOST_COMPLETE"),
    fourFixedToolsExecuted: ["cursor_cloud_spawn", "cursor_cloud_send", "cursor_cloud_status", "cursor_cloud_cancel"].every(name => tools.some(e => e.tool === name && e.status === "completed")),
    launchNotice: resultText(spawn?.result).includes("not local, uncommitted or unpushed commits"),
    busyFollowupRejected: send?.result?.metadata?.isError === true && resultText(send?.result).includes("active run"),
    liveStatus: status.some(e => e.result?.metadata?.agents?.[0]?.status?.type === "running"),
    finalStatus: status.some(e => e.result?.metadata?.agents?.[0]?.status?.type === "cancelled"),
    oneCreateAndSend: evidence.filter(e => e.at === "create").length === 1 && evidence.filter(e => e.at === "send").length === 1,
    explicitCancelOnly: evidence.filter(e => e.at === "cancel").length === 1 && !evidence.some(e => e.at === "delete"),
    oneDurableCompletion: synthetic.length === 1 && synthetic[0]?.sessionID === spawn?.sessionID && synthetic[0]?.runId === "run-host-tools" && String(synthetic[0]?.text).includes("FAKE_REMOTE_RESULT"),
    noDiagnostics: !evidence.some(e => e.at === "diagnostic" || e.at === "refusal"),
  };
  const report = { version, pass: Object.values(checks).every(Boolean), checks, evidence: base };
  writeFileSync(join(base, "summary.json"), JSON.stringify(report, null, 2)); reports.push(report);
}
console.log(JSON.stringify(reports, null, 2));
process.exit(reports.every(r => r.pass) ? 0 : 1);
