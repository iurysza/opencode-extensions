// F-14/F-16/F-17 unit invariants. Hand-written host events: NOT real-host proof (see test/req).
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { readRequestStamp, STAMP_HEADER, stampModelRequest } from "../../src/compat/request-stamp.js";
import { REQUEST_KINDS, type RequestKind } from "../../src/core/request-context.js";
import { HelperLaneUnavailableError, type TurnLanes } from "../../src/core/lanes.js";
import type { CursorTurnRequest, CursorTurnSource } from "../../src/core/turn-events.js";
import { codingOnly, createLanguageModel, PROVIDER_ID, UnstampedRequestError } from "../../src/provider/language-model.js";

const event = (over: Record<string, unknown> = {}) => ({
  sessionID: "ses_a",
  agent: "build",
  model: { providerID: PROVIDER_ID, id: "fake" },
  kind: "primary",
  headers: { "X-Session-Id": "ses_spoof", "x-session-affinity": "ses_spoof" } as Record<string, string>,
  ...over,
});

function recorder() {
  const calls: CursorTurnRequest[] = [];
  const source: CursorTurnSource = (request) => {
    calls.push(request);
    return (async function* () {
      yield { type: "text", text: "ok" } as const;
      yield { type: "done", reason: "stop" } as const;
    })();
  };
  return { calls, source };
}

const testLanes = (source: CursorTurnSource): TurnLanes => ({ coding: source, helper: { _tag: "test-only", source } });

async function stream(lanes: TurnLanes, headers: Record<string, string | undefined> | undefined, abortSignal?: AbortSignal) {
  const model = createLanguageModel("fake", lanes, "plugin-hook");
  const result = await model.doStream({ prompt: [], headers, abortSignal } as LanguageModelV3CallOptions);
  const reader = result.stream.getReader();
  const parts: string[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) return parts;
    parts.push(next.value.type);
  }
}

const stamped = (over: Record<string, unknown> = {}) => {
  const e = event(over);
  stampModelRequest(e, PROVIDER_ID);
  return e.headers;
};

describe("model.request stamping (F-14)", () => {
  it("overwrites a spoofed stamp, keeps host headers, never trusts X-Session-Id", () => {
    const headers = stamped({
      headers: { "X-Session-Id": "ses_spoof", [STAMP_HEADER.toUpperCase()]: '{"v":1,"kind":"primary","sessionID":"ses_spoof"}' },
    });
    expect(Object.keys(headers).filter((k) => k.toLowerCase() === STAMP_HEADER)).toEqual([STAMP_HEADER]);
    expect(headers["X-Session-Id"]).toBe("ses_spoof");
    const read = readRequestStamp(headers);
    expect(read._tag === "ok" && read.value).toEqual({ kind: "primary", sessionID: "ses_a", agent: "build", model: { providerID: "cursor", id: "fake" } });
  });

  it("leaves a foreign provider request untouched, including a forged stamp", () => {
    const e = event({ model: { providerID: "openai", id: "gpt" }, headers: { a: "1", [STAMP_HEADER]: "forged" } });
    const before = structuredClone(e);
    stampModelRequest(e, PROVIDER_ID);
    expect(e).toEqual(before);
  });

  it.each(REQUEST_KINDS)("stamps kind %s", (kind) => {
    const read = readRequestStamp(stamped({ kind }));
    expect(read._tag === "ok" && read.value.kind).toBe(kind);
  });

  it("keeps one session stamp across turns and separates sessions", () => {
    const a1 = readRequestStamp(stamped());
    const a2 = readRequestStamp(stamped({ model: { providerID: PROVIDER_ID, id: "other", variant: "high" } }));
    const b = readRequestStamp(stamped({ sessionID: "ses_b" }));
    expect([a1, a2, b].map((r) => r._tag === "ok" && r.value.sessionID)).toEqual(["ses_a", "ses_a", "ses_b"]);
    expect(a2._tag === "ok" && a2.value.model).toEqual({ providerID: "cursor", id: "other", variant: "high" });
  });

  it("writes no stamp for an unknown or missing kind, and strips a stale one", () => {
    for (const kind of ["summarize", undefined, 3]) {
      const headers = stamped({ kind, headers: { [STAMP_HEADER]: "stale" } });
      expect(headers[STAMP_HEADER]).toBeUndefined();
    }
  });
});

describe("provider rejects unidentified requests before any source runs (F-17)", () => {
  const valid = JSON.parse(stamped()[STAMP_HEADER] as string);
  it.each([
    ["no headers", undefined, "missing"],
    ["only X-Session-Id", { "X-Session-Id": "ses_a" }, "missing"],
    ["non-JSON", { [STAMP_HEADER]: "{" }, "malformed"],
    ["wrong version", { [STAMP_HEADER]: JSON.stringify({ ...valid, v: 2 }) }, "malformed"],
    ["no kind", { [STAMP_HEADER]: JSON.stringify({ ...valid, kind: undefined }) }, "malformed"],
    ["unknown kind", { [STAMP_HEADER]: JSON.stringify({ ...valid, kind: "summarize" }) }, "unknown-kind"],
    ["no session", { [STAMP_HEADER]: JSON.stringify({ ...valid, sessionID: "" }) }, "malformed"],
    ["duplicate", { [STAMP_HEADER]: JSON.stringify(valid), [STAMP_HEADER.toUpperCase()]: JSON.stringify(valid) }, "duplicate"],
  ] as const)("%s", async (_label, headers, reason) => {
    const { calls, source } = recorder();
    const error = await stream(testLanes(source), headers as Record<string, string> | undefined).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnstampedRequestError);
    expect((error as UnstampedRequestError).reason).toBe(reason);
    expect((error as Error).message).not.toContain("ses_");
    expect(calls).toEqual([]);
  });

  it("does not infer purpose from an empty tool list", async () => {
    const { calls, source } = recorder();
    const model = createLanguageModel("fake", testLanes(source), "plugin-hook");
    await expect(model.doStream({ prompt: [], tools: [] } as LanguageModelV3CallOptions)).rejects.toBeInstanceOf(UnstampedRequestError);
    expect(calls).toEqual([]);
  });

  it("an already aborted request starts no source", async () => {
    const { calls, source } = recorder();
    const abort = new AbortController();
    abort.abort();
    await expect(stream(testLanes(source), stamped(), abort.signal)).rejects.toMatchObject({ code: "cursor-request-aborted" });
    expect(calls).toEqual([]);
  });
});

describe("request lanes (F-16)", () => {
  it.each(REQUEST_KINDS.filter((k) => k !== "primary"))("production lanes refuse %s before the coding source", async (kind) => {
    const { calls, source } = recorder();
    const error = await stream(codingOnly(source), stamped({ kind })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HelperLaneUnavailableError);
    expect(calls).toEqual([]);
  });

  it("production lanes run primary on the coding source with the parsed context", async () => {
    const { calls, source } = recorder();
    expect(await stream(codingOnly(source), stamped())).toContain("finish");
    expect(calls.map((c) => c.context)).toEqual([{ kind: "primary", sessionID: "ses_a", agent: "build", model: { providerID: "cursor", id: "fake" } }]);
  });

  it("test-only helper lane gets helper kinds; coding source never does", async () => {
    const coding = recorder();
    const helper = recorder();
    const lanes: TurnLanes = { coding: coding.source, helper: { _tag: "test-only", source: helper.source } };
    for (const kind of REQUEST_KINDS) await stream(lanes, stamped({ kind }));
    expect(coding.calls.map((c) => c.context.kind)).toEqual(["primary"]);
    expect(helper.calls.map((c) => c.context.kind as RequestKind)).toEqual(["title", "compaction", "generate"]);
  });
});
