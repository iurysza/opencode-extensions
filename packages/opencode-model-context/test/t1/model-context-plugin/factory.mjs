// Test-only AI SDK factory. The host's dynamic loader imports the first create* export.
// It never calls a real model.

function fake(modelId) {
  return {
    specificationVersion: "v3",
    provider: "modelctx",
    modelId,
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error("fixture supports streaming only")),
    async doStream() {
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-start", id: "t" });
            controller.enqueue({ type: "text-delta", id: "t", delta: "ok" });
            controller.enqueue({ type: "text-end", id: "t" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: undefined, text: undefined, reasoning: undefined },
              },
            });
            controller.close();
          },
        }),
      };
    },
  };
}

export function createModelContextFixture() {
  return { languageModel: (modelId) => fake(modelId) };
}
