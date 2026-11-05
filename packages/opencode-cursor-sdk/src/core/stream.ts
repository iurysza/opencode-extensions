import type { CursorTurnEvent, JsonValue } from "./turn-events.js";

/**
 * Structural subset of AI SDK `LanguageModelV3StreamPart` that this translator emits.
 * Kept local so `src/core` imports nothing from host packages.
 */
export type StreamPart =
  | { readonly type: "stream-start"; readonly warnings: [] }
  | { readonly type: "text-start"; readonly id: string }
  | { readonly type: "text-delta"; readonly id: string; readonly delta: string }
  | { readonly type: "text-end"; readonly id: string }
  | { readonly type: "tool-input-start"; readonly id: string; readonly toolName: string; readonly providerExecuted: true }
  | { readonly type: "tool-input-delta"; readonly id: string; readonly delta: string }
  | { readonly type: "tool-input-end"; readonly id: string }
  | {
      readonly type: "tool-call";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: string;
      readonly providerExecuted: true;
    }
  | {
      readonly type: "tool-result";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly result: Exclude<JsonValue, null>;
      readonly isError?: boolean;
    }
  | {
      readonly type: "finish";
      readonly finishReason: { readonly unified: "stop" | "length" | "other"; readonly raw: string };
      readonly usage: {
        readonly inputTokens: { total: undefined; noCache: undefined; cacheRead: undefined; cacheWrite: undefined };
        readonly outputTokens: { total: undefined; text: undefined; reasoning: undefined };
      };
    }
  | { readonly type: "error"; readonly error: Error };

export class StreamContractError extends Error {
  constructor(
    readonly code:
      | "result-without-call"
      | "duplicate-call"
      | "duplicate-result"
      | "tool-name-mismatch"
      | "unsettled-native-call"
      | "missing-done",
    message: string,
  ) {
    super(message);
    this.name = "StreamContractError";
  }
}

/**
 * Translates one Cursor turn into V3 stream parts that satisfy the OpenCode 2.x
 * streaming contract: every native call is provider-executed, settled by exactly
 * one result with the same name, and the stream ends with exactly one `finish`
 * or one `error`. Events after `done` are ignored. Source failures become one
 * `error` part.
 */
export async function* translateTurn(events: AsyncIterable<CursorTurnEvent>): AsyncGenerator<StreamPart> {
  yield { type: "stream-start", warnings: [] };
  const calls = new Map<string, { readonly toolName: string; settled: boolean }>();
  let closed = false;
  let textId: string | undefined;
  let textCount = 0;

  const closeText = function* (): Generator<StreamPart> {
    if (textId !== undefined) {
      yield { type: "text-end", id: textId };
      textId = undefined;
    }
  };
  const fail = (error: Error): StreamPart => {
    closed = true;
    return { type: "error", error };
  };

  try {
    for await (const event of events) {
      if (closed) break;
      switch (event.type) {
        case "text": {
          if (textId === undefined) {
            textId = `text-${textCount++}`;
            yield { type: "text-start", id: textId };
          }
          yield { type: "text-delta", id: textId, delta: event.text };
          break;
        }
        case "native-tool-call": {
          if (calls.has(event.callId)) {
            yield fail(new StreamContractError("duplicate-call", `Duplicate native tool call ${event.callId}`));
            return;
          }
          yield* closeText();
          calls.set(event.callId, { toolName: event.toolName, settled: false });
          const input = JSON.stringify(event.input);
          yield { type: "tool-input-start", id: event.callId, toolName: event.toolName, providerExecuted: true };
          yield { type: "tool-input-delta", id: event.callId, delta: input };
          yield { type: "tool-input-end", id: event.callId };
          yield { type: "tool-call", toolCallId: event.callId, toolName: event.toolName, input, providerExecuted: true };
          break;
        }
        case "native-tool-result": {
          const call = calls.get(event.callId);
          if (!call) {
            yield fail(new StreamContractError("result-without-call", `Native tool result before call ${event.callId}`));
            return;
          }
          if (call.toolName !== event.toolName) {
            yield fail(new StreamContractError("tool-name-mismatch", `Native tool ${event.callId} changed name`));
            return;
          }
          if (call.settled) {
            yield fail(new StreamContractError("duplicate-result", `Duplicate native tool result ${event.callId}`));
            return;
          }
          call.settled = true;
          yield* closeText();
          yield {
            type: "tool-result",
            toolCallId: event.callId,
            toolName: event.toolName,
            result: event.result,
            ...(event.isError ? { isError: true } : {}),
          };
          break;
        }
        case "done": {
          const unsettled = [...calls].find(([, call]) => !call.settled);
          if (unsettled) {
            yield fail(new StreamContractError("unsettled-native-call", `Native tool call ${unsettled[0]} has no result`));
            return;
          }
          yield* closeText();
          closed = true;
          yield {
            type: "finish",
            finishReason: { unified: event.reason, raw: event.reason },
            usage: {
              inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: undefined, text: undefined, reasoning: undefined },
            },
          };
          return;
        }
      }
    }
  } catch (cause) {
    if (!closed) yield fail(cause instanceof Error ? cause : new Error(String(cause)));
    return;
  }
  if (!closed) {
    yield fail(new StreamContractError("missing-done", "Cursor turn ended without completion"));
  }
}
