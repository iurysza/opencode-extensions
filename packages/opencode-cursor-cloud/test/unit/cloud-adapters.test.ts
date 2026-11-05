import { describe, expect, it } from "vitest";
import { cloudKey } from "../../src/core/auth.js";
import { cloudError, createCloudClient, mapCompletion, mapDelta, mapStep, type SdkLoader } from "../../src/core/cloud-client.js";
import { originToHttps, resolveRepo, type Git } from "../../src/core/repo.js";
import { cleanText, formatCompletion } from "../../src/core/render.js";

const KEY = "synthetic-test-key-not-a-credential";
it("host key wins env; environment-only works; no Pi files are used", async () => {
  let envReads = 0;
  const key = cloudKey({ hostCredential: async () => ({ type: "key", key: ` ${KEY} ` }), envKey: () => { envReads++; return "env"; } });
  expect(await key()).toBe(KEY); expect(envReads).toBe(0);
  expect(await cloudKey({ hostCredential: async () => undefined, envKey: () => " env " })()).toBe("env");
  await expect(cloudKey({ hostCredential: async () => undefined, envKey: () => " " })()).rejects.toThrow("host cursor key or CURSOR_API_KEY");
  await expect(cloudKey({ hostCredential: async () => { throw new Error(KEY); }, envKey: () => "env" })()).rejects.not.toThrow(KEY);
  await expect(cloudKey({ hostCredential: async () => ({ type: "oauth", access: KEY }), envKey: () => "env" })()).rejects.toThrow("key credential");
});

describe("public SDK adapter with fake loader", () => {
  function sdkRig() {
    const inputs: unknown[] = [], emitted: unknown[] = [];
    let loaded = 0, closed = false, cancelled = false, reject = false;
    const result = { status: "completed", result: KEY, durationMs: 2, git: { branches: [{ repoUrl: KEY, branch: KEY, prUrl: KEY }] } };
    const sdk = {
      Cursor: { models: { list: async (input: unknown) => { inputs.push(input); if (reject) throw new Error(KEY); return [{ id: "m", displayName: "model" }]; } } },
      Agent: {
        create: async (input: unknown) => {
          inputs.push(input); if (reject) throw new Error(KEY);
          return { agentId: "bc-fake", close: () => { closed = true; if (reject) throw new Error(KEY); },
            send: async (_prompt: string, options: { onDelta(event: unknown): void; onStep(event: unknown): void }) => {
              if (reject) throw new Error(KEY);
              options.onDelta({ update: { type: "text-delta", text: KEY } });
              options.onDelta({ update: { type: "tool-call-started", callId: "one", toolCall: { type: "shell", args: { command: KEY } } } });
              options.onStep({ step: { type: "assistantMessage", message: { text: KEY } } });
              return { id: "run-fake", wait: async () => { if (reject) throw new Error(KEY); return result; }, cancel: async () => { cancelled = true; if (reject) throw new Error(KEY); } };
            } };
        },
        delete: async (id: string, options: unknown) => { inputs.push([id, options]); if (reject) throw new Error(KEY); },
      },
    };
    // Test-only partial SDK. Production's default loader is checked against the full public SDK exports.
    const load = (async () => { loaded++; return sdk; }) as unknown as SdkLoader;
    const client = createCloudClient(async () => KEY, load);
    return { client, inputs, emitted, loaded: () => loaded, closed: () => closed, cancelled: () => cancelled, reject: () => { reject = true; } };
  }
  it("does not load SDK until a user action, creates only a cloud repo/ref agent, and maps events/results", async () => {
    const r = sdkRig(); expect(r.loaded()).toBe(0);
    expect(await r.client.models()).toEqual([{ id: "m", displayName: "model" }]);
    const handle = await r.client.create({ repo: "https://github.com/o/r", ref: "main", model: "m", name: "local-only" });
    expect(r.inputs[1]).toEqual({ apiKey: KEY, model: { id: "m" }, cloud: { repos: [{ url: "https://github.com/o/r", startingRef: "main" }] } });
    const run = await handle.send("prompt", event => r.emitted.push(event));
    expect(JSON.stringify(r.emitted)).not.toContain(KEY); expect(JSON.stringify(r.emitted)).toContain("[redacted]");
    expect(await run.wait()).toMatchObject({ type: "finished", result: { text: "[redacted]", branches: [{ repoUrl: "[redacted]", branch: "[redacted]", prUrl: "[redacted]" }] } });
    await run.cancel(); handle.close(); await r.client.delete(handle.id);
    expect(r.closed()).toBe(true); expect(r.cancelled()).toBe(true);
  });
  it("drops SDK serialization and auth values from every failure boundary", async () => {
    const r = sdkRig(); const handle = await r.client.create({ repo: "https://github.com/o/r", ref: "main", model: "m", name: "n" });
    const run = await handle.send("p", () => {}); r.reject();
    for (const action of [() => r.client.models(), () => r.client.create({ repo: "r", ref: "r", model: "m", name: "n" }), () => r.client.delete("bc-fake"), () => handle.send("p", () => {}), () => run.wait(), () => run.cancel()]) {
      await expect(action()).rejects.not.toThrow(KEY);
    }
    expect(() => handle.close()).toThrow("close failed");
    expect(cloudError(new Error(`[agent_busy] ${KEY}`), "send")).toContain("active run");
    expect(cloudError({ serializedClient: KEY }, "create")).not.toContain(KEY);
  });
});

it("maps SDK thinking without exposing thoughts and counts tool starts separately from steps", () => {
  expect(mapDelta({ type: "thinking-delta", text: "private" } as Parameters<typeof mapDelta>[0])).toEqual({ type: "delta", activity: { type: "thinking" } });
  expect(mapStep({ type: "thinkingMessage" } as Parameters<typeof mapStep>[0])).toEqual({ type: "step", activity: { type: "thinking" } });
  expect(mapDelta({ type: "tool-call-started", callId: "x", toolCall: { type: "shell", args: { command: "ls" } } } as Parameters<typeof mapDelta>[0])).toMatchObject({ activity: { type: "tool", callId: "x", activity: "run_terminal_cmd: ls" } });
  expect(cleanText("\x1b[31mhello\x00\x1b[0m")).toBe("hello");
});

describe("ported GitHub repository inference", () => {
  for (const origin of ["git@github.com:owner/repo.git", "ssh://git@github.com/owner/repo", "https://github.com/owner/repo.git"]) it(`accepts ${origin}`, () => expect(originToHttps(origin)).toBe("https://github.com/owner/repo"));
  for (const invalid of ["https://key@github.com/o/r", "https://github.com.evil/o/r", "/tmp/repo", "file:///tmp/repo", "https://github.com/o/..", "http://github.com/o/r"]) it(`rejects ${invalid}`, () => expect(() => originToHttps(invalid)).toThrow());
  const git = (tracked: boolean, detached = false): Git => async (_cwd, args) => {
    if (args[0] === "remote") return "git@github.com:o/r.git";
    if (args[0] === "symbolic-ref") { if (detached) throw new Error(); return "feature"; }
    expect(args).toEqual(["show-ref", "--verify", "refs/remotes/origin/feature"]);
    if (!tracked) throw new Error(); return "local-tracking-hash";
  };
  it("uses the current branch only when the local origin tracking ref exists; never fetches", async () => {
    expect(await resolveRepo("/fake", undefined, undefined, git(true))).toEqual({ repo: "https://github.com/o/r", ref: "feature" });
    expect((await resolveRepo("/fake", undefined, undefined, git(false))).ref).toBe("main");
    expect((await resolveRepo("/fake", undefined, undefined, git(true, true))).ref).toBe("main");
    expect((await resolveRepo("/fake", "https://github.com/different/repo", undefined, git(true))).ref).toBe("main");
  });
  it("refuses a nonGit context without repo, permits explicit repo/ref, and validates refs", async () => {
    const noGit: Git = async () => { throw new Error("not Git"); };
    await expect(resolveRepo("/fake", undefined, undefined, noGit)).rejects.toThrow("No GitHub origin");
    expect(await resolveRepo("/fake", "https://github.com/o/r", "release", noGit)).toEqual({ repo: "https://github.com/o/r", ref: "release" });
    for (const ref of ["", "-bad", "bad ref", "bad\nref"]) await expect(resolveRepo("/fake", "https://github.com/o/r", ref, noGit)).rejects.toThrow("Invalid repository ref");
  });
});
