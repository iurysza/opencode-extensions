import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareIsolatedBase, requireBinaryVersion, requireIsolationTools, sandboxed } from "../isolation.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const die = (message) => { console.error(`BRIDGE FAIL-CLOSED: ${message}`); process.exit(2); };
requireIsolationTools(die);
const versions = process.argv.slice(2).length ? process.argv.slice(2) : ["2.0.0", "2.2.5"];
const reports = [];
for (const version of versions) for (const mode of ["allow", "deny", "malformed", "missing", "wrong-id", "wrong-name", "abort"]) {
  const deny = mode === "deny";
  const failure = ["malformed", "missing", "wrong-id", "wrong-name", "abort"].includes(mode);
  const base = join(repo, ".fixtures/bridge", version, mode);
  prepareIsolatedBase(base, `${version}-${deny}`, die);
  const bin = join(repo, ".fixtures/inspect", `bin-${version}/package/bin/opencode`);
  requireBinaryVersion(base, bin, version, die);
  const log = join(base, "bridge.jsonl");
  const target = join(base, "project", "empty.txt");
  writeFileSync(target, "");
  writeFileSync(join(base, "oc/opencode.json"), JSON.stringify({ plugins: [{ package: join(here, "fixture-plugin"), options: { log, target, mode, deny } }] }));
  const run = sandboxed(base, bin, ["run", "--standalone", "--print-logs", "--log-level", "warn", "-m", "cursor/fake", "--format", "json", "bridge fixture"], join(base, "project"));
  writeFileSync(join(base, "run.out"), run.stdout ?? "");
  writeFileSync(join(base, "run.err"), run.stderr ?? "");
  const lines = (text) => text.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return {}; } });
  const events = lines(run.stdout ?? "");
  const evidence = existsSync(log) ? lines(readFileSync(log, "utf8")) : [];
  const sessionID = events.find((event) => event.sessionID)?.sessionID;
  let stored;
  if (sessionID) {
    const exported = sandboxed(base, bin, ["session", "export", "--standalone", sessionID], join(base, "project"));
    writeFileSync(join(base, "export.json"), exported.stdout ?? "");
    try { stored = JSON.parse(exported.stdout.slice(exported.stdout.indexOf("{"))); } catch {}
  }
  const tools = [];
  const walk = (item) => { if (Array.isArray(item)) return item.forEach(walk); if (item && typeof item === "object") { if (item.type === "tool") tools.push(item); Object.values(item).forEach(walk); } };
  walk(stored);
  const native = tools.filter((tool) => tool.tool === "cursor_write" || tool.name === "cursor_write");
  const bridge = tools.filter((tool) => (tool.tool ?? tool.name) === "bridge_probe" || tool.name === "bridge_probe");
  const mcp = evidence.find((event) => event.at === "mcp-result")?.result;
  const checks = failure ? {
    noComplete: !(run.stdout ?? "").includes("BRIDGE_COMPLETE"),
    oneSend: evidence.filter((event) => event.at === "send").length === 1,
    cancelled: evidence.some((event) => event.at === "cancel"),
    invalidated: evidence.some((event) => event.at === "close"),
    mcpFailed: evidence.some((event) => (event.at === "mcp-result" || event.at === "empty-result") && event.result?.isError === true),
    failureRecorded: mode === "abort" ? tools.some((tool) => (tool.tool ?? tool.name) === "bridge_probe" && ["interrupted", "error"].includes(tool.state?.status)) : events.some((event) => event.type === "error"),
  } : {
    exit0: run.status === 0,
    noErrors: !events.some((event) => event.type === "error"),
    complete: (run.stdout ?? "").includes("BRIDGE_COMPLETE"),
    oneSend: evidence.filter((event) => event.at === "send").length === 1,
    reentered: evidence.filter((event) => event.at === "stream" && event.tools.length > 0).length === 3,
    permissionPipeline: evidence.some((event) => event.at === "permission"),
    executedOnceOrDenied: evidence.filter((event) => event.at === "execute").length === 1,
    correctMcpResult: deny ? mcp?.isError === true : mcp?.isError !== true,
    emptyResult: JSON.stringify(evidence.find((event) => event.at === "empty-result")?.result?.content) === JSON.stringify([{ type: "text", text: "(no tool output)" }]),
    nativeStoredOnce: native.length === 1,
    nativeProviderExecuted: native.length === 1 && native[0].executed === true,
    bridgeStoredOnce: bridge.length === 1,
    bridgeNotProviderExecuted: bridge.length === 1 && bridge[0].executed !== true,
    noEchoDisplay: tools.length === 3,
    nativeTrapNeverExecuted: !evidence.some((event) => event.at === "native-trap"),
    explicitKey: evidence.some((event) => event.at === "create" && event.explicitKey && event.settingSources.length === 0),
  };
  const report = { version, mode, deny, checks, pass: Object.values(checks).every(Boolean), evidence: base };
  writeFileSync(join(base, "summary.json"), JSON.stringify(report, null, 2));
  reports.push(report);
}
console.log(JSON.stringify(reports, null, 2));
process.exit(reports.every((report) => report.pass) ? 0 : 1);
