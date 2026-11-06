import type { Plugin } from "@opencode/plugin";
import type { LocalPluginOptions } from "./local.js";
import type { RuntimeOptions } from "./runtime.js";
import type { LocalControls } from "../provider/local-runtime.js";
import { FALLBACK_SPECS } from "../provider/models.js";
import { parseHost, subscribeEvents, type HostRefusal } from "../compat/host.js";
import { registerProvider, type ProviderSpec } from "../compat/provider-registration.js";
import { stampModelRequest } from "../compat/request-stamp.js";
import type { TurnLanes } from "../core/lanes.js";
import { createLanguageModel, createSdk, PROVIDER_ID } from "../provider/language-model.js";

export const PLUGIN_ID = "iurysza.cursor-sdk";
/** Public events after which the active Cursor key may have changed. */
export const CONNECTION_EVENTS = ["credential.switched", "credential.updated", "integration.updated"] as const;

export interface CursorPluginOptions {
  /**
   * Turn sources by request purpose. `coding` runs `primary` only. Production passes no helper
   * lane until G4b passes, so title, compaction and generate refuse to start (F-16).
   */
  readonly lanes?: TurnLanes;
  readonly local?: LocalPluginOptions;
  readonly foreground?: RuntimeOptions["foreground"];
  readonly onLocalControls?: (controls: LocalControls) => void;
  /** Fixed models to register. Default: the account catalog, discovered with the lazy SDK. */
  readonly models?: ProviderSpec["models"];
  /** Receives the fixed refusal message when the host is unsupported. */
  readonly onRefusal?: (refusal: HostRefusal) => void;
}

/** `aisdk:` package for the `create*` hedge: a file URL, so the host imports it without npm. */
export const factoryPackage = (): string => `aisdk:${new URL("../provider/factory.js", import.meta.url).href}`;

/**
 * Builds the `@opencode/plugin` `define({ id, setup })` definition. Structural on purpose:
 * `define` is an identity function, and this package must not import host code at load.
 */
export function createCursorPlugin(options: CursorPluginOptions = {}) {
  return {
    id: PLUGIN_ID,
    async setup(context: unknown): Promise<void | (() => Promise<void>)> {
      const host = parseHost(context);
      if (host._tag === "err") {
        (options.onRefusal ?? ((refusal) => console.warn(refusal.message)))(host.error);
        return;
      }
      if (host.value.workspaceID !== undefined) return;
      const local = options.lanes ? undefined : await (await import("./runtime.js")).composeRuntime(context as Plugin.Context, { local: options.local, foreground: options.foreground });
      const lanes = options.lanes ?? local!.lanes;
      if (local) options.onLocalControls?.(local.controls);
      // Stamp purpose and session identity on our provider's requests only (F-14).
      await host.value.sessionHook("model.request", (event) => stampModelRequest(event, PROVIDER_ID), {
        providerID: PROVIDER_ID,
      });
      const catalog = options.models ? undefined : local?.catalog;
      const registration = host.value.registration;
      await registerProvider(registration, {
        id: PROVIDER_ID,
        name: "Cursor",
        package: factoryPackage(),
        models: options.models ?? (catalog ? () => catalog.specs() : FALLBACK_SPECS),
      });
      const events = new AbortController();
      if (catalog && registration.reload) {
        // The transform reads catalog.specs() on every replay; reload() makes the host replay it.
        const reload = registration.reload;
        catalog.attach(async () => { if (!events.signal.aborted) await reload(); });
        const discover = () => { void catalog.refresh().catch(() => {}); };
        discover();
        subscribeEvents(context, CONNECTION_EVENTS, events.signal, discover);
      }
      // If no earlier hook supplied an SDK (internal dynamic loader absent), supply ours.
      await host.value.aisdkHook(
        "sdk",
        (event) => {
          if (event.sdk === undefined) event.sdk = createSdk(lanes, "plugin-hook");
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
          event.language = createLanguageModel(model.modelID ?? model.id, lanes, origin);
        },
        { providerID: PROVIDER_ID },
      );
      if (!local) return;
      return async () => { events.abort(); await local.dispose(); };
    },
  };
}
