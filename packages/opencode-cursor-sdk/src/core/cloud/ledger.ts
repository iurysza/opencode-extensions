import { randomUUID } from "node:crypto";

export type CloudPhase = "prepared" | "created" | "running" | "finished" | "error" | "cancelled" |
  "archive_intent" | "delete_intent" | "archived" | "deleted";
export interface CloudRecord {
  readonly operationID: string;
  readonly sessionID: string;
  readonly phase: CloudPhase;
  readonly agentID?: string;
  readonly runID?: string;
}
export interface CloudLedger {
  readonly version: 1;
  readonly sessionID: string;
  readonly records: readonly CloudRecord[];
}
/** write resolves only after durable host persistence; never an SDK database or memory cache. */
export interface ForegroundCloudStore {
  sessionExists(sessionID: string): Promise<boolean>;
  read(sessionID: string): Promise<unknown>;
  write(sessionID: string, ledger: CloudLedger): Promise<void>;
}
export class CloudRuntimeError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "CloudRuntimeError"; }
}
export const validCloudAgentID = (id: unknown): id is string => typeof id === "string" &&
  /^bc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const validRunID = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(id);
const phases: readonly string[] = ["prepared", "created", "running", "finished", "error", "cancelled", "archive_intent", "delete_intent", "archived", "deleted"];
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
export const pendingIntent = (entry: CloudRecord): boolean => entry.phase === "archive_intent" || entry.phase === "delete_intent";

export async function readCloudLedger(store: ForegroundCloudStore, sessionID: string): Promise<CloudLedger> {
  const raw = await store.read(sessionID);
  if (raw === undefined) return { version: 1, sessionID, records: [] };
  if (!record(raw) || raw.version !== 1 || raw.sessionID !== sessionID || !Array.isArray(raw.records)) {
    throw new CloudRuntimeError("ledger_invalid", "Cursor Cloud ledger is invalid; no remote action was taken.");
  }
  const entries: CloudRecord[] = [];
  const seen = new Set<string>();
  for (const item of raw.records) {
    if (!record(item) || item.sessionID !== sessionID || typeof item.operationID !== "string" ||
      !/^[a-zA-Z0-9-]{1,256}$/.test(item.operationID) || seen.has(item.operationID) ||
      typeof item.phase !== "string" || !phases.includes(item.phase) ||
      (item.agentID !== undefined && !validCloudAgentID(item.agentID)) ||
      (item.runID !== undefined && !validRunID(item.runID)) ||
      (item.phase !== "prepared" && !validCloudAgentID(item.agentID))) {
      throw new CloudRuntimeError("ledger_invalid", "Cursor Cloud ledger is invalid; no remote action was taken.");
    }
    seen.add(item.operationID);
    entries.push({ operationID: item.operationID, sessionID, phase: item.phase as CloudPhase,
      ...(validCloudAgentID(item.agentID) ? { agentID: item.agentID } : {}),
      ...(validRunID(item.runID) ? { runID: item.runID } : {}) });
  }
  return { version: 1, sessionID, records: entries };
}

export async function prepareCloudRecord(store: ForegroundCloudStore, sessionID: string): Promise<CloudRecord> {
  if (!await store.sessionExists(sessionID)) throw new CloudRuntimeError("session_not_persisted", "Cursor Cloud requires a persisted host session. No agent was created.");
  const ledger = await readCloudLedger(store, sessionID);
  if (ledger.records.some(pendingIntent)) throw new CloudRuntimeError("cleanup_pending", "An unresolved Cloud cleanup intent blocks new actions. Inspect the Cursor dashboard.");
  const entry: CloudRecord = { operationID: randomUUID(), sessionID, phase: "prepared" };
  await store.write(sessionID, { ...ledger, records: [...ledger.records, entry] });
  return entry;
}
export async function writeCloudRecord(store: ForegroundCloudStore, entry: CloudRecord): Promise<void> {
  if ((entry.phase !== "prepared" && !validCloudAgentID(entry.agentID)) ||
    (entry.runID !== undefined && !validRunID(entry.runID))) throw new CloudRuntimeError("cloud_id_invalid", "Cursor returned an invalid Cloud identifier. Inspect the Cursor dashboard.");
  const ledger = await readCloudLedger(store, entry.sessionID);
  if (!ledger.records.some(item => item.operationID === entry.operationID)) throw new CloudRuntimeError("ledger_missing", "Cursor Cloud preparation record is missing.");
  await store.write(entry.sessionID, { ...ledger, records: ledger.records.map(item => item.operationID === entry.operationID ? entry : item) });
}
