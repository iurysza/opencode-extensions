import type { RegistrationApi } from "./host.js";
import type { ModelSpec } from "../provider/models.js";

export type { ModelSpec };

export interface ProviderSpec {
  readonly id: string;
  readonly name: string;
  /** AI SDK package string, `aisdk:` + module specifier with a `create*` export. */
  readonly package: string;
  /** A function is read on every host replay, so `reload()` publishes the current list. */
  readonly models: readonly ModelSpec[] | (() => readonly ModelSpec[]);
}

/** Minimal structural editors, from `@opencode/plugin` 2.0.0 (`CatalogEditor`) and 2.0.4+ (`ProviderEditor`). */
interface CatalogEditor {
  readonly provider: { update(id: string, update: (provider: Record<string, unknown>) => void): void };
  readonly model: { update(providerID: string, modelID: string, update: (model: Record<string, unknown>) => void): void };
}
interface ProviderEditor {
  add(input: { info: Record<string, unknown>; models: readonly Record<string, unknown>[] }): void;
}

export function modelInfo(provider: ProviderSpec, model: ModelSpec): Record<string, unknown> {
  return {
    id: model.id,
    modelID: model.id,
    providerID: provider.id,
    name: model.name,
    package: provider.package,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: (model.variants ?? []).map((id) => ({ id })),
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: model.context, output: model.output },
  };
}

export function providerInfo(provider: ProviderSpec): Record<string, unknown> {
  // `enabled`: no host integration owns this provider yet; auth arrives in M1.
  return { id: provider.id, name: provider.name, activation: "enabled", package: provider.package };
}

/**
 * Before 2.0.4, `catalog.provider.update` creates a missing provider and `catalog.model.update`
 * creates a missing model. From 2.0.4, `provider.add({ info, models })` registers both.
 */
export function registerProvider(api: RegistrationApi, provider: ProviderSpec): Promise<unknown> {
  const models = () => (typeof provider.models === "function" ? provider.models() : provider.models);
  if (api._tag === "provider") {
    return api.transform((editor) => {
      (editor as ProviderEditor).add({
        info: providerInfo(provider),
        models: models().map((model) => modelInfo(provider, model)),
      });
    });
  }
  return api.transform((editor) => {
    const catalog = editor as CatalogEditor;
    catalog.provider.update(provider.id, (info) => Object.assign(info, providerInfo(provider)));
    for (const model of models()) {
      catalog.model.update(provider.id, model.id, (info) => Object.assign(info, modelInfo(provider, model)));
    }
  });
}
