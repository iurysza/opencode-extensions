// Type contract against the pinned latest qualified host types (@opencode/plugin 2.2.5).
import type { Plugin } from "@opencode/plugin";
import type { CompletionContext } from "../../src/plugin/completion.js";

export const latest = (context: Plugin.Context): CompletionContext => context;
