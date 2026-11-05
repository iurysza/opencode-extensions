import type { CloudResponse, CloudService, SpawnParams } from "../core/cloud-service.js";

const textField = (maxLength = 2048) => ({ type: "string" as const, minLength: 1, maxLength });
const schema = (properties: Record<string, object>, required: string[]) => ({ type: "object" as const, properties, required, additionalProperties: false });
export interface CloudTool {
  readonly name: string;
  readonly description: string;
  readonly input: ReturnType<typeof schema>;
  readonly options: { readonly codemode: false };
  readonly execute: (input: unknown, context: { readonly sessionID: string; readonly progress: (update: Record<string, unknown>) => Promise<void> }) => Promise<{ readonly content: string; readonly metadata: Record<string, unknown> }>;
}
export interface CloudTools {
  readonly transform: (callback: (editor: { add(tool: CloudTool): void }) => void) => Promise<{ dispose(): Promise<void> }>;
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Cloud tool input.");
  return value as Record<string, unknown>;
};
function string(input: Record<string, unknown>, key: string): string;
function string(input: Record<string, unknown>, key: string, optional: true): string | undefined;
function string(input: Record<string, unknown>, key: string, optional = false): string | undefined {
  const value = input[key];
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error("Invalid Cloud tool input.");
  return value;
}
export function cloudToolResult(result: CloudResponse) {
  return result._tag === "ok"
    ? { content: result.value.text, metadata: { agents: result.value.agents, receiptIssues: result.value.receiptIssues } }
    : { content: result.error.message, metadata: { isError: true } };
}

/** Public tool.transform and tool-context progress, available since 2.0.0. No current-session global. */
export async function registerCloudTools(tool: CloudTools, service: CloudService) {
  return tool.transform(editor => {
    const definitions = [
      { name: "cursor_cloud_spawn", description: "Start a paid background Cursor Cloud run at Max Mode pricing. Cloud sees the remote ref, not local or unpushed commits. Results arrive later in this session.",
        input: schema({ prompt: textField(100_000), repo: textField(), ref: textField(), model: textField(), name: textField(200) }, ["prompt"]),
        run: (sessionID: string, input: Record<string, unknown>) => {
          const params: SpawnParams = { prompt: string(input, "prompt"), repo: string(input, "repo", true), ref: string(input, "ref", true), model: string(input, "model", true), name: string(input, "name", true) };
          return service.spawn(sessionID, params);
        } },
      { name: "cursor_cloud_send", description: "Send a paid follow-up to an idle Cloud agent created in this process and session. Active runs reject follow-ups.",
        input: schema({ id: textField(256), prompt: textField(100_000) }, ["id", "prompt"]),
        run: (sessionID: string, input: Record<string, unknown>) => service.send(sessionID, string(input, "id"), string(input, "prompt")) },
      { name: "cursor_cloud_status", description: "Read status and results of this session's process-owned Cloud agents only.",
        input: schema({ id: textField(256) }, []),
        run: (sessionID: string, input: Record<string, unknown>) => service.status(sessionID, string(input, "id", true)) },
      { name: "cursor_cloud_cancel", description: "Request cancellation of a Cloud run created in this process and session. Shutdown never cancels remote work.",
        input: schema({ id: textField(256) }, ["id"]),
        run: (sessionID: string, input: Record<string, unknown>) => service.cancel(sessionID, string(input, "id")) },
    ];
    for (const definition of definitions) editor.add({
      name: definition.name, description: definition.description, input: definition.input, options: { codemode: false },
      async execute(input, context) {
        const sessionID = context.sessionID; // Capture before any await; never infer from focused UI.
        let parsed: Record<string, unknown>;
        try {
          parsed = record(input);
          if (Object.keys(parsed).some(key => !(key in definition.input.properties))) throw new Error();
        } catch { return { content: "Invalid Cloud tool input.", metadata: { isError: true } }; }
        // Progress is advisory. A disconnected tool observer must not duplicate or block a launch.
        try { await context.progress({ title: definition.name, status: "starting" }); } catch {}
        try { return cloudToolResult(await definition.run(sessionID, parsed)); }
        catch { return { content: "Invalid Cloud tool input or unavailable Cloud action.", metadata: { isError: true } }; }
      },
    });
  });
}
