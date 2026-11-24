import { expect, test } from "vitest";
import { applyVendorPart, type SystemPart } from "../../src/inject.js";

const part = (text: string, metadata?: Record<string, unknown>): SystemPart => ({ type: "text", text, ...(metadata ? { metadata } : {}) });

test("inserts the vendor part between the base prompt and instructions", () => {
  const system = [part("base"), part("instructions AGENTS.md")];
  applyVendorPart(system, "vendor", "gpt.md");
  expect(system).toEqual([
    part("base"),
    { type: "text", text: "vendor", metadata: { modelContext: true, file: "gpt.md" } },
    part("instructions AGENTS.md"),
  ]);
});

test("appends when the request has only the base prompt", () => {
  const system = [part("base")];
  applyVendorPart(system, "vendor", "gpt.md");
  expect(system.map((item) => item.text)).toEqual(["base", "vendor"]);
  expect(system[1]?.metadata).toEqual({ modelContext: true, file: "gpt.md" });
});

test("leaves an empty system array alone", () => {
  const system: SystemPart[] = [];
  applyVendorPart(system, "vendor", "gpt.md");
  expect(system).toEqual([]);
});

test("a second call replaces the vendor part instead of stacking one", () => {
  const system = [part("base"), part("instructions")];
  applyVendorPart(system, "first", "gpt.md");
  applyVendorPart(system, "second", "claude.md");
  const marked = system.filter((item) => item.metadata?.modelContext === true);
  expect(marked).toEqual([{ type: "text", text: "second", metadata: { modelContext: true, file: "claude.md" } }]);
  expect(system.map((item) => item.text)).toEqual(["base", "second", "instructions"]);
});
