// Pure lookup, ported from agents2 pi/agent/extensions/model-context.ts (b852545).
// Names match that file. skipSoul is intentionally absent: this plugin never edits soul.
//
// modelFileStem also strips an @ suffix, which the Pi original does not.
// lookupKeys tries the raw id before the stripped stem when the id contains @,
// so a map key that keeps the suffix beats the stripped name. Ids without @
// keep Pi's order: provider/stem, stem, provider/id, id.

export interface ModelFamily {
  pattern: string;
  file: string;
}

export interface ModelContextMap {
  skipProviders?: string[];
  models?: Record<string, string>;
  families?: ModelFamily[];
}

export function modelFileStem(id = ""): string {
  const bare = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return bare.replace(/:.*$/, "").replace(/@.*$/, "").trim();
}

export function lookupKeys(provider = "", id = ""): string[] {
  const stem = modelFileStem(id);
  const stemKeys = [`${provider}/${stem}`, stem];
  const idKeys = [`${provider}/${id}`, id];
  const ordered = id.includes("@") ? [...idKeys, ...stemKeys] : [...stemKeys, ...idKeys];
  return [...new Set(ordered.filter(Boolean))];
}

export function modelMatches(provider = "", id = "", pattern: string): boolean {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch {
    return false;
  }
  const stem = modelFileStem(id);
  return regex.test(`${provider}/${stem}`) || regex.test(stem) || regex.test(provider);
}

export function resolveContextFile(provider = "", id = "", map: ModelContextMap = {}): string | undefined {
  const models = map.models ?? {};
  for (const key of lookupKeys(provider, id)) {
    const file = models[key];
    if (file) return file;
  }
  for (const family of map.families ?? []) {
    if (modelMatches(provider, id, family.pattern)) return family.file;
  }
  return undefined;
}

export function shouldSkipVendorPrompt(provider = "", map: ModelContextMap = {}): boolean {
  return (map.skipProviders ?? []).some((name) => name.toLowerCase() === provider.toLowerCase());
}

export function parseModelContextMap(text: string): ModelContextMap {
  const value = JSON.parse(text) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as ModelContextMap;
}
