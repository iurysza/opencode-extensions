import { randomUUID } from "node:crypto";
import type { CloudClient, CloudHandle, CloudRun } from "./cloud-client.js";
import { cloudError } from "./cloud-client.js";
import { resolveRepo } from "./repo.js";
import { agentUrl, cleanText, formatCompletion, formatList, singleLine } from "./render.js";
import { err, ok, type Result } from "./result.js";
import type { ReceiptService } from "./receipts.js";
import { elapsedMs, isActive, reduce, shortId, type CloudAgent, type Event, type State } from "./state.js";

export interface SpawnParams { prompt: string; repo?: string; ref?: string; model?: string; name?: string }
export interface CloudLocation { readonly directory: string; readonly workspaceID?: string }
export interface CloudReply {
  readonly text: string;
  readonly agents: State;
  readonly receiptIssues: readonly { readonly agentId: string; readonly runId: string; readonly message: string }[];
}
export type CloudResponse = Result<CloudReply, { readonly message: string }>;
export interface CloudService {
  spawn(sessionID: string, params: SpawnParams): Promise<CloudResponse>;
  send(sessionID: string, id: string, prompt: string): Promise<CloudResponse>;
  status(sessionID: string, id?: string): Promise<CloudResponse>;
  cancel(sessionID: string, id: string): Promise<CloudResponse>;
  delete(sessionID: string, id: string, confirmed: boolean): Promise<CloudResponse>;
  dispose(): Promise<void>;
}
export interface CloudServiceOptions {
  readonly client: CloudClient;
  readonly receipts: Pick<ReceiptService, "submit">;
  readonly location: CloudLocation;
  readonly currentLocation?: () => CloudLocation;
  readonly repo?: typeof resolveRepo;
  readonly now?: () => number;
  readonly diagnostic?: (message: string) => void;
  /** A notification only; never receives prompts, credentials, or raw service state. */
  readonly onChange?: (sessionID: string) => void;
}
class Refusal extends Error {}
const requireText = (value: unknown, label: string, max: number): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new Refusal(`Invalid ${label}.`);
  return value;
};
interface Job { readonly sessionID: string; readonly ready: Promise<CloudRun>; active: boolean }

/** Owns only this process's handles. Recovery belongs exclusively to the receipt adapter. */
export function createCloudService(options: CloudServiceOptions): CloudService {
  const now = options.now ?? Date.now;
  const location = { ...options.location };
  const owners = new Map<string, string>();
  const handles = new Map<string, CloudHandle>();
  const jobs = new Map<string, Job>();
  const deleting = new Set<string>();
  const issues: { sessionID: string; agentId: string; runId: string; message: string }[] = [];
  let state: State = [];
  let stopped = false;

  function check(sessionID: string) {
    if (stopped) throw new Refusal("Cursor Cloud has shut down.");
    requireText(sessionID, "session ID", 256);
    const current = options.currentLocation?.() ?? location;
    if (location.workspaceID !== undefined || current.workspaceID !== undefined || current.directory !== location.directory)
      throw new Refusal("Cursor Cloud is unavailable in this location.");
  }
  function dispatch(event: Event) {
    if (stopped) return;
    state = reduce(state, event);
    const sessionID = event.type === "spawned" ? owners.get(event.agent.id) : owners.get(event.id);
    if (sessionID) { try { options.onChange?.(sessionID); } catch {} }
  }
  function find(sessionID: string, id: string): CloudAgent {
    const prefix = requireText(id, "cloud agent ID", 256).trim().replace(/^bc-/, "");
    if (!prefix) throw new Refusal("Invalid cloud agent ID.");
    const matches = state.filter(a => owners.get(a.id) === sessionID && a.id.replace(/^bc-/, "").startsWith(prefix));
    const agent = matches[0];
    if (matches.length !== 1 || !agent) throw new Refusal(matches.length > 1 ? "Ambiguous cloud agent ID. Use a longer prefix." : "Unknown cloud agent. Only agents created in this process and session are available.");
    return agent;
  }
  function reply(sessionID: string, text: string, id?: string): CloudReply {
    // Callers cannot mutate live reducer state or inspect another session's jobs/receipts.
    return structuredClone({ text, agents: state.filter(a => owners.get(a.id) === sessionID && (!id || a.id === id)),
      receiptIssues: issues.filter(i => i.sessionID === sessionID).map(({ agentId, runId, message }) => ({ agentId, runId, message })) });
  }
  async function action(sessionID: string, operation: string, fn: () => Promise<CloudReply> | CloudReply): Promise<CloudResponse> {
    try { check(sessionID); return ok(await fn()); }
    catch (cause) { return err({ message: cause instanceof Refusal ? cause.message : cloudError(cause, operation) }); }
  }
  function close(handle: CloudHandle) { try { handle.close(); } catch { /* Detach is best effort, never cancel. */ } }
  function receiptIssue(sessionID: string, agentId: string, runId: string) {
    const message = "Cloud completion receipt could not be confirmed. Result remains available through status; no fallback notification was sent.";
    issues.push({ sessionID, agentId, runId, message });
    try { options.diagnostic?.(message); } catch { /* Diagnostics must not affect state. */ }
  }
  function startRun(sessionID: string, agent: CloudAgent, handle: CloudHandle, prompt: string) {
    // Reserve synchronously. A concurrent follow-up sees starting before send is awaited.
    const job: Job = { sessionID, active: true, ready: Promise.resolve().then(() => {
      check(sessionID);
      return handle.send(prompt, event => {
        if (jobs.get(agent.id) === job && job.active) dispatch({ ...event, id: agent.id });
      });
    }) };
    jobs.set(agent.id, job);
    void (async () => {
      let runId = `local-${randomUUID()}`;
      try {
        const run = await job.ready;
        if (stopped || jobs.get(agent.id) !== job) return;
        runId = run.id;
        dispatch({ type: "running", id: agent.id, runId });
        const completion = await run.wait();
        if (stopped || jobs.get(agent.id) !== job) return;
        const current = find(sessionID, agent.id);
        dispatch({ ...completion, id: agent.id, now: now(), result: { ...completion.result,
          text: completion.result.text || current.text, durationMs: completion.result.durationMs || elapsedMs(current, now()) } });
      } catch (cause) {
        if (stopped || jobs.get(agent.id) !== job) return;
        const current = find(sessionID, agent.id);
        dispatch({ type: "error", id: agent.id, now: now(), error: cloudError(cause, "run"),
          result: { text: current.text, durationMs: elapsedMs(current, now()), branches: [] } });
      }
      job.active = false; // Drop terminal/late stream callbacks, even during durable submission.
      if (stopped || jobs.get(agent.id) !== job) return;
      const text = formatCompletion(find(sessionID, agent.id));
      try {
        // Never replace a failed receipt with a direct synthetic call or fake completion.
        const submitted = await options.receipts.submit({ sessionID, agentId: agent.id, runId, text });
        if (submitted._tag !== "receipt" || submitted.receipt.hold) receiptIssue(sessionID, agent.id, runId);
      } catch { receiptIssue(sessionID, agent.id, runId); }
    })().catch(() => { if (!stopped) receiptIssue(sessionID, agent.id, "unknown"); });
  }
  return {
    spawn: (sessionID, params) => action(sessionID, "spawn", async () => {
      requireText(params.prompt, "prompt", 100_000);
      for (const field of ["repo", "ref", "model", "name"] as const) if (params[field] !== undefined) requireText(params[field], field, field === "name" ? 200 : 2048);
      let resolved: { repo: string; ref: string };
      try { resolved = await (options.repo ?? resolveRepo)(location.directory, params.repo, params.ref); }
      catch { throw new Refusal("No valid GitHub repository/ref found. Pass an explicit GitHub repo and ref."); }
      check(sessionID);
      const model = params.model?.trim() || "composer-2.5";
      const name = singleLine(params.name || `cloud-${state.length + 1}`);
      const handle = await options.client.create({ ...resolved, model, name });
      try { check(sessionID); } catch (cause) { close(handle); throw cause; }
      if (!/^bc-[\w-]+$/.test(handle.id) || handles.has(handle.id)) { close(handle); throw new Refusal("Cursor Cloud returned an invalid or duplicate agent ID."); }
      handles.set(handle.id, handle);
      owners.set(handle.id, sessionID);
      const agent: CloudAgent = { id: handle.id, name, description: cleanText(params.prompt), ...resolved, model, startedAt: now(),
        status: { type: "starting" }, activity: "starting…", text: "", tools: 0, toolCallIds: [] };
      dispatch({ type: "spawned", agent });
      startRun(sessionID, agent, handle, params.prompt);
      return reply(sessionID, `Cloud agent ${shortId(handle.id)} (${name}) runs in the background. Results arrive later as a follow-up. It sees the remote ${resolved.repo} at ${resolved.ref}, not local, uncommitted or unpushed commits. Open: ${agentUrl(handle.id)}`, handle.id);
    }),
    send: (sessionID, id, prompt) => action(sessionID, "send", () => {
      requireText(prompt, "prompt", 100_000);
      const agent = find(sessionID, id);
      if (deleting.has(agent.id)) throw new Refusal("Cloud agent deletion is in progress.");
      if (isActive(agent)) throw new Refusal("Agent already has an active run. Wait until it is idle before sending a follow-up.");
      const handle = handles.get(agent.id);
      if (!handle) throw new Refusal("Cloud agent handle is unavailable. Start a new agent.");
      dispatch({ type: "followUp", id: agent.id, prompt: cleanText(prompt), now: now() });
      startRun(sessionID, find(sessionID, agent.id), handle, prompt);
      return reply(sessionID, `Follow-up sent to ${shortId(agent.id)} in the background. Results arrive later.`, agent.id);
    }),
    status: (sessionID, id) => action(sessionID, "status", () => {
      const selected = id === undefined ? state.filter(a => owners.get(a.id) === sessionID) : [find(sessionID, id)];
      return reply(sessionID, [formatList(selected, now()), ...selected.filter(a => !isActive(a)).map(formatCompletion)].join("\n\n"), id === undefined ? undefined : selected[0]?.id);
    }),
    cancel: (sessionID, id) => action(sessionID, "cancel", async () => {
      const agent = find(sessionID, id);
      if (!isActive(agent)) return reply(sessionID, `Cloud agent is already ${agent.status.type}.`, agent.id);
      const job = jobs.get(agent.id);
      if (!job || job.sessionID !== sessionID) throw new Refusal("No active cloud run is available to cancel.");
      const run = await job.ready;
      check(sessionID); // Shutdown while send was pending must never cancel remote work.
      if (jobs.get(agent.id) !== job || !job.active) return reply(sessionID, "Cloud run has already ended.", agent.id);
      await run.cancel();
      return reply(sessionID, `Cancellation requested for ${shortId(agent.id)}. Its final result arrives later.`, agent.id);
    }),
    delete: (sessionID, id, confirmed) => action(sessionID, "delete", async () => {
      const agent = find(sessionID, id);
      if (confirmed !== true) throw new Refusal("Cloud agent deletion requires explicit confirmation.");
      if (isActive(agent)) throw new Refusal("Cancel the active run and wait for completion before deleting this agent.");
      if (deleting.has(agent.id)) throw new Refusal("Cloud agent deletion is already in progress.");
      deleting.add(agent.id);
      try {
        await options.client.delete(agent.id);
        const handle = handles.get(agent.id);
        if (handle) close(handle);
        handles.delete(agent.id); jobs.delete(agent.id);
        dispatch({ type: "removed", id: agent.id });
        owners.delete(agent.id);
        return reply(sessionID, `Deleted cloud agent ${shortId(agent.id)}.`);
      } finally { deleting.delete(agent.id); }
    }),
    async dispose() {
      if (stopped) return;
      stopped = true;
      for (const handle of handles.values()) close(handle);
      handles.clear(); jobs.clear(); owners.clear(); state = [];
    },
  };
}
