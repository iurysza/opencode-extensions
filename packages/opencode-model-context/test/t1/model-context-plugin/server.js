// Test-only probe. Loaded after @iurysza/opencode-model-context so its context hook
// sees the spliced system array. Registers a local provider and writes each
// context, compaction, and generate event to a JSONL file. No network.
import { appendFileSync } from "node:fs";

let log = "/nonexistent/model-context.jsonl";
const record = (entry) => appendFileSync(log, `${JSON.stringify({ t: Date.now(), ...entry })}\n`);

const PROVIDERS = ["modelctx", "claude-agent"];
const MODELS = {
  modelctx: ["gpt-6.2-sol", "gpt-9-unknown", "mystery-1", "claude-opus-5-5"],
  "claude-agent": ["claude-opus-5-5"],
};

function fake(modelId, provider) {
  return {
    specificationVersion: "v3",
    provider,
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

function modelInfo(provider, id, packageName) {
  return {
    id,
    modelID: id,
    providerID: provider.id,
    name: id,
    package: packageName,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 128000, output: 4096 },
  };
}

function providerInfo(provider) {
  return { id: provider.id, name: provider.name, activation: "enabled", package: provider.package };
}

async function register(ctx, spec) {
  if (typeof ctx.provider?.transform === "function") {
    await ctx.provider.transform((editor) => {
      editor.add({
        info: providerInfo(spec),
        models: spec.models.map((id) => modelInfo(spec, id, spec.package)),
      });
    });
    return "provider";
  }
  if (typeof ctx.catalog?.transform === "function") {
    await ctx.catalog.transform((editor) => {
      editor.provider.update(spec.id, (info) => Object.assign(info, providerInfo(spec)));
      for (const id of spec.models) editor.model.update(spec.id, id, (info) => Object.assign(info, modelInfo(spec, id, spec.package)));
    });
    return "catalog";
  }
  throw new Error("no provider or catalog registration");
}

const HOOKS = ["context", "compaction", "generate"];

export default {
  id: "model-context-probe",
  async setup(ctx) {
    log = ctx.options?.log ?? log;
    record({ at: "setup-start", hasOptions: ctx.options != null, log });
    const packageName = `aisdk:${new URL("./factory.mjs", import.meta.url).href}`;
    const registered = {};
    for (const id of PROVIDERS) {
      try {
        registered[id] = await register(ctx, { id, name: id, package: packageName, models: MODELS[id] });
      } catch (error) {
        registered[id] = `error: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (typeof ctx.aisdk?.hook === "function") {
      for (const providerID of PROVIDERS) {
        const accept = (event) => (event?.model?.providerID ?? event?.providerID) === providerID;
        await ctx.aisdk.hook("sdk", (event) => {
          if (!accept(event) || event.sdk != null) return;
          event.sdk = { languageModel: (modelId) => fake(modelId, providerID) };
        }, { providerID });
        await ctx.aisdk.hook("language", (event) => {
          if (!accept(event)) return;
          const model = event.model ?? {};
          event.language = fake(model.modelID ?? model.id ?? "unknown", providerID);
        }, { providerID });
      }
    }
    for (const name of HOOKS) {
      if (typeof ctx.session?.hook !== "function") break;
      await ctx.session.hook(name, (event) => {
        record({
          at: "system",
          hook: name,
          sessionID: event?.sessionID,
          agent: event?.agent,
          model: event?.model ? { id: event.model.id, providerID: event.model.providerID } : undefined,
          system: Array.isArray(event?.system)
            ? event.system.map((part) => ({ type: part?.type, text: part?.text, metadata: part?.metadata }))
            : event?.system,
        });
      });
    }
    record({ at: "setup", registered, hasSessionHook: typeof ctx.session?.hook === "function" });
    return async () => {};
  },
};
