// Runs under env -i and loopback-only sandbox. Public client RPC is the TUI transport.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { OpenCode } from "@opencode/client";
import { controls } from "../../../../.fixtures/control-build/sdk/control-contract.js";
const [url, project, log, password, version] = process.argv.slice(2);
const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json", "x-opencode-directory": encodeURIComponent(project) };
const records = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
async function until(fn) { const end = Date.now() + 10000; while (!await fn()) { if (Date.now() > end) throw new Error("evidence timeout"); await new Promise(resolve => setTimeout(resolve, 25)); } }
async function raw(path, body, extra = {}) {
  const r = await fetch(url + path, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000), ...extra });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json };
}
const rpc = (id, method, input, extra) => raw(`/api/rpc/${id}/${method}`, { input }, extra);
const SDK = controls.id, CLOUD = "cursor-cloud-controls";
const newSession = async title => { const r = await raw("/api/session", { title }); assert.equal(r.status, 200); return r.json.data.id; };
const sessionID = await newSession("controls-fixture");
const scope = { sessionID, location: { directory: project } };
const checks = {};
for (const authorization of [undefined, "Basic invalid"]) {
  const unauth = await rpc(SDK, "status", { scope }, { headers: { ...headers, authorization: authorization ?? "" } });
  assert.equal(unauth.status, 401);
}
checks.hostGlobalAuthorization = true;
const unknown = await rpc(SDK, "shell", { scope }); assert.equal(unknown.status, 400); assert.ok(JSON.stringify(unknown.json).includes("rpc.method_not_found")); checks.fixedMethods = true;
assert.equal((await rpc(SDK, "status", { scope, apiKey: "forbidden" })).status, 400);
assert.equal((await rpc(CLOUD, "spawn", { scope, prompt: "x".repeat(16001), repository: "https://github.com/fixture/repo" })).status, 400); checks.boundedSchema = true;
for (const method of ["archive", "delete"]) assert.equal((await rpc(SDK, method, { scope, id: "foreground-fixture" })).status, 400);
checks.foregroundConfirmationRequired = true;
for (const bad of [{ ...scope, sessionID: "ses_missing" }, { ...scope, location: { directory: project + "/other" } }, { ...scope, location: { directory: project, workspaceID: "wrk_remote" } }]) {
  const reply = await rpc(SDK, "status", { scope: bad }); assert.equal(reply.status, 200, JSON.stringify(reply.json)); assert.equal(reply.json.output.code, "refused");
}
checks.scopeRefusal = true;
const reply = await rpc(SDK, "status", { scope }); assert.equal(reply.json.output.code, "ok"); assert.ok(!JSON.stringify(reply).includes("fixture-secret")); checks.redacted = true;
assert.equal((await rpc(SDK, "refreshConfig", { scope })).json.output.code, "not_implemented"); checks.unavailableHonest = true;
const otherID = await newSession("controls-other");
const otherScope = { ...scope, sessionID: otherID };
const spawned = await rpc(CLOUD, "spawn", { scope, prompt: "fake only", repository: "https://github.com/fixture/repo" });
const id = spawned.json.output.snapshot.items[0].id;
assert.equal((await rpc(CLOUD, "cancel", { scope: otherScope, id, confirmed: true })).json.output.code, "refused");
assert.equal((await rpc(CLOUD, "cancel", { scope, id, confirmed: true })).json.output.code, "ok"); checks.crossSessionAgentRefusal = true;
// Two independent attached clients use the exact rpc(definition) API that the TUI uses.
const clients = [OpenCode.make({ baseUrl: url, headers }), OpenCode.make({ baseUrl: url, headers })];
const stop = new AbortController();
const seen = [[], []];
const off = clients.map((client, i) => client.rpc(controls).events.on("status", event => { seen[i].push(event); }, { signal: stop.signal }));
// Subscription readiness is observed via delivery, not a sleep. Repeat an idempotent setting
// until both live streams receive it, then require another mutation to reach both.
await until(async () => { await rpc(SDK, "fast", { scope, enabled: true }); return seen.every(list => list.length > 0); });
const before = seen.map(list => list.length);
await until(async () => { await clients[0].rpc(controls).fast({ scope, enabled: false }, { location: { directory: project } }); return seen.every((list, i) => list.length > before[i]); });
assert.ok(seen.every(list => list.every(event => event.data.scope.sessionID === sessionID && event.location.directory === project && !JSON.stringify(event).includes("fixture-secret"))));
checks.publicClientEventFanout = true;
off.forEach(close => close()); stop.abort();
const abortID = await newSession("control-abort");
const controller = new AbortController();
const pending = clients[0].rpc(controls).status({ scope: { ...scope, sessionID: abortID } }, { location: { directory: project }, signal: controller.signal }).catch(() => undefined);
await until(() => records().some(record => record.at === "started" && record.sessionID === abortID));
controller.abort(); await pending;
await until(() => records().some(record => record.at === "aborted" && record.sessionID === abortID)); checks.effectInterruptReachesAction = true;
const summary = { version, checks, pass: true, proof: "actual host HTTP/public RPC client, not a rendered TUI" };
writeFileSync(log.replace("actions.jsonl", "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
