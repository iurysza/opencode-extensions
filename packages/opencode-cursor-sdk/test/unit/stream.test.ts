import { describe, expect, it } from "vitest";
import { translateTurn, type StreamPart } from "../../src/core/stream.js";
import type { CursorTurnEvent } from "../../src/core/turn-events.js";
import { createCursor } from "../../src/provider/factory.js";

async function collect(events: CursorTurnEvent[] | (() => AsyncIterable<CursorTurnEvent>)): Promise<StreamPart[]> {
  const source = typeof events === "function" ? events() : (async function* () { yield* events; })();
  const parts: StreamPart[] = [];
  for await (const part of translateTurn(source)) parts.push(part);
  return parts;
}

const types = (parts: StreamPart[]) => parts.map((p) => p.type);

describe("translateTurn", () => {
  it("emits a provider-executed call, its single result and one finish", async () => {
    const parts = await collect([
      { type: "text", text: "a" },
      { type: "native-tool-call", callId: "c1", toolName: "write", input: { path: "x", content: "y" } },
      { type: "native-tool-result", callId: "c1", toolName: "write", result: "ok" },
      { type: "text", text: "b" },
      { type: "done", reason: "stop" },
    ]);
    expect(types(parts)).toEqual([
      "stream-start", "text-start", "text-delta", "text-end",
      "tool-input-start", "tool-input-delta", "tool-input-end", "tool-call", "tool-result",
      "text-start", "text-delta", "text-end", "finish",
    ]);
    expect(parts.find((p) => p.type === "tool-call")).toMatchObject({ providerExecuted: true, input: '{"path":"x","content":"y"}' });
    expect(parts.filter((p) => p.type === "finish")).toHaveLength(1);
  });

  it.each([
    ["result-without-call", [{ type: "native-tool-result", callId: "x", toolName: "t", result: 1 }]],
    ["duplicate-result", [
      { type: "native-tool-call", callId: "x", toolName: "t", input: {} },
      { type: "native-tool-result", callId: "x", toolName: "t", result: 1 },
      { type: "native-tool-result", callId: "x", toolName: "t", result: 1 },
    ]],
    ["tool-name-mismatch", [
      { type: "native-tool-call", callId: "x", toolName: "t", input: {} },
      { type: "native-tool-result", callId: "x", toolName: "u", result: 1 },
    ]],
    ["duplicate-call", [
      { type: "native-tool-call", callId: "x", toolName: "t", input: {} },
      { type: "native-tool-call", callId: "x", toolName: "t", input: {} },
    ]],
    ["unsettled-native-call", [{ type: "native-tool-call", callId: "x", toolName: "t", input: {} }, { type: "done", reason: "stop" }]],
    ["missing-done", [{ type: "text", text: "a" }]],
  ] as [string, CursorTurnEvent[]][])("ends with one error and no finish on %s", async (code, events) => {
    const parts = await collect(events);
    const last = parts.at(-1);
    expect(last?.type).toBe("error");
    expect((last as { error: { code?: string } }).error.code).toBe(code);
    expect(parts.some((p) => p.type === "finish")).toBe(false);
  });

  it("ignores events after done", async () => {
    const parts = await collect([{ type: "done", reason: "stop" }, { type: "text", text: "late" }]);
    expect(types(parts)).toEqual(["stream-start", "finish"]);
  });

  it("turns a source failure into one error part", async () => {
    const parts = await collect(async function* () {
      yield { type: "text", text: "a" } as CursorTurnEvent;
      throw new Error("boom");
    });
    expect(parts.at(-1)).toMatchObject({ type: "error", error: { message: "boom" } });
  });
});

describe("create* hedge factory", () => {
  it("fails closed without contacting Cursor", async () => {
    const model = createCursor().languageModel("m");
    const { stream } = await model.doStream({ prompt: [] } as never);
    const reader = stream.getReader();
    const parts: unknown[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value);
    }
    expect(parts.at(-1)).toMatchObject({ type: "error", error: { code: "cursor-runtime-unavailable" } });
  });
});
