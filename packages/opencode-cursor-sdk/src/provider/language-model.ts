import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { translateTurn } from "../core/stream.js";
import type { CursorTurnSource } from "../core/turn-events.js";

export const PROVIDER_ID = "cursor";

/** Which path produced the AI SDK object. Recorded for the G2 hook-order probe. */
export type SdkOrigin = "plugin-hook" | "package-factory";

export function createLanguageModel(modelId: string, source: CursorTurnSource, origin: SdkOrigin): LanguageModelV3 {
  const doStream = async (options: LanguageModelV3CallOptions) => {
    const parts = translateTurn(source({ modelId, prompt: options.prompt, abortSignal: options.abortSignal }));
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

export function createSdk(source: CursorTurnSource, origin: SdkOrigin): CursorSdk {
  return { origin, languageModel: (modelId) => createLanguageModel(modelId, source, origin) };
}
