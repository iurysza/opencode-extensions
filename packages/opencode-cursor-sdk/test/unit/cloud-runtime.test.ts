import { describe, expect, it } from "vitest";
import { setImmediate } from "node:timers/promises";
import type { Run, RunResult, SendOptions, AgentOptions } from "@cursor/sdk";
import { createForegroundCloudSource, type ForegroundCloudAgentFactory, type ForegroundCloudDependencies } from "../../src/core/cloud/source.js";
import type { CursorCloudLocalState } from "../../src/core/cloud/local-state.js";
import type { CloudLedger, ForegroundCloudStore } from "../../src/core/cloud/ledger.js";
import type { CursorTurnEvent, CursorTurnRequest } from "../../src/core/turn-events.js";

const bc = "bc-11111111-1111-4111-8111-111111111111";
const bc2 = "bc-22222222-2222-4222-8222-222222222222";
const request = (sessionID = "ses_a", extra: Partial<CursorTurnRequest> = {}): CursorTurnRequest => ({
  modelId: "model", context: { kind: "primary", sessionID, agent: "build", model: { providerID: "cursor", id: "model" } },
  prompt: [{ role: "system", content: "system" }, { role: "user", content: [{ type: "text", text: "hello" }] }], ...extra,
});
async function collect(events: AsyncIterable<CursorTurnEvent>): Promise<CursorTurnEvent[]> { const result = []; for await (const event of events) result.push(event); return result; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const trace: string[] = [];
  const sendStarted = deferred<void>();
  const runRecorded = deferred<void>();
  const data = new Map<string, CloudLedger>();
  let exists = true;
  let failure = "";
  let writes = 0;
  let creates = 0;
  let cancelled = 0;
  let closed = 0;
  let result: RunResult = { id: "run-test", status: "finished", result: "answer" };
  let wait: (() => Promise<RunResult>) | undefined;
  let sendGate: Promise<void> | undefined;
  let cancel: (() => Promise<void>) | undefined;
  let createOptions: AgentOptions | undefined;
  let activity: ((options: SendOptions | undefined) => Promise<void>) | undefined;
  const sends: string[] = [];
  const store: ForegroundCloudStore = {
    sessionExists: async () => { trace.push("exists"); return exists; },
    read: async id => structuredClone(data.get(id)),
    write: async (id, ledger) => {
      const phase = ledger.records.at(-1)?.phase;
      trace.push(`write:${phase}`); writes++;
      if (failure === phase) throw new Error("secret storage failure");
      data.set(id, structuredClone(ledger));
      if (phase === "running") runRecorded.resolve();
    },
  };
  const factory: ForegroundCloudAgentFactory = {
    create: async options => {
      createOptions = options; trace.push("create"); creates++;
      const agentID = creates === 1 ? bc : bc2;
      return {
        agentId: agentID,
        close: () => { trace.push("close"); closed++; },
        send: async (message, options?: SendOptions) => {
          sends.push(typeof message === "string" ? message : ""); trace.push("send"); sendStarted.resolve();
          await sendGate;
          if (activity) await activity(options);
          else {
            await options?.onDelta?.({ update: { type: "text-delta", text: "answer" } });
            await options?.onDelta?.({ update: { type: "thinking-delta", text: "thinking" } });
          }
          const run: Run = { id: "run-test", agentId: agentID, status: "running", supports: () => true,
            unsupportedReason: () => undefined, stream: async function* () {}, conversation: async () => [],
            wait: async () => { trace.push("wait"); return wait ? wait() : result; },
            cancel: async () => { trace.push("cancel"); cancelled++; await cancel?.(); }, onDidChangeStatus: () => () => {},
          };
          return run;
        },
      };
    },
    archive: async () => { trace.push("archive"); if (failure === "archive") throw new Error("private SDK error"); },
    delete: async () => { trace.push("delete"); if (failure === "delete") throw new Error("private SDK error"); },
  };
  const deps: ForegroundCloudDependencies = {
    cwd: "/fixture", getApiKey: () => "fake-personal-key",
    getConfig: () => ({ user: { runtime: "cloud", cloud: { acknowledged: true } } }), store,
    isLocalRunPending: () => false, loadAgentFactory: async () => { trace.push("load"); return factory; },
    inspectLocalState: () => ({ insideGitRepo: true, dirty: false, comparison: "contains_head" }), cancelTimeoutMs: 10,
  };
  return { deps, trace, data, sends, sendStarted: sendStarted.promise, runRecorded: runRecorded.promise, stats: () => ({ writes, creates, cancelled, closed, createOptions }),
    fail: (phase: string) => { failure = phase; }, exists: (value: boolean) => { exists = value; },
    activity: (value: (options: SendOptions | undefined) => Promise<void>) => { activity = value; },
    result: (value: RunResult) => { result = value; }, wait: (value: () => Promise<RunResult>) => { wait = value; },
    sendGate: (value: Promise<void>) => { sendGate = value; }, cancel: (value: () => Promise<void>) => { cancel = value; } };
}

describe("foreground Cloud source", () => {
  it("persists prepared, agent and run records in order before create, send and wait", async () => {
    const f = fixture(); const source = createForegroundCloudSource(f.deps);
    const events = await collect(source(request()));
    expect(f.trace).toEqual(["exists", "write:prepared", "load", "create", "write:created", "send", "write:running", "wait", "write:finished", "close"]);
    expect(events).toContainEqual({ type: "thinking", text: "thinking" });
    expect(events).toContainEqual({ type: "text", text: "answer" });
    expect(events.at(-1)).toEqual({ type: "done", reason: "stop" });
    expect(f.stats().createOptions).toEqual({ apiKey: "fake-personal-key", model: { id: "model" }, mode: "agent", cloud: {} });
    expect(events.some(event => "usage" in event || event.type.includes("tool"))).toBe(false);
  });
  it("creates fresh handles on every turn and scopes records to their host session", async () => {
    const f = fixture(); const source = createForegroundCloudSource(f.deps);
    await collect(source(request())); await collect(source(request("ses_b")));
    expect(f.stats().creates).toBe(2);
    expect((await source.list("ses_a")).map(entry => entry.agentID)).toEqual([bc]);
    expect((await source.list("ses_b")).map(entry => entry.agentID)).toEqual([bc2]);
    await expect(source.cleanup("ses_b", bc, "delete", { confirmed: true })).rejects.toMatchObject({ code: "cloud_agent_not_owned" });
    expect(f.trace).not.toContain("delete");
  });
  it.each(["missing", "prepared"])("never loads SDK or creates when durable session preparation fails: %s", async failure => {
    const f = fixture(); failure === "missing" ? f.exists(false) : f.fail("prepared");
    await expect(collect(createForegroundCloudSource(f.deps)(request()))).rejects.toBeInstanceOf(Error);
    expect(f.stats().creates).toBe(0); expect(f.trace).not.toContain("load");
  });
  it("closes the local handle without send or remote deletion if the agent write fails", async () => {
    const f = fixture(); f.fail("created");
    await expect(collect(createForegroundCloudSource(f.deps)(request()))).rejects.toMatchObject({ code: "cloud_agent_record_failed" });
    expect(f.sends).toEqual([]); expect(f.stats().closed).toBeGreaterThan(0);
    expect(f.trace).not.toContain("delete"); expect(f.stats().cancelled).toBe(0);
  });
  it("attempts bounded cancellation on failed run write before waiting", async () => {
    const f = fixture(); f.fail("running"); f.cancel(() => new Promise(() => {}));
    await expect(collect(createForegroundCloudSource(f.deps)(request()))).rejects.toMatchObject({ code: "cloud_run_record_failed" });
    expect(f.stats().cancelled).toBe(1); expect(f.trace).not.toContain("wait");
    expect(f.data.get("ses_a")?.records[0]?.phase).toBe("created");
  });
  it("refuses helper requests and pending local runs before loading SDK", async () => {
    const f = fixture(); const source = createForegroundCloudSource(f.deps);
    await expect(collect(source(request("ses_a", { context: { ...request().context, kind: "title" } })))).rejects.toMatchObject({ code: "cloud_helpers_disabled" });
    const pending = createForegroundCloudSource({ ...f.deps, isLocalRunPending: () => true });
    await expect(collect(pending(request()))).rejects.toMatchObject({ code: "local_run_pending" });
    expect(f.stats().creates).toBe(0); expect(f.trace).not.toContain("load");
  });
  it("refuses dirty, unpushed and unverifiable state before create", async () => {
    const states: CursorCloudLocalState[] = [
      { insideGitRepo: true, dirty: true, comparison: "contains_head" } as const,
      { insideGitRepo: true, dirty: false, comparison: "unpushed" } as const,
      { insideGitRepo: "unknown", dirty: "unknown", comparison: "unknown", reasons: [{ code: "repository_detection_failed" }] } as const,
    ];
    for (const state of states) {
      const f = fixture();
      const source = createForegroundCloudSource({ ...f.deps, inspectLocalState: () => state });
      await expect(collect(source(request()))).rejects.toMatchObject({ code: "local_state_not_allowed" });
      expect(f.stats().creates).toBe(0);
    }
  });
  it("uses fresh context by default, bootstrap only on opt-in and refuses never with prior context", async () => {
    const prompt = [{ role: "system", content: "instructions\n<skills>private catalog</skills>\ncursor_ask_question guide" },
      { role: "user", content: "old" }, { role: "assistant", content: "previous" }, { role: "user", content: "new" }];
    const fresh = fixture(); await collect(createForegroundCloudSource(fresh.deps)(request("ses_a", { prompt })));
    expect(fresh.sends).toEqual(["new"]);
    const bootstrap = fixture();
    await collect(createForegroundCloudSource({ ...bootstrap.deps, getConfig: () => ({ user: { runtime: "cloud", cloud: { acknowledged: true, contextHandoff: "bootstrap" } } }) })(request("ses_a", { prompt })));
    expect(bootstrap.sends[0]).toContain("assistant: previous"); expect(bootstrap.sends[0]).toContain("user: old");
    expect(bootstrap.sends[0]).not.toContain("private catalog"); expect(bootstrap.sends[0]).not.toContain("cursor_ask_question");
    const never = fixture();
    await expect(collect(createForegroundCloudSource({ ...never.deps, getConfig: () => ({ user: { runtime: "cloud", cloud: { acknowledged: true, contextHandoff: "never" } } }) })(request("ses_a", { prompt })))).rejects.toMatchObject({ code: "context_handoff_required" });
    expect(never.stats().creates).toBe(0);
  });
  it("writes cleanup intent before action and result after, and archived agents remain deletable", async () => {
    const f = fixture(); const source = createForegroundCloudSource(f.deps); await collect(source(request()));
    f.trace.length = 0;
    await source.cleanup("ses_a", bc, "archive", { confirmed: true });
    await source.cleanup("ses_a", bc, "delete", { confirmed: true });
    expect(f.trace).toEqual(["exists", "load", "write:archive_intent", "archive", "write:archived", "exists", "load", "write:delete_intent", "delete", "write:deleted"]);
    expect((await source.list("ses_a"))[0]?.phase).toBe("deleted");
  });
  it.each(["archive", "archived", "delete", "deleted"])("blocks all retries after unresolved cleanup: %s failure", async failure => {
    const f = fixture(); const source = createForegroundCloudSource(f.deps); await collect(source(request()));
    f.fail(failure); const action = failure.startsWith("archiv") ? "archive" : "delete";
    await expect(source.cleanup("ses_a", bc, action, { confirmed: true })).rejects.toBeInstanceOf(Error);
    await expect(source.cleanup("ses_a", bc, action, { confirmed: true })).rejects.toMatchObject({ code: "cleanup_pending" });
    await expect(collect(source(request()))).rejects.toMatchObject({ code: "cleanup_pending" });
    expect(f.stats().creates).toBe(1);
  });
  it("never calls cleanup when its intent write fails or confirmation is absent", async () => {
    const f = fixture(); const source = createForegroundCloudSource(f.deps); await collect(source(request()));
    await expect(source.cleanup("ses_a", bc, "delete", { confirmed: false })).rejects.toMatchObject({ code: "cloud_confirmation_required" });
    f.fail("delete_intent"); await expect(source.cleanup("ses_a", bc, "delete", { confirmed: true })).rejects.toBeInstanceOf(Error);
    expect(f.trace).not.toContain("delete");
  });
  it("shutdown detaches handles without remote cancellation and refuses later turns", async () => {
    const f = fixture(); const waiting = deferred<RunResult>(); const entered = deferred<void>();
    f.wait(() => { entered.resolve(); return waiting.promise; });
    const source = createForegroundCloudSource(f.deps); const turn = collect(source(request()));
    await entered.promise; await source.shutdown(); await turn;
    expect(f.stats().cancelled).toBe(0); expect(f.stats().closed).toBeGreaterThan(0);
    await expect(collect(source(request("ses_b")))).rejects.toMatchObject({ code: "cloud_shutdown" });
    waiting.resolve({ id: "run-test", status: "finished" });
  });
  it("explicit abort cancels a live run but shutdown does not", async () => {
    const f = fixture(); const entered = deferred<void>(); f.wait(() => { entered.resolve(); return new Promise(() => {}); });
    const abort = new AbortController(); const source = createForegroundCloudSource(f.deps);
    const turn = collect(source(request("ses_a", { abortSignal: abort.signal })));
    await entered.promise; abort.abort();
    await expect(turn).rejects.toMatchObject({ code: "cloud_aborted" }); expect(f.stats().cancelled).toBe(1);
  });
  it("scrubs remote errors and report credentials, omits unsafe URLs and exposes no usage event", async () => {
    const f = fixture(); f.result({ id: "run-test", status: "finished", usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 9 },
      git: { branches: [{ repoUrl: "https://user:secret@example.com/repo", branch: "fake-personal-key\u001b[31mbranch", prUrl: "https://example.com/pr?secret=1" }] } });
    const events = await collect(createForegroundCloudSource(f.deps)(request())); const output = JSON.stringify(events);
    expect(output).not.toContain("fake-personal-key"); expect(output).not.toContain("user:secret"); expect(output).not.toContain("secret=1"); expect(output).not.toContain("\\u001b");
    expect(output).toContain("display only"); expect(events.every(event => !event.type.includes("usage"))).toBe(true);
  });
});


describe("foreground Cloud boundaries", () => {
  it("streams text before a blocked wait and does not replay completed text steps", async () => {
    const f = fixture(); const gate = deferred<RunResult>(); f.wait(() => gate.promise);
    f.activity(async options => {
      await options?.onDelta?.({ update: { type: "text-delta", text: "streamed answer " } });
      await options?.onStep?.({ step: { type: "assistantMessage", message: { text: "streamed answer " } } });
      await options?.onStep?.({ step: { type: "thinkingMessage", message: { text: "reasoning " } } });
    });
    const source = createForegroundCloudSource(f.deps); const iterator = source(request())[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: { type: "text", text: "streamed answer " } });
    gate.resolve({ id: "run-test", status: "finished" }); const rest: CursorTurnEvent[] = [];
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) rest.push(next.value);
    expect(rest).toContainEqual({ type: "thinking", text: "reasoning " });
    expect(rest.some(event => event.type === "text" && event.text.includes("streamed answer"))).toBe(false);
  });
  it("rejects provider forwarding aliases before loading the SDK", async () => {
    const f = fixture();
    await expect(collect(createForegroundCloudSource(f.deps)(request("ses_a", { providerOptions: { cursor: { cloud: { envVars: { SECRET: "not-forwarded" } } } } })))).rejects.toMatchObject({ code: "env_forwarding_not_implemented" });
    expect(f.trace).not.toContain("load"); expect(f.stats().creates).toBe(0);
  });
  it("does not allow ambient environment alone to bypass local-state safety", async () => {
    const f = fixture();
    const source = createForegroundCloudSource({ ...f.deps, getConfig: () => ({ env: { PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE: "1" }, user: { runtime: "cloud", cloud: { acknowledged: true } } }) });
    await expect(collect(source(request()))).rejects.toMatchObject({ code: "cloud_config_invalid" }); expect(f.stats().creates).toBe(0);
  });
  it("accepts explicit user-approved local-state override but still runs the Git probe", async () => {
    const f = fixture(); let probes = 0;
    const source = createForegroundCloudSource({ ...f.deps, getConfig: () => ({ user: { runtime: "cloud", cloud: { acknowledged: true, allowLocalState: true } } }),
      inspectLocalState: () => { probes++; return { insideGitRepo: true, dirty: true, comparison: "unpushed" }; } });
    await collect(source(request())); expect(probes).toBe(1); expect(f.stats().creates).toBe(1);
  });
  it("refuses a malformed or cross-session ledger before any SDK create", async () => {
    const f = fixture();
    const source = createForegroundCloudSource({ ...f.deps, store: { ...f.deps.store, read: async () => ({ version: 1, sessionID: "ses_other", records: [] }) } });
    await expect(collect(source(request()))).rejects.toMatchObject({ code: "ledger_invalid" }); expect(f.stats().creates).toBe(0);
  });
  it("requires validated variant selection and passes the same model on create and send", async () => {
    const f = fixture();
    await expect(collect(createForegroundCloudSource(f.deps)(request("ses_a", { context: { ...request().context, model: { ...request().context.model, variant: "fast" } } })))).rejects.toMatchObject({ code: "cloud_model_selection_required" });
    expect(f.stats().creates).toBe(0);
    const selected = createForegroundCloudSource({ ...f.deps, selection: async () => ({ model: { id: "model", params: [{ id: "speed", value: "fast" }] }, mode: "plan" }) });
    await collect(selected(request("ses_b")));
    expect(f.stats().createOptions).toMatchObject({ model: { id: "model", params: [{ id: "speed", value: "fast" }] }, mode: "plan" });
  });
  it.each(["shutdown", "abort"] as const)("does not create after %s while model selection is pending", async action => {
    const f = fixture();
    const entered = deferred<void>();
    const selection = deferred<{ model: { id: string }; mode: "agent" }>();
    const abort = new AbortController();
    const source = createForegroundCloudSource({ ...f.deps, selection: () => {
      entered.resolve();
      return selection.promise;
    } });
    const turn = collect(source(request("ses_a", { abortSignal: abort.signal })));
    await entered.promise;
    if (action === "shutdown") {
      await source.shutdown();
      await turn;
    } else {
      abort.abort();
      await expect(turn).rejects.toMatchObject({ code: "cloud_aborted" });
    }
    expect(f.stats().creates).toBe(0);
    selection.resolve({ model: { id: "model" }, mode: "agent" });
    // Drain the released selection continuation, including any erroneous create/send.
    await setImmediate();
    expect(f.stats().creates).toBe(0);
    expect(f.sends).toEqual([]);
    expect(f.data.get("ses_a")?.records[0]?.phase).toBe("prepared");
  });
  it("creates and sends normally when deferred selection resolves without interruption", async () => {
    const f = fixture();
    const entered = deferred<void>();
    const selection = deferred<{ model: { id: string }; mode: "agent" }>();
    const source = createForegroundCloudSource({ ...f.deps, selection: () => {
      entered.resolve();
      return selection.promise;
    } });
    const turn = collect(source(request()));
    await entered.promise;
    expect(f.stats().creates).toBe(0);
    selection.resolve({ model: { id: "model" }, mode: "agent" });
    await turn;
    expect(f.stats().creates).toBe(1);
    expect(f.sends).toEqual(["hello"]);
    expect(f.data.get("ses_a")?.records[0]?.phase).toBe("finished");
  });
  it("shutdown during pending send still records its run ID without cancelling it", async () => {
    const f = fixture(); const send = deferred<void>(); f.sendGate(send.promise);
    const source = createForegroundCloudSource(f.deps);
    const turn = collect(source(request())); await f.sendStarted;
    await source.shutdown(); send.resolve(); await turn; await f.runRecorded;
    expect(f.stats().cancelled).toBe(0);
    expect(f.data.get("ses_a")?.records[0]?.phase).toBe("running");
  });
});
