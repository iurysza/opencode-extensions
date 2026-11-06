#!/usr/bin/env node
// Workspace layout guard: private root, exactly two child packages, one root lockfile.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const expected = { "opencode-cursor-sdk": "@iurysza/opencode-cursor-sdk", "opencode-cursor-cloud": "@iurysza/opencode-cursor-cloud" };

/** Returns layout errors for the workspace at `root`. Empty means ok. */
export function checkLayout(root) {
  const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
  const errors = [];

  if (!existsSync(join(root, "package.json"))) return ["root package.json missing"];
  if (read("package.json").private !== true) errors.push("root package.json must be private");
  if (!existsSync(join(root, "package-lock.json"))) errors.push("root package-lock.json missing");

  const dirs = existsSync(join(root, "packages")) ? readdirSync(join(root, "packages")).filter((d) => !d.startsWith(".")).sort() : [];
  if (JSON.stringify(dirs) !== JSON.stringify(Object.keys(expected).sort())) errors.push(`packages/ must contain exactly ${Object.keys(expected).join(", ")}; found ${dirs.join(", ")}`);
  for (const [dir, name] of Object.entries(expected)) {
    if (existsSync(join(root, "packages", dir, "package-lock.json"))) errors.push(`child lockfile forbidden: packages/${dir}/package-lock.json`);
    if (!existsSync(join(root, "packages", dir, "package.json"))) {
      errors.push(`missing manifest: packages/${dir}/package.json`);
      continue;
    }
    const pkg = read(`packages/${dir}/package.json`);
    if (pkg.name !== name) errors.push(`packages/${dir} must be named ${name}`);
    if (pkg.dependencies?.["@cursor/sdk"] !== "1.0.37") errors.push(`packages/${dir} must declare @cursor/sdk 1.0.37 as a runtime dependency`);
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const other of Object.values(expected).filter((entry) => entry !== name)) {
        if (Object.hasOwn(pkg[field] ?? {}, other)) errors.push(`packages/${dir} must not depend on ${other}`);
      }
    }
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkLayout(resolve(fileURLToPath(import.meta.url), "../.."));
  if (errors.length) {
    for (const e of errors) console.error(`layout: ${e}`);
    process.exit(1);
  }
  console.log("layout: ok");
}
