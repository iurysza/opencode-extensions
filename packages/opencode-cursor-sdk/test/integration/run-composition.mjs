#!/usr/bin/env node
// Isolated actual-host RPC proofs. No real Cursor SDK, credentials or non-loopback network.
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareIsolatedBase, requireBinaryVersion, requireIsolationTools, sandboxed, sandboxedSpawn } from "../isolation.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const die = message => { throw new Error(`COMPOSITION FAIL-CLOSED: ${message}`); };
requireIsolationTools(die);
const versions = process.argv.slice(2).length ? process.argv.slice(2) : ["2.0.0", "2.2.5"];
for (const version of versions) {
  const base = join(repo, ".fixtures/composition-host", version);
  prepareIsolatedBase(base, "composition-" + version, die);
  const bin = join(repo, ".fixtures/inspect", `bin-${version}`, "package/bin/opencode");
  requireBinaryVersion(base, bin, version, die);
  const project = join(base, "project");
  const log = join(base, "actions.jsonl"); writeFileSync(log, "");
  writeFileSync(join(base, "oc/opencode.json"), JSON.stringify({ plugins: [{ package: join(here, "composition-plugin"), options: { log } }] }));
  const password = randomBytes(24).toString("base64url");
  const port = await new Promise(resolve => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const port = s.address().port; s.close(() => resolve(port)); }); });
  const child = sandboxedSpawn(base, bin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], project, { OPENCODE_PASSWORD: password });
  let output = "";
  child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
  const exited = new Promise(resolve => { child.once("exit", () => resolve(true)); child.once("error", () => resolve(true)); });
  try {
    const end = Date.now() + 30000;
    while (!output.includes("server listening on")) {
      if (Date.now() > end || child.exitCode !== null) die("host did not start");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const probe = sandboxed(base, process.execPath, [join(here, "composition-probe.mjs"), `http://127.0.0.1:${port}`, project, log, password, version], repo);
    writeFileSync(join(base, "probe.out"), probe.stdout ?? ""); writeFileSync(join(base, "probe.err"), probe.stderr ?? "");
    if (probe.status !== 0) die(`probe ${version} failed: ${(probe.stderr ?? "").slice(-1000)}`);
    console.log((probe.stdout ?? "").trim());
  } finally {
    if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
    writeFileSync(join(base, "server.out"), output.replace(/server password \S+/g, "server password [fixture-redacted]"));
  }
}
