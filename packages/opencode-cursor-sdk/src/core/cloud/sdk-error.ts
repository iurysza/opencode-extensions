// Kept identical in both packages: they cannot depend on each other.
// Classifies @cursor/sdk 1.0.40 errors by `name` and duck-typed fields only.
// Importing the SDK here would load it at package load time.

export const AGENT_BUSY = "Agent already has an active run. Wait until it is idle before sending a follow-up.";

const kinds: Record<string, { summary: string; hint: string }> = {
  AuthenticationError: { summary: "authentication failed",
    hint: "Check the Cursor API key. Team Admin keys do not work for Cloud Agents; use a user or service-account key." },
  IntegrationNotConnectedError: { summary: "integration not connected",
    hint: "Connect the integration in Cursor and grant it access to this repository." },
  ConfigurationError: { summary: "request refused", hint: "Check the model, repository, ref and any team admin policy." },
  RateLimitError: { summary: "rate limited", hint: "Rate or usage limit reached. Retry later." },
  NetworkError: { summary: "network or service error", hint: "Cursor is unreachable or unavailable. Retry later." },
  AgentNotFoundError: { summary: "agent not found", hint: "The agent does not exist on Cursor. Start a new agent." },
  UnknownAgentError: { summary: "unexpected Cursor error", hint: "Check Cursor service status and retry." },
};
// Billing is keyed by code, not name: Cursor sends it as a ConfigurationError.
const billing = { summary: "usage limit reached", hint: "Add funds or enable auto top-up in Cursor billing settings." };
const providers: Record<string, string> = { github: "GitHub", gitlab: "GitLab", bitbucket: "Bitbucket", azure: "Azure DevOps" };

const field = (error: object, key: string): unknown => Reflect.get(error, key);
const clean = (text: string): string => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ");

/** Strip ANSI first so split keys rejoin before redaction, then remove token-like strings. */
export function sanitizeServerText(text: string, key: string, max = 300): string {
  let value = clean(text);
  if (key) value = value.split(key).join("[redacted]");
  value = value
    .replace(/\bcrsr_[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\b(?:bearer|basic)\s+\S+/gi, "[redacted]")
    .replace(/\b[\w-]*(?:key|token|secret|password|authorization)\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/\s+/g, " ").trim();
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}

function helpUrl(value: unknown, key: string): string | undefined {
  if (typeof value !== "string" || value.length > 240) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
  } catch { return undefined; }
  const safe = sanitizeServerText(value, key, 240);
  return safe.includes("[redacted]") ? undefined : safe;
}

/**
 * One safe line for a known SDK error, or undefined when the error is not one.
 * Uses only the message string and scalar fields: never cause, stack or toJSON.
 */
export function describeSdkError(error: unknown, operation: string, key = ""): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.name === "AgentBusyError" || error.message.includes("[agent_busy]")) return AGENT_BUSY;
  const kind = kinds[error.name];
  // Every SDK error sets a boolean isRetryable. This excludes DOMException("NetworkError") and lookalikes.
  if (!kind || typeof field(error, "isRetryable") !== "boolean") return undefined;
  const code = field(error, "code"), status = field(error, "status"), requestId = field(error, "requestId");
  const safeCode = typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code) && code !== "unknown" ? code : undefined;
  const safeStatus = typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
  const meta = [safeCode, safeStatus === undefined ? undefined : `HTTP ${safeStatus}`].filter(Boolean).join(", ");

  const url = helpUrl(field(error, "helpUrl"), key);
  let summary = kind.summary, hint = kind.hint;
  if (safeCode === "usage_limit_exceeded") {
    ({ summary, hint } = billing);
    if (url) hint += ` Help: ${url}.`;
  } else if (error.name === "IntegrationNotConnectedError" || safeCode === "integration_not_connected") {
    const provider = field(error, "provider");
    const label = typeof provider === "string" && /^[\w-]{1,32}$/.test(provider) ? providers[provider.toLowerCase()] ?? provider : "Repository";
    summary = `${label} integration not connected`;
    hint = url ? `Connect it: ${url}.` : `Connect the ${label} integration in Cursor and grant it access to this repository.`;
  } else {
    if (safeCode === "repository_access") hint = "Grant the Cursor integration access to this repository.";
    if (url) hint += ` Help: ${url}.`;
  }

  // The SDK prefixes some messages with "[code] ". Drop it to avoid repeating the code.
  const server = sanitizeServerText(error.message.replace(/^\s*\[[^\]]{1,64}\]\s*/, ""), key).replace(/[.\s]+$/, "");
  const request = typeof requestId === "string" && /^[\w.:-]{1,128}$/.test(requestId) ? requestId : undefined;
  return [
    `Cursor Cloud ${operation} failed: ${summary}${meta ? ` (${meta})` : ""}.`,
    hint,
    server ? `Server: ${server}.` : "",
    request ? `Request: ${request}.` : "",
  ].filter(Boolean).join(" ");
}
