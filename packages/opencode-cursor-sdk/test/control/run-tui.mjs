#!/usr/bin/env node
// Real keyboard/rendered TUI smoke with fake actions, no prompts sent to a model.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildControls } from "./build.mjs";
import { prepareIsolatedBase, requireBinaryVersion, requireIsolationTools, sandboxCommand, sandboxed, sandboxedSpawn } from "../isolation.mjs";
const here = dirname(fileURLToPath(import.meta.url)); const repo = resolve(here, "../../../..");
const die = message => { throw new Error("CONTROL TUI FAIL-CLOSED: " + message); };
requireIsolationTools(die);
const terminalVersion = spawnSync("termctrl", ["--version"], { encoding: "utf8", timeout: 5000 });
if (terminalVersion.error?.code === "ENOENT") {
  console.log(JSON.stringify({ skip: "optional TUI capability unavailable: termctrl executable missing" }));
  process.exit(0);
}
if (terminalVersion.error || terminalVersion.status !== 0) die("termctrl executable exists but --version failed");
buildControls(repo);
const versions = process.argv.slice(2).length ? process.argv.slice(2) : ["2.0.0", "2.2.5"];
// The trusted controller must start its own daemon inside the validated Linux namespace.
// A unique, short socket path cannot attach to an existing host daemon. Reuse for this run only.
const env = { ...process.env, TERMCTRL_RUNTIME_DIR: mkdtempSync("/tmp/oc-control-") };
function tc(...args) { const r = spawnSync("termctrl", args, { env, encoding: "utf8", timeout: 15000 }); if (r.status !== 0) die(`termctrl ${args[0]}: ${r.stderr}`); return r.stdout; }
async function until(label, fn, ms = 15000) { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) die("timeout: " + label); await new Promise(resolve => setTimeout(resolve, 50)); } }
try {
for (const version of versions) for (const topology of (process.env.CONTROL_TOPOLOGY ? [process.env.CONTROL_TOPOLOGY] : ["standalone", "attached-local"])) {
  const base = join(repo, ".fixtures/control-tui", `${version}-${topology}`);
  prepareIsolatedBase(base, `${version}-${topology}`, die);
  const project = join(base, "project"); const bin = join(repo, ".fixtures/inspect", `bin-${version}`, "package/bin/opencode");
  requireBinaryVersion(base, bin, version, die);
  const log = join(base, "actions.jsonl"); const tuiLog = join(base, "tui.jsonl"); writeFileSync(log, ""); writeFileSync(tuiLog, "");
  writeFileSync(join(base, "oc/opencode.json"), JSON.stringify({ plugins: [{ package: join(here, "fixture-plugin"), options: { log } }] }));
  const created = sandboxed(base, bin, ["api", "--standalone", "POST", "/api/session", "-d", JSON.stringify({ title: "Control TUI fixture" })], project);
  assert.equal(created.status, 0, created.stderr); const sessionID = JSON.parse(created.stdout.slice(created.stdout.indexOf("{"))).data.id;
  const name = `control-${version.replaceAll(".", "-")}-${topology}`;
  const password = randomBytes(24).toString("base64url");
  let server; let serverOutput = ""; let serverExit;
  const args = ["--standalone", "-s", sessionID];
  try {
    if (topology === "attached-local") {
      const port = await new Promise(resolve => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const port = s.address().port; s.close(() => resolve(port)); }); });
      server = sandboxedSpawn(base, bin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], project, { OPENCODE_PASSWORD: password });
      server.stdout.on("data", data => { serverOutput += data; }); server.stderr.on("data", data => { serverOutput += data; });
      serverExit = new Promise(resolve => { server.once("exit", resolve); server.once("error", resolve); });
      await until("local backend", () => serverOutput.includes("server listening on"));
      args.splice(0, 1, "--server", `http://127.0.0.1:${port}`);
    }
    const invocation = sandboxCommand(base, bin, args, { TERM: "xterm-256color", CONTROL_TUI_LOG: tuiLog, ...(topology === "attached-local" ? { OPENCODE_PASSWORD: password } : {}) });
    tc("start", name, "--host", "opentui", "--cols", "132", "--rows", "40", "--cwd", project, "--", invocation.command, ...invocation.args);
    const screen = () => tc("show", name);
    const wait = (label, text) => until(label, () => screen().includes(text));
    const absent = (label, text) => until(label, () => !screen().includes(text));
    const capture = title => writeFileSync(join(base,title+".txt"), screen());
    const command = async (name, text = "") => {
      const count = readFileSync(tuiLog,"utf8").split("\n").filter(Boolean).length;
      tc("send", nameSession(), `text:/${name}${text ? " " + text : " "}`);
      await wait("typed command", "/"+name); tc("send", nameSession(), "enter");
      await until("command dispatch", () => readFileSync(tuiLog,"utf8").split("\n").filter(Boolean).length > count);
    };
    const nameSession = () => name;
    await wait("native status", "Cursor: idle"); await wait("cloud native status", "Cloud: idle"); capture("01-native-status");
    await command("cursor-runtime", "cloud"); await wait("Cloud acknowledgement", "Enable foreground Cloud runtime?"); capture("02-runtime-disclosure");
    tc("send", name, "escape"); await absent("cancel runtime dialog", "Enable foreground Cloud runtime?");
    assert.ok(!readFileSync(log,"utf8").includes('"at":"runtime"'));
    await command("cursor-runtime", "local"); await until("local runtime callback", () => readFileSync(log,"utf8").includes('"runtime":"local"'));
    await command("cursor-fast", "on"); await wait("pushed status", "Cursor: running"); capture("03-push-status");
    await command("cursor-refresh-config"); await wait("honest unavailable", "not implemented"); capture("04-unavailable");
    await command("cloud", "cancel"); await wait("agent picker", "Select entry to cancel"); tc("send", name, "enter");
    await wait("cancel confirmation", "Cancel Cloud agent?"); capture("05-cancel-confirmation"); tc("send", name, "escape"); await absent("cancel dismissed", "Cancel Cloud agent?");
    await command("cloud", "delete"); await wait("delete picker", "Select entry to delete"); tc("send", name, "enter");
    await wait("delete confirmation", "Delete Cloud agent?"); capture("06-delete-confirmation"); tc("send", name, "escape"); await absent("delete dismissed", "Delete Cloud agent?");
    await command("cursor-cloud", "archive"); await wait("foreground archive picker", "Select entry to archive"); tc("send", name, "enter");
    await wait("foreground archive confirmation", "Archive foreground Cloud entry?"); capture("07-archive-confirmation"); tc("send", name, "escape"); await absent("archive dismissed", "Archive foreground Cloud entry?");
    const summary = { version, topology, pass:true, checks:{ nativeText:true, keyboardRpc:true, runtimeDisclosure:true, declinedRuntimeNoMutation:true, statusPush:true, unavailableHonest:true, cancelConfirmation:true, deleteConfirmation:true, foregroundArchiveConfirmation:true }, proof:"actual rendered TUI, fake backend actions" };
    writeFileSync(join(base,"summary.json"),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
  } catch (error) {
    try { writeFileSync(join(base,"failure.txt"),tc("show",name)); } catch {}
    throw error;
  } finally {
    try { tc("stop",name); } catch {}
    if(server?.pid) { try{process.kill(-server.pid,"SIGKILL");}catch{} await Promise.race([serverExit,new Promise(resolve=>setTimeout(resolve,5000))]); }
    writeFileSync(join(base,"server.out"),serverOutput.replace(/server password \S+/g, "server password [fixture-redacted]"));
  }
}
} finally { rmSync(env.TERMCTRL_RUNTIME_DIR, { recursive: true, force: true }); }
