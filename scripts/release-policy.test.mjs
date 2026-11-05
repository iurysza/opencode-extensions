import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkPackage, packPackage, verifyTarball } from "./release-check.mjs";
import { PACKAGES, REGISTRY, packageForDirectory, parseReleaseTag, validateManifest, validatePack } from "./release-policy.mjs";

const pkg = PACKAGES[0];
const version = "1.2.3";
const tag = `${pkg.component}-v${version}`;
const rootManifest = { name: "private-root", private: true, workspaces: PACKAGES.map((entry) => entry.directory) };
const manifest = (entry = pkg) => ({
  name: entry.name,
  version,
  private: false,
  type: "module",
  files: ["dist"],
  exports: { ".": "./dist/index.js" },
  publishConfig: { access: "public", provenance: true, registry: REGISTRY },
});
const validate = (overrides = {}) => validateManifest({ rootManifest, manifest: manifest(), directory: pkg.directory, release: parseReleaseTag(tag), production: true, ...overrides });
const files = ["package.json", "README.md", "LICENSE", "CHANGELOG.md", "dist/index.js", "dist/index.d.ts"];

function fixture(t, entry = pkg) {
  const root = mkdtempSync(join(tmpdir(), "opencode-release-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = join(root, entry.directory);
  mkdirSync(join(child, "src"), { recursive: true });
  mkdirSync(join(child, "dist"), { recursive: true });
  const write = (path, data) => writeFileSync(join(root, path), typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`);
  write("package.json", rootManifest);
  write(".release-please-manifest.json", { [entry.directory]: version });
  write(`${entry.directory}/package.json`, manifest(entry));
  write(`${entry.directory}/src/index.ts`, "export const load = () => import('@cursor/sdk');\n");
  write(`${entry.directory}/dist/index.js`, "export const load = () => import('@cursor/sdk');\n");
  write(`${entry.directory}/dist/index.d.ts`, "export declare const load: () => Promise<unknown>;\n");
  write(`${entry.directory}/README.md`, "# Fixture\n");
  return { root, child, write };
}

test("exactly two independent stable component tags round-trip", () => {
  for (const entry of PACKAGES) {
    assert.deepEqual(parseReleaseTag(`${entry.component}-v${version}`), { ...entry, version, tag: `${entry.component}-v${version}` });
  }
  for (const invalid of [undefined, "v1.2.3", "opencode-cursor-unknown-v1.2.3", "opencode-cursor-sdk-v01.2.3", "opencode-cursor-sdk-v1.2", "opencode-cursor-sdk-v1.2.3-beta.1", "opencode-cursor-sdk-v1.2.3+meta", "opencode-cursor-sdk-v1.2.3\n", "opencode-cursor-sdk-v1.2.3; echo unsafe", "opencode-cursor-sdk-v$(touch /tmp/no)"]) {
    assert.throws(() => parseReleaseTag(invalid), /tag|version/);
  }
});

test("root and unknown directories are rejected before npm or filesystem access", () => {
  for (const directory of [".", "", "packages/unknown", "packages/opencode-cursor-sdk/../opencode-cursor-cloud", pkg.name]) {
    assert.throws(() => packageForDirectory(directory), /allowlisted.*root publication/);
    assert.throws(() => packPackage("/path/that/does/not/exist", directory), /root publication/);
  }
  assert.throws(() => validate({ rootManifest: { private: false } }), /Root workspace/);
});

test("production identity rejects wrong versions, cross-package tags and unknown names", () => {
  assert.equal(validate().name, pkg.name);
  assert.throws(() => validate({ manifest: { ...manifest(), version: "1.2.4" } }), /must agree/);
  assert.throws(() => validate({ release: parseReleaseTag("opencode-cursor-cloud-v1.2.3") }), /must agree/);
  assert.throws(() => validate({ manifest: { ...manifest(), name: "@other/unknown" } }), /name.*allowlist/);
  for (const invalid of ["01.2.3", "1.2.3-rc.1", "1.2.3+meta", "1.2", "1.2.3\n"]) {
    assert.throws(() => validate({ manifest: { ...manifest(), version: invalid } }), /semver/);
  }
  assert.throws(() => validate({ release: undefined }), /validated release tag/);
});

test("private packages and incomplete public provenance configuration fail closed", () => {
  assert.throws(() => validate({ manifest: { ...manifest(), private: true } }), /still private/);
  for (const config of [undefined, {}, { access: "restricted", provenance: true, registry: REGISTRY }, { access: "public", provenance: false, registry: REGISTRY }, { access: "public", provenance: true, registry: "https://other.invalid" }]) {
    assert.throws(() => validate({ manifest: { ...manifest(), publishConfig: config } }), /explicit public access/);
  }
  // Portable pack checks work while the integrator intentionally keeps both packages private.
  validate({ production: false, manifest: { ...manifest(), private: true, publishConfig: undefined } });
});

test("bundled SDK and local runtime dependencies cannot be published", () => {
  for (const field of ["bundleDependencies", "bundledDependencies"]) {
    for (const value of [true, ["@cursor/sdk"], { "@cursor/sdk": true }]) {
      assert.throws(() => validate({ manifest: { ...manifest(), [field]: value } }), /Bundled dependencies/);
    }
  }
  for (const range of ["file:../../sdk", "workspace:*", "link:../sdk", "git+https://example.invalid/sdk", "https://example.invalid/sdk.tgz", "../sdk"]) {
    assert.throws(() => validate({ manifest: { ...manifest(), dependencies: { "@cursor/sdk": range } } }), /Non-registry/);
  }
  validate({ manifest: { ...manifest(), dependencies: { "@cursor/sdk": "1.0.37" } } });
});

test("pack allowlist admits compiled code and docs, never vendored SDK or secrets", () => {
  validatePack({ files, manifest: manifest() });
  for (const path of ["node_modules/@cursor/sdk/index.js", "dist/node_modules/sdk/index.js", "dist/vendor/index.js", "dist/sdk/index.js", "dist/bundled/index.js", ".env", "src/index.ts", "test/index.js", "package-lock.json", "dist/index.js.map", "../private", "dist/../index.js", "/dist/index.js", "dist\\index.js"]) {
    assert.throws(() => validatePack({ files: [...files, path], manifest: manifest() }), /allowlist|Unsafe/);
  }
  assert.throws(() => validatePack({ files: [...files, "dist/index.js"], manifest: manifest() }), /duplicate/);
  assert.throws(() => validatePack({ files: ["package.json"], manifest: manifest() }), /declarations/);
  assert.throws(() => validatePack({ files, manifest: { ...manifest(), exports: { ".": "./dist/missing.js" } } }), /Export target/);
});

test("production verifies the release manifest at the checked out commit", (t) => {
  const { root, write } = fixture(t);
  checkPackage(root, pkg.directory, { production: true, tag });
  write(".release-please-manifest.json", { [pkg.directory]: "1.2.4" });
  assert.throws(() => checkPackage(root, pkg.directory, { production: true, tag }), /Release manifest/);
});

test("actual clean tarballs contain external SDK references, not bundled SDK code", (t) => {
  for (const entry of PACKAGES) {
    const { root, write } = fixture(t, entry);
    const data = manifest(entry);
    data.private = true;
    data.dependencies = entry === pkg ? { "@cursor/sdk": "1.0.37" } : {};
    data.scripts = { prepack: "node -e \"require('fs').writeFileSync('HOOK-RAN', 'bad')\"" };
    write(`${entry.directory}/package.json`, data);
    const result = packPackage(root, entry.directory, { keep: true });
    t.after(() => rmSync(dirname(result.tarball), { recursive: true, force: true }));
    assert.equal(result.name, entry.name);
    assert.equal(result.version, version);
    assert.equal(result.files, 4);
    assert.equal(existsSync(join(root, entry.directory, "HOOK-RAN")), false);
    assert.equal(existsSync(join(root, "package-lock.json")), false);
    assert.equal(existsSync(join(root, entry.directory, "package-lock.json")), false);
    assert.throws(() => verifyTarball({ tarball: result.tarball, root, directory: entry.directory, manifest: data, reportedFiles: ["package.json"] }), /disagree/);
    write(`${entry.directory}/dist/index.js`, "changed after pack\n");
    assert.throws(() => verifyTarball({ tarball: result.tarball, root, directory: entry.directory, manifest: data, reportedFiles: ["package.json", "README.md", "dist/index.js", "dist/index.d.ts"] }), /differs from the local build/);
  }
});

test("copied SDK artifacts without a matching project source fail actual tarball verification", (t) => {
  const { root, write } = fixture(t);
  write(`${pkg.directory}/dist/copied-sdk.js`, "// unwanted vendor payload\n");
  assert.throws(() => packPackage(root, pkg.directory), /no local TypeScript source/);
});

test("grouped release PR keeps independent components and shared-lock updates coherent behind activation gates", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const config = JSON.parse(readFileSync(join(root, "release-please-config.json"), "utf8"));
  assert.deepEqual(config.plugins, ["node-workspace"], "retain the workspace plugin's default candidate merging");
  assert.equal(config["separate-pull-requests"], false, "one grouped release PR carries the coherent shared root-lock update");
  assert.deepEqual(Object.keys(config.packages).sort(), PACKAGES.map((entry) => entry.directory).sort());
  for (const entry of PACKAGES) {
    const settings = config.packages[entry.directory];
    assert.equal(settings["release-type"], "node");
    assert.equal(settings["package-name"], entry.name);
    assert.equal(settings.component, entry.component);
    assert.equal(settings["include-component-in-tag"], true);
    assert.equal(settings["include-v-in-tag"], true);
    assert.equal(settings["tag-separator"], "-");
  }
  for (const file of ["release.yml", "release-please.yml"]) {
    const workflow = readFileSync(join(root, ".github/workflows", file), "utf8");
    assert.ok(workflow.includes("vars.RELEASE_AUTOMATION_ENABLED == 'true'"));
    assert.ok(!workflow.includes("continue-on-error"));
  }
  const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
  assert.ok(release.indexOf("release-check.mjs production-pack") < release.indexOf("secrets.NPM_TOKEN"));
  assert.ok(release.includes('npm publish "$TARBALL" --ignore-scripts --workspaces=false --access public --provenance'));
  assert.ok(release.includes('git merge-base --is-ancestor "$RELEASE_SHA" refs/remotes/origin/main'));
  assert.ok(!release.includes('run: npm publish ${{'));
  const verify = readFileSync(join(root, ".github/workflows/verify.yml"), "utf8");
  assert.ok(verify.includes("runs-on: [self-hosted, macOS, ARM64]"));
  assert.ok(verify.includes("vars.HOST_VERIFICATION_ENABLED == 'true'"));
  assert.ok(verify.includes("acquire.mjs 2.0.0 2.2.5"));
});
