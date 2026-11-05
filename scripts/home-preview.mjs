#!/usr/bin/env node
// Configuration only. Never imports an SDK, reads credentials, or starts a process.
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
if ([...args].some(arg => !["--write", "--include-cloud", "--help"].includes(arg))) throw new Error("Use --write and optionally --include-cloud. No path overrides are accepted.");
if (args.has("--help")) {
  console.log("node scripts/home-preview.mjs [--write] [--include-cloud]\nPrint a worktree-only preview config. --write saves it with mode 0600. Never launches OpenCode.");
  process.exit(0);
}
const names = ["sdk", ...(args.has("--include-cloud") ? ["cloud"] : [])];
const packages = names.map(name => join(root, "packages", `opencode-cursor-${name}`));
for (const pkg of packages) for (const file of ["dist/server.js", "dist/tui.js"]) if (!existsSync(join(pkg, file))) throw new Error(`Build first: missing ${join(pkg, file)}`);
const base = join(root, ".fixtures", "home-preview");
const config = { model: "cursor/composer-2.5", plugins: packages.map(pkg => ({ package: join(pkg, "dist") })) };
if (args.has("--include-cloud")) console.warn("WARNING: background Cloud tools can launch billable remote work at Cursor Max Mode pricing. This command only writes config; it does not launch anything.");
if (args.has("--write")) {
  for (const dir of [base, ...["home", "config", "data", "state", "cache"].map(d => join(base, d))]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(base, "opencode.json");
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 }); chmodSync(path, 0o600);
  console.log(`Wrote ${path}. Nothing was started.`);
} else console.log(JSON.stringify(config, null, 2));
console.log("Local runtime is the default. Live Cursor behavior is unverified. See ai-artifacts/opencode-port/home-test.md before manually running installed OpenCode 2.x.");
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
const launchEnv = { HOME: join(base, "home"), XDG_CONFIG_HOME: join(base, "config"), XDG_DATA_HOME: join(base, "data"), XDG_STATE_HOME: join(base, "state"), XDG_CACHE_HOME: join(base, "cache"), OPENCODE_CONFIG: join(base, "opencode.json"), OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1" };
console.log("After approval, config --write, and silent user key entry, manually run from your intended checkout:");
console.log(`env -u PI_CURSOR_RUNTIME -u PI_CURSOR_CLOUD_ACK ${Object.entries(launchEnv).map(([key, value]) => `${key}=${quote(value)}`).join(" ")} opencode`);
