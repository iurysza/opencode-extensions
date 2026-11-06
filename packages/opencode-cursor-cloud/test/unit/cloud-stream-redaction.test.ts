import { expect, it } from "vitest";
import type { RunResult, SendOptions } from "@cursor/sdk";
import { createCloudClient, type SdkLoader } from "../../src/core/cloud-client.js";
import { createCloudService, type CloudResponse } from "../../src/core/cloud-service.js";
import { createReceiptService } from "../../src/core/receipts.js";
import { sessionHost } from "../../src/plugin/completion.js";
import { cleanText } from "../../src/core/render.js";
import { deferred, until } from "./cloud-fakes.js";
import { fakeHost, ids, memoryStore } from "./fake-host.js";

// Synthetic fixture key only. No environment credentials or real SDK module is read.
const KEY = "synthetic-stream-key-not-a-credential";
const emptyResult = { id: "unused", status: "finished", result: "", durationMs: 1 } as RunResult;
function rig() {
  const host = fakeHost(); host.addSession("s1");
  const memory = memoryStore();
  const receipts = createReceiptService({ store: memory.store, host: sessionHost(host.session), mint: ids() });
  const runs: { options: SendOptions; done: ReturnType<typeof deferred<RunResult>> }[] = [];
  let rejectSend = false;
  const sdk = { Agent: { create: async () => ({
    agentId: "bc-stream-test", close() {},
    async send(_prompt: string, options: SendOptions) {
      const done = deferred<RunResult>();
      runs.push({ options, done });
      if (rejectSend) {
        options.onDelta?.({ update: { type: "text-delta", text: KEY.slice(0, 7) } } as Parameters<NonNullable<SendOptions["onDelta"]>>[0]);
        options.onDelta?.({ update: { type: "text-delta", text: `${KEY.slice(7)} send failed s` } } as Parameters<NonNullable<SendOptions["onDelta"]>>[0]);
        throw new Error("synthetic send failure");
      }
      return { id: `run-${runs.length}`, wait: () => done.promise, cancel: async () => {} };
    },
  }) } };
  // Test-only partial public SDK implementation; the production loader is never invoked.
  const client = createCloudClient(async () => KEY, (async () => sdk) as unknown as SdkLoader);
  const service = createCloudService({ client, receipts, location: { directory: "/fake" }, repo: async () => ({ repo: "https://github.com/o/r", ref: "main" }) });
  const delta = (text: string, index = 0) => runs[index]!.options.onDelta?.({ update: { type: "text-delta", text } } as Parameters<NonNullable<SendOptions["onDelta"]>>[0]);
  const replace = (text: string, index = 0) => runs[index]!.options.onStep?.({ step: { type: "assistantMessage", message: { text } } } as Parameters<NonNullable<SendOptions["onStep"]>>[0]);
  const state = async () => {
    const result: CloudResponse = await service.status("s1");
    if (result._tag !== "ok") throw new Error("status unexpectedly refused");
    expect(JSON.stringify(result).includes(KEY)).toBe(false);
    expect(cleanText(JSON.stringify(result)).includes(KEY)).toBe(false);
    return result.value.agents[0]!;
  };
  const spawn = async () => {
    expect((await service.spawn("s1", { prompt: "fixture task" }))._tag).toBe("ok");
    await until(() => runs.length === 1);
  };
  const terminal = async (index = 0, result = emptyResult) => {
    runs[index]!.done.resolve(result);
    await until(() => host.calls.length === index + 1);
    expect(JSON.stringify([...memory.data.values()]).includes(KEY)).toBe(false);
    expect(JSON.stringify(host.calls).includes(KEY)).toBe(false);
    return state();
  };
  return { service, client, runs, delta, replace, state, spawn, terminal, host, memory, rejectSend: () => { rejectSend = true; } };
}

for (let split = 1; split < KEY.length; split++) it(`sanitizes split boundary ${split} before live status and durable empty-result fallback`, async () => {
  const r = rig(); await r.spawn();
  r.delta(`useful progress: ${KEY.slice(0, split)}`);
  expect((await r.state()).text).toBe("useful progress: ");
  r.delta(KEY.slice(split));
  expect((await r.state()).text).toBe("useful progress: [redacted]");
  r.delta(" done.");
  const terminal = await r.terminal();
  expect(terminal.status).toMatchObject({ type: "idle", result: { text: "useful progress: [redacted] done." } });
  expect(r.host.calls[0]?.text.includes("useful progress: [redacted] done.")).toBe(true);
  await r.service.dispose();
});

it("streams normal text promptly, handles one-character chunks, and flushes a harmless trailing prefix at completion", async () => {
  const r = rig(); await r.spawn();
  r.delta("normal progress."); expect((await r.state()).text).toBe("normal progress.");
  for (const char of KEY) { r.delta(char); await r.state(); }
  expect((await r.state()).text).toBe("normal progress.[redacted]");
  r.delta(" ends with s");
  expect((await r.state()).text).toBe("normal progress.[redacted] ends with ");
  expect((await r.terminal()).status).toMatchObject({ result: { text: "normal progress.[redacted] ends with s" } });
  r.delta(KEY); expect((await r.state()).text).toBe("normal progress.[redacted] ends with s");
  await r.service.dispose();
});

for (let split = 1; split < KEY.length; split++) it(`replacement resets pending text and protects its suffix at boundary ${split}`, async () => {
  const r = rig(); await r.spawn();
  r.delta(`discarded ${KEY.slice(0, split)}`);
  r.replace(`replacement ${KEY.slice(0, split)}`);
  expect((await r.state()).text).toBe("replacement ");
  r.delta(`${KEY.slice(split)} retained.`);
  expect((await r.state()).text).toBe("replacement [redacted] retained.");
  expect((await r.terminal()).status).toMatchObject({ result: { text: "replacement [redacted] retained." } });
  await r.service.dispose();
});

it("flushes on wait failure before service fallback, with no key in failed receipt metadata", async () => {
  const r = rig(); await r.spawn();
  r.delta(KEY.slice(0, 9)); r.delta(`${KEY.slice(9)} failed after progress s`);
  await r.state();
  r.runs[0]!.done.reject(new Error("synthetic wait failure"));
  await until(() => r.host.calls.length === 1);
  expect((await r.state()).status).toMatchObject({ type: "failed", result: { text: "[redacted] failed after progress s" } });
  expect(JSON.stringify([...r.memory.data.values()]).includes(KEY)).toBe(false);
  await r.service.dispose();
});

for (let split = 1; split < KEY.length; split++) it(`flushes cancellation and resets the follow-up sanitizer at boundary ${split}`, async () => {
  const r = rig(); await r.spawn();
  r.delta(`${KEY.slice(0, split)}`); r.delta(`${KEY.slice(split)} progress s`);
  expect((await r.service.cancel("s1", "stream-test"))._tag).toBe("ok");
  await r.state();
  await r.terminal(0, { ...emptyResult, status: "cancelled" });
  expect((await r.state()).text).toBe("[redacted] progress s");
  expect((await r.service.send("s1", "stream-test", "follow-up"))._tag).toBe("ok");
  await until(() => r.runs.length === 2);
  r.delta("fresh ", 1); r.delta(KEY.slice(0, split), 1); await r.state();
  r.delta(`${KEY.slice(split)} output.`, 1);
  expect((await r.state()).text).toBe("fresh [redacted] output.");
  expect((await r.terminal(1)).status).toMatchObject({ result: { text: "fresh [redacted] output." } });
  await r.service.dispose();
});

it("discards a replaced prefix, preserves tool progress, and does not join prefixes across snapshots", async () => {
  const r = rig(); await r.spawn();
  r.delta(`old ${KEY.slice(0, 8)}`);
  r.runs[0]!.options.onDelta?.({ update: { type: "tool-call-started", callId: "tool-one", toolCall: { type: "shell", args: { command: `echo ${KEY}` } } } } as Parameters<NonNullable<SendOptions["onDelta"]>>[0]);
  const progress = await r.state();
  expect(progress.text).toBe("old "); expect(progress.tools).toBe(1);
  expect(progress.activity).toBe("run_terminal_cmd: echo [redacted]");
  r.replace(""); expect((await r.state()).text).toBe("");
  r.delta(KEY.slice(8));
  expect((await r.state()).text).toBe(KEY.slice(8));
  r.replace(`final ${KEY}`);
  expect((await r.terminal()).status).toMatchObject({ result: { text: "final [redacted]" } });
  await r.service.dispose();
});

it("flushes before failed-send fallback without persisting a split key", async () => {
  const r = rig(); r.rejectSend(); await r.spawn();
  await until(() => r.host.calls.length === 1);
  expect((await r.state()).status).toMatchObject({ type: "failed", result: { text: "[redacted] send failed s" } });
  expect(JSON.stringify([...r.memory.data.values()]).includes(KEY)).toBe(false);
  await r.service.dispose();
});

it("close flushes a bounded ordinary tail once and seals all late callbacks", async () => {
  const r = rig();
  const handle = await r.client.create({ repo: "https://github.com/o/r", ref: "main", model: "m", name: "fixture" });
  let text = "";
  const run = await handle.send("fixture task", event => {
    if (event.activity.type === "text") text = event.activity.replace ? event.activity.text : text + event.activity.text;
    expect(text.includes(KEY)).toBe(false);
  });
  r.delta(KEY.slice(0, 12)); r.delta(`${KEY.slice(12)} ordinary s`);
  expect(text).toBe("[redacted] ordinary ");
  handle.close(); expect(text).toBe("[redacted] ordinary s");
  r.delta(KEY); r.replace(KEY); handle.close();
  expect(text).toBe("[redacted] ordinary s");
  r.runs[0]!.done.resolve(emptyResult); await run.wait();
  expect(text).toBe("[redacted] ordinary s");
  await r.service.dispose();
});

const removedControls = Array.from({ length: 160 }, (_, index) => String.fromCharCode(index))
  .filter(char => cleanText(char) === "").join("");
for (let split = 1; split < KEY.length; split++) it(`normalizes terminal separators before matching key boundary ${split}`, async () => {
  for (const separator of ["\x1b[31m", "\x1b[?25l", "\x1b[0 q", removedControls]) {
    const r = rig(); await r.spawn();
    r.delta(`progress ${KEY.slice(0, split)}${separator}`);
    expect((await r.state()).text).toBe("progress ");
    r.delta(KEY.slice(split));
    expect((await r.state()).text).toBe("progress [redacted]");
    expect((await r.terminal()).status).toMatchObject({ result: { text: "progress [redacted]" } });
    expect(r.host.calls[0]?.text.includes("progress [redacted]")).toBe(true);
    await r.service.dispose();
  }
});

for (let split = 1; split < KEY.length; split++) it(`handles every ANSI callback boundary inside key boundary ${split}`, async () => {
  const ansi = "\x1b[31m";
  for (let at = 1; at < ansi.length; at++) {
    const r = rig(); await r.spawn();
    r.delta(`progress ${KEY.slice(0, split)}${ansi.slice(0, at)}`);
    expect((await r.state()).text).toBe("progress ");
    r.delta(ansi.slice(at));
    expect((await r.state()).text).toBe("progress ");
    r.delta(KEY.slice(split));
    expect((await r.state()).text).toBe("progress [redacted]");
    expect((await r.terminal()).status).toMatchObject({ result: { text: "progress [redacted]" } });
    await r.service.dispose();
  }
});

it("normalizes a character-at-a-time escape stream and never exposes reconstructable text", async () => {
  const r = rig(); await r.spawn();
  for (const char of `normal ${KEY.slice(0, 9)}\x1b[31m${KEY.slice(9)} done.`) {
    r.delta(char); const state = await r.state();
    expect(cleanText(state.text).includes(KEY)).toBe(false);
  }
  expect((await r.terminal()).status).toMatchObject({ result: { text: "normal [redacted] done." } });
  await r.service.dispose();
});

it("cleans and re-redacts terminal SDK results and branch metadata before receipt persistence", async () => {
  const r = rig(); await r.spawn();
  const disguised = `${KEY.slice(0, 12)}\x1b[31m${KEY.slice(12)}`;
  const terminal = await r.terminal(0, { ...emptyResult, result: disguised, git: { branches: [{ repoUrl: disguised, branch: disguised, prUrl: disguised }] } });
  expect(terminal.status).toMatchObject({ result: { text: "[redacted]", branches: [{ repoUrl: "[redacted]", branch: "[redacted]", prUrl: "[redacted]" }] } });
  await r.service.dispose();
});

it("replaces and resets partial terminal escapes without inheriting them into the next run", async () => {
  const r = rig(); await r.spawn();
  r.delta(`discard ${KEY.slice(0, 7)}\x1b[31`);
  r.replace(`replacement ${KEY.slice(0, 11)}\x1b`);
  r.delta(`[31m${KEY.slice(11)} done.`);
  expect((await r.terminal()).status).toMatchObject({ result: { text: "replacement [redacted] done." } });
  expect((await r.service.send("s1", "stream-test", "next fixture task"))._tag).toBe("ok");
  await until(() => r.runs.length === 2);
  r.delta("normal [31m text.", 1);
  expect((await r.terminal(1)).status).toMatchObject({ result: { text: "normal [31m text." } });
  await r.service.dispose();
});

it("flushes incomplete ESC tails through normalization before the final known-key pass", async () => {
  for (const tail of ["\x1b", "\x1b[", "\x1b[31", "\x1b[0 "]) {
    const r = rig(); await r.spawn();
    r.delta(`normal ${KEY.slice(0, 7)}\x1b[31m${KEY.slice(7)} trailing${tail}`);
    expect((await r.state()).text).toBe("normal [redacted] trailing");
    expect((await r.terminal()).status).toMatchObject({ result: { text: `normal [redacted] trailing${cleanText(tail)}` } });
    await r.service.dispose();
  }
});

it("normalizes tool activity before redaction and bounds unterminated ANSI buffering", async () => {
  const r = rig(); await r.spawn();
  const disguised = `${KEY.slice(0, 6)}\x1b[31m${KEY.slice(6)}`;
  r.runs[0]!.options.onDelta?.({ update: { type: "tool-call-started", callId: "normalized-tool", toolCall: { type: "shell", args: { command: disguised } } } } as Parameters<NonNullable<SendOptions["onDelta"]>>[0]);
  expect((await r.state()).activity).toBe("run_terminal_cmd: [redacted]");
  r.delta("normal progress."); expect((await r.state()).text).toBe("normal progress.");
  r.delta(`\x1b[${"1".repeat(4096)}`);
  expect((await r.state()).text).toBe("normal progress.[terminal sequence omitted]");
  r.delta("m normal resumed.");
  expect((await r.terminal()).status).toMatchObject({ result: { text: "normal progress.[terminal sequence omitted]m normal resumed." } });
  await r.service.dispose();
});

it("normalizes before failed-wait fallback and preserves renderer-stable text", async () => {
  const r = rig(); await r.spawn();
  r.delta(`progress ${KEY.slice(0, 10)}\x1b[`);
  r.delta(`31m${KEY.slice(10)} done\x1b`);
  r.runs[0]!.done.reject(new Error("synthetic normalized wait failure"));
  await until(() => r.host.calls.length === 1);
  const state = await r.state();
  expect(state.status).toMatchObject({ type: "failed", result: { text: "progress [redacted] done" } });
  expect(state.text).toBe(cleanText(state.text));
  expect(JSON.stringify([...r.memory.data.values()]).includes(KEY)).toBe(false);
  await r.service.dispose();
});
