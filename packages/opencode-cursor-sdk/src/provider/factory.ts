import { unavailableTurnSource } from "../core/turn-events.js";
import { codingOnly, createSdk, type CursorSdk } from "./language-model.js";

/**
 * G2 hedge. OpenCode's internal `DynamicProviderPlugin` fills `evt.sdk` from the
 * registered package's first `create*` export when no earlier hook set it.
 * This factory never contacts Cursor; the plugin's `language` hook replaces
 * the model it returns.
 */
export function createCursor(_options?: Record<string, unknown>): CursorSdk {
  return createSdk(codingOnly(unavailableTurnSource), "package-factory");
}
