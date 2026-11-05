// Uses temporary workspace trees only. Never loads package code or the Cursor SDK.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkLayout } from "./check-layout.mjs";

const packages = [
  ["opencode-cursor-sdk", "@iurysza/opencode-cursor-sdk"],
  ["opencode-cursor-cloud", "@iurysza/opencode-cursor-cloud"],
];

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "layout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true }));
  writeFileSync(join(root, "package-lock.json"), "{}");
  for (const [dir, name] of packages) {
    mkdirSync(join(root, "packages", dir), { recursive: true });
    writeFileSync(join(root, "packages", dir, "package.json"), JSON.stringify({ name, dependencies: { "@cursor/sdk": "1.0.37" } }));
  }
  return root;
}

function updateManifest(root, path, update) {
  const file = join(root, path);
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  update(manifest);
  writeFileSync(file, JSON.stringify(manifest));
}

test("valid fixture passes with the same exact SDK runtime dependency in both packages", (t) => {
  assert.deepEqual(checkLayout(fixture(t)), []);
});

test("missing child manifest fails", (t) => {
  const root = fixture(t);
  rmSync(join(root, "packages/opencode-cursor-cloud/package.json"));
  assert.deepEqual(checkLayout(root), ["missing manifest: packages/opencode-cursor-cloud/package.json"]);
});

for (const [dir] of packages) {
  const path = `packages/${dir}/package.json`;
  const pinError = `packages/${dir} must declare @cursor/sdk 1.0.37 as a runtime dependency`;
  for (const version of ["1.0.23", "^1.0.37", "~1.0.37", "latest", "npm:@cursor/sdk@1.0.37"]) {
    test(`${dir} rejects SDK version ${version}`, (t) => {
      const root = fixture(t);
      updateManifest(root, path, (pkg) => { pkg.dependencies["@cursor/sdk"] = version; });
      assert.deepEqual(checkLayout(root), [pinError]);
    });
  }
  test(`${dir} rejects an undeclared SDK dependency`, (t) => {
    const root = fixture(t);
    updateManifest(root, path, (pkg) => { delete pkg.dependencies; });
    assert.deepEqual(checkLayout(root), [pinError]);
  });
  for (const field of ["devDependencies", "optionalDependencies", "peerDependencies"]) {
    test(`${dir} rejects SDK declared only in ${field}`, (t) => {
      const root = fixture(t);
      updateManifest(root, path, (pkg) => {
        delete pkg.dependencies;
        pkg[field] = { "@cursor/sdk": "1.0.37" };
      });
      assert.deepEqual(checkLayout(root), [pinError]);
    });
  }
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    test(`${dir} cannot depend on the other workspace through ${field}`, (t) => {
      const root = fixture(t);
      const other = packages.find(([entry]) => entry !== dir)[1];
      updateManifest(root, path, (pkg) => { pkg[field] = { ...pkg[field], [other]: "0.0.0" }; });
      assert.deepEqual(checkLayout(root), [`packages/${dir} must not depend on ${other}`]);
    });
  }
  test(`${dir} rejects a child lockfile`, (t) => {
    const root = fixture(t);
    writeFileSync(join(root, "packages", dir, "package-lock.json"), "{}");
    assert.deepEqual(checkLayout(root), [`child lockfile forbidden: packages/${dir}/package-lock.json`]);
  });
  test(`${dir} rejects a renamed child`, (t) => {
    const root = fixture(t);
    updateManifest(root, path, (pkg) => { pkg.name = "@other/package"; });
    assert.deepEqual(checkLayout(root), [`packages/${dir} must be named ${packages.find(([entry]) => entry === dir)[1]}`]);
  });
}

test("root must stay private", (t) => {
  const root = fixture(t);
  updateManifest(root, "package.json", (pkg) => { delete pkg.private; });
  assert.deepEqual(checkLayout(root), ["root package.json must be private"]);
});

test("root lockfile is required", (t) => {
  const root = fixture(t);
  rmSync(join(root, "package-lock.json"));
  assert.deepEqual(checkLayout(root), ["root package-lock.json missing"]);
});

test("third package is forbidden", (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "packages/third-package"));
  assert.deepEqual(checkLayout(root), ["packages/ must contain exactly opencode-cursor-sdk, opencode-cursor-cloud; found opencode-cursor-cloud, opencode-cursor-sdk, third-package"]);
});
