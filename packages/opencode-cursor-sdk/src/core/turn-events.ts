/**
 * Host-neutral events for one provider slice of a Cursor run, including MCP reentry.
 * Imports nothing from OpenCode, Pi or the Cursor SDK.
 */
import type { RequestContext } from "./request-context.js";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type CursorTurnEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string }
  | { readonly type: "bridge-tool-call"; readonly callId: string; readonly toolName: string; readonly input: JsonValue }
  /** A Cursor-native tool call. Cursor runs it; the host must only record it. */
  | { readonly type: "native-tool-call"; readonly callId: string; readonly toolName: string; readonly input: JsonValue }
  | {
      readonly type: "native-tool-result";
      readonly callId: string;
      readonly toolName: string;
      readonly result: Exclude<JsonValue, null>;
      readonly isError?: boolean;
    }
  | { readonly type: "done"; readonly reason: "stop" | "length" | "other" | "tool-calls" };

export interface CursorTurnRequest {
  readonly modelId: string;
  /** Purpose and session identity from our private stamp, parsed before the source runs (F-14, F-17). */
  readonly context: RequestContext;
  /** The AI SDK prompt as received by the provider. Opaque to this layer. */
  readonly prompt: unknown;
  readonly tools?: unknown;
  readonly providerOptions?: unknown;
  readonly abortSignal?: AbortSignal;
}

export type CursorTurnSource = (request: CursorTurnRequest) => AsyncIterable<CursorTurnEvent>;

export class CursorRuntimeUnavailableError extends Error {
  readonly code = "cursor-runtime-unavailable";
  constructor() {
    super("Cursor runtime is not available in this build. The local Cursor SDK adapter is not implemented yet.");
    this.name = "CursorRuntimeUnavailableError";
  }
}

/** Default source until the real adapter lands: fails closed, never contacts Cursor. */
export const unavailableTurnSource: CursorTurnSource = () => ({
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.reject(new CursorRuntimeUnavailableError()),
  }),
});
