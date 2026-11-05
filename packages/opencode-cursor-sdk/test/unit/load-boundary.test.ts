// F-44 load boundary: loading the built package entries must not import @cursor/sdk, Pi or
// OpenCode internals, and must not open a network connection. Runs in a fresh Node process
// with a module resolve hook that records every specifier and network APIs that throw.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const pkg = resolve(import.meta.dirname, "../..");
const FORBIDDEN = /^(@cursor\/sdk|@iurysza\/pi-|pi-cursor|@earendil-works\/|@opencode\/(?!plugin$))/;

const childScript = `
const { registerHooks, syncBuiltinESMExports } = await import("node:module");
const seen = [];
registerHooks({ resolve(specifier, context, next) { seen.push(specifier); return next(specifier, context); } });
const net = (await import("node:net")).default; const http = (await import("node:http")).default; const https = (await import("node:https")).default;
const deny = (name) => () => { throw new Error("network attempted: " + name); };
globalThis.fetch = deny("fetch"); net.connect = net.createConnection = deny("net.connect");
http.request = http.get = deny("http"); https.request = https.get = deny("https");
syncBuiltinESMExports();
for (const entry of JSON.parse(process.argv[1])) await import(entry.startsWith(".") ? new URL(entry, "file://${pkg}/").href : entry);
process.stdout.write(JSON.stringify(seen));
`;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}

function load(entries: string[]) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", childScript, JSON.stringify(entries)], { cwd: pkg, encoding: "utf8" });
}

describe("package load boundary", () => {
  it("built entries load without importing the SDK or touching the network", () => {
    expect(existsSync(join(pkg, "dist/server.js")), "run npm run build first").toBe(true);
    const run = load(["./dist/server.js", "./dist/provider/factory.js"]);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const seen: string[] = JSON.parse(run.stdout);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((s) => FORBIDDEN.test(s))).toEqual([]);
  });

  it("negative control: the hook records an SDK import when one happens", () => {
    // Resolve-only via import.meta.resolve: records the specifier without loading SDK code.
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", `${childScript.split("for (const entry")[0]}import.meta.resolve("@cursor/sdk"); process.stdout.write(JSON.stringify(seen));`], { cwd: pkg, encoding: "utf8" });
    expect(run.status).toBe(0);
    expect((JSON.parse(run.stdout) as string[]).filter((s) => FORBIDDEN.test(s))).toEqual(["@cursor/sdk"]);
  });

  it("network deny hooks fire", () => {
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", `${childScript.split("for (const entry")[0]}const { connect } = await import("node:net"); try { connect(80, "127.0.0.1"); } catch (e) { process.stdout.write(e.message); }`], { cwd: pkg, encoding: "utf8" });
    expect(run.stdout).toBe("network attempted: net.connect");
  });

  it("production static imports exclude SDK execution, Pi and private host APIs", () => {
    const offenders = sourceFiles(join(pkg, "src")).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      // Type-only imports erase at build time. SDK execution is permitted only via
      // lazy import; the fresh-process test above verifies the actual startup graph.
      return [...source.matchAll(/import\s+(?!type\b)[^;]*?from\s*["']([^"']+)["']/g)]
        .map((m) => m[1] ?? "")
        .filter((spec) => FORBIDDEN.test(spec) && !(file.includes("/src/tui/") && spec === "@opencode/plugin/tui"))
        .map((spec) => `${file}: ${spec}`);
    });
    expect(offenders).toEqual([]);
  });
});
