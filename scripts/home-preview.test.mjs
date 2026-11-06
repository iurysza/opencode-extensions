import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts/home-preview.mjs");
const configPath = join(root, ".fixtures/home-preview/opencode.json");
function generate(args = []) {
  const source = `
    import { registerHooks, syncBuiltinESMExports } from "node:module";
    import child from "node:child_process"; import net from "node:net";
    const deny = () => { throw new Error("generator attempted launch/network"); };
    for (const k of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) child[k] = deny;
    net.connect = net.createConnection = deny; globalThis.fetch = deny;
    syncBuiltinESMExports();
    registerHooks({ resolve(spec, ctx, next) { if (/^(@cursor\\/|@opentui\\/|@opencode\\/)/.test(spec)) throw new Error("unexpected host/SDK import"); return next(spec, ctx); } });
    process.env = new Proxy(process.env, { get(target, key) { if (key === "CURSOR_API_KEY") throw new Error("generator read credentials"); return target[key]; } });
    process.argv = [process.execPath, ${JSON.stringify(script)}, ...${JSON.stringify(args)}];
    await import(${JSON.stringify(pathToFileURL(script).href)});
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: root, encoding: "utf8", env: { PATH: "/usr/bin:/bin", CURSOR_API_KEY: "preview-test-sentinel-not-a-key" } });
  assert.equal(run.status, 0, run.stderr); assert.ok(!run.stdout.includes("preview-test-sentinel"));
  return run;
}
const parsed = run => JSON.parse(run.stdout.slice(0, run.stdout.indexOf("\nLocal runtime")));
function verify(config, cloud) {
  assert.deepEqual(Object.keys(config).sort(), ["model", "plugins"]);
  assert.equal(config.model, "cursor/composer-2.5");
  assert.deepEqual(config.plugins, ["sdk", ...(cloud ? ["cloud"] : [])].map(name => ({ package: join(root, "packages", `opencode-cursor-${name}`, "dist") })));
  assert.doesNotMatch(JSON.stringify(config), /apiKey|credential|authorization|password|acknowledg/i);
}
test("default config targets built dist wrappers without SDK, credentials, network, or process launch", () => {
  const run = generate(); verify(parsed(run), false); assert.equal(run.stderr, "");
  assert.match(run.stdout, /env -u PI_CURSOR_RUNTIME -u PI_CURSOR_CLOUD_ACK /);
  assert.doesNotMatch(run.stdout, /PI_CURSOR_RUNTIME=local/);
});
test("background tools require explicit opt-in and print billing warning", () => {
  const run = generate(["--include-cloud"]); verify(parsed(run), true); assert.match(run.stderr, /Max Mode pricing/);
});
test("worktree-only saved config has mode 0600 and contains no auth fields", () => {
  generate(["--write"]); verify(JSON.parse(readFileSync(configPath, "utf8")), false);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
});
