import { loadMap, modelContextDir, readPrompt } from "./files.js";
import type { ModelContextHost, VendorRequest } from "./host.js";
import { applyVendorPart } from "./inject.js";
import { resolveContextFile, shouldSkipVendorPrompt, type ModelContextMap } from "./resolve.js";

export const PLUGIN_ID = "iurysza.model-context";

/** Always skipped, then unioned with the option list and the map's skipProviders. */
export const DEFAULT_SKIP_PROVIDERS = ["claude-agent"];

export const HOOK_NAMES = ["context", "compaction", "generate"] as const;

function logOnce(seen: Set<string>, message: string): void {
  if (seen.has(message)) return;
  seen.add(message);
  console.error(message);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function combinedSkip(map: ModelContextMap, options: Readonly<Record<string, unknown>>): string[] {
  return [...DEFAULT_SKIP_PROVIDERS, ...stringList(options.skipProviders), ...(map.skipProviders ?? [])];
}

async function agentHasOwnSystem(ctx: ModelContextHost, agentID: string): Promise<boolean> {
  const result = await ctx.agent.get({ agentID });
  return typeof result?.data?.system === "string" && result.data.system.length > 0;
}

async function inject(ctx: ModelContextHost, event: VendorRequest): Promise<void> {
  const system = event.system;
  if (!Array.isArray(system) || system.length === 0) return;
  const provider = event.model?.providerID ?? "";
  const id = event.model?.id ?? "";
  if (!id) return;
  const options = ctx.options ?? {};
  const dir = modelContextDir(options);
  if (!dir) return;
  const map = loadMap(dir);
  if (!map) return;
  if (shouldSkipVendorPrompt(provider, { skipProviders: combinedSkip(map, options) })) return;
  if (typeof event.agent === "string" && event.agent.length > 0 && (await agentHasOwnSystem(ctx, event.agent))) return;
  const file = resolveContextFile(provider, id, map);
  if (!file) return;
  const text = readPrompt(dir, file);
  if (!text) return;
  applyVendorPart(system, text, file);
}

export function createModelContextPlugin(): {
  readonly id: string;
  setup(ctx: ModelContextHost): Promise<() => Promise<void>>;
} {
  return {
    id: PLUGIN_ID,
    async setup(ctx) {
      if (typeof ctx.session?.hook !== "function") {
        console.error("model-context: disabled, this host has no session.hook");
        return async () => {};
      }
      const seen = new Set<string>();
      const registrations: Array<{ dispose: () => Promise<void> }> = [];
      for (const name of HOOK_NAMES) {
        try {
          registrations.push(
            await ctx.session.hook(name, (event: VendorRequest) =>
              inject(ctx, event).catch((error: unknown) => {
                logOnce(seen, `model-context: ${errorText(error)}`);
              }),
            ),
          );
        } catch (error) {
          logOnce(seen, `model-context: hook ${name} is unavailable (${errorText(error)})`);
        }
      }
      return async () => {
        for (const registration of registrations) {
          try {
            await registration.dispose();
          } catch {
            // Unload must not surface a hook error.
          }
        }
      };
    },
  };
}

// Constructing the definition reads no files and touches no network.
export default createModelContextPlugin();
