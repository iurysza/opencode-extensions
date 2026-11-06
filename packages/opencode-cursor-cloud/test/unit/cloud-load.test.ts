import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const pkg = resolve(import.meta.dirname, "../..");
const script = `
const { registerHooks, syncBuiltinESMExports } = await import("node:module");
const seen = [];
registerHooks({ resolve(specifier, context, next) {
  seen.push(specifier);
  if (/^(@cursor\\/sdk|@earendil-works\\/|@opentui\\/|@opencode\\/(?!plugin$))/.test(specifier)) throw new Error("forbidden import: " + specifier);
  return next(specifier, context);
} });
const deny = () => { throw new Error("network attempted"); };
globalThis.fetch = deny;
const net = (await import("node:net")).default;
net.connect = net.createConnection = deny;
for (const name of ["node:http", "node:https"]) { const mod = (await import(name)).default; mod.request = mod.get = deny; }
syncBuiltinESMExports();
const plugin = await import(new URL("./dist/server.js", "file://${pkg}/").href);
if (plugin.default.id !== "iurysza.cursor-cloud") throw new Error("wrong entry");
process.stdout.write(JSON.stringify(seen));
`;
it("loads the production default entry with no SDK/TUI/private host import or network", () => {
  expect(existsSync(resolve(pkg, "dist/server.js")), "run the Cloud build first").toBe(true);
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: pkg, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent/cloud-load", XDG_CONFIG_HOME: "/nonexistent/cloud-load", XDG_DATA_HOME: "/nonexistent/cloud-load" },
  });
  expect(run.stderr).toBe(""); expect(run.status).toBe(0);
  expect((JSON.parse(run.stdout) as string[]).some(specifier => specifier.endsWith("/dist/server.js"))).toBe(true);
});
