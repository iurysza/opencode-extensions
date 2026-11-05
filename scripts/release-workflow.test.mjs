import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Run the actual github-script boundary with fixture API responses, never GitHub.
const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const body = /          script: \|\n([\s\S]*?)(?=\n      - uses:)/.exec(workflow)?.[1];
assert.ok(body, "release workflow must contain its metadata validation script");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const preflight = new AsyncFunction("context", "github", "core", body);
const tag = "opencode-cursor-sdk-v1.2.3";
const sha = "1234567890123456789012345678901234567890";

async function runFixture({ eventRepository = {}, eventRelease = {}, liveRelease = {}, liveRepository = {}, commitSHA = sha } = {}) {
  const repository = { full_name: "fixture-owner/fixture-repo", default_branch: "main" };
  const release = { id: 42, tag_name: tag, target_commitish: "main", draft: false, prerelease: false, published_at: "2026-01-01T00:00:00Z" };
  const calls = [];
  const outputs = {};
  const context = {
    repo: { owner: "fixture-owner", repo: "fixture-repo" },
    payload: { repository: { ...repository, ...eventRepository }, release: { ...release, ...eventRelease } },
  };
  const github = { rest: { repos: {
    getRelease: async (request) => {
      assert.deepEqual(request, { ...context.repo, release_id: context.payload.release.id });
      calls.push("release");
      return { data: { ...release, ...liveRelease } };
    },
    get: async (request) => {
      assert.deepEqual(request, context.repo);
      return { data: { ...repository, ...liveRepository } };
    },
    getCommit: async (request) => {
      assert.deepEqual(request, { ...context.repo, ref: `refs/tags/${release.tag_name}` });
      calls.push("commit");
      return { data: { sha: commitSHA } };
    },
  } } };
  await preflight(context, github, { setOutput: (key, value) => { outputs[key] = value; } });
  return { calls, outputs };
}

test("published component metadata resolves an exact tag commit in context.repository", async () => {
  assert.deepEqual(await runFixture(), { calls: ["release", "commit"], outputs: { tag, sha } });
});

test("release-please releases targeting the exact tag commit SHA are accepted", async () => {
  assert.deepEqual(await runFixture({ eventRelease: { target_commitish: sha }, liveRelease: { target_commitish: sha } }), {
    calls: ["release", "commit"], outputs: { tag, sha },
  });
});

test("release targets reject mismatched SHAs, abbreviated SHAs and arbitrary branches", async () => {
  for (const target of ["a".repeat(40), "A".repeat(40), sha.slice(0, 7), `${sha}\n`, "other", "refs/heads/main", "refs/tags/other", null]) {
    await assert.rejects(runFixture({ liveRelease: { target_commitish: target } }), /main or the exact resolved tag commit SHA/);
  }
});

test("resolved tag commits require canonical full SHAs even when targeting main", async () => {
  for (const commitSHA of ["A".repeat(40), sha.slice(0, 7), `${sha}\n`, "main", null]) {
    await assert.rejects(runFixture({ commitSHA }), /canonical full SHA/);
  }
});

test("release ownership cannot cross repositories or use an unexpected default branch", async () => {
  for (const fixture of [
    { eventRepository: { full_name: "someone/else" } },
    { eventRepository: { default_branch: "other" } },
    { liveRepository: { full_name: "someone/else" } },
    { liveRepository: { default_branch: "other" } },
    { liveRelease: { id: 99 } },
  ]) await assert.rejects(runFixture(fixture), /repository|main branch/);
});

test("drafts, prereleases, unpublished and mismatched release events fail before checkout", async () => {
  for (const fixture of [
    { liveRelease: { draft: true } },
    { liveRelease: { prerelease: true } },
    { liveRelease: { published_at: null } },
    { eventRelease: { tag_name: "opencode-cursor-cloud-v1.2.3" } },
  ]) await assert.rejects(runFixture(fixture), /metadata does not match/);
});

test("unknown and shell-shaped tags fail before fetching a tag or checking out code", async () => {
  for (const invalid of ["v1.2.3", "opencode-cursor-other-v1.2.3", "opencode-cursor-sdk-v01.2.3", "opencode-cursor-sdk-v1.2.3-rc.1", `${tag}\n`, `${tag}$(echo injected)`, `${tag}; exit 0`]) {
    await assert.rejects(runFixture({ eventRelease: { tag_name: invalid }, liveRelease: { tag_name: invalid } }), /Unknown component tag/);
  }
});
