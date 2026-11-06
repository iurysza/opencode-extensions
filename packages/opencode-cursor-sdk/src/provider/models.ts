// Pure Cursor catalog mapping. Type-only SDK imports; no SDK code at load.
import type { ModelListItem, ModelParameterDefinition, ModelParameterValue, ModelSelection } from "@cursor/sdk";

export interface ModelSpec {
  readonly id: string;
  readonly name: string;
  readonly context: number;
  readonly output: number;
  /** OpenCode variant IDs. Resolved back to Cursor params by `resolveModelSelection`. */
  readonly variants?: readonly string[];
}

const DEFAULT_CONTEXT = 200_000;
const DEFAULT_OUTPUT = 32_000;

// Public model metadata from Pi's bundled snapshot (pi-cursor-sdk, @cursor/sdk 1.0.23), trimmed to
// the default variant. All three ids are still in the live catalog; context-split IDs mirror Pi.
export const FALLBACK_MODELS: readonly ModelListItem[] = [
  { id: "auto-smart", displayName: "Auto",
    parameters: [{ id: "optimize_for", values: [{ value: "intelligence" }, { value: "balanced" }, { value: "cost" }] }],
    variants: [
      { displayName: "Auto Intelligence", params: [{ id: "optimize_for", value: "intelligence" }] },
      { displayName: "Auto Balance", params: [{ id: "optimize_for", value: "balanced" }], isDefault: true },
      { displayName: "Auto Cost", params: [{ id: "optimize_for", value: "cost" }] },
    ] },
  { id: "composer-2.5", displayName: "Composer 2.5",
    parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true" }] }],
    variants: [{ displayName: "Composer 2.5", params: [{ id: "fast", value: "true" }], isDefault: true }] },
  { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol",
    parameters: [
      { id: "context", values: [{ value: "272k" }, { value: "1m" }] },
      { id: "reasoning", values: [{ value: "none" }, { value: "low" }, { value: "medium" }, { value: "high" }] },
      { id: "fast", values: [{ value: "false" }, { value: "true" }] },
    ],
    variants: [{ displayName: "GPT-5.6 Sol", isDefault: true,
      params: [{ id: "context", value: "1m" }, { id: "reasoning", value: "medium" }, { id: "fast", value: "false" }] }] },
];

export const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Level = typeof LEVELS[number];

const param = (item: ModelListItem, id: string): ModelParameterDefinition | undefined => item.parameters?.find((p) => p.id === id);
const value = (p: ModelParameterDefinition | undefined, lower: string): string | undefined =>
  p?.values.find((v) => v.value.toLowerCase() === lower)?.value;
const isBoolean = (p: ModelParameterDefinition | undefined): boolean => !!value(p, "true") && !!value(p, "false");
/** Effort-like parameter, in Pi's order plus `reasoning_effort` (seen on Grok 4.7 and Gemini 4). */
const effortParam = (item: ModelListItem) => param(item, "effort") ?? param(item, "reasoning_effort");

/** Pi's thinking-level map (model-discovery.ts): level -> raw value of the controlling parameter. */
export function thinkingLevels(item: ModelListItem): Partial<Record<Level, string>> {
  const reasoning = param(item, "reasoning");
  const thinking = param(item, "thinking");
  const control = effortParam(item) ?? reasoning ?? thinking;
  if (!control) return {};
  if (control === thinking && isBoolean(thinking)) return { off: value(thinking, "false")!, high: value(thinking, "true")! };
  const levels: Partial<Record<Level, string>> = {};
  const off = value(reasoning, "none") ?? value(reasoning, "off") ?? value(thinking, "false");
  if (off) levels.off = off;
  for (const level of LEVELS.slice(1)) {
    const mapped = level === "xhigh" ? value(control, "xhigh") ?? value(control, "extra-high") : value(control, level);
    if (mapped) levels[level] = mapped;
  }
  return levels;
}

function setParam(params: ModelParameterValue[], id: string, next: string): ModelParameterValue[] {
  return params.some((p) => p.id === id) ? params.map((p) => (p.id === id ? { id, value: next } : p)) : [...params, { id, value: next }];
}

/** Pi's applyThinkingLevel, with the effort parameter id taken from the catalog. */
function applyLevel(item: ModelListItem, params: ModelParameterValue[], level: Level): ModelParameterValue[] {
  const mapped = thinkingLevels(item)[level];
  if (mapped === undefined) return params;
  const effort = effortParam(item);
  const hasThinking = !!param(item, "thinking");
  if (level === "off") {
    if (hasThinking && mapped === value(param(item, "thinking"), "false")) {
      return setParam(params, "thinking", mapped).filter((p) => p.id !== effort?.id);
    }
    return param(item, "reasoning") ? setParam(params, "reasoning", mapped) : params;
  }
  if (effort) return setParam(hasThinking ? setParam(params, "thinking", "true") : params, effort.id, mapped);
  if (param(item, "reasoning")) return setParam(params, "reasoning", mapped);
  return hasThinking ? setParam(params, "thinking", mapped) : params;
}

const defaultParams = (item: ModelListItem): ModelParameterValue[] =>
  ((item.variants ?? []).find((v) => v.isDefault) ?? item.variants?.[0])?.params.map((p) => ({ ...p })) ?? [];

/** `256k` -> 256000, `1m` -> 1000000. */
export function parseContext(label: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([km])$/i.exec(label.trim());
  return match ? Math.round(Number(match[1]) * (match[2]!.toLowerCase() === "m" ? 1_000_000 : 1_000)) : undefined;
}

/** One OpenCode model per Cursor model and context choice (Pi's `id@context`); thinking levels become variants. */
export function toModelSpecs(items: readonly ModelListItem[]): ModelSpec[] {
  const specs: ModelSpec[] = [];
  const seen = new Set<string>();
  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    const variants = LEVELS.filter((level) => thinkingLevels(item)[level] !== undefined);
    const contexts = param(item, "context")?.values.map((v) => v.value) ?? [];
    for (const context of contexts.length ? contexts : [undefined]) {
      const id = context ? `${item.id}@${context}` : item.id;
      if (seen.has(id)) continue;
      seen.add(id);
      specs.push({
        id,
        name: context ? `${item.displayName || item.id} @ ${context}` : item.displayName || item.id,
        context: (context && parseContext(context)) || DEFAULT_CONTEXT,
        output: DEFAULT_OUTPUT,
        ...(variants.length ? { variants } : {}),
      });
    }
  }
  return specs;
}

export const FALLBACK_SPECS: readonly ModelSpec[] = toModelSpecs(FALLBACK_MODELS);

/** Finds the catalog entry for an OpenCode model ID, splitting Pi-style `id@context`. */
export function findModel(items: readonly ModelListItem[], modelId: string): { item: ModelListItem; context?: string } | undefined {
  const exact = items.find((item) => item.id === modelId);
  if (exact) return { item: exact };
  const at = modelId.lastIndexOf("@");
  if (at <= 0) return undefined;
  const item = items.find((candidate) => candidate.id === modelId.slice(0, at));
  const context = modelId.slice(at + 1);
  return item && param(item, "context")?.values.some((v) => v.value === context) ? { item, context } : undefined;
}

const record = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/**
 * Maps an OpenCode model ID, variant and `providerOptions.cursor.params` to a Cursor selection.
 * Returns `undefined` for any unsupported setting. Unknown model IDs pass through without params.
 * As in Pi, every selection starts from the catalog's default variant params, then applies a
 * named Cursor variant, a thinking level, the `@context` split and explicit params, in that order.
 */
export function resolveModelSelection(items: readonly ModelListItem[], modelId: string, variant: string | undefined, providerOptions: unknown): ModelSelection | undefined {
  const found = findModel(items, modelId);
  const item = found?.item;
  const provider = record(record(providerOptions)?.cursor);
  if (provider && (Object.keys(provider).some((key) => key !== "params") || (provider.params !== undefined && !record(provider.params)))) return undefined;
  let params = item ? defaultParams(item) : [];
  if (variant && variant !== "default") {
    const named = item?.variants?.find((v) => v.displayName === variant);
    if (named) params = named.params.map((p) => ({ ...p }));
    else if (item && (LEVELS as readonly string[]).includes(variant) && thinkingLevels(item)[variant as Level] !== undefined) params = applyLevel(item, params, variant as Level);
    else return undefined;
  }
  if (found?.context) params = setParam(params, "context", found.context);
  for (const [id, raw] of Object.entries(record(provider?.params) ?? {})) {
    if (typeof raw !== "string" || !item?.parameters?.some((p) => p.id === id && p.values.some((v) => v.value === raw))) return undefined;
    params = setParam(params, id, raw);
  }
  return { id: item?.id ?? modelId, ...(params.length ? { params } : {}) };
}
