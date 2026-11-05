// Regression: a missing child package.json must fail the layout check. Uses a temp tree only.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkLayout } from "./check-layout.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "layout-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true }));
  writeFileSync(join(root, "package-lock.json"), "{}");
  for (const [dir, name] of [["opencode-cursor-sdk", "@iurysza/opencode-cursor-sdk"], ["opencode-cursor-cloud", "@iurysza/opencode-cursor-cloud"]]) {
    mkdirSync(join(root, "packages", dir), { recursive: true });
    writeFileSync(join(root, "packages", dir, "package.json"), JSON.stringify({ name }));
  }
  return root;
}

test("valid fixture passes", (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(checkLayout(root), []);
});

test("missing child manifest fails", (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  rmSync(join(root, "packages/opencode-cursor-cloud/package.json"));
  assert.deepEqual(checkLayout(root), ["missing manifest: packages/opencode-cursor-cloud/package.json"]);
});
