// Type contract against the pinned latest qualified host types (@opencode/plugin 2.2.5).
import type { Plugin } from "@opencode/plugin";
import type { ModelContextHost } from "../../src/host.js";

export const latest = (context: Plugin.Context): ModelContextHost => context;
