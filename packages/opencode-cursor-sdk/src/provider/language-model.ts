import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { readRequestStamp, type StampFailure } from "../compat/request-stamp.js";
import { helperUnavailable, selectLane, type TurnLanes } from "../core/lanes.js";
import { translateTurn } from "../core/stream.js";
import type { CursorTurnSource } from "../core/turn-events.js";

export const PROVIDER_ID = "cursor";

/** Which path produced the AI SDK object. Recorded for the G2 hook-order probe. */
export type SdkOrigin = "plugin-hook" | "package-factory";

/** A request without a valid private stamp. Raised before any Cursor source runs (F-17). */
export class UnstampedRequestError extends Error {
  readonly code = "cursor-unstamped-request";
  constructor(readonly reason: StampFailure) {
    super(`Cursor request rejected: request stamp is ${reason}.`);
    this.name = "UnstampedRequestError";
  }
}

export class RequestAbortedError extends Error {
  readonly code = "cursor-request-aborted";
  constructor() {
    super("Cursor request aborted before it started.");
    this.name = "RequestAbortedError";
  }
}

export function createLanguageModel(modelId: string, lanes: TurnLanes, origin: SdkOrigin): LanguageModelV3 {
  const doStream = async (options: LanguageModelV3CallOptions) => {
    // Order matters: identify, then route, then start. Nothing below runs a source on failure.
    const stamp = readRequestStamp(options.headers);
    if (stamp._tag === "err") throw new UnstampedRequestError(stamp.error);
    const lane = selectLane(stamp.value.kind, lanes);
    if (lane._tag === "err") throw lane.error;
    if (options.abortSignal?.aborted) throw new RequestAbortedError();
    const parts = translateTurn(
      lane.value({ modelId, context: stamp.value, prompt: options.prompt, abortSignal: options.abortSignal }),
    );
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async pull(controller) {
        const next = await parts.next();
        if (next.done) controller.close();
        else if (next.value.type === "finish")
          controller.enqueue({ ...next.value, providerMetadata: { cursor: { sdkOrigin: origin } } });
        else controller.enqueue(next.value as LanguageModelV3StreamPart);
      },
      async cancel() {
        await parts.return(undefined);
      },
    });
    return { stream, response: { headers: { "x-cursor-sdk-origin": origin } } };
  };
  return {
    specificationVersion: "v3",
    provider: PROVIDER_ID,
    modelId,
    supportedUrls: {},
    doStream,
    doGenerate: () => Promise.reject(new Error("Cursor provider supports streaming only.")),
  };
}

export interface CursorSdk {
  readonly origin: SdkOrigin;
  languageModel(modelId: string): LanguageModelV3;
}

export function createSdk(lanes: TurnLanes, origin: SdkOrigin): CursorSdk {
  return { origin, languageModel: (modelId) => createLanguageModel(modelId, lanes, origin) };
}

/** Lanes with a coding source and no helper lane: helper requests refuse to start. */
export const codingOnly = (coding: CursorTurnSource): TurnLanes => ({ coding, helper: helperUnavailable });
