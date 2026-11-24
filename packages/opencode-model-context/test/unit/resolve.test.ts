import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  lookupKeys,
  modelFileStem,
  modelMatches,
  parseModelContextMap,
  resolveContextFile,
  shouldSkipVendorPrompt,
  type ModelContextMap,
} from "../../src/resolve.js";

const here = dirname(fileURLToPath(import.meta.url));

const map = parseModelContextMap(`{
  "skipProviders": ["claude-code"],
  "models": {
    "gpt-6.2-sol": "gpt-6.2-sol.md",
    "claude-opus-5-5": "claude-opus-5-5.md",
    "claude-haiku-5-5": "claude-haiku-5-5.md",
    "gpt-6-luna": "gpt-6-luna.md"
  },
  "families": [
    { "pattern": "haiku|gpt-6-luna|grok|deepseek|glm|kimi|^jetson/", "file": "budget.md" },
    { "pattern": "gpt-|openai", "file": "gpt.md" },
    { "pattern": "gemini-2", "file": "gemini-legacy.md" },
    { "pattern": "gemini|^google/", "file": "gemini.md" }
  ]
}`);

test.each([
  ["github-copilot", "gpt-6.2-sol", "gpt-6.2-sol.md"],
  ["openai-codex", "gpt-6.1-sol", "gpt.md"],
  ["openai", "gpt-6.1-terra", "gpt.md"],
  ["cursor", "claude-opus-5-5", "claude-opus-5-5.md"],
  ["cursor", "claude-sonnet-5-5", undefined],
  ["anthropic", "claude-haiku-5-5", "claude-haiku-5-5.md"],
  ["openai-codex", "gpt-6-luna", "gpt-6-luna.md"],
  ["xai", "grok-5", "budget.md"],
  ["deepseek", "deepseek-v4", "budget.md"],
  ["zai", "glm-5", "budget.md"],
  ["moonshot", "kimi-k3", "budget.md"],
  ["jetson", "ornith-9b", "budget.md"],
  ["google", "gemini-4-neon", "gemini.md"],
  ["google", "gemini-2.5-pro", "gemini-legacy.md"],
  ["anthropic", "unknown-model", undefined],
] as const)("%s/%s resolves to %s", (provider, id, file) => {
  expect(resolveContextFile(provider, id, map)).toBe(file);
});

test("exact model id is tried before a family pattern, then none", () => {
  expect(modelFileStem("github-copilot/gpt-6.2-sol:high")).toBe("gpt-6.2-sol");
  expect(lookupKeys("github-copilot", "gpt-6.2-sol:high")).toEqual([
    "github-copilot/gpt-6.2-sol",
    "gpt-6.2-sol",
    "github-copilot/gpt-6.2-sol:high",
    "gpt-6.2-sol:high",
  ]);
  expect(resolveContextFile("github-copilot", "gpt-6.2-sol:high", map)).toBe("gpt-6.2-sol.md");
  expect(resolveContextFile("openai-codex", "gpt-6.1-sol", map)).toBe("gpt.md");
  expect(resolveContextFile("cursor", "no-such-model", map)).toBeUndefined();
});

test("provider/id is an exact key and beats a later family", () => {
  const scoped: ModelContextMap = {
    models: { "openai/gpt-custom": "scoped.md" },
    families: [{ pattern: "gpt-", file: "gpt.md" }],
  };
  expect(resolveContextFile("openai", "gpt-custom", scoped)).toBe("scoped.md");
  expect(resolveContextFile("other", "gpt-custom", scoped)).toBe("gpt.md");
});

test("the first matching family wins and an invalid regex is skipped", () => {
  const families: ModelContextMap = {
    families: [
      { pattern: "(", file: "bad.md" },
      { pattern: "gpt-", file: "first.md" },
      { pattern: "gpt-9", file: "second.md" },
    ],
  };
  expect(modelMatches("openai", "gpt-9-unknown", "(")).toBe(false);
  expect(resolveContextFile("openai", "gpt-9-unknown", families)).toBe("first.md");
});

test("a new prompt is added by the map, with no code change", () => {
  const next = parseModelContextMap(JSON.stringify({
    ...map,
    models: { ...map.models, "gpt-7-sol": "gpt-7-sol.md" },
  }));
  expect(resolveContextFile("openai", "gpt-7-sol", next)).toBe("gpt-7-sol.md");
});

test("claude-code is skipped from the map, not hardcoded in the resolver", () => {
  expect(shouldSkipVendorPrompt("claude-code", map)).toBe(true);
  expect(shouldSkipVendorPrompt("Claude-Code", map)).toBe(true);
  expect(shouldSkipVendorPrompt("cursor", map)).toBe(false);
  expect(shouldSkipVendorPrompt("claude-code", { skipProviders: [] })).toBe(false);
});

test("an @ suffix is stripped, and a suffixed map key beats the stripped stem", () => {
  expect(modelFileStem("claude-opus-5-5@300k")).toBe("claude-opus-5-5");
  expect(modelFileStem("gpt-5.6-sol@272k")).toBe("gpt-5.6-sol");
  expect(modelFileStem("openai/claude-opus-5-5@300k:slow")).toBe("claude-opus-5-5");
  expect(modelFileStem("gpt-5.6-sol@custom")).toBe("gpt-5.6-sol");

  const suffixOnly: ModelContextMap = { models: { "claude-opus-5-5@300k": "suffix.md" } };
  expect(resolveContextFile("cursor", "claude-opus-5-5@300k", suffixOnly)).toBe("suffix.md");

  const both: ModelContextMap = {
    models: { "claude-opus-5-5": "stripped.md", "claude-opus-5-5@300k": "suffix.md" },
  };
  expect(lookupKeys("cursor", "claude-opus-5-5@300k")[0]).toBe("cursor/claude-opus-5-5@300k");
  expect(resolveContextFile("cursor", "claude-opus-5-5@300k", both)).toBe("suffix.md");
  expect(resolveContextFile("cursor", "gpt-5.6-sol@272k", {
    models: { "gpt-5.6-sol": "stripped.md", "gpt-5.6-sol@272k": "suffix.md" },
  })).toBe("suffix.md");
  expect(resolveContextFile("cursor", "claude-opus-5-5@300k", map)).toBe("claude-opus-5-5.md");
});

test("a non-object map parses as empty and invalid JSON throws", () => {
  expect(parseModelContextMap("null")).toEqual({});
  expect(parseModelContextMap("[]")).toEqual({});
  expect(parseModelContextMap("42")).toEqual({});
  expect(() => parseModelContextMap("{")).toThrow(SyntaxError);
});

test("the agents2 map resolves the named models to their files", () => {
  const real = parseModelContextMap(readFileSync(join(here, "../fixtures/map.json"), "utf8"));
  expect(resolveContextFile("cursor", "gpt-6.2-sol", real)).toBe("gpt-6.2-sol.md");
  expect(resolveContextFile("cursor", "claude-fable-5-2", real)).toBe("claude-fable-5-2.md");
  expect(resolveContextFile("google", "gemini-2.5-pro", real)).toBe("gemini-legacy.md");
  expect(resolveContextFile("google", "gemini-4-pro", real)).toBe("gemini.md");
  expect(resolveContextFile("moonshot", "kimi-k3", real)).toBe("budget.md");
});
