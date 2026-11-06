import type { Plugin } from "@opencode/plugin";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLocalRuntime, LocalTurnError, type LocalRuntimeDependencies } from "../provider/local-runtime.js";
import { codingOnly } from "../provider/language-model.js";

export interface LocalPluginOptions {
  readonly loadSdk?: LocalRuntimeDependencies["loadSdk"];
  readonly getOptions?: LocalRuntimeDependencies["getOptions"];
  readonly stateRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly warn?: (message: string) => void;
}

/** Host-stored personal key first, env second. No SDK or Pi credential lookup. */
export async function resolveHostKey(context: Pick<Plugin.Context, "integration">, env: Readonly<Record<string, string | undefined>>): Promise<string | undefined> {
  const integration = context.integration;
  const [active, catalog] = await Promise.all([
    integration.connection.active("cursor"),
    integration.get({ integrationID: "cursor" }),
  ]);
  const stored = active?.type === "credential" && active.method === "key"
    ? active : catalog.data.connections.find((item) => item.type === "credential" && item.method === "key");
  if (stored) {
    const credential = await integration.connection.resolve(stored);
    if (credential?.type !== "key" || !credential.key.trim()) throw new LocalTurnError("auth");
    return credential.key;
  }
  return env.CURSOR_API_KEY;
}

export async function composeLocal(context: unknown, options: LocalPluginOptions = {}) {
  // parseHost has already validated the host version. Only public 2.0.0 APIs below.
  const ctx = context as Plugin.Context;
  const registration = await ctx.integration.transform((editor) => {
    editor.update("cursor", (integration) => { integration.name = "Cursor"; });
    editor.method.update({ integrationID: "cursor", method: { type: "key", label: "Personal Cursor API key" } });
    editor.method.update({ integrationID: "cursor", method: { type: "env", names: ["CURSOR_API_KEY"] } });
  });
  const env = options.env ?? process.env;
  const runtime = createLocalRuntime({
    cwd: ctx.location.directory,
    stateRoot: options.stateRoot ?? join(env.XDG_STATE_HOME ?? join(env.HOME ?? homedir(), ".local", "state"), "opencode", "cursor-sdk"),
    getApiKey: () => resolveHostKey(ctx, env),
    getOptions: options.getOptions,
    inspectSession: async (sessionID) => {
      const [info, messages] = await Promise.all([ctx.session.get({ sessionID }), ctx.session.context({ sessionID })]);
      return { info, messages };
    },
    loadSdk: options.loadSdk,
    warn: options.warn ?? ((message) => console.warn(message)),
  });
  let disposed = false;
  return { lanes: codingOnly(runtime.source), controls: runtime.controls, async dispose() {
    if (disposed) return;
    disposed = true;
    try { await runtime.controls.dispose(); } finally { await registration.dispose(); }
  } };
}
