/**
 * Maps Cursor native tool calls to OpenCode built-in tool names and input shapes,
 * so the stock TUI draws its native card (F-06). Input that fails the built-in
 * shape keeps the collision-safe `cursor_<type>` name (F-09). Pure functions only.
 */
import { json, record } from "../core/bridge.js";
import type { JsonValue } from "../core/turn-events.js";

export interface NativeCall {
  readonly name: string;
  readonly input: JsonValue;
  /** Leaf tools that cannot nest MCP calls; only these are emitted when they start. */
  readonly live: boolean;
}
export interface NativeResult {
  readonly text: string;
  readonly isError: boolean;
  /** Unified diff for edits. The edit card reads diffs only from metadata, which a provider result cannot set. */
  readonly diff?: string;
}

const MAX_LINES = 200;
const MAX_CHARS = 16_000;
const MAX_ITEMS = 100;
const TODO_STATUS: Record<string, string> = { pending: "pending", inProgress: "in_progress", completed: "completed", cancelled: "cancelled" };

/** OpenCode's own path rule (2.0.0 and 2.2.5): nonempty and no NUL bytes. */
const path = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 && !value.includes("\0") ? value : undefined;
const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const nonempty = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
const optional = <T>(value: T | undefined, ok: boolean): ok is true => ok || value === undefined;

/** Built-in input for one Cursor tool, or undefined when it would fail the built-in schema. */
function builtin(type: string, args: Record<string, unknown>): { name: string; input: Record<string, unknown> } | undefined {
  switch (type) {
    case "shell": {
      const command = nonempty(args.command);
      const workdir = args.workingDirectory;
      const timeout = args.timeout;
      if (!command || !optional(workdir, !!path(workdir)) || !optional(timeout, typeof timeout === "number" && Number.isFinite(timeout) && timeout >= 0)) return undefined;
      return { name: "shell", input: { command, ...(workdir !== undefined ? { workdir } : {}), ...(timeout !== undefined ? { timeout } : {}) } };
    }
    case "read": {
      const file = path(args.path);
      return file ? { name: "read", input: { path: file } } : undefined;
    }
    case "write": {
      const file = path(args.path);
      const content = text(args.fileText);
      return file && content !== undefined ? { name: "write", input: { path: file, content } } : undefined;
    }
    case "edit": {
      // Cursor edit args carry only the path; the card reads only `input.path`.
      const file = path(args.path);
      return file ? { name: "edit", input: { path: file } } : undefined;
    }
    case "grep": {
      const pattern = nonempty(args.pattern);
      if (!pattern || !optional(args.path, !!path(args.path)) || !optional(args.glob, typeof args.glob === "string")) return undefined;
      return { name: "grep", input: { pattern, ...(args.path !== undefined ? { path: args.path } : {}), ...(args.glob !== undefined ? { include: args.glob } : {}) } };
    }
    case "glob": {
      const pattern = nonempty(args.globPattern);
      if (!pattern || !optional(args.targetDirectory, !!path(args.targetDirectory))) return undefined;
      return { name: "glob", input: { pattern, ...(args.targetDirectory !== undefined ? { path: args.targetDirectory } : {}) } };
    }
    case "updateTodos": {
      if (!Array.isArray(args.todos)) return undefined;
      const todos = args.todos.map((item) => {
        const todo = record(item);
        const status = typeof todo?.status === "string" ? TODO_STATUS[todo.status] : undefined;
        return typeof todo?.content === "string" && status ? { content: todo.content, status } : undefined;
      });
      return todos.every((todo) => todo) ? { name: "todowrite", input: { todos } } : undefined;
    }
    default: return undefined;
  }
}
const LEAF = new Set(["shell", "read", "write", "edit", "grep", "glob", "updateTodos"]);

export const fallbackName = (type: string): string => `cursor_${type.replace(/[^a-zA-Z0-9_]/g, "_")}`;

/** Chooses the name and input once; the caller must reuse them for the result. */
export function nativeCall(type: string, args: unknown): NativeCall {
  const live = LEAF.has(type);
  const mapped = record(args) && builtin(type, record(args)!);
  return mapped ? { name: mapped.name, input: json(mapped.input), live } : { name: fallbackName(type), input: json(args), live };
}

export function limit(value: string, maxLines = MAX_LINES, maxChars = MAX_CHARS): string {
  const lines = value.split("\n");
  let out = lines.slice(0, maxLines).join("\n");
  let cut = lines.length > maxLines;
  if (out.length > maxChars) { out = out.slice(0, maxChars); cut = true; }
  return cut ? `${out}\n... (truncated)` : out;
}
const items = (list: string[], noun: string): string => {
  const shown = list.slice(0, MAX_ITEMS).join("\n");
  return limit(list.length > MAX_ITEMS ? `${shown}\n... (${list.length - MAX_ITEMS} more ${noun})` : shown);
};
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const num = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const generic = (value: unknown): string => typeof value === "string" ? limit(value) : value === undefined ? "Done" : limit(JSON.stringify(value) ?? "", 20, 2_000);

function errorText(error: unknown): string {
  const obj = record(error);
  const message = typeof error === "string" ? error : typeof obj?.message === "string" ? obj.message : typeof obj?.error === "string" ? obj.error : undefined;
  return `Error: ${limit(message ?? (error === undefined ? "Cursor tool failed" : JSON.stringify(error) ?? "Cursor tool failed"), 20, 2_000)}`;
}

function searchLines(value: Record<string, unknown> | undefined): string[] {
  const workspace = record(value?.workspaceResults);
  const outputs = [value?.activeEditorResult, ...(workspace ? Object.values(workspace) : [])].filter((item) => item !== undefined);
  const lines: string[] = [];
  for (const entry of outputs) {
    const result = record(entry);
    const output = record(result?.output);
    if (result?.type === "content") {
      for (const match of Array.isArray(output?.matches) ? output.matches : []) {
        const m = record(match);
        const file = String(m?.file ?? "");
        const at = num(m?.lineNumber) !== undefined ? `${file}:${m!.lineNumber}` : file;
        const line = typeof m?.line === "string" ? m.line : "";
        lines.push(line ? `${at}: ${line}` : at);
      }
    } else if (result?.type === "files") {
      for (const file of Array.isArray(output?.files) ? output.files : []) if (typeof file === "string") lines.push(file);
    } else if (result?.type === "count") {
      for (const count of Array.isArray(output?.counts) ? output.counts : []) { const c = record(count); lines.push(`${String(c?.file ?? "")}: ${num(c?.count) ?? 0}`); }
    }
  }
  return lines.filter(Boolean);
}

/** Readable result text for one Cursor tool, independent of the chosen name. */
export function nativeResult(type: string, args: unknown, raw: unknown): NativeResult {
  const result = record(raw);
  if (result?.status === "error") return { text: errorText(result.error), isError: true };
  const value = result && "value" in result ? result.value : raw;
  const v = record(value);
  const a = record(args) ?? {};
  switch (type) {
    case "shell": {
      const parts = [text(v?.stdout)?.trimEnd(), text(v?.stderr)?.trimEnd()].filter((part): part is string => !!part);
      const exit = num(v?.exitCode);
      if (exit !== undefined && exit !== 0) parts.push(`Exit code: ${exit}`);
      return { text: limit(parts.join("\n\n") || "(no output)"), isError: false };
    }
    case "read": {
      const lines = num(v?.totalLines);
      const size = num(v?.fileSize);
      const detail = [lines !== undefined ? plural(lines, "line") : undefined, size !== undefined ? plural(size, "byte") : undefined].filter(Boolean).join(", ");
      return { text: `Read ${String(a.path ?? "file")}${detail ? ` (${detail})` : ""}`, isError: false };
    }
    case "write": {
      const lines = num(v?.linesCreated);
      return { text: `Wrote ${String(v?.path ?? a.path ?? "file")}${lines !== undefined ? ` (${plural(lines, "line")})` : ""}`, isError: false };
    }
    case "edit": {
      const diff = ["diffString", "diff", "unifiedDiff", "patch"].map((key) => v?.[key]).find((item): item is string => typeof item === "string" && item.length > 0);
      const added = num(v?.linesAdded);
      const removed = num(v?.linesRemoved);
      const stats = added !== undefined || removed !== undefined ? ` (+${added ?? 0} -${removed ?? 0})` : "";
      const shown = diff ? limit(diff.trimEnd()) : undefined;
      return { text: `Edited ${String(a.path ?? "file")}${stats}${shown ? `\n\n${shown}` : ""}`, isError: false, ...(shown ? { diff: shown } : {}) };
    }
    case "grep": {
      const lines = searchLines(v);
      const total = num(v?.totalMatches);
      return { text: lines.length ? items(lines, "matches") : total ? plural(total, "match") : "No matches found", isError: false };
    }
    case "glob": {
      const files = Array.isArray(v?.files) ? v.files.filter((file): file is string => typeof file === "string") : [];
      const truncated = v?.clientTruncated === true || v?.ripgrepTruncated === true ? "\n(Results are truncated.)" : "";
      return { text: files.length ? `${items(files, "files")}${truncated}` : "No files found", isError: false };
    }
    case "updateTodos": {
      const todos = (Array.isArray(v?.todos) ? v.todos : Array.isArray(a.todos) ? a.todos : []).map(record).filter((todo) => typeof todo?.content === "string");
      const done = todos.filter((todo) => todo!.status === "completed").length;
      return { text: todos.length ? `Todos updated: ${done}/${todos.length} completed` : "Todos cleared", isError: false };
    }
    default: return { text: generic(value), isError: false };
  }
}

/** Markdown shown after an edit card so the diff is visible in the transcript. */
export const diffBlock = (diff: string): string => `\n\n\`\`\`diff\n${diff}\n\`\`\`\n\n`;
