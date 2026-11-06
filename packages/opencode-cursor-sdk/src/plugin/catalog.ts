import { createHash } from "node:crypto";
import type { ModelListItem } from "@cursor/sdk";
import { FALLBACK_MODELS, toModelSpecs, type ModelSpec } from "../provider/models.js";

export const DISCOVERY_FALLBACK_WARNING = "Cursor model discovery unavailable; using bundled fallback models.";

export interface CatalogDependencies {
  /** Host key resolution (stored connection, then env). May throw; never logged. */
  readonly getApiKey: () => Promise<string | undefined>;
  /** Lazy SDK listing. `force` bypasses the per-key cache. */
  readonly list: (apiKey: string, force: boolean) => Promise<ModelListItem[]>;
  readonly warn?: (message: string) => void;
}

export type CatalogSource = "fallback" | "account";
export type Publisher = (specs: readonly ModelSpec[]) => Promise<void>;

/**
 * Holds the provider's model list. Discovery replaces it with the account catalog; a missing key
 * reverts to the bundled fallback; a failed listing keeps the last good list. Every change is pushed
 * to the attached publisher, which reloads the host's provider registration.
 */
export function createModelCatalog(deps: CatalogDependencies) {
  let items: readonly ModelListItem[] = FALLBACK_MODELS;
  let source: CatalogSource = "fallback";
  let appliedKey: string | undefined;
  let publisher: Publisher | undefined;
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();

  const publish = async () => { if (publisher && !closed) await publisher(toModelSpecs(items)); };
  async function run(force: boolean): Promise<CatalogSource> {
    if (closed) return source;
    let key: string | undefined;
    try { key = (await deps.getApiKey())?.trim() || undefined; } catch { key = undefined; }
    const fingerprint = key && createHash("sha256").update(key).digest("hex");
    if (!force && fingerprint === appliedKey && (source === "account" || !fingerprint)) return source;
    if (!key) {
      const changed = source !== "fallback";
      items = FALLBACK_MODELS; source = "fallback"; appliedKey = undefined;
      if (changed) await publish();
      throw new Error("Cursor API key unavailable");
    }
    try {
      const listed = await deps.list(key, force);
      if (closed) return source;
      items = listed; source = "account"; appliedKey = fingerprint;
    } catch (error) {
      deps.warn?.(DISCOVERY_FALLBACK_WARNING);
      throw error;
    }
    await publish();
    return source;
  }
  /** Serialized discovery. Rejects when no key is available or listing fails. */
  const refresh = (options: { readonly force?: boolean } = {}): Promise<CatalogSource> => {
    const next = queue.then(() => run(options.force === true));
    queue = next.catch(() => {});
    return next;
  };
  return {
    items: () => items,
    specs: () => toModelSpecs(items),
    source: () => source,
    refresh,
    attach(next: Publisher) { publisher = next; },
    close() { closed = true; publisher = undefined; },
  };
}
export type ModelCatalog = ReturnType<typeof createModelCatalog>;
