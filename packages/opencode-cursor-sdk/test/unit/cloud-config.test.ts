import { describe, expect, it } from "vitest";
import { acknowledgeForegroundCloud, resolveCursorSdkConfig, type ResolveCursorSdkConfigOptions } from "../../src/core/cloud/config.js";
import { buildCursorCloudAgentOptions, preflightCursorCloudRuntime } from "../../src/core/cloud/options.js";
import { createCloudTextSanitizer } from "../../src/core/cloud/reporting.js";
import { foregroundCloudContext } from "../../src/core/cloud/source.js";
import { createHostForegroundCloudStore } from "../../src/plugin/cloud-runtime.js";

const clean = { insideGitRepo: true, dirty: false, comparison: "contains_head" } as const;
const resolve = (options: ResolveCursorSdkConfigOptions = {}) => resolveCursorSdkConfig({ env: {}, ...options });

describe("foreground Cloud settings", () => {
  it("is off and fresh by default, project acknowledgment never authorizes", () => {
    const defaults = resolve(); expect(defaults.runtime.value).toBe("local"); expect(defaults.cloud.contextHandoff.value).toBe("fresh");
    const project = resolve({ project: { cloud: { acknowledged: true } } });
    expect(project.cloud.acknowledged).toMatchObject({ source: "builtin", value: false });
    expect(resolve({ builtIn: { cloud: { acknowledged: true, allowLocalState: true } } }).cloud.acknowledged.value).toBe(false);
  });
  it.each(["cli", "user", "session"] as const)("permits explicit acknowledgment in %s scope", scope => {
    expect(resolve({ [scope]: { cloud: { acknowledged: true } } }).cloud.acknowledged.value).toBe(true);
  });
  it("permits env acknowledgment without implying it from Cloud selection", () => {
    expect(resolve({ env: { PI_CURSOR_CLOUD_ACK: "1" } }).cloud.acknowledged).toMatchObject({ source: "environment", value: true });
    expect(resolve({ cli: { runtime: "cloud" } }).cloud.acknowledged.value).toBe(false);
  });
  it("applies per-field precedence and caps risky environment settings with stricter user settings", () => {
    const config = resolve({ env: { PI_CURSOR_RUNTIME: "cloud", PI_CURSOR_CLOUD_DIRECT_PUSH: "1", PI_CURSOR_CLOUD_CONTEXT: "bootstrap" },
      user: { runtime: "local", cloud: { directPush: false, contextHandoff: "fresh" } }, session: { runtime: "cloud" } });
    expect(config.runtime).toMatchObject({ source: "user", value: "local", cappedBy: { cappedSource: "environment" } });
    expect(config.cloud.directPush.value).toBe(false); expect(config.cloud.contextHandoff.value).toBe("fresh");
    expect(resolve({ cli: { cloud: { directPush: true } }, user: { cloud: { directPush: false } } }).cloud.directPush.value).toBe(true);
    expect(resolve({ session: { cloud: { repo: "https://ignored.example/repo" } }, user: { cloud: { repo: "https://example.com/repo" } } }).cloud.repo.value).toBe("https://example.com/repo");
  });
  it.each([
    { cli: { runtime: "invalid" } }, { env: { PI_CURSOR_RUNTIME: "invalid" } },
    { cli: { cloud: { contextHandoff: "invalid" } } }, { env: { PI_CURSOR_CLOUD_ACK: "invalid" } },
  ])("invalid explicit settings do not fall through", options => {
    expect(() => resolve({ ...options, user: { runtime: "cloud", cloud: { acknowledged: true } } })).toThrow();
  });
  it.each([
    { project: { runtime: "cloud" as const } }, { project: { cloud: { repo: "https://example.com/repo" } } },
    { project: { cloud: { allowLocalState: true } } },
  ])("refuses sensitive project overrides until a host trust API exists", options => {
    expect(() => resolve(options)).toThrow(expect.objectContaining({ code: "project_settings_untrusted" }));
  });
  it.each(["PI_CURSOR_CLOUD_ENV", "PI_CURSOR_CLOUD_ENV_FROM_FILES", "CURSOR_CLOUD_ENV_VARS", "OPENCODE_CURSOR_CLOUD_ENV_NAMES", "CURSOR_CLOUD_FORWARD_ENV"])("rejects forwarding environment alias %s", name => {
    expect(() => resolve({ env: { [name]: "SECRET" } })).toThrow(expect.objectContaining({ code: "env_forwarding_not_implemented" }));
  });
  it.each(["envNames", "envVars", "envFromFiles", "forwardEnv", "environmentVariables", "env"])("rejects forwarding config alias %s even in an otherwise ignored project layer", name => {
    for (const scope of ["cli", "user", "session", "project"] as const) {
      expect(() => resolve({ [scope]: { cloud: { [name]: ["CURSOR_API_KEY"] } } })).toThrow(expect.objectContaining({ code: "env_forwarding_not_implemented" }));
    }
  });
  it("persists accepted acknowledgment through the supplied host port only; declining/headless writes nothing", async () => {
    const patches: unknown[] = [];
    const persist = async (patch: unknown) => { patches.push(patch); };
    expect(await acknowledgeForegroundCloud({ persist })).toBe(false);
    expect(await acknowledgeForegroundCloud({ confirm: async () => false, persist })).toBe(false);
    expect(patches).toEqual([]);
    expect(await acknowledgeForegroundCloud({ confirm: async text => text.includes("Max Mode") && text.includes("Local tools"), persist })).toBe(true);
    expect(patches).toEqual([{ runtime: "cloud", cloud: { acknowledged: true } }]);
  });
  it("reports all ten preflight categories with independent literal expectations", () => {
    const config = resolve({ user: { cloud: { repo: "http://user:secret@example.com/repo?q=x#secret", branch: "refs/tags/v1", environment: { type: "invalid", name: "named" } } } });
    // Test the pure policy independently of resolver rejection of reserved forwarding settings.
    config.cloud.envNames.value = ["SECRET"];
    config.cloud.contextHandoff.value = "never";
    const result = preflightCursorCloudRuntime({ resolvedConfig: config, localState: { insideGitRepo: true, dirty: true, comparison: "unpushed" }, hasPriorContext: true });
    expect(result.issues.map(issue => issue.code)).toEqual(["cloud_ack_required", "context_handoff_required", "local_state_not_allowed", "env_forwarding_not_implemented", "cloud_repo_invalid", "cloud_branch_invalid", "cloud_environment_type_invalid"]);
    const missing = preflightCursorCloudRuntime({ resolvedConfig: resolve({ user: { cloud: { acknowledged: true, branch: "main", environment: { name: "named" } } } }), localState: clean });
    expect(missing.issues.map(issue => issue.code)).toEqual(["cloud_branch_repo_required", "cloud_environment_type_required"]);
    const conflict = preflightCursorCloudRuntime({ resolvedConfig: resolve({ user: { cloud: { acknowledged: true, repo: "https://example.com/repo", environment: { type: "cloud", name: "named" } } } }), localState: clean });
    expect(conflict.issues.map(issue => issue.code)).toEqual(["cloud_environment_repo_conflict"]);
    expect(JSON.stringify(result)).not.toContain("user:secret");
  });
  it.each(["http://example.com/repo", "https://user:secret@example.com/repo", "https://example.com/repo?token=secret", "https://example.com/repo#secret"])("rejects unsafe repo without echoing it", repo => {
    const result = preflightCursorCloudRuntime({ resolvedConfig: resolve({ user: { cloud: { repo, acknowledged: true } } }), localState: clean });
    expect(result.issues.map(issue => issue.code)).toEqual(["cloud_repo_invalid"]); expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("sends only explicit PR controls/environment/ref and never local options", () => {
    const options = buildCursorCloudAgentOptions({ apiKey: "fake", modelSelection: { id: "model" }, agentMode: "agent", resolvedConfig: resolve({ user: {
      cloud: { repo: "https://example.com/repo", branch: "refs/heads/main", directPush: true, autoCreatePR: false, skipReviewerRequest: true, environment: { type: "pool", name: "pool" } },
      local: { sandbox: true, autoReview: true },
    } }) });
    expect(options).toEqual({ apiKey: "fake", model: { id: "model" }, mode: "agent", cloud: { env: { type: "pool", name: "pool" }, repos: [{ url: "https://example.com/repo", startingRef: "main" }], workOnCurrentBranch: true, autoCreatePR: false, skipReviewerRequest: true } });
  });
  it("redacts keys split across small SDK deltas and strips controls", () => {
    const sanitizer = createCloudTextSanitizer("fake-secret-api-key");
    const first = sanitizer.push("prefix fake-secret-"); const second = sanitizer.push("api-key\u001b[31m suffix");
    expect(first + second + sanitizer.finish()).toBe("prefix [redacted] suffix");
  });
  it("requires text user content, never fabricates a bootstrap from opaque input", () => {
    expect(() => foregroundCloudContext("opaque")).toThrow(); expect(() => foregroundCloudContext([{ role: "system", content: "only" }])).toThrow();
  });
  it("host store adapter writes isolated namespace keys and persisted prepared JSON", async () => {
    const values = new Map<string, unknown>(); const keys: string[] = [];
    const store = createHostForegroundCloudStore({ storage: {
      get: async key => { keys.push(key); return undefined; }, set: async (key, value) => { keys.push(key); values.set(key, value); },
      remove: async () => {}, scan: async () => ({ entries: [] }),
    } }, async () => true);
    await store.write("ses_a", { version: 1, sessionID: "ses_a", records: [{ operationID: "prepared", sessionID: "ses_a", phase: "prepared" }] });
    await store.read("ses_b"); expect(keys[0]).not.toBe(keys[1]); expect(keys.every(key => key.startsWith("foreground-cloud:v1:"))).toBe(true);
    expect([...values.values()]).toEqual([{ version: 1, sessionID: "ses_a", records: [{ operationID: "prepared", sessionID: "ses_a", phase: "prepared" }] }]);
  });
});


it("redacts credential URLs and Authorization values split across chunks", () => {
  const sanitizer = createCloudTextSanitizer("fake-key");
  const output = [sanitizer.push("URL https://user:"), sanitizer.push("secret@example.com/repo Authorization: Bear"), sanitizer.push("er other-secret "), sanitizer.finish()].join("");
  expect(output).not.toContain("user:secret"); expect(output).not.toContain("other-secret");
});
