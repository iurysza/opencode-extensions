// Type contract against the minimum host types (@opencode/plugin 2.0.0, aliased as opencode-plugin-min).
import type { Plugin } from "opencode-plugin-min";
import type { ModelContextHost } from "../../src/host.js";

export const minimum = (context: Plugin.Context): ModelContextHost => context;
