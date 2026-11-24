export interface SystemPart {
  type: string;
  text: string;
  metadata?: Record<string, unknown>;
}

/**
 * Splices the vendor prompt at index 1, after the harness base and before instructions.
 * An empty system array is left alone. An existing model-context part is removed first,
 * so a second call replaces the text instead of stacking another part.
 */
export function applyVendorPart(system: SystemPart[], text: string, file: string): void {
  if (system.length === 0) return;
  for (let index = system.length - 1; index >= 0; index -= 1) {
    if (system[index]?.metadata?.modelContext === true) system.splice(index, 1);
  }
  if (system.length === 0) return;
  system.splice(1, 0, { type: "text", text, metadata: { modelContext: true, file } });
}
