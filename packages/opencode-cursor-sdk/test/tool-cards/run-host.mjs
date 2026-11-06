#!/usr/bin/env node
// Tool-card render probe. Real pinned host, scripted fake Cursor source, isolated sandbox.
// For each shape (today / builtin) it runs one turn, exports the stored parts and captures
// the rendered TUI for the same session with termctrl.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareIsolatedBase, requireBinaryVersion, requireIsolationTools, sandboxCommand, sandboxed } from "../isolation.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const die = (message) => { throw new Error(`TOOL-CARDS FAIL-CLOSED: ${message}`); };
requireIsolationTools(die);
const out = process.env.TOOL_CARDS_OUT ?? join(repo, ".fixtures/tool-cards");
const versions = process.argv.slice(2).length ? process.argv.slice(2) : ["2.2.5"];
const shapes = (process.env.TOOL_CARDS_SHAPES ?? "today,builtin").split(",");
const env = { ...process.env, TERMCTRL_RUNTIME_DIR: mkdtempSync("/tmp/oc-cards-") };
const tc = (...args) => { const r = spawnSync("termctrl", args, { env, encoding: "utf8", timeout: 15000 }); if (r.status !== 0) die(`termctrl ${args[0]}: ${r.stderr}`); return r.stdout; };
const until = async (label, fn, ms = 20000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) die(`timeout: ${label}`); await new Promise((r) => setTimeout(r, 100)); } };
const json = (text) => JSON.parse(text.slice(text.indexOf("{")));
const reports = [];
try {
  for (const version of versions) for (const shape of shapes) {
    const base = join(repo, ".fixtures/tool-cards-run", `${version}-${shape}`);
    prepareIsolatedBase(base, `${version}-${shape}`, die);
    const bin = join(repo, ".fixtures/inspect", `bin-${version}/package/bin/opencode`);
    requireBinaryVersion(base, bin, version, die);
    const project = join(base, "project");
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "src/sample.ts"), "const a = 1;\nconst b = 2;\n");
    writeFileSync(join(base, "oc/opencode.json"), JSON.stringify({ plugins: [{ package: join(here, "fixture-plugin"), options: { shape, project, delayMs: 4000 } }] }));
    const created = sandboxed(base, bin, ["api", "--standalone", "POST", "/api/session", "-d", JSON.stringify({ title: `tool cards ${shape}` })], project);
    if (created.status !== 0) die(`session create: ${created.stderr}`);
    const sessionID = json(created.stdout).data.id;
    const run = sandboxed(base, bin, ["run", "--standalone", "-s", sessionID, "-m", "cursor/fake", "--format", "json", "probe tool cards"], project);
    const dir = join(out, version, shape);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.jsonl"), run.stdout ?? "");
    writeFileSync(join(dir, "run.err"), run.stderr ?? "");
    const exported = sandboxed(base, bin, ["session", "export", "--standalone", sessionID], project);
    const tools = [];
    const walk = (item) => { if (Array.isArray(item)) return item.forEach(walk); if (item && typeof item === "object") { if (item.type === "tool") tools.push(item); Object.values(item).forEach(walk); } };
    try { walk(json(exported.stdout)); } catch { die(`export unreadable: ${exported.stderr}`); }
    writeFileSync(join(dir, "tool-parts.json"), JSON.stringify(tools, null, 2));
    const name = `cards-${version.replaceAll(".", "-")}-${shape}`;
    // The TUI submits a second, slow turn so the running state is visible mid-call.
    const invocation = sandboxCommand(base, bin, ["--standalone", "-s", sessionID, "--prompt", "probe live"], { TERM: "xterm-256color" });
    let screen = "";
    try {
      tc("start", name, "--host", "opentui", "--cols", "132", "--rows", "60", "--cwd", project, "--", invocation.command, ...invocation.args);
      await until("live turn started", () => (screen = tc("show", name)).split(`Probe ${shape} start.`).length > 2);
      await new Promise((r) => setTimeout(r, 1500));
      // Text only: the PNG capture was observed to return the settled frame, not the live one.
      writeFileSync(join(dir, "tui-running.txt"), tc("show", name));
      await until("live turn finished", () => (screen = tc("show", name)).split(`Probe ${shape} end.`).length > 2, 40000);
      await new Promise((r) => setTimeout(r, 800));
      screen = tc("show", name);
      writeFileSync(join(dir, "tui.txt"), screen);
      tc("save", name, "--format", "png", "--out", join(dir, "tui.png"));
    } catch (error) {
      if (screen) writeFileSync(join(dir, "tui-failure.txt"), screen);
      throw error;
    } finally { try { tc("stop", name); } catch {} }
    const stored = tools.map((tool) => ({ name: tool.name ?? tool.tool, status: tool.state?.status, executed: tool.executed, metadataKeys: Object.keys(tool.state?.metadata ?? {}) }));
    const untouched = readFileSync(join(project, "src/sample.ts"), "utf8") === "const a = 1;\nconst b = 2;\n";
    const report = { version, shape, exit: run.status, sessionID, stored, hostNeverExecuted: untouched && tools.every((tool) => tool.executed === true) };
    writeFileSync(join(dir, "summary.json"), JSON.stringify(report, null, 2));
    reports.push(report);
  }
} finally { rmSync(env.TERMCTRL_RUNTIME_DIR, { recursive: true, force: true }); }
console.log(JSON.stringify(reports, null, 2));
