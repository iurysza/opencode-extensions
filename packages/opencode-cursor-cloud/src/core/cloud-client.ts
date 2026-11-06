// SDK mapping ported from Pi; auth and SDK acquisition are injected.
import type { SDKAgent, SendOptions, RunResult } from "@cursor/sdk";
import type { Activity, Outcome } from "./state.js";
import { cleanText } from "./render.js";
import { AGENT_BUSY, describeSdkError } from "./sdk-error.js";

type Delta = Parameters<NonNullable<SendOptions["onDelta"]>>[0]["update"];
type Step = Parameters<NonNullable<SendOptions["onStep"]>>[0]["step"];
export type StreamEvent = { type: "delta" | "step"; activity: Activity };
export type Completion =
  | { type: "finished" | "cancelled"; result: Outcome }
  | { type: "error"; error: string; result: Outcome };
export interface SpawnOptions { repo: string; ref: string; model: string; name: string }
export interface CloudRun {
  id: string;
  wait(): Promise<Completion>;
  cancel(): Promise<void>;
}
export interface CloudHandle {
  id: string;
  send(prompt: string, emit: (event: StreamEvent) => void): Promise<CloudRun>;
  close(): void;
}
export interface CloudClient {
  models(): Promise<{ id: string; displayName?: string }[]>;
  create(options: SpawnOptions): Promise<CloudHandle>;
  delete(id: string): Promise<void>;
}

export function redact(text: string, key: string): string {
  return key ? text.replaceAll(key, "[redacted]") : text;
}

/** A message already made safe at the client boundary, where the key is known. */
export class CloudFailure extends Error { override name = "CloudFailure"; }

/**
 * No raw SDK errors: they can include a serialized client holding credentials.
 * Known SDK errors keep their class, code, status, request ID and a redacted server line.
 */
export function cloudError(error: unknown, operation: string, key = ""): string {
  if (error instanceof CloudFailure) return error.message;
  if (error instanceof Error && error.message.includes("[agent_busy]")) return AGENT_BUSY;
  return describeSdkError(error, operation, key)
    ?? `Cursor Cloud ${operation} failed. Check authentication, repository access, and Cursor service availability.`;
}
const fail = (error: unknown, operation: string, key: string) => new CloudFailure(cloudError(error, operation, key));

function toolActivity(tool: { type: string; args?: unknown }): string {
  let detail = "";
  if (typeof tool.args === "object" && tool.args !== null) {
    for (const field of ["command", "path", "pattern", "query", "globPattern"] as const) {
      if (field in tool.args) {
        const value = Reflect.get(tool.args, field);
        if (typeof value === "string") { detail = value.slice(0, 200); break; }
      }
    }
  }
  return `${tool.type === "shell" ? "run_terminal_cmd" : tool.type}${detail ? `: ${detail}` : ""}`;
}

export function mapDelta(update: Delta): StreamEvent | undefined {
  switch (update.type) {
    case "thinking-delta": return { type: "delta", activity: { type: "thinking" } };
    case "text-delta": return { type: "delta", activity: { type: "text", text: update.text } };
    case "tool-call-started": return { type: "delta", activity: { type: "tool", callId: update.callId, activity: toolActivity(update.toolCall) } };
    default: return undefined;
  }
}

export function mapStep(step: Step): StreamEvent | undefined {
  switch (step.type) {
    case "thinkingMessage": return { type: "step", activity: { type: "thinking" } };
    case "assistantMessage": return { type: "step", activity: { type: "text", text: step.message.text, replace: true } };
    // Tool starts are counted by callId in onDelta, not counted twice here.
    case "toolCall": return { type: "step", activity: { type: "activity", activity: toolActivity(step.message) } };
    default: return undefined;
  }
}

export function mapCompletion(result: RunResult, key: string): Completion {
  const outcome: Outcome = {
    text: redact(cleanText(result.result ?? ""), key),
    durationMs: result.durationMs ?? 0,
    branches: (result.git?.branches ?? []).map(branch => ({
      repoUrl: redact(cleanText(branch.repoUrl), key),
      branch: branch.branch === undefined ? undefined : redact(cleanText(branch.branch), key),
      prUrl: branch.prUrl === undefined ? undefined : redact(cleanText(branch.prUrl), key),
    })),
  };
  if (result.status === "error") return { type: "error", error: "Cursor Cloud run failed.", result: outcome };
  return { type: result.status === "cancelled" ? "cancelled" : "finished", result: outcome };
}

/** Use the renderer's normalization, retaining incomplete ESC/CSI tails across callbacks. */
function streamingTerminal() {
  let pending = "";
  return {
    write(text: string, replace: boolean): string {
      const input = (replace ? "" : pending) + text;
      const incomplete = /\x1b(?:\[[0-?]*[ -/]*)?$/.exec(input);
      const cut = incomplete?.index ?? input.length;
      pending = input.slice(cut);
      // A malformed, unbounded control fragment must not buffer the whole turn.
      // The visible marker cannot be removed by later cleanText and reconnect a key.
      if (pending.length > 4096) {
        pending = "";
        return cleanText(input.slice(0, cut)) + "[terminal sequence omitted]";
      }
      return cleanText(input.slice(0, cut));
    },
    finish(): string {
      const tail = cleanText(pending);
      pending = "";
      return tail;
    },
  };
}

/** Holds only a suffix that could become this key, never the whole response. */
function streamingKey(key: string) {
  let pending = "";
  return {
    write(text: string, replace: boolean): string {
      const input = (replace ? "" : pending) + text;
      pending = "";
      if (!key) return input;
      let output = "", cursor = 0;
      for (let at = input.indexOf(key); at !== -1; at = input.indexOf(key, cursor)) {
        output += input.slice(cursor, at) + "[redacted]";
        cursor = at + key.length;
      }
      const rest = input.slice(cursor);
      let held = Math.min(key.length - 1, rest.length);
      while (held > 0 && !rest.endsWith(key.slice(0, held))) held--;
      pending = held ? rest.slice(-held) : "";
      return output + rest.slice(0, rest.length - held);
    },
    finish(): string {
      // The run is sealed before this is emitted. This incomplete prefix cannot join
      // a later chunk into the key; flushing preserves ordinary trailing text.
      const tail = pending;
      pending = "";
      return tail;
    },
  };
}

function wrapHandle(agent: SDKAgent, key: string): CloudHandle {
  const finalizers = new Set<() => void>();
  return {
    id: agent.agentId,
    close() {
      try {
        for (const finish of finalizers) finish();
        agent.close();
      } catch (error) { throw fail(error, "close", key); }
    },
    async send(prompt, emit) {
      const text = streamingKey(key); // New run, including every follow-up, starts empty.
      const terminal = streamingTerminal();
      let snapshot = "";
      let sealed = false;
      const finish = () => {
        if (sealed) return;
        sealed = true;
        finalizers.delete(finish);
        const tail = text.write(terminal.finish(), false) + text.finish();
        // Defense at the client boundary: downstream rendering must not reconstruct
        // a key in either the terminal result or the service's empty-result fallback.
        const safe = redact(cleanText(snapshot + tail), key);
        if (safe !== snapshot) {
          snapshot = safe;
          emit({ type: "delta", activity: { type: "text", text: safe, replace: true } });
        }
      };
      finalizers.add(finish);
      const publish = (event: StreamEvent | undefined) => {
        if (!event || sealed) return;
        const activity = event.activity;
        if (activity.type === "text") {
          const replace = activity.replace === true;
          const safe = text.write(terminal.write(activity.text, replace), replace);
          snapshot = replace ? safe : snapshot + safe;
          // Empty replacements still clear old reducer text and discard its pending prefix.
          if (safe || replace) emit({ ...event, activity: { ...activity, text: safe } });
        } else if (activity.type === "tool" || activity.type === "activity") emit({ ...event, activity: { ...activity, activity: redact(cleanText(activity.activity), key) } });
        else emit(event);
      };
      try {
        const run = await agent.send(prompt, {
          onDelta: ({ update }) => publish(mapDelta(update)),
          onStep: ({ step }) => publish(mapStep(step)),
        });
        return {
          id: run.id,
          async cancel() {
            try { await run.cancel(); finish(); } catch (error) { throw fail(error, "cancel", key); }
          },
          async wait() {
            try {
              const result = await run.wait();
              finish(); // Flush safe tail before the service reads its empty-result fallback.
              const completion = mapCompletion(result, key);
              return { ...completion, result: { ...completion.result, text: completion.result.text || snapshot } };
            } catch (error) {
              finish();
              throw fail(error, "wait", key);
            }
          },
        };
      } catch (error) {
        finish();
        throw fail(error, "send", key);
      }
    },
  };
}

/** Public SDK exports only. This function is never called during package load or setup. */
export type SdkLoader = () => Promise<Pick<typeof import("@cursor/sdk"), "Agent" | "Cursor">>;
export const loadSdk: SdkLoader = () => import("@cursor/sdk");

export function createCloudClient(getKey: () => Promise<string>, sdk: SdkLoader = loadSdk): CloudClient {
  return {
    async models() {
      const apiKey = await getKey();
      try { const { Cursor } = await sdk(); return (await Cursor.models.list({ apiKey })).map(({ id, displayName }) => ({ id, displayName })); }
      catch (error) { throw fail(error, "model listing", apiKey); }
    },
    async create(options) {
      const apiKey = await getKey();
      try {
        const { Agent } = await sdk();
        return wrapHandle(await Agent.create({ apiKey, model: { id: options.model },
          cloud: { repos: [{ url: options.repo, startingRef: options.ref }] } }), apiKey);
      } catch (error) { throw fail(error, "create", apiKey); }
    },
    async delete(id) {
      const apiKey = await getKey();
      try { const { Agent } = await sdk(); await Agent.delete(id, { apiKey }); }
      catch (error) { throw fail(error, "delete", apiKey); }
    },
  };
}
