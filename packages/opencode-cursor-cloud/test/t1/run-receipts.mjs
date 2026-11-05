#!/usr/bin/env node
// G5 real-host T1 runner. Starts the pinned OpenCode `serve` binary under the shared isolation
// (`env -i`, isolated HOME/XDG, loopback-only sandbox, positive EPERM checks) with the receipts
// fixture plugin, and drives every case through public server routes and the fixture RPC.
// Crash cases SIGKILL the host (from the fixture fault point or from here) and restart it on the
// same isolated data dir, so receipt persistence across host processes is real.
// Waits are bounded polls on explicit evidence (log records or host state), never fixed sleeps.
// No Cursor SDK call, no network beyond loopback.
//
// Every version run ends in a bounded cleanup (`finally`) that kills the server process group,
// including after a start timeout or an unexpected runner error; the exit code stays nonzero.
//
// Usage: node test/t1/run-receipts.mjs [2.0.0] [2.2.5] [--fault=start-timeout|after-start]
// `--fault` is test-only: it makes the runner fail on purpose to prove cleanup leaves no process.
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { prepareIsolatedBase, realHome, requireBinaryVersion, requireIsolationTools, sandboxedSpawn } from "../../../opencode-cursor-sdk/test/isolation.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "../..");
const repo = resolve(pkg, "../..");
const args = process.argv.slice(2);
const fault = args.find((a) => a.startsWith("--fault="))?.slice("--fault=".length);
const versionArgs = args.filter((a) => !a.startsWith("--"));
const versions = versionArgs.length ? versionArgs : ["2.0.0", "2.2.5"];
const RPC = "iurysza.receipts-fixture";

const die = (message) => {
  console.error(`RECEIPTS FAIL-CLOSED: ${message}`);
  process.exit(2);
};
requireIsolationTools(die);
for (const f of ["dist/plugin/completion.js", "../opencode-cursor-sdk/dist/plugin/create.js"]) if (!existsSync(join(pkg, f))) die(`${f} missing; run npm run build first`);

const freePort = () =>
  new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

async function until(label, fn, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function survivors(base) {
  const ps = spawnSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return (ps.stdout ?? "").split("\n").filter((l) => l.includes(base) && !l.includes("/bin/ps"));
}

async function runVersion(version) {
  const bin = join(repo, ".fixtures/inspect", `bin-${version}`, "package/bin/opencode");
  const base = join(repo, ".fixtures/receipts", version);
  prepareIsolatedBase(base, version, die);
  const reported = requireBinaryVersion(base, bin, version, die);
  const log = join(base, "receipts.jsonl");
  writeFileSync(log, "");
  writeFileSync(join(base, "oc/opencode.json"), JSON.stringify({ plugins: [{ package: join(here, "receipts-plugin"), options: { log } }] }, null, 2));
  const project = join(base, "project");
  const password = randomBytes(24).toString("base64url"); // per-run loopback server password, not a credential
  const headers = {
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    "content-type": "application/json",
    "x-opencode-directory": encodeURIComponent(project),
  };

  let server;
  let port;
  let starts = 0;
  const pids = [];
  async function start() {
    port = await freePort();
    starts++;
    const child = sandboxedSpawn(base, bin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], project, { OPENCODE_PASSWORD: password });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const exited = new Promise((r) => {
      child.once("exit", (code, signal) => r({ code, signal }));
      child.once("error", (error) => r({ code: null, signal: null, error: String(error?.message ?? error) }));
    });
    server = { child, exited, output: () => out };
    pids.push(child.pid);
    try {
      await until(`server ${starts} ready`, async () => (await call("POST", `/api/rpc/${RPC}/ping`, { input: {} }).catch(() => ({ status: 0 }))).status === 200, fault === "start-timeout" ? 0 : 30_000);
    } catch (error) {
      await stop();
      throw error;
    }
    writeFileSync(join(base, `server-${starts}.out`), "");
    return server;
  }
  /** Kills the server's process group and waits at most 10 s for it to exit. */
  async function stop(signal = "SIGKILL") {
    if (!server) return;
    const current = server;
    server = undefined;
    if (current.child.pid !== undefined) {
      try {
        process.kill(-current.child.pid, signal);
      } catch {}
    }
    const r = await Promise.race([current.exited, new Promise((ok) => setTimeout(() => ok({ timeout: true }), 10_000))]);
    writeFileSync(join(base, `server-${starts}.out`), current.output() + (r?.timeout ? "\n[runner] server did not exit within 10 s of SIGKILL\n" : r?.error ? `\n[runner] spawn error: ${r.error}\n` : ""));
  }
  async function crashed() {
    const r = await Promise.race([server.exited, new Promise((ok) => setTimeout(() => ok(undefined), 20_000))]);
    if (!r) throw new Error("expected fixture crash did not happen");
    await stop();
    return r;
  }

  async function call(method, path, body) {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, json, text: text.slice(0, 500) };
  }
  const rpc = async (method, input = {}) => {
    const r = await call("POST", `/api/rpc/${RPC}/${method}`, { input });
    if (r.status !== 200) throw new Error(`rpc ${method} ${r.status}: ${r.text}`);
    return r.json.output;
  };
  const newSession = async () => (await call("POST", "/api/session", { model: { providerID: "cursor", id: "fake" } })).json.data.id;
  const context = async (sid) => (await call("GET", `/api/session/${sid}/context`)).json?.data ?? [];
  const inbox = async (sid) => (await call("GET", `/api/session/${sid}/inbox`)).json?.data ?? [];
  const prompt = async (sid, text) => (await call("POST", `/api/session/${sid}/prompt`, { text })).json?.data;
  const waitIdle = async (sid) => {
    for (const p of [`/api/session/${sid}/wait`, `/api/experimental/session/${sid}/wait`]) {
      const r = await call("POST", p, {});
      if (r.status !== 404) return r.status;
    }
    throw new Error("no wait route");
  };
  const records = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const rowsWith = async (sid, id) => (await context(sid)).filter((m) => m.type === "synthetic" && m.id === id);
  const receiptOf = async (runId) => (await rpc("list")).receipts.find((r) => r.runId === runId);
  const callsFor = (runId) => records().filter((e) => e.at === "synthetic-call" && e.runId === runId);
  const sawText = (sid, text) => records().some((e) => e.at === "source" && e.sessionID === sid && e.seen.includes(text));
  const observe = (sessionID, runId, extra = {}) => rpc("observe", { sessionID, agentId: "bc-fixture", runId, text: `Cloud agent finished run=${runId}`, ...extra });
  const T = (runId) => `Cloud agent finished run=${runId}`;

  const scenarios = [];
  const sessions = new Set();
  async function scenario(name, cases, fn) {
    const checks = {};
    const notes = [];
    try {
      await fn(checks, notes);
    } catch (error) {
      checks.completed = false;
      notes.push(`error: ${String(error?.message ?? error).slice(0, 300)}`);
    }
    const pass = Object.keys(checks).length > 0 && Object.values(checks).every(Boolean);
    scenarios.push({ name, cases, status: pass ? "pass" : "fail", checks, notes });
    if (!server) await start().catch(() => {});
  }

  try {
  await start();
  if (!records().some((e) => e.at === "setup")) throw new Error(`${version}: fixture plugin did not load`);
  if (fault === "after-start") throw new Error("test-only fault after server start");

  let s1;
  let s1Id;
  await scenario("basic", ["one stored synthetic per receipt", "admission and delivery recorded separately"], async (c) => {
    s1 = await newSession();
    sessions.add(s1);
    const out = await observe(s1, "s1");
    s1Id = out.receipt.id;
    c.created = out._tag === "receipt" && out.created === true;
    c.mintedHostShape = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(s1Id);
    c.wakeRequested = out.receipt.admission?.wake === "requested";
    await until("delivered event", () => records().some((e) => e.at === "delivered-event" && e.inboxID === s1Id));
    await until("woken turn saw completion", () => sawText(s1, T("s1")));
    await waitIdle(s1);
    const r = await receiptOf("s1");
    c.delivered = r?.state === "delivered" && r.delivery?.via === "event";
    c.admissionAndDeliverySeparate = r?.admission !== null && r?.delivery !== null && r.admission.at <= r.delivery.at;
    c.answerUnknown = r?.answer === "unknown";
    c.oneRow = (await rowsWith(s1, s1Id)).length === 1;
    c.oneCall = callsFor("s1").length === 1;
  });

  await scenario("busy-final-step-and-intervening-prompt", ["busy session", "last step", "delayed reply / intervening user prompt"], async (c, n) => {
    const sid = await newSession();
    sessions.add(sid);
    await rpc("hold", { sessionID: sid });
    await prompt(sid, "user turn that will be busy");
    await until("turn blocked on its final step", () => records().some((e) => e.at === "blocked" && e.sessionID === sid));
    const out = await observe(sid, "s2");
    const id = out.receipt.id;
    c.admittedWhileBusy = out.receipt.state === "admitted" && out.receipt.admission?.wake === "requested";
    c.notPromotedWhileBusy = (await inbox(sid)).some((i) => i.id === id) && (await rowsWith(sid, id)).length === 0;
    await prompt(sid, "intervening user prompt");
    await rpc("release", { sessionID: sid });
    await until("delivered event", () => records().some((e) => e.at === "delivered-event" && e.inboxID === id));
    await until("later turn saw completion", () => sawText(sid, T("s2")));
    await waitIdle(sid);
    const r = await receiptOf("s2");
    c.delivered = r?.state === "delivered";
    c.answerUnknown = r?.answer === "unknown";
    c.oneRow = (await rowsWith(sid, id)).length === 1;
    c.oneCall = callsFor("s2").length === 1;
    n.push("The fake turn has one step, blocked after its first text part; the completion is admitted while that final step is in flight.");
  });

  await scenario("two-sessions", ["several sessions, originating one gets it"], async (c) => {
    const a = await newSession();
    const b = await newSession();
    sessions.add(a).add(b);
    await rpc("hold", { sessionID: b });
    await prompt(b, "other session busy");
    await until("other session blocked", () => records().some((e) => e.at === "blocked" && e.sessionID === b));
    const out = await observe(a, "s3");
    const id = out.receipt.id;
    await until("delivered to originating session", () => records().some((e) => e.at === "delivered-event" && e.inboxID === id && e.sessionID === a));
    await rpc("release", { sessionID: b });
    await waitIdle(a);
    await waitIdle(b);
    c.originatingHasRow = (await rowsWith(a, id)).length === 1;
    c.otherHasNoRow = (await rowsWith(b, id)).length === 0;
    c.otherNeverSawText = !sawText(b, T("s3"));
    c.oneCall = callsFor("s3").length === 1;
  });

  await scenario("two-completions-one-session", ["two completions in one session"], async (c) => {
    const sid = await newSession();
    sessions.add(sid);
    const [x, y] = await Promise.all([observe(sid, "s4a"), observe(sid, "s4b")]);
    c.distinctIds = x.receipt.id !== y.receipt.id;
    await until("both delivered", () => ["s4a", "s4b"].every((run) => records().some((e) => e.at === "delivered-event" && e.inboxID === (run === "s4a" ? x : y).receipt.id)));
    await waitIdle(sid);
    c.oneRowEach = (await rowsWith(sid, x.receipt.id)).length === 1 && (await rowsWith(sid, y.receipt.id)).length === 1;
    c.oneCallEach = callsFor("s4a").length === 1 && callsFor("s4b").length === 1;
  });

  await scenario("duplicate-and-late-events", ["duplicate and late terminal events"], async (c) => {
    const outs = await Promise.all([observe(s1, "s1"), observe(s1, "s1"), observe(s1, "s1")]);
    c.allDuplicates = outs.every((o) => o._tag === "receipt" && o.created === false && o.receipt.id === s1Id && o.receipt.state === "delivered");
    c.noNewCall = callsFor("s1").length === 1;
    c.oneRow = (await rowsWith(s1, s1Id)).length === 1;
  });

  await scenario("payload-mismatch", ["payload mismatch under an existing receipt ID"], async (c, n) => {
    const changed = await observe(s1, "s1", { text: "different text for the same run" });
    c.refusedByReceipt = changed._tag === "refused" && changed.reason === "payload-mismatch";
    c.noCallForRefusal = callsFor("s1").length === 1;
    // Promoted row: reusing s1's ID is caught from public history before any host call.
    await rpc("nextId", { id: s1Id });
    const promoted = await observe(s1, "s6");
    c.promotedReuseHeldWithoutCall = promoted.receipt.state === "held" && promoted.receipt.hold?.reason === "payload-mismatch" && callsFor("s6").length === 0;
    const rows = await rowsWith(s1, s1Id);
    c.stillOneRowWithOriginalText = rows.length === 1 && rows[0].text === T("s1");
    // Pending row (resume:false, not promoted): the host call happens and the raw host ignores new text.
    const sid = await newSession();
    sessions.add(sid);
    const pending = await observe(sid, "s6a", { resume: false });
    await rpc("nextId", { id: pending.receipt.id });
    const staged = await observe(sid, "s6b", { resume: false });
    const ret = records().filter((e) => e.at === "synthetic-return" && e.id === pending.receipt.id).at(-1);
    c.hostCalledForPendingReuse = callsFor("s6b").length === 1;
    c.hostReturnedOriginalText = ret?.text === T("s6a");
    c.heldPayloadMismatch = staged.receipt.state === "held" && staged.receipt.hold?.reason === "payload-mismatch";
    const items = (await inbox(sid)).filter((i) => i.id === pending.receipt.id);
    c.onePendingItem = items.length === 1;
    n.push("Raw host: a replayed ID with new text returns the existing row unchanged and raises no error. Fresh minted IDs make this unreachable in production; both cases are staged with nextId.");
  });

  await scenario("cross-session-id-conflict", ["same ID from another session (host conflict)"], async (c) => {
    const other = await newSession();
    sessions.add(other);
    await rpc("nextId", { id: s1Id });
    const out = await observe(other, "s7");
    const thrown = records().filter((e) => e.at === "synthetic-throw" && e.id === s1Id).at(-1);
    c.hostRaisedConflict = /SyntheticConflict/.test(thrown?.error ?? "");
    c.heldHostConflict = out.receipt.state === "held" && out.receipt.hold?.reason === "host-conflict";
    c.noRowInOther = (await rowsWith(other, s1Id)).length === 0;
    c.originalUntouched = (await rowsWith(s1, s1Id)).length === 1;
  });

  await scenario("resume-false-then-intervening-prompt", ["resume:false", "delayed reply / intervening user prompt"], async (c) => {
    const sid = await newSession();
    sessions.add(sid);
    const out = await observe(sid, "s8", { resume: false });
    const id = out.receipt.id;
    c.admittedSuppressed = out.receipt.state === "admitted" && out.receipt.admission?.wake === "suppressed";
    await waitIdle(sid);
    c.pendingAfterIdle = (await inbox(sid)).some((i) => i.id === id);
    c.noTurnRan = !records().some((e) => e.at === "source" && e.sessionID === sid && e.kind === "primary");
    await prompt(sid, "intervening user prompt wakes the session");
    await until("delivered event", () => records().some((e) => e.at === "delivered-event" && e.inboxID === id));
    await waitIdle(sid);
    const r = await receiptOf("s8");
    c.delivered = r?.state === "delivered";
    c.answerUnknown = r?.answer === "unknown";
    c.oneRow = (await rowsWith(sid, id)).length === 1;
    c.oneCall = callsFor("s8").length === 1;
  });

  await scenario("reverted-session", ["reverted session"], async (c) => {
    const sid = await newSession();
    sessions.add(sid);
    await prompt(sid, "message to revert");
    await waitIdle(sid);
    const user = (await context(sid)).find((m) => m.type === "user");
    const staged = await call("POST", `/api/session/${sid}/revert/stage`, { messageID: user?.id });
    c.revertStaged = staged.status === 200;
    const before = records().filter((e) => e.at === "source" && e.sessionID === sid).length;
    const out = await observe(sid, "s9");
    const id = out.receipt.id;
    c.admittedWithoutWake = out.receipt.state === "admitted" && out.receipt.admission?.wake === "skipped-reverted";
    await waitIdle(sid);
    c.pendingAfterIdle = (await inbox(sid)).some((i) => i.id === id);
    c.noNewTurn = records().filter((e) => e.at === "source" && e.sessionID === sid).length === before;
    const again = await rpc("reconcile", { sessionID: sid });
    c.surfacedNotRetried = again.receipts.find((r) => r.id === id)?.state === "admitted" && callsFor("s9").length === 1;
  });

  await scenario("deleted-session", ["deleted session"], async (c) => {
    const sid = await newSession();
    const del = await call("DELETE", `/api/session/${sid}`);
    c.deleted = del.status >= 200 && del.status < 300;
    const out = await observe(sid, "s10");
    c.failedClosed = out.receipt.state === "held" && out.receipt.hold?.reason === "session-deleted";
    c.noSyntheticCall = callsFor("s10").length === 0;
  });

  // ---- crash and restart cases ----
  const beforeRestart = (await rpc("list")).receipts;

  await scenario("crash-before-attempt", ["crash before admission (observed, not attempted)", "restart"], async (c) => {
    const sid = await newSession();
    sessions.add(sid);
    await rpc("arm", { point: "observed-saved", runId: "c1" });
    await observe(sid, "c1").catch(() => {});
    const exit = await crashed();
    c.hostKilled = exit.signal === "SIGKILL" || exit.code !== 0;
    c.noCallBeforeCrash = callsFor("c1").length === 0;
    await start();
    const rec = await rpc("recover");
    c.recoveryDispatched = rec.dispatched >= 1;
    const r = await receiptOf("c1");
    await until("delivered after recovery", () => records().some((e) => e.at === "delivered-event" && e.inboxID === r?.id));
    await waitIdle(sid);
    c.oneCall = callsFor("c1").length === 1;
    c.oneRow = (await rowsWith(sid, r.id)).length === 1;
    const post = await rpc("list");
    c.persistedAcrossRestart = beforeRestart.every((b) => post.receipts.some((p) => p.id === b.id && p.runId === b.runId && (p.state === b.state || p.state === "delivered")));
  });

  await scenario("crash-after-attempt", ["crash after attempt (intent persisted, host not called)", "restart"], async (c) => {
    const sid = await newSession();
    sessions.add(sid);
    await rpc("arm", { point: "intent-saved", runId: "c2" });
    await observe(sid, "c2").catch(() => {});
    await crashed();
    await start();
    const rec = await rpc("recover");
    const r = await receiptOf("c2");
    c.heldUncertain = r?.state === "held" && r.hold?.reason === "uncertain-attempt" && rec.heldUncertain >= 1;
    c.diagnosticShown = records().some((e) => e.at === "diagnostic" && e.detail?.runId === "c2");
    const dup = await observe(sid, "c2");
    c.duplicateNotReplayed = dup.receipt.state === "held";
    c.noCall = callsFor("c2").length === 0;
    c.noRow = (await rowsWith(sid, r.id)).length === 0 && !(await inbox(sid)).some((i) => i.id === r.id);
  });

  await scenario("crash-after-admission", ["crash after admission (host admitted, receipt not updated)", "restart"], async (c, n) => {
    const sid = await newSession();
    sessions.add(sid);
    await rpc("arm", { point: "host-admitted", runId: "c3" });
    await observe(sid, "c3").catch(() => {});
    await crashed();
    const id = records().find((e) => e.at === "synthetic-call" && e.runId === "c3")?.id;
    await start();
    await rpc("recover");
    await waitIdle(sid);
    const final = (await rpc("reconcile", { sessionID: sid })).receipts.find((r) => r.runId === "c3");
    c.notReplayed = callsFor("c3").length === 1;
    c.atMostOneRow = (await rowsWith(sid, id)).length <= 1;
    c.stateDeliveredOrHeld = final?.state === "delivered" || (final?.state === "held" && final.hold?.reason === "uncertain-attempt");
    const returned = records().some((e) => e.at === "synthetic-return" && e.id === id);
    const rows = (await rowsWith(sid, id)).length;
    const pending = (await inbox(sid)).filter((i) => i.id === id).length;
    c.atMostOneInboxItem = pending <= 1 && pending + rows <= 1;
    const host = rows ? "promoted (public context row)" : pending ? "pending (inbox item, not promoted)" : "absent (no context row, no inbox item)";
    n.push(`host returned before SIGKILL: ${returned}; after restart, ID ${host}; receipt ${final?.state}${final?.hold ? ` (${final.hold.reason})` : ""}; delivery via ${final?.delivery?.via ?? "none"}`);
  });

  await scenario("crash-after-wake", ["crash after wake, before promotion", "restart"], async (c, n) => {
    const sid = await newSession();
    sessions.add(sid);
    await rpc("hold", { sessionID: sid });
    await prompt(sid, "busy before crash");
    await until("blocked", () => records().some((e) => e.at === "blocked" && e.sessionID === sid));
    const out = await observe(sid, "c4");
    const id = out.receipt.id;
    c.admittedWakeRequested = out.receipt.state === "admitted" && out.receipt.admission?.wake === "requested";
    c.pendingAtCrash = (await inbox(sid)).some((i) => i.id === id);
    await stop();
    const sourcesBefore = records().filter((e) => e.at === "source" && e.sessionID === sid).length;
    await start();
    await rpc("recover");
    c.notReplayed = callsFor("c4").length === 1;
    await waitIdle(sid);
    const final = (await rpc("reconcile", { sessionID: sid })).receipts.find((r) => r.id === id);
    c.atMostOneRow = (await rowsWith(sid, id)).length <= 1;
    c.neverRegressed = final?.state === "admitted" || final?.state === "delivered";
    const rerun = records().filter((e) => e.at === "source" && e.sessionID === sid).length - sourcesBefore;
    n.push(`after restart: receipt ${final?.state}; host model requests for this session after restart: ${rerun} (host restart recovery is at-least-once; disclosed, not a gate failure)`);
  });

  await scenario("crash-after-promotion", ["crash after promotion, before local delivered record", "restart"], async (c, n) => {
    const sid = await newSession();
    sessions.add(sid);
    await rpc("arm", { point: "before-delivered-save", runId: "c5" });
    await observe(sid, "c5").catch(() => {});
    await crashed();
    const id = records().find((e) => e.at === "synthetic-call" && e.runId === "c5")?.id;
    c.promotedBeforeCrash = records().some((e) => e.at === "delivered-event" && e.inboxID === id);
    await start();
    await rpc("recover");
    const r = await receiptOf("c5");
    c.reconciledDelivered = r?.state === "delivered";
    c.notReplayed = callsFor("c5").length === 1;
    await waitIdle(sid);
    c.oneRow = (await rowsWith(sid, id)).length === 1;
    n.push(`delivery evidence after restart: ${r?.delivery?.via ?? "none"}`);
  });

  await scenario("late-duplicate-after-restart", ["duplicate and late terminal events", "restart"], async (c) => {
    const out = await observe(s1, "s1");
    c.duplicate = out._tag === "receipt" && out.created === false && out.receipt.state === "delivered";
    c.noNewCall = callsFor("s1").length === 1;
  });

  // ---- global invariants over the whole run ----
  const all = (await rpc("list")).receipts;
  const calls = records().filter((e) => e.at === "synthetic-call");
  const perReceipt = new Map();
  for (const e of calls) perReceipt.set(`${e.id}|${e.runId}`, (perReceipt.get(`${e.id}|${e.runId}`) ?? 0) + 1);
  const rowCount = new Map();
  for (const sid of sessions) for (const m of await context(sid)) if (m.type === "synthetic") rowCount.set(m.id, (rowCount.get(m.id) ?? 0) + 1);
  const invariants = {
    atMostOneHostCallPerReceipt: [...perReceipt.values()].every((n) => n <= 1),
    atMostOneStoredSyntheticPerId: [...rowCount.values()].every((n) => n <= 1),
    everyAnswerUnknown: all.every((r) => r.answer === "unknown"),
    noCorruptReceipts: (await rpc("list")).corrupt.length === 0,
  };
  await stop();
  const orphans = survivors(base);
  invariants.noOrphanProcess = orphans.length === 0;

  const pass = scenarios.every((s) => s.status === "pass") && Object.values(invariants).every(Boolean);
  const summary = {
    version,
    reported,
    serverStarts: starts,
    scenarios,
    invariants,
    receipts: all.map((r) => ({ runId: r.runId, state: r.state, wake: r.admission?.wake ?? null, delivery: r.delivery?.via ?? null, hold: r.hold?.reason ?? null, answer: r.answer })),
    pass,
    evidence: base.replace(realHome, "~"),
  };
  writeFileSync(join(base, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
  } finally {
    await stop();
    for (const pid of pids) {
      try {
        process.kill(-pid, "SIGKILL"); // any group left from an earlier start; ESRCH when gone
      } catch {}
    }
  }
}

const results = [];
for (const v of versions) {
  try {
    results.push(await runVersion(v));
  } catch (error) {
    const base = join(repo, ".fixtures/receipts", v);
    const orphans = survivors(base);
    results.push({ version: v, pass: false, error: String(error?.stack ?? error).slice(0, 1000), orphans });
  }
}
for (const r of results) {
  if (r.error) {
    console.log(`== ${r.version} pass=false RUNNER ERROR\n  ${r.error.split("\n").join("\n  ")}\n  orphan processes after cleanup: ${r.orphans.length}`);
    continue;
  }
  console.log(`== ${r.version} (${r.reported}) pass=${r.pass} starts=${r.serverStarts}`);
  for (const s of r.scenarios) console.log(`  ${s.status.padEnd(4)} ${s.name}${s.status === "pass" ? "" : ` ${JSON.stringify(s.checks)}`}${s.notes.length ? `\n         ${s.notes.join("\n         ")}` : ""}`);
  console.log(`  invariants ${JSON.stringify(r.invariants)}`);
}
process.exit(results.every((r) => r.pass) ? 0 : 1);
