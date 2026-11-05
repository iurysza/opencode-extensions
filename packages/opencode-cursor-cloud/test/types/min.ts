// Type contract against the minimum host types (@opencode/plugin 2.0.0, aliased as opencode-plugin-min).
import type { Plugin } from "opencode-plugin-min";
import type { CompletionContext } from "../../src/plugin/completion.js";

export const minimum = (context: Plugin.Context): CompletionContext => context;
