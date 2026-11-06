#!/usr/bin/env node
// Packs locally only. This script never publishes, reads tokens or calls Cursor.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PACKAGES, packageForDirectory, parseReleaseTag, validateManifest, validatePack } from "./release-policy.mjs";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJSON = (path) => JSON.parse(readFileSync(path, "utf8"));
function command(program, args, cwd, binary = false) {
  const result = spawnSync(program, args, { cwd, encoding: binary ? undefined : "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${program} failed while checking a local release artifact`);
  return result.stdout;
}

export function checkPackage(root, directory, { production = false, tag } = {}) {
  packageForDirectory(directory); // Reject root and unknown paths before reading or running npm.
  const manifest = readJSON(join(root, directory, "package.json"));
  const release = tag === undefined ? undefined : parseReleaseTag(tag);
  validateManifest({ rootManifest: readJSON(join(root, "package.json")), manifest, directory, release, production });
  if (production) {
    if (readJSON(join(root, ".release-please-manifest.json"))[directory] !== manifest.version) {
      throw new Error("Release manifest must match the package version at the release commit");
    }
  }
  return manifest;
}

/** Verify an actual npm tarball without extracting it or executing package lifecycle hooks. */
export function verifyTarball({ tarball, root, directory, manifest, reportedFiles }) {
  const entries = command("tar", ["-tzf", tarball], root).trimEnd().split("\n");
  if (entries.some((path) => !path.startsWith("package/"))) throw new Error("Tarball entries must belong to package/");
  const files = entries.map((path) => path.slice("package/".length));
  validatePack({ files, manifest });
  if (JSON.stringify([...files].sort()) !== JSON.stringify([...reportedFiles].sort())) {
    throw new Error("Tarball contents disagree with npm pack metadata");
  }
  const types = command("tar", ["-tvzf", tarball], root).trimEnd().split("\n");
  if (types.some((line) => !line.startsWith("-"))) throw new Error("Tarball must contain regular files only");
  const packed = (path) => command("tar", ["-xOf", tarball, `package/${path}`], root, true);
  if (JSON.stringify(JSON.parse(packed("package.json").toString("utf8"))) !== JSON.stringify(manifest)) {
    throw new Error("Packed manifest differs from the validated package manifest");
  }
  for (const path of files) {
    const local = join(root, directory, path);
    if (!lstatSync(local).isFile() || !readFileSync(local).equals(packed(path))) throw new Error("Packed file differs from the local build");
    if (path.startsWith("dist/")) {
      const source = join(root, directory, path.replace(/^dist\//, "src/").replace(/(?:\.d\.ts|\.js)$/, ".ts"));
      if (!existsSync(source) || !lstatSync(source).isFile()) throw new Error("Compiled artifact has no local TypeScript source; bundled SDK code is forbidden");
    }
  }
  return files;
}

export function packPackage(root, directory, { production = false, tag, keep = false } = {}) {
  const manifest = checkPackage(root, directory, { production, tag });
  const destination = mkdtempSync(join(tmpdir(), "opencode-release-"));
  let success = false;
  try {
    const result = JSON.parse(command("npm", ["pack", "--ignore-scripts", "--json", "--workspaces=false", "--pack-destination", destination], join(root, directory)));
    if (!Array.isArray(result) || result.length !== 1) throw new Error("npm pack must produce exactly one child tarball");
    const item = result[0];
    if (item.name !== manifest.name || item.version !== manifest.version || !/^[a-zA-Z0-9.-]+\.tgz$/.test(item.filename)) {
      throw new Error("Packed identity does not match the validated package");
    }
    const tarball = join(destination, item.filename);
    const files = verifyTarball({ tarball, root, directory, manifest, reportedFiles: item.files.map((file) => file.path) });
    success = true;
    return { name: manifest.name, version: manifest.version, files: files.length, ...(keep ? { tarball } : {}) };
  } finally {
    if (!keep || !success) rmSync(destination, { recursive: true, force: true });
  }
}

function main() {
  const [mode, ...directories] = process.argv.slice(2);
  if (mode === "pack") {
    for (const directory of directories.length ? directories : PACKAGES.map((pkg) => pkg.directory)) {
      console.log(JSON.stringify(packPackage(defaultRoot, directory)));
    }
    return;
  }
  if ((mode === "production" || mode === "production-pack") && directories.length === 0) {
    const release = parseReleaseTag(process.env.RELEASE_TAG);
    if (mode === "production") {
      checkPackage(defaultRoot, release.directory, { production: true, tag: release.tag });
      console.log(`release: validated ${release.name}@${release.version}`);
    } else {
      const result = packPackage(defaultRoot, release.directory, { production: true, tag: release.tag, keep: true });
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tarball=${result.tarball}\n`);
      console.log(JSON.stringify(result));
    }
    return;
  }
  throw new Error("Usage: release-check.mjs pack [allowlisted-directory ...] | production | production-pack");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(`release: ${error.message}`); process.exitCode = 1; }
}
