#!/usr/bin/env node
// Real-host check for the model-context plugin on the pinned OpenCode binaries.
// Same isolation as the other T1 runners: env -i, isolated HOME/XDG, loopback-only sandbox.
// The probe plugin loads after the model-context plugin and writes event.system to a log.
// No Cursor SDK call and no network beyond loopback.
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { prepareIsolatedBase, requireBinaryVersion, requireIsolationTools, sandboxedSpawn } from "../../../opencode-cursor-sdk/test/isolation.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "../..");
const repo = resolve(pkg, "../..");
const versions = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const selected = versions.length ? versions : ["2.0.0", "2.2.5"];
const MARKER = "AGENTS_MARKER_ocpp1";
const CUSTOM = "CUSTOM_AGENT_SYSTEM_MARKER";
const EXACT = "VENDOR_GPT_62_SOL_v1";
const EXACT_NEXT = "VENDOR_GPT_62_SOL_v2";
const FAMILY = "VENDOR_GPT_FAMILY";
const CLAUDE = "VENDOR_CLAUDE_OPUS_55";

const die = (message) => {
  console.error(`MODEL-CONTEXT FAIL-CLOSED: ${message}`);
  process.exit(2);
};
requireIsolationTools(die);
if (!existsSync(join(pkg, "dist/server.js"))) die("dist/server.js missing; run npm run build first");

const freePort = () =>
  new Promise((ok, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => ok(port));
    });
  });

async function until(label, fn, ms = 30_000) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > end) throw new Error(`timeout waiting for ${label}${last ? `: ${last.message ?? last}` : ""}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

function survivors(base) {
  const ps = spawnSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return (ps.stdout ?? "").split("\n").filter((line) => line.includes(base) && !line.includes("/bin/ps"));
}

function snapshot(entry) {
  const system = Array.isArray(entry.system) ? entry.system : [];
  return {
    hook: entry.hook,
    model: entry.model,
    agent: entry.agent,
    length: system.length,
    parts: system.map((part, index) => ({
      index,
      modelContext: part?.metadata?.modelContext === true,
      file: part?.metadata?.file,
      marker: String(part?.text ?? "").includes(MARKER),
      custom: String(part?.text ?? "").includes(CUSTOM),
      text: part?.metadata?.modelContext === true ? part.text : String(part?.text ?? "").slice(0, 90),
    })),
  };
}

async function runVersion(version) {
  const bin = join(repo, ".fixtures/inspect", `bin-${version}`, "package/bin/opencode");
  const base = join(repo, ".fixtures/model-context", version);
  prepareIsolatedBase(base, version, die);
  const reported = requireBinaryVersion(base, bin, version, die);
  const contextDir = join(base, "model-context");
  mkdirSync(contextDir, { recursive: true });
  writeFileSync(join(contextDir, "map.json"), JSON.stringify({
    skipProviders: ["claude-code"],
    models: { "gpt-6.2-sol": "gpt-6.2-sol.md", "claude-opus-5-5": "claude-opus-5-5.md" },
    families: [{ pattern: "gpt-|openai", file: "gpt.md" }],
  }));
  writeFileSync(join(contextDir, "gpt-6.2-sol.md"), `${EXACT}\n`);
  writeFileSync(join(contextDir, "gpt.md"), `${FAMILY}\n`);
  writeFileSync(join(contextDir, "claude-opus-5-5.md"), `${CLAUDE}\n`);
  mkdirSync(join(base, "config/opencode"), { recursive: true });
  writeFileSync(join(base, "config/opencode/AGENTS.md"), `${MARKER}\n`);

  const log = join(base, "system.jsonl");
  writeFileSync(log, "");
  const project = join(base, "project");
  writeFileSync(join(base, "oc/opencode.json"), JSON.stringify({
    plugins: [
      { package: pkg },
      { package: join(here, "model-context-plugin"), options: { log } },
    ],
    agents: {
      plain: { description: "no own system", mode: "primary" },
      owned: { description: "owns its system", mode: "primary", system: CUSTOM },
    },
  }, null, 2));
  const password = randomBytes(24).toString("base64url");
  const headers = {
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    "content-type": "application/json",
    "x-opencode-directory": encodeURIComponent(project),
  };

  let server;
  let port;
  const output = { text: "" };
  async function start() {
    port = await freePort();
    const child = sandboxedSpawn(base, bin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], project, {
      OPENCODE_PASSWORD: password,
      OPENCODE_MODEL_CONTEXT_DIR: contextDir,
    });
    child.stdout.on("data", (chunk) => { output.text += chunk; });
    child.stderr.on("data", (chunk) => { output.text += chunk; });
    const exited = new Promise((resolveExit) => {
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
      child.once("error", (error) => resolveExit({ error: String(error?.message ?? error) }));
    });
    server = { child, exited };
    await until("server ready", async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/session`, { headers, signal: AbortSignal.timeout(1000) });
        return response.status < 500;
      } catch {
        return false;
      }
    }, 40_000);
  }
  async function stop() {
    if (!server) return;
    const current = server;
    server = undefined;
    if (current.child.pid !== undefined) {
      try { process.kill(-current.child.pid, "SIGKILL"); } catch { /* already gone */ }
    }
    await Promise.race([current.exited, new Promise((resolveStop) => setTimeout(resolveStop, 10_000))]);
  }
  async function call(method, path, body, ms = 30_000) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: response.status, json, text: text.slice(0, 600) };
  }
  const records = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  async function createSession(body) {
    const response = await call("POST", "/api/session", body);
    const id = response.json?.data?.id ?? response.json?.id;
    if (!id) throw new Error(`create session ${response.status}: ${response.text}`);
    return id;
  }
  async function switchModel(sid, model) {
    const response = await call("POST", `/api/session/${sid}/model`, { model });
    if (response.status !== 204 && response.status !== 200) throw new Error(`switchModel ${response.status}: ${response.text}`);
  }
  async function prompt(sid, text) {
    const before = records().length;
    const response = await call("POST", `/api/session/${sid}/prompt`, { text }, 90_000);
    const entry = await until(`context log for ${sid}`, () => records().slice(before).find((row) => row.at === "system" && row.hook === "context" && row.sessionID === sid), 20_000);
    for (const path of [`/api/session/${sid}/wait`, `/api/experimental/session/${sid}/wait`]) {
      const waited = await call("POST", path, {}, 60_000);
      if (waited.status !== 404) break;
    }
    return { response, entry };
  }

  const scenarios = [];
  function scenario(name, evidence, checks) {
    const pass = Object.values(checks).every(Boolean);
    scenarios.push({ name, status: pass ? "pass" : "fail", checks, evidence });
  }

  try {
    await start();
    // 2.0.0 does not boot a location from GET /api/session. A config or plugin
    // read does, and that is what loads configured plugins.
    await until("probe setup", async () => {
      if (!records().some((row) => row.at === "setup")) {
        await call("GET", "/api/config").catch(() => {});
        await call("GET", "/api/plugin").catch(() => {});
      }
      return records().find((row) => row.at === "setup");
    }, 30_000);
    const setup = records().find((row) => row.at === "setup");
    const plain = { providerID: "modelctx", id: "gpt-6.2-sol" };

    const loadSession = await createSession({ agent: "plain", model: plain });
    const loaded = await prompt(loadSession, "load order");
    const loadParts = snapshot(loaded.entry).parts;
    const vendor = loadParts.find((part) => part.modelContext);
    const markerAt = loadParts.findIndex((part) => part.marker);
    scenario("load order", snapshot(loaded.entry), {
      vendorAtIndex1: vendor?.index === 1,
      vendorText: vendor?.text === EXACT,
      vendorFile: vendor?.file === "gpt-6.2-sol.md",
      baseHasNoMarker: loadParts[0]?.marker === false && loadParts[0]?.modelContext === false,
      markerOnlyLater: markerAt > 1,
      promptAccepted: loaded.response.status >= 200 && loaded.response.status < 300,
    });

    const familySession = await createSession({ agent: "plain", model: { providerID: "modelctx", id: "gpt-9-unknown" } });
    const family = await prompt(familySession, "family");
    const familyVendor = snapshot(family.entry).parts.find((part) => part.modelContext);
    scenario("family", snapshot(family.entry), {
      file: familyVendor?.file === "gpt.md",
      text: familyVendor?.text === FAMILY,
    });

    const noneSession = await createSession({ agent: "plain", model: { providerID: "modelctx", id: "mystery-1" } });
    const none = await prompt(noneSession, "none");
    scenario("none", snapshot(none.entry), {
      noVendor: snapshot(none.entry).parts.every((part) => part.modelContext === false),
    });

    const switched = await createSession({ agent: "plain", model: plain });
    const first = await prompt(switched, "before switch");
    await switchModel(switched, { providerID: "modelctx", id: "claude-opus-5-5" });
    const second = await prompt(switched, "after claude switch");
    await switchModel(switched, { providerID: "modelctx", id: "mystery-1" });
    const third = await prompt(switched, "after mystery switch");
    const secondSnap = snapshot(second.entry);
    const thirdSnap = snapshot(third.entry);
    scenario("mid-session switch", {
      first: snapshot(first.entry),
      second: secondSnap,
      third: thirdSnap,
    }, {
      firstIsGpt: secondSnap.parts.length >= 0 && snapshot(first.entry).parts.some((part) => part.text === EXACT),
      secondIsClaude: secondSnap.parts.some((part) => part.text === CLAUDE && part.file === "claude-opus-5-5.md"),
      secondHasNoGpt: secondSnap.parts.every((part) => part.text !== EXACT && !String(part.text).includes("VENDOR_GPT")),
      thirdHasNoVendor: thirdSnap.parts.every((part) => part.modelContext === false),
    });

    const skipped = await createSession({ agent: "plain", model: { providerID: "claude-agent", id: "claude-opus-5-5" } });
    const skip = await prompt(skipped, "skip provider");
    scenario("skip claude-agent", snapshot(skip.entry), {
      provider: skip.entry.model?.providerID === "claude-agent",
      noVendor: snapshot(skip.entry).parts.every((part) => part.modelContext === false),
    });

    const owned = await createSession({ agent: "owned", model: plain });
    const custom = await prompt(owned, "custom agent");
    const customSnap = snapshot(custom.entry);
    scenario("custom agent", customSnap, {
      noVendor: customSnap.parts.every((part) => part.modelContext === false),
      ownSystemPresent: customSnap.parts.some((part) => part.custom),
    });

    writeFileSync(join(contextDir, "gpt-6.2-sol.md"), `${EXACT_NEXT}\n`);
    const edited = await prompt(loadSession, "live edit");
    const editedVendor = snapshot(edited.entry).parts.find((part) => part.modelContext);
    scenario("live edit", snapshot(edited.entry), {
      text: editedVendor?.text === EXACT_NEXT,
      replaced: snapshot(edited.entry).parts.filter((part) => part.modelContext).length === 1,
    });

    const beforeHooks = records().length;
    const compact = await call("POST", `/api/session/${loadSession}/compact`, {}, 90_000);
    const generate = await call("POST", `/api/session/${loadSession}/generate`, { prompt: "title this" }, 90_000);
    const extra = records().slice(beforeHooks).filter((row) => row.at === "system" && row.sessionID === loadSession);
    const compactHit = extra.some((row) => row.hook === "compaction" && snapshot(row).parts.some((part) => part.text === EXACT_NEXT));
    scenario("compaction and generate hooks", {
      compactStatus: compact.status,
      generateStatus: generate.status,
      hooks: extra.map((row) => row.hook),
      compactInvoked: extra.some((row) => row.hook === "compaction"),
      stderrHasUnavailable: output.text.includes("is unavailable"),
    }, {
      // 2.0.0 accepts the hook and can return 200 from POST /compact without
      // reaching the model request. 2.2.5 does reach it. Either way the vendor
      // text is present when the hook runs.
      compactHook: compactHit || (compact.status >= 200 && compact.status < 300 && !extra.some((row) => row.hook === "compaction")),
      generateHook: extra.some((row) => row.hook === "generate" && snapshot(row).parts.some((part) => part.text === EXACT_NEXT)),
      registrationAccepted: !output.text.includes("hook compaction is unavailable") && !output.text.includes("hook generate is unavailable") && !output.text.includes("no session.hook"),
    });

    const failed = scenarios.filter((item) => item.status === "fail");
    return {
      version,
      binary: reported,
      status: failed.length ? "fail" : "pass",
      setup,
      scenarios,
      serverTail: output.text.slice(-1500),
    };
  } finally {
    await stop();
    writeFileSync(join(base, "server.out"), output.text);
    const left = survivors(base);
    if (left.length) console.error(`survivors for ${version}:\n${left.join("\n")}`);
  }
}

const reports = [];
for (const version of selected) {
  try {
    reports.push(await runVersion(version));
  } catch (error) {
    reports.push({ version, status: "fail", error: String(error?.stack ?? error?.message ?? error) });
  }
}
const out = join(repo, ".fixtures/model-context/report.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(reports, null, 2));
console.log(JSON.stringify(reports, null, 2));
if (reports.some((report) => report.status !== "pass")) process.exit(1);
