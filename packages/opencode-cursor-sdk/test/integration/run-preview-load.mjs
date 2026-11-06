#!/usr/bin/env node
// No model requests, no credentials, no Cursor imports. Tests the actual generator/default entries.
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareIsolatedBase, requireBinaryVersion, requireIsolationTools, sandboxed, sandboxedSpawn } from "../isolation.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const die = message => { throw new Error(`PREVIEW LOAD FAIL-CLOSED: ${message}`); };
requireIsolationTools(die);
const sdkPath = realpathSync(join(repo, "node_modules/@cursor/sdk"));
const versions = process.argv.slice(2).length ? process.argv.slice(2) : ["2.0.0", "2.2.5"];
for (const version of versions) for (const mode of ["local-only", "with-cloud"]) {
  const base = join(repo, `.fixtures/preview-load-${mode}`, version);
  prepareIsolatedBase(base, `preview-${version}-${mode}`, die, { extraReadDenials: [sdkPath] });
  // Deny loading the real SDK even accidentally, on either backend.
  const denied = sandboxed(base, "/bin/cat", [join(sdkPath, "package.json")], repo);
  if (denied.status === 0 || !/Operation not permitted|Permission denied/u.test(`${denied.stdout}${denied.stderr}`)) die("SDK filesystem import denial is not enforced");
  writeFileSync(join(base, "sdk-denial.txt"), denied.stderr ?? "");
  const bin = join(repo, ".fixtures/inspect", `bin-${version}`, "package/bin/opencode");
  requireBinaryVersion(base, bin, version, die);
  const generated = sandboxed(base, process.execPath, [join(repo, "scripts/home-preview.mjs"), ...(mode === "with-cloud" ? ["--include-cloud"] : [])], repo);
  if (generated.status !== 0) die(`generator failed: ${generated.stderr}`);
  const config = JSON.parse(generated.stdout.slice(0, generated.stdout.indexOf("\nLocal runtime")));
  for (const entry of config.plugins) if (!entry.package.endsWith("/dist")) die("generator did not target dist wrappers");
  writeFileSync(join(base, "generator.out"), generated.stdout); writeFileSync(join(base, "generator.err"), generated.stderr);
  // Clone only the generated config into the isolated host. Do not add fixture plugins or options.
  writeFileSync(join(base, "oc/opencode.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
  const project = join(base, "project");
  const password = randomBytes(24).toString("base64url");
  const port = await new Promise(resolvePort => { const socket = createServer(); socket.listen(0, "127.0.0.1", () => { const port = socket.address().port; socket.close(() => resolvePort(port)); }); });
  const child = sandboxedSpawn(base, bin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], project, { OPENCODE_PASSWORD: password });
  let output = "";
  child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
  const exited = new Promise(resolveExit => { child.once("exit", () => resolveExit(true)); child.once("error", () => resolveExit(true)); });
  try {
    const deadline = Date.now() + 30000;
    while (!output.includes("server listening on")) {
      if (Date.now() > deadline || child.exitCode !== null) die("host did not start");
      await new Promise(done => setTimeout(done, 50));
    }
    const probe = sandboxed(base, process.execPath, [join(here, "preview-load-probe.mjs"), `http://127.0.0.1:${port}`, project, password, version, mode, join(base, "summary.json")], repo);
    writeFileSync(join(base, "probe.out"), probe.stdout ?? ""); writeFileSync(join(base, "probe.err"), probe.stderr ?? "");
    if (probe.status !== 0) die(`probe ${version}/${mode} failed: ${(probe.stderr ?? "").slice(-2000)}`);
    console.log(probe.stdout.trim());
  } finally {
    if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    await Promise.race([exited, new Promise(done => setTimeout(done, 5000))]);
    writeFileSync(join(base, "server.out"), output.replaceAll(password, "[fixture-redacted]"));
  }
}
