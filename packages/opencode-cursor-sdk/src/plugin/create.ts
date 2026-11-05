import { parseHost, type HostRefusal } from "../compat/host.js";
import { registerProvider, type ProviderSpec } from "../compat/provider-registration.js";
import type { CursorTurnSource } from "../core/turn-events.js";
import { createLanguageModel, createSdk, PROVIDER_ID } from "../provider/language-model.js";

export const PLUGIN_ID = "iurysza.cursor-sdk";

export interface CursorPluginOptions {
  /** Produces Cursor turn events. Production passes the real SDK adapter (M1); tests pass a scripted fake. */
  readonly source: CursorTurnSource;
  /** Models to register. The real model list arrives with the SDK adapter (M1). */
  readonly models: ProviderSpec["models"];
  /** Receives the fixed refusal message when the host is unsupported. */
  readonly onRefusal?: (refusal: HostRefusal) => void;
}

/** `aisdk:` package for the `create*` hedge: a file URL, so the host imports it without npm. */
export const factoryPackage = (): string => `aisdk:${new URL("../provider/factory.js", import.meta.url).href}`;

/**
 * Builds the `@opencode/plugin` `define({ id, setup })` definition. Structural on purpose:
 * `define` is an identity function, and this package must not import host code at load.
 */
export function createCursorPlugin(options: CursorPluginOptions) {
  return {
    id: PLUGIN_ID,
    async setup(context: unknown): Promise<void> {
      const host = parseHost(context);
      if (host._tag === "err") {
        (options.onRefusal ?? ((refusal) => console.warn(refusal.message)))(host.error);
        return;
      }
      if (host.value.workspaceID !== undefined) return;
      await registerProvider(host.value.registration, {
        id: PROVIDER_ID,
        name: "Cursor",
        package: factoryPackage(),
        models: options.models,
      });
      // If no earlier hook supplied an SDK (internal dynamic loader absent), supply ours.
      await host.value.aisdkHook(
        "sdk",
        (event) => {
          if (event.sdk === undefined) event.sdk = createSdk(options.source, "plugin-hook");
        },
        { providerID: PROVIDER_ID },
      );
      // Always own the language model for our provider, whichever path produced the SDK.
      await host.value.aisdkHook(
        "language",
        (event) => {
          const model = event.model as { modelID?: string; id: string };
          const sdk = event.sdk as { origin?: unknown } | undefined;
          const origin = sdk?.origin === "plugin-hook" ? "plugin-hook" : "package-factory";
          event.language = createLanguageModel(model.modelID ?? model.id, options.source, origin);
        },
        { providerID: PROVIDER_ID },
      );
    },
  };
}
