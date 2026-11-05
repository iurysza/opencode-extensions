import { elapsedMs, shortId, type CloudAgent, type State } from "./state.js";

// Cloud text is untrusted terminal input, not ANSI markup.
export const cleanText = (text: string): string => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
export const singleLine = (text: string): string => cleanText(text).replace(/\s+/g, " ").trim();
export function duration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Cursor web page for a cloud agent. Full id, e.g. bc-1234…. */
export const agentUrl = (id: string): string => `https://cursor.com/agents/${id}`;

export function formatCompletion(agent: CloudAgent): string {
  if (!("result" in agent.status)) return `Cloud agent ${shortId(agent.id)} is ${agent.status.type}.`;
  const { result } = agent.status;
  const label = agent.status.type === "idle" ? "finished" : agent.status.type === "failed" ? "failed" : "cancelled";
  const header = `Cloud agent ${singleLine(agent.name)} (${shortId(agent.id)}) ${label} · ${duration(result.durationMs)}`;
  const error = agent.status.type === "failed" ? `Error: ${cleanText(agent.status.error)}` : "";
  const branches = result.branches.map(b => [b.repoUrl, b.branch && `branch: ${b.branch}`, b.prUrl && `PR: ${b.prUrl}`].filter(Boolean).join(" · "));
  return [header, error, cleanText(result.text) || "No result text.", ...branches.map(cleanText), `Open: ${agentUrl(agent.id)}`].filter(Boolean).join("\n\n");
}

export function formatList(state: State, now: number): string {
  if (!state.length) return "No cloud agents started in this process.";
  return ["ID        NAME                  STATUS      ELAPSED  REPO", ...state.flatMap(a => [
    `${shortId(a.id).padEnd(10)}${singleLine(a.name).slice(0, 20).padEnd(22)}${a.status.type.padEnd(12)}${duration(elapsedMs(a, now)).padEnd(9)}${a.repo}`,
    `          ${agentUrl(a.id)}`])].join("\n");
}

/** Structured view of one agent. Tool results and messages carry it as `details` for renderers. */
export interface AgentSummary {
  id: string; url: string; name: string; status: CloudAgent["status"]["type"]; repo: string; ref: string;
  model: string; elapsedMs: number; tools: number; activity: string;
}
export function summarize(agent: CloudAgent, now: number): AgentSummary {
  return { id: shortId(agent.id), url: agentUrl(agent.id), name: agent.name, status: agent.status.type, repo: agent.repo,
    ref: agent.ref, model: agent.model, elapsedMs: elapsedMs(agent, now), tools: agent.tools, activity: singleLine(agent.activity) };
}
