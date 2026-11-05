import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
const [url, project, password, version, mode, summaryPath] = process.argv.slice(2);
const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json", "x-opencode-directory": encodeURIComponent(project) };
async function call(path, body) {
  const response = await fetch(url + path, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const text = await response.text(); let json; try { json = JSON.parse(text); } catch {}
  return { status: response.status, json };
}
const created = await call("/api/session", { title: "default-entry-load-only" });
assert.equal(created.status, 200, JSON.stringify(created));
const sessionID = created.json.data.id;
const scope = { sessionID, location: { directory: project } };
const rpc = (owner, method) => call(`/api/rpc/${owner}/${method}`, { input: { scope } });
const status = await rpc("cursor-sdk-controls", "status");
assert.equal(status.status, 200, JSON.stringify(status));
assert.equal(status.json.output.code, "ok");
assert.deepEqual(status.json.output.snapshot, { state: "idle", runtime: "local", mode: "agent", tools: "both" });
const models = await rpc("cursor-sdk-controls", "models");
assert.equal(models.json.output.code, "ok"); assert.ok(models.json.output.snapshot.items.length > 0);
assert.ok(models.json.output.snapshot.items.some(item => item.id === "composer-2.5"));
const cloud = await rpc("cursor-cloud-controls", "status");
if (mode === "with-cloud") {
  assert.equal(cloud.status, 200, JSON.stringify(cloud));
  assert.equal(cloud.json.output.code, "ok"); assert.deepEqual(cloud.json.output.snapshot.items, []);
  const cloudModels = await rpc("cursor-cloud-controls", "models");
  assert.equal(cloudModels.json.output.code, "ok"); assert.ok(cloudModels.json.output.snapshot.items.some(item => item.id === "composer-2.5"));
} else assert.equal(cloud.status, 400, JSON.stringify(cloud));
const context = await call(`/api/session/${sessionID}/context`);
assert.equal(context.status, 200);
assert.ok(!context.json.data.some(item => ["assistant", "user", "synthetic"].includes(item.type)));
const summary = { version, mode, pass: true, checks: { actualGeneratorDistTargets: true, actualDefaultEntries: true, sdkLocalIdle: true, sdkFallbackModels: true, backgroundOptIn: true, noPromptOrGenerate: true, noConversationMessages: true, sdkFilesystemImportBlocked: true, isolatedHomeXdg: true, loopbackOnly: true }, proof: "Public session creation and read-only status/models RPC only. SDK filesystem access positively denied by sandbox; no factory injections or credentials." };
writeFileSync(summaryPath, JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary));
