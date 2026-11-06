// Type contract against the minimum host types (@opencode/plugin 2.0.0, aliased as opencode-plugin-min).
import type { Plugin } from "opencode-plugin-min";
import plugin from "../../src/server.js";

export const minimum: Plugin.Plugin = plugin;
