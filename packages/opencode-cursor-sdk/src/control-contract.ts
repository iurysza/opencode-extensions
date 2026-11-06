// Portable Standard Schema v1. No Effect/OpenTUI runtime enters the backend contract.
import { Rpc } from "@opencode/plugin";

export interface ValueSchema<T> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: "cursor-controls";
    readonly types?: { readonly input: T; readonly output: T };
    readonly validate: (value: unknown) => { value: T } | { issues: readonly { message: string }[] };
  };
}
export function schema<T>(parse: (value: unknown) => T): ValueSchema<T> {
  return { "~standard": { version: 1, vendor: "cursor-controls", validate(value) {
    try { return { value: parse(value) }; }
    catch { return { issues: [{ message: "Invalid bounded control value" }] }; }
  } } };
}
export function parse<T>(s: ValueSchema<T>, value: unknown): T {
  const result = s["~standard"].validate(value);
  if ("issues" in result) throw new Error("Invalid bounded control value");
  return result.value;
}
type Fields = Record<string, ValueSchema<unknown>>;
type FieldValue<S> = S extends ValueSchema<infer T> ? T : never;
type Values<F extends Fields> = {
  [K in keyof F as undefined extends FieldValue<F[K]> ? never : K]: FieldValue<F[K]>;
} & {
  [K in keyof F as undefined extends FieldValue<F[K]> ? K : never]?: FieldValue<F[K]>;
};
export function object<const F extends Fields>(fields: F): ValueSchema<Values<F>> {
  return schema(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw 0;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some(k => !Object.hasOwn(fields, k))) throw 0;
    // Each key is parsed by its associated field schema before restoring the mapped type.
    return Object.fromEntries(Object.entries(fields).map(([k, s]) => [k, parse(s, record[k])]).filter(([, value]) => value !== undefined)) as Values<F>;
  });
}
export const choice = <const T extends readonly string[]>(...values: T) => schema<T[number]>(v => {
  if (typeof v !== "string" || !values.includes(v)) throw 0;
  return v as T[number];
});
const secret = /(?:bearer\s|(?:api[_-]?key|authorization|password|secret|token)\s*[:=]|sk[-_][a-z0-9_-]{8,}|cur[_-][a-z0-9_-]{12,})/i;
export function displayText(value: string): string {
  return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/(?:bearer\s+\S+|(?:api[_-]?key|authorization|password|secret|token)\s*[:=]\s*\S+|(?:sk|cur)[-_][a-z0-9_-]{8,})/gi, "[redacted]").slice(0, 4096);
}
export const text = (max: number, pattern?: RegExp) => schema<string>(v => {
  if (typeof v !== "string" || !v.trim() || v.length > max || secret.test(v) || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(v) || (pattern && !pattern.test(v))) throw 0;
  return v;
});
export const id = text(160, /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/);
const optional = <T>(s: ValueSchema<T>) => schema<T | undefined>(v => v === undefined ? undefined : parse(s, v));
const boolean = schema<boolean>(v => { if (typeof v !== "boolean") throw 0; return v; });
const confirmed = schema<true>(v => { if (v !== true) throw 0; return true; });
export const locationSchema = object({ directory: text(4096, /^\//), workspaceID: optional(id) });
export const scopeSchema = object({ sessionID: id, location: locationSchema });
// Infer without depending on the host's Schema or branded ID types.
export type SchemaValue<S> = S extends ValueSchema<infer T> ? T : never;
export type Scope = SchemaValue<typeof scopeSchema>;
const state = choice("idle", "running", "finished", "failed", "cancelled", "archived", "unknown");
const item = object({ id, state });
const items = schema<SchemaValue<typeof item>[]>(v => {
  if (!Array.isArray(v) || v.length > 100) throw 0;
  return v.map(x => parse(item, x));
});
export const snapshotSchema = object({
  state: optional(state), runtime: optional(choice("local", "cloud")), items: optional(items),
  fast: optional(boolean), mode: optional(choice("agent", "plan")),
  tools: optional(choice("native", "bridge", "both")), http: optional(choice("auto", "http1")),
  resumeCleanup: optional(boolean),
});
export type Snapshot = SchemaValue<typeof snapshotSchema>;
export type SnapshotInput = Partial<Snapshot>;
export const resultSchema = object({ code: choice("ok", "not_implemented", "refused", "failed", "aborted", "invalid_input"), snapshot: optional(snapshotSchema) });
export type ControlResult = SchemaValue<typeof resultSchema>;
export const statusSchema = object({ scope: scopeSchema, state: choice("changed"), });
const read = object({ scope: scopeSchema });
const destructive = object({ scope: scopeSchema, id, confirmed });
const method = <T>(input: ValueSchema<T>) => ({ input, output: resultSchema });
export const REMOTE_ACK = "remote-execution-billing-persistent-session-scope-v1" as const;

export const controls = Rpc.define({ id: "cursor-sdk-controls", methods: {
  status: method(read), models: method(read), ledger: method(read),
  archive: method(destructive), delete: method(destructive),
  runtime: method(object({ scope: scopeSchema, runtime: choice("local", "cloud"), acknowledgement: optional(choice(REMOTE_ACK)) })),
  fast: method(object({ scope: scopeSchema, enabled: boolean })),
  mode: method(object({ scope: scopeSchema, mode: choice("agent", "plan") })),
  tools: method(object({ scope: scopeSchema, tools: choice("native", "bridge", "both") })),
  http: method(object({ scope: scopeSchema, http: choice("auto", "http1") })),
  resumeCleanup: method(object({ scope: scopeSchema, enabled: boolean })),
  refreshModels: method(read), refreshConfig: method(read),
}, events: { status: { schema: statusSchema } } });

export type MethodName = keyof typeof controls.methods;
export type Inputs = { [K in MethodName]: SchemaValue<typeof controls.methods[K]["input"]> };
/** Actions must restrict agent/ledger IDs to this verified session and location, not a global ledger. */
export type ControlActions = { readonly [K in MethodName]?: (input: Inputs[K], signal: AbortSignal) => Promise<SnapshotInput | void | ActionRefusal> };

export type ActionRefusal = { readonly refused: "scope" | "unavailable" };
