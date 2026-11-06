import { stripVTControlCharacters } from "node:util";
import type { RunResult } from "@cursor/sdk";

/** Remote text is untrusted terminal input; reports never carry active controls. */
export function sanitizeCloudText(text: string, apiKey?: string): string {
  let value = text;
  if (apiKey) value = value.split(apiKey).join("[redacted]");
  return stripVTControlCharacters(value)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .replace(/\b(?:https?|ssh):\/\/[^\s/]*@/gi, "https://[redacted]@")
    .replace(/\b(?:Bearer|Basic)\s+[^\s]+/gi, "[redacted authorization]")
    .replace(/\b(?:api[_-]?key|authorization|access[_-]?token)\s*[:=]\s*[^\s,;]+/gi, "[redacted credential]");
}
function safeURL(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return undefined;
    return url.toString().slice(0, 240);
  } catch { return undefined; }
}
/** Uses public SDK result metadata only. No extra API calls, no host usage accounting. */
export function formatForegroundCloudReport(agentID: string, result: RunResult, apiKey: string): string {
  const lines = ["\nCursor Cloud run:", `- agent: ${agentID}`, `- run: ${result.id}`,
    `- dashboard: https://cursor.com/agents/${encodeURIComponent(agentID)}`];
  for (const branch of (result.git?.branches ?? []).slice(0, 5)) {
    const repo = safeURL(branch.repoUrl);
    if (branch.branch) lines.push(`- branch: ${branch.branch.slice(0, 160)}${repo ? ` (${repo})` : ""}`);
    const pr = safeURL(branch.prUrl);
    if (pr) lines.push(`- PR: ${pr}`);
  }
  if (result.usage) {
    const usage = Object.entries(result.usage).filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value >= 0);
    if (usage.length) lines.push(`- raw usage, display only: ${usage.map(([key, value]) => `${key} ${value}`).join(", ")}`);
  }
  return sanitizeCloudText(lines.join("\n") + "\n", apiKey);
}

/** Retain a tail so a key split across SDK deltas cannot escape redaction. */
export function createCloudTextSanitizer(apiKey: string): { push(text: string): string; finish(): string } {
  let pending = "";
  return {
    push(text) {
      pending += text;
      if (apiKey) pending = pending.split(apiKey).join("[redacted]");
      // Keep the incomplete token and any preceding credential label. This also
      // catches userinfo/Authorization split over SDK callback boundaries.
      let count = 0;
      for (const match of pending.matchAll(/\s+/g)) count = (match.index ?? 0) + match[0].length;
      const label = /(?:bearer|basic|api[_-]?key|authorization|access[_-]?token)\s*[:=]?\s*$/i.exec(pending.slice(0, count));
      if (label?.index !== undefined) count = label.index;
      const prefix = pending.slice(0, count);
      pending = pending.slice(count);
      return sanitizeCloudText(prefix, apiKey);
    },
    finish() { const result = sanitizeCloudText(pending, apiKey); pending = ""; return result; },
  };
}
