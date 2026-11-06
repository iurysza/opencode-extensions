import type { Plugin } from "@opencode/plugin";
import { cloudKey } from "../core/auth.js";
import { messageIdFactory } from "../core/message-id.js";
import { createCloudClient, type CloudClient } from "../core/cloud-client.js";
import { createCloudService, type CloudService } from "../core/cloud-service.js";
import { attachCompletionReceipts, type CompletionContext } from "./completion.js";
import { registerCloudTools, type CloudTools } from "./tools.js";
import type { registerControls, ControlContext } from "./control-rpc.js";
import type { SnapshotInput } from "../control-contract.js";
import type { CloudResponse } from "../core/cloud-service.js";

export const PLUGIN_ID = "iurysza.cursor-cloud";
/** Only minimum-version public capabilities. Also checked against the 2.0.0 alias in tests. */
export interface CloudContext extends CompletionContext {
  readonly app: { readonly version: string };
  readonly location: { readonly directory: string; readonly workspaceID?: string };
  readonly tool: CloudTools;
  readonly command: Pick<Plugin.Context["command"], "transform">;
  readonly integration: {
    readonly transform: (callback: (editor: { readonly method: { update(input: { integrationID: string; method: { type: "key"; label: string } }): void } }) => void) => Promise<{ dispose(): Promise<void> }>;
    /** ConnectionInfo changes across 2.x. Only round-trip this opaque host value. */
    readonly connection: {
      active(integrationID: string): Promise<unknown>;
      resolve(connection: unknown): Promise<unknown>;
    };
  };
  /** Presence check only. The control adapter owns the version-specific RPC contract. */
  readonly rpc: { readonly register: unknown };
}
export interface CloudPluginOptions {
  readonly client?: CloudClient;
  readonly diagnostic?: (message: string) => void;
  /** Test/control seam. Backend remains the sole owner; never expose credentials through it. */
  readonly serviceReady?: (service: CloudService) => void;
}

/** Structural define: no runtime import of the host, Cursor SDK, TUI, or credentials. */
export function createCloudPlugin(options: CloudPluginOptions = {}) {
  return {
    id: PLUGIN_ID,
    async setup(context: CloudContext): Promise<() => Promise<void>> {
      const diagnostic = (message: string) => { try { (options.diagnostic ?? console.warn)(message); } catch {} };
      if (!/^v?2\.\d+\.\d+(?:[-+].*)?$/.test(context?.app?.version ?? "") ||
          typeof context?.tool?.transform !== "function" || typeof context?.command?.transform !== "function" ||
          typeof context?.session?.synthetic !== "function" || typeof context?.rpc?.register !== "function" ||
          typeof context?.integration?.transform !== "function" || typeof context?.integration?.connection?.active !== "function" || typeof context?.integration?.connection?.resolve !== "function" ||
          typeof context?.storage?.scan !== "function" || typeof context?.event?.subscribe !== "function") {
        diagnostic("Cursor Cloud disabled: OpenCode >=2.0.0 <3 public tool, command, auth, receipt and RPC APIs are required.");
        return async () => {};
      }
      if (context.location.workspaceID !== undefined || !context.location.directory) {
        diagnostic("Cursor Cloud disabled: remote workspaces are unsupported.");
        return async () => {};
      }
      const receipts = attachCompletionReceipts(context, { diagnostic: () => diagnostic("Cursor Cloud completion receipt needs attention.") });
      const client = options.client ?? createCloudClient(cloudKey({
        hostCredential: async () => {
          const active = await context.integration.connection.active("cursor");
          if (!active) return undefined;
          const credential = await context.integration.connection.resolve(active);
          if (!credential) throw new Error("Unresolved cursor credential.");
          return credential;
        },
        envKey: () => process.env.CURSOR_API_KEY,
      }));
      let controls: Awaited<ReturnType<typeof registerControls>> | undefined;
      const changed = (sessionID: string) => { void controls?.publish({ sessionID, location: { directory: context.location.directory, workspaceID: undefined } }).catch(() => {}); };
      const service = createCloudService({ client, receipts: receipts.service, location: context.location,
        currentLocation: () => context.location, diagnostic, onChange: changed });
      const project = (result: CloudResponse): SnapshotInput => {
        if (result._tag === "err") throw new Error("Cursor Cloud action refused.");
        return { items: result.value.agents.slice(0, 100).map(agent => ({ id: agent.id,
          state: agent.remote === "never" ? "not_created" : agent.status.type === "starting" || agent.status.type === "running" ? "running" :
            agent.status.type === "idle" ? "finished" : agent.status.type === "cancelled" ? "cancelled" : "failed" })) };
      };
      const checkAbort = (signal: AbortSignal) => { if (signal.aborted) throw new Error("Cloud action aborted."); };
      const registrations: { dispose(): Promise<void> }[] = [];
      const mint = messageIdFactory();
      const cleanup = async () => {
        await service.dispose(); // Detach only. Never send, cancel or delete during cleanup.
        receipts.dispose();
        await controls?.dispose();
        await Promise.all(registrations.map(async registration => { try { await registration.dispose(); } catch {} }));
      };
      try {
        await receipts.ready;
        await receipts.service.recover(); // Receipts only. No remote agent rehydration.
        registrations.push(await context.integration.transform(editor => editor.method.update({
          integrationID: "cursor", method: { type: "key", label: "Cursor API key" },
        })));
        registrations.push(await registerCloudTools(context.tool, service));
        registrations.push(await context.command.transform(editor => editor.add({
          name: "cloud-delete", description: "Delete an inactive process-owned Cloud agent: /cloud-delete <id> --confirm",
          async execute(input) {
            const match = /^\s*([\w-]{1,256})\s+--confirm\s*$/.exec(input.prompt.text);
            const result = match?.[1] ? await service.delete(input.sessionID, match[1], true) : undefined;
            const text = result ? result._tag === "ok" ? result.value.text : result.error.message : "Usage: /cloud-delete <id> --confirm. Deletion is irreversible.";
            try { await context.session.synthetic({ sessionID: input.sessionID, id: mint(), text, metadata: { source: "cursor-cloud-command" }, resume: false }); }
            catch { diagnostic("Cursor Cloud command result could not be displayed; check status before retrying deletion."); }
          },
        })));
        // The real host implements the public control context. Legacy tool-only mocks can
        // omit session.get; no second service or SDK owner is constructed for RPC.
        if (typeof (context.session as Partial<Plugin.Context["session"]>).get === "function") {
          const { registerControls } = await import("./control-rpc.js");
          controls = await registerControls(context as unknown as ControlContext, {
            status: async ({ scope }) => project(await service.status(scope.sessionID)),
            ledger: async ({ scope }) => project(await service.status(scope.sessionID)),
            // Fixed bundled fallback. Reads never acquire SDK credentials or start work.
            models: async () => ({ items: [{ id: "composer-2.5", state: "unknown" }] }),
            spawn: async ({ scope, prompt, repository, model }, signal) => { checkAbort(signal); return project(await service.spawn(scope.sessionID, { prompt, repo: repository, model })); },
            followup: async ({ scope, id, prompt }, signal) => { checkAbort(signal); if ((await service.status(scope.sessionID, id))._tag === "err") return { refused: "scope" }; return project(await service.send(scope.sessionID, id, prompt)); },
            cancel: async ({ scope, id, confirmed }, signal) => { checkAbort(signal); if ((await service.status(scope.sessionID, id))._tag === "err") return { refused: "scope" }; if (!confirmed) throw new Error("Confirmation required."); return project(await service.cancel(scope.sessionID, id)); },
            delete: async ({ scope, id, confirmed }, signal) => { checkAbort(signal); if ((await service.status(scope.sessionID, id))._tag === "err") return { refused: "scope" }; return project(await service.delete(scope.sessionID, id, confirmed)); },
          });
        }
        options.serviceReady?.(service);
        return cleanup;
      } catch {
        await cleanup();
        diagnostic("Cursor Cloud setup failed; background tools are disabled.");
        return async () => {};
      }
    },
  };
}
