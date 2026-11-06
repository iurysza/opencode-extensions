// MIT, OpenCode adaptation of pi-cursor-sdk's loopback bridge design.
// Copyright (c) 2026 Mitch Fultz. See the package LICENSE.
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { CursorTurnEvent, JsonValue } from "./turn-events.js";

export const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
const validJson = (value: unknown, depth = 0): boolean => {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => validJson(item, depth + 1));
  const obj = record(value);
  return !!obj && Object.values(obj).every((item) => validJson(item, depth + 1));
};
export interface BridgeResult { content: { type: "text"; text: string }[]; isError?: boolean }
const failure = (text: string): BridgeResult => ({ content: [{ type: "text", text }], isError: true });

/** Accept only explicit V3 outputs. Empty strings and empty content arrays are valid. */
export function parseToolOutput(value: unknown): BridgeResult {
  const output = record(value);
  if (!output) throw new Error("Malformed OpenCode tool result");
  switch (output.type) {
    case "text": case "error-text":
      if (typeof output.value !== "string") break;
      // OpenCode 2.x serializes tool failures as a text JSON envelope, even
      // though V3 also has error-text. Do not report that envelope as success.
      if (output.type === "text") {
        let envelope: Record<string, unknown> | undefined;
        try { envelope = record(JSON.parse(output.value)); } catch { /* ordinary text */ }
        if (envelope && "error" in envelope && "content" in envelope) {
          const error = record(envelope.error);
          if (!error || typeof error.type !== "string" || typeof error.message !== "string" || !Array.isArray(envelope.content)) throw new Error("Malformed OpenCode error envelope");
          return failure("OpenCode tool execution failed or was denied");
        }
      }
      return { content: [{ type: "text", text: output.value }], isError: output.type === "error-text" };
    case "json": case "error-json":
      if (!("value" in output) || !validJson(output.value)) break;
      return { content: [{ type: "text", text: JSON.stringify(output.value) }], isError: output.type === "error-json" };
    case "execution-denied":
      return failure("OpenCode denied tool execution");
    case "content":
      if (!Array.isArray(output.value)) break;
      return { content: output.value.map((part) => {
        const item = record(part);
        if (item?.type !== "text" || typeof item.text !== "string") throw new Error("Unsupported OpenCode tool content");
        return { type: "text", text: item.text };
      }) };
  }
  throw new Error("Malformed OpenCode tool result");
}

/** One endpoint per live SDK run. This class never executes host tools. */
export class ToolBridge {
  readonly serverName = `opencode_${randomUUID().replaceAll("-", "")}`;
  readonly tools = new Map<string, { name: string; description?: string; inputSchema: unknown }>();
  readonly pending = new Map<string, { name: string; resolve: (result: BridgeResult) => void; emitted: boolean }>();
  private server?: Server;
  private disposed = false;
  private path = `/mcp/${randomUUID()}`;
  url?: string;
  constructor(tools: unknown, private readonly emit: (event: CursorTurnEvent) => void) {
    if (!Array.isArray(tools)) return;
    for (const entry of tools) {
      const tool = record(entry);
      if (tool?.type !== "function" || typeof tool.name !== "string" || !record(tool.inputSchema)) continue;
      // Mint names independently of host names: sanitized names cannot collide.
      this.tools.set(`oc_${this.tools.size}_${randomUUID().replaceAll("-", "")}`, {
        name: tool.name, description: typeof tool.description === "string" ? tool.description : undefined,
        inputSchema: tool.inputSchema,
      });
    }
  }
  async start(): Promise<void> {
    if (!this.tools.size) return;
    const server = this.server = createServer(async (req, res) => {
      const reply = (status: number, data?: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(data === undefined ? undefined : JSON.stringify(data));
      };
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "")) return reply(403);
      if (req.url !== this.path) return reply(404);
      if (this.disposed) return reply(410);
      if (req.method !== "POST") return reply(405);
      try {
        let body = "";
        for await (const chunk of req) {
          body += String(chunk);
          if (body.length > 1_048_576) return reply(413);
        }
        const rpc = record(JSON.parse(body));
        if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") return reply(400);
        if (rpc.id === undefined) return reply(202);
        let result: unknown;
        switch (rpc.method) {
          case "initialize": result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: this.serverName, version: "1.0.0" } }; break;
          case "ping": result = {}; break;
          case "tools/list": result = { tools: [...this.tools].map(([name, tool]) => ({ name, description: tool.description, inputSchema: tool.inputSchema, _meta: { opencodeToolName: tool.name } })) }; break;
          case "tools/call": {
            const params = record(rpc.params);
            const tool = typeof params?.name === "string" ? this.tools.get(params.name) : undefined;
            if (!tool || !record(params?.arguments)) result = failure("Unknown tool or invalid arguments");
            else result = await this.call(tool.name, json(params?.arguments));
            break;
          }
          default: return reply(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } });
        }
        reply(200, { jsonrpc: "2.0", id: rpc.id, result });
      } catch { reply(400); }
    });
    // No default HTTP timeout may terminate an MCP call while OpenCode asks permission.
    server.requestTimeout = 0;
    server.timeout = 0;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Bridge listener unavailable");
    this.url = `http://127.0.0.1:${address.port}${this.path}`;
  }
  private call(name: string, input: JsonValue): Promise<BridgeResult> {
    if (this.disposed) return Promise.resolve(failure("Cursor bridge disposed"));
    const callId = `oc-bridge-${randomUUID()}`;
    return new Promise((resolve) => {
      this.pending.set(callId, { name, resolve, emitted: false });
      this.emit({ type: "bridge-tool-call", callId, toolName: name, input });
    });
  }
  markEmitted(id: string): void { const call = this.pending.get(id); if (call) call.emitted = true; }
  ingest(prompt: unknown): void {
    const expected = [...this.pending].filter(([, call]) => call.emitted);
    if (!expected.length) return;
    if (!Array.isArray(prompt)) throw new Error("Missing OpenCode tool results");
    // Only the trailing tool response batch belongs to this continuation. Historical
    // results cannot satisfy a pending call, even when a host tool name is reused.
    const tail = prompt.at(-1);
    const message = record(tail);
    const parts = message?.role === "tool" && Array.isArray(message.content) ? message.content : [];
    const parsed = expected.map(([id, call]) => {
      const matches = parts.map(record).filter((part) => part?.type === "tool-result" && part.toolCallId === id);
      if (matches.length !== 1 || matches[0]?.toolName !== call.name) throw new Error("Missing or mismatched OpenCode tool result");
      return { id, call, result: parseToolOutput(matches[0].output) };
    });
    for (const { id, call, result } of parsed) { this.pending.delete(id); call.resolve(result); }
  }
  isEcho(value: unknown): boolean {
    const visit = (item: unknown, depth: number): boolean => {
      if (depth > 6) return false;
      if (typeof item === "string") return item === this.serverName || this.tools.has(item);
      if (Array.isArray(item)) return item.some((part) => visit(part, depth + 1));
      const obj = record(item);
      return obj !== undefined && Object.values(obj).some((part) => visit(part, depth + 1));
    };
    return visit(value, 0);
  }
  async close(reason = "Cursor bridge disposed"): Promise<void> {
    this.disposed = true;
    for (const call of this.pending.values()) call.resolve(failure(reason));
    this.pending.clear();
    const server = this.server;
    if (server) {
      // Let the outstanding JSON-RPC error flush before closing its socket.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => server.closeAllConnections(), 250);
        server.close(() => { clearTimeout(force); resolve(); });
        server.closeIdleConnections();
      });
      this.server = undefined;
    }
  }
}
