import { describe, expect, it } from "vitest";
import { cloudError, createCloudClient, type SdkLoader } from "../../src/core/cloud-client.js";
import { describeSdkError, sanitizeServerText } from "../../src/core/sdk-error.js";

const KEY = "synthetic-test-key-not-a-credential";
const GENERIC = "Cursor Cloud send failed. Check authentication, repository access, and Cursor service availability.";

/** Same shape the SDK builds: name from errorName plus scalar fields, cause holding the raw client. */
function sdkError(name: string, message: string, fields: Record<string, unknown> = {}): Error {
  const error = new Error(message);
  error.name = name;
  Object.assign(error, { isRetryable: false, cause: { serializedClient: `cause-${KEY}` }, ...fields });
  return error;
}

describe("safe SDK error mapping", () => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["AuthenticationError", { status: 401 }, /authentication failed \(HTTP 401\)\. .*Team Admin keys do not work for Cloud Agents; use a user or service-account key/],
    ["RateLimitError", { status: 429, isRetryable: true }, /rate limited \(HTTP 429\)\. .*Retry later/],
    ["ConfigurationError", { code: "invalid_model", status: 400 }, /request refused \(invalid_model, HTTP 400\)\. Check the model, repository, ref and any team admin policy/],
    ["NetworkError", { status: 503, isRetryable: true }, /network or service error \(HTTP 503\)/],
    ["AgentNotFoundError", { code: "agent_not_found", status: 404 }, /agent not found \(agent_not_found, HTTP 404\)\. .*Start a new agent/],
    ["UnknownAgentError", { status: 500 }, /unexpected Cursor error \(HTTP 500\)/],
  ];
  for (const [name, fields, expected] of cases) it(`maps ${name} without the key or cause`, () => {
    const text = cloudError(sdkError(name, `[x] server said ${KEY} Bearer abc.def api_key=zzz crsr_0123456789abcdef`, { requestId: "req-1", ...fields }), "send", KEY);
    expect(text).toMatch(expected);
    expect(text).toContain("Request: req-1.");
    expect(text).toContain("Server: server said [redacted]");
    for (const leak of [KEY, "cause-", "serializedClient", "abc.def", "zzz", "crsr_0123", "stack"]) expect(text).not.toContain(leak);
    expect(text).not.toContain("\n");
  });

  it("names the provider and shows helpUrl and requestId for a missing integration", () => {
    const text = cloudError(sdkError("IntegrationNotConnectedError", "[integration_not_connected] Connect GitHub to use this repo", {
      code: "integration_not_connected", status: 400, helpUrl: "https://cursor.com/integrations", provider: "github", requestId: "req-42" }), "send", KEY);
    expect(text).toBe("Cursor Cloud send failed: GitHub integration not connected (integration_not_connected, HTTP 400). " +
      "Connect it: https://cursor.com/integrations. Server: Connect GitHub to use this repo. Request: req-42.");
  });

  it("gives a billing hint for usage_limit_exceeded", () => {
    const text = cloudError(sdkError("ConfigurationError", "[usage_limit_exceeded] Your prepaid balance is used up. Add funds or enable auto top-up in your billing settings to keep going.", {
      code: "usage_limit_exceeded", status: 400, requestId: "req-7" }), "send", KEY);
    expect(text).toContain("usage limit reached (usage_limit_exceeded, HTTP 400).");
    expect(text).toContain("Add funds or enable auto top-up in Cursor billing settings.");
    expect(text).toContain("Server: Your prepaid balance is used up.");
    expect(text).not.toContain("repository URL");
    expect(text).not.toContain("Check the model, repository");
  });

  it("drops unsafe help URLs and unsafe request IDs", () => {
    const text = cloudError(sdkError("ConfigurationError", "nope", { helpUrl: `https://user:${KEY}@evil.example/`, requestId: `id ${KEY}` }), "send", KEY);
    expect(text).not.toContain(KEY); expect(text).not.toContain("Help:"); expect(text).not.toContain("Request:");
  });

  it("keeps the busy text and the generic text for unknown errors", () => {
    expect(cloudError(sdkError("AgentBusyError", "[agent_busy] busy"), "send")).toBe("Agent already has an active run. Wait until it is idle before sending a follow-up.");
    expect(cloudError(new Error(`boom ${KEY}`), "send", KEY)).toBe(GENERIC);
    expect(cloudError({ name: "AuthenticationError", message: KEY, isRetryable: false }, "send", KEY)).toBe(GENERIC);
    // A DOMException-style NetworkError has no SDK isRetryable flag.
    const lookalike = new Error(KEY); lookalike.name = "NetworkError";
    expect(cloudError(lookalike, "send", KEY)).toBe(GENERIC);
    expect(describeSdkError("string", "send")).toBeUndefined();
  });

  it("caps the server line and keeps one line", () => {
    const text = sanitizeServerText(`a\nb\x1b[31m${"x".repeat(1000)}`, KEY);
    expect(text.length).toBeLessThanOrEqual(300); expect(text).not.toMatch(/[\n\x1b]/);
  });

  it("rejoins a key split by ANSI codes before redaction", () => {
    const split = KEY.slice(0, 8) + "\x1b[0m" + KEY.slice(8);
    expect(sanitizeServerText(`saw ${split}`, KEY)).toBe("saw [redacted]");
  });

  it("client send failure carries the safe detail through the client boundary", async () => {
    const sdk = { Agent: { create: async () => ({ agentId: "bc-x", close() {}, send: async () => {
      throw sdkError("IntegrationNotConnectedError", `[integration_not_connected] no ${KEY}`, { code: "integration_not_connected", status: 400, provider: "github", helpUrl: "https://cursor.com/x", requestId: "r9" });
    } }) } };
    const client = createCloudClient(async () => KEY, (async () => sdk) as unknown as SdkLoader);
    const handle = await client.create({ repo: "https://github.com/o/r", ref: "main", model: "m", name: "n" });
    const failure = await handle.send("p", () => {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("GitHub integration not connected"); expect(message).toContain("Connect it: https://cursor.com/x");
    expect(message).not.toContain(KEY);
    // The service re-wraps with cloudError; the safe message must pass through unchanged.
    expect(cloudError(failure, "run")).toBe(message);
  });
});
