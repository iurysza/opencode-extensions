import type { AgentOptions, LocalAgentStore, RunResult, SendOptions } from "@cursor/sdk";
import { describe, expect, it, vi } from "vitest";
import { createLocalRuntime, type LocalSdkPort } from "../../src/provider/local-runtime.js";
import type { CursorTurnEvent, CursorTurnRequest } from "../../src/core/turn-events.js";

const KEY = "fake-local-stream-key-0123";
const prompt = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
const request = (signal?: AbortSignal): CursorTurnRequest => ({ modelId: "fake", context: { sessionID: "ses_security", kind: "primary", agent: "build", model: { id: "fake", providerID: "cursor" } }, prompt, abortSignal: signal });
const collect = async (source: AsyncIterable<CursorTurnEvent>, output: CursorTurnEvent[] = []) => { for await (const event of source) output.push(event); return output; };
const visible = (events: CursorTurnEvent[]) => events.flatMap((event) => event.type === "text" || event.type === "thinking" ? [event.text] : []).join("");
const delta = async (options: SendOptions, type: "text-delta" | "thinking-delta", text: string) => options.onDelta?.({ update: { type, text } });
const step = async (options: SendOptions, text: string) => options.onStep?.({ step: { type: "assistantMessage", message: { text } } });
const finished = (result = ""): RunResult => ({ id: "run-security", status: "finished", result });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function harness(drive: (options: SendOptions, turn: number) => Promise<RunResult>) {
  let turn = 0;
  const close = vi.fn();
  const disposeStore = vi.fn(async () => {});
  const send = vi.fn(async (_text: string, options: SendOptions) => {
    const result = drive(options, turn++);
    void result.catch(() => {});
    return { wait: () => result, cancel: async () => {} };
  });
  const port: LocalSdkPort = {
    models: async () => [{ id: "fake", displayName: "Fake" }],
    openStore: async () => ({ store: {} as LocalAgentStore, dispose: disposeStore }),
    create: async () => ({ send, close }),
  };
  const runtime = createLocalRuntime({ cwd: "/fake", stateRoot: "/fake/state", getApiKey: async () => KEY, inspectSession: async () => ({ info: { id: "ses_security" }, messages: [] }), loadSdk: async () => port });
  return { ...runtime, close, disposeStore, send };
}

describe("local per-run credential redaction", () => {
  it.each(["text-delta", "thinking-delta"] as const)("redacts every two-callback split in %s, including empty final results and cumulative echoes", async (type) => {
    for (const echo of [false, true]) for (let cut = 0; cut <= KEY.length; cut++) {
      const text = `ordinary ${KEY} tail.`;
      const f = harness(async (options) => {
        await delta(options, type, `ordinary ${KEY.slice(0, cut)}`);
        await delta(options, type, `${KEY.slice(cut)} tail.`);
        if (type === "text-delta") await step(options, text);
        return finished(echo && type === "text-delta" ? text : "");
      });
      try {
        const output = await collect(f.source(request()));
        expect(visible(output), `cut=${cut}, echo=${echo}`).toBe("ordinary [redacted] tail.");
        expect(JSON.stringify(output)).not.toContain(KEY);
      } finally { await f.controls.dispose(); }
    }
  });
  it("redacts one-character callbacks and a key crossing text/reasoning channels", async () => {
    const f = harness(async (options) => {
      for (let index = 0; index < KEY.length; index++) await delta(options, index % 2 ? "thinking-delta" : "text-delta", KEY[index]!);
      return finished();
    });
    try { expect(visible(await collect(f.source(request())))).toBe("[redacted]"); }
    finally { await f.controls.dispose(); }
  });
  it("preserves ordinary prefix mismatches without losing characters", async () => {
    const f = harness(async (options) => {
      for (const text of ["ordinary ", "fake-local-", "not-the-key", " text."]) await delta(options, "text-delta", text);
      return finished();
    });
    try { expect(visible(await collect(f.source(request())))).toBe("ordinary fake-local-not-the-key text."); }
    finally { await f.controls.dispose(); }
  });
  it("flushes incomplete prefixes safely before errors and never emits raw SDK errors", async () => {
    for (let cut = 1; cut < KEY.length; cut++) {
      const f = harness(async (options) => {
        await delta(options, "text-delta", `ordinary ${KEY.slice(0, cut)}`);
        throw new Error(`network failure ${KEY} Bearer ${KEY}`);
      });
      const output: CursorTurnEvent[] = [];
      try {
        await expect(collect(f.source(request()), output)).rejects.toMatchObject({ code: "network", message: "Cursor transport failed. Retry the turn." });
        expect(visible(output)).toBe("ordinary [redacted]");
        expect(JSON.stringify(output)).not.toContain(KEY);
      } finally { await f.controls.dispose(); }
    }
  });
  it("flushes replacements and keeps fallback text inside the same redactor", async () => {
    const f = harness(async (options) => {
      await delta(options, "text-delta", KEY.slice(0, 7));
      await step(options, `replacement ${KEY}`);
      // A cumulative final may legitimately complete a preceding delta prefix.
      return finished(`${KEY} tail.`);
    });
    try {
      const output = await collect(f.source(request()));
      expect(visible(output)).not.toContain(KEY);
      expect(visible(output)).toContain("[redacted]");
    } finally { await f.controls.dispose(); }
  });
  it("redacts a step-only and final-only complete key", async () => {
    for (const useStep of [false, true]) {
      const f = harness(async (options) => { if (useStep) await step(options, `ordinary ${KEY} tail.`); return finished(`ordinary ${KEY} tail.`); });
      try { expect(visible(await collect(f.source(request())))).toBe("ordinary [redacted] tail."); }
      finally { await f.controls.dispose(); }
    }
  });
  it("does not join an incomplete prefix with a followup or reset run suffix", async () => {
    for (const reset of [false, true]) for (let cut = 1; cut < KEY.length; cut++) {
      const f = harness(async (options, turn) => {
        await delta(options, "text-delta", turn === 0 ? KEY.slice(0, cut) : KEY.slice(cut));
        return finished();
      });
      try {
        const first = await collect(f.source(request()));
        if (reset) await f.controls.reset("ses_security");
        const next = await collect(f.source({ ...request(), prompt: [...prompt, { role: "user", content: [{ type: "text", text: "followup" }] }] }));
        expect(visible([...first, ...next])).not.toContain(KEY);
        expect(visible(first)).toBe("[redacted]");
      } finally { await f.controls.dispose(); }
    }
  });
  it.each(["abort", "reset", "dispose"] as const)("flushes a live prefix on %s and ignores late run callbacks", async (stop) => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const controller = new AbortController();
    const f = harness(async (options) => {
      await delta(options, "thinking-delta", KEY.slice(0, 8));
      entered.resolve();
      await release.promise;
      await delta(options, "thinking-delta", KEY.slice(8));
      await step(options, KEY);
      return finished(KEY);
    });
    const output: CursorTurnEvent[] = [];
    const pending = collect(f.source(request(controller.signal)), output).then(() => undefined, (error: unknown) => error);
    await entered.promise;
    if (stop === "abort") controller.abort();
    else if (stop === "reset") await f.controls.reset("ses_security");
    else await f.controls.dispose();
    expect(await pending).toMatchObject({ code: "abort" });
    release.resolve();
    await Promise.resolve();
    await f.controls.dispose();
    expect(visible(output)).toBe("[redacted]");
    expect(JSON.stringify(output)).not.toContain(KEY);
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.disposeStore).toHaveBeenCalledOnce();
  });
  it("scrubs native names, argument/property names and results without JSON string replacement", async () => {
    const f = harness(async (options) => {
      await options.onDelta?.({ update: { type: "tool-call-completed", callId: KEY, toolCall: {
        type: `read_${KEY}`, args: { [KEY]: KEY, nested: [KEY] }, result: { status: "error", error: { message: `error ${KEY}`, authorization: `Bearer ${KEY}` } },
      } } } as never);
      return finished();
    });
    try {
      const output = await collect(f.source(request()));
      expect(JSON.stringify(output)).not.toContain(KEY);
      expect(output.find((event) => event.type === "native-tool-call")).toMatchObject({ toolName: "cursor_read__redacted_" });
    } finally { await f.controls.dispose(); }
  });
  it("flushes every possible prefix before bridge splits and drains the same run", async () => {
    for (let cut = 1; cut < KEY.length; cut++) {
      const f = harness(async (options) => {
        await delta(options, "text-delta", KEY.slice(0, cut));
        const server = Object.values(options.mcpServers ?? {})[0] as { url: string };
        const rpc = async (method: string, params?: unknown) => {
          const response = await fetch(server.url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
          return (await response.json() as { result: unknown }).result;
        };
        const list = await rpc("tools/list") as { tools: { name: string }[] };
        await rpc("tools/call", { name: list.tools[0]!.name, arguments: { secret: KEY } });
        await delta(options, "text-delta", KEY.slice(cut));
        return finished();
      });
      try {
        const first = await collect(f.source({ ...request(), tools: [{ type: "function", name: "probe", inputSchema: { type: "object" } }] }));
        const call = first.find((event) => event.type === "bridge-tool-call");
        if (!call || call.type !== "bridge-tool-call") throw new Error("Missing bridge call");
        const next = await collect(f.source({ ...request(), prompt: [...prompt, { role: "tool", content: [{ type: "tool-result", toolCallId: call.callId, toolName: call.toolName, output: { type: "text", value: "" } }] }] }));
        expect(visible([...first, ...next])).not.toContain(KEY);
        expect(visible(first)).toBe("[redacted]");
        expect(JSON.stringify(first)).not.toContain(KEY);
        expect(call.input).toEqual({ secret: "[redacted]" });
        expect(f.send).toHaveBeenCalledTimes(1);
      } finally { await f.controls.dispose(); }
    }
  });
});

const phases = ["key", "inspect", "sdk", "models", "store", "create"] as const;
describe("local acquisition shutdown and abort races", () => {
  it.each(phases)("refuses a late %s acquisition after dispose or abort", async (phase) => {
    for (const stop of ["dispose", "abort"] as const) {
      const entered = deferred<void>();
      const release = deferred<void>();
      const block = async (at: typeof phases[number]) => { if (phase === at) { entered.resolve(); await release.promise; } };
      const close = vi.fn();
      const disposeStore = vi.fn(async () => {});
      const send = vi.fn(async () => ({ wait: async () => finished(), cancel: async () => {} }));
      const create = vi.fn(async (_options: AgentOptions) => { await block("create"); return { send, close }; });
      const port: LocalSdkPort = {
        models: async () => { await block("models"); return [{ id: "fake", displayName: "Fake" }]; },
        openStore: async () => { await block("store"); return { store: {} as LocalAgentStore, dispose: disposeStore }; },
        create,
      };
      const controller = new AbortController();
      const f = createLocalRuntime({ cwd: "/fake", stateRoot: "/fake/state", getApiKey: async () => { await block("key"); return KEY; }, inspectSession: async () => { await block("inspect"); return { info: { id: "ses_security" }, messages: [] }; }, loadSdk: async () => { await block("sdk"); return port; } });
      const pending = collect(f.source({ ...request(controller.signal), tools: [{ type: "function", name: "probe", inputSchema: { type: "object" } }] })).then(() => undefined, (error: unknown) => error);
      await entered.promise;
      if (stop === "dispose") await f.controls.dispose(); else controller.abort();
      expect(f.controls.status("ses_security").active).toBe(false);
      expect(send).not.toHaveBeenCalled();
      if (phase === "create") {
        const endpoint = Object.values(create.mock.calls[0]![0].mcpServers ?? {})[0] as { url: string };
        const status = await fetch(endpoint.url, { method: "POST", body: "{}" }).then((response) => response.status, () => 0);
        expect([0, 410]).toContain(status);
      }
      release.resolve();
      const error = await pending;
      expect(error).toMatchObject({ code: stop === "abort" ? "abort" : "failed" });
      expect(create).toHaveBeenCalledTimes(phase === "create" ? 1 : 0);
      expect(send).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(phase === "create" ? 1 : 0);
      expect(disposeStore).toHaveBeenCalledTimes(phase === "store" || phase === "create" ? 1 : 0);
      expect(f.controls.status("ses_security").active).toBe(false);
      if (phase === "create") {
        const endpoint = Object.values(create.mock.calls[0]![0].mcpServers ?? {})[0] as { url: string };
        await expect(fetch(endpoint.url, { method: "POST", body: "{}" })).rejects.toThrow();
      }
      await f.controls.dispose();
    }
  });
});
