import { createHash } from "node:crypto";
import type { Plugin } from "@opencode/plugin";
import { CloudRuntimeError, type ForegroundCloudStore } from "../core/cloud/ledger.js";
export { createForegroundCloudSource, loadPublicCloudAgentFactory, foregroundCloudContext } from "../core/cloud/source.js";
export type { ForegroundCloudAgentFactory, ForegroundCloudDependencies, ForegroundCloudSource } from "../core/cloud/source.js";
export { resolveCursorSdkConfig, acknowledgeForegroundCloud, CLOUD_ACK_DISCLOSURE } from "../core/cloud/config.js";
export type { ResolveCursorSdkConfigOptions, CursorSdkConfig, CursorResolvedSdkConfig } from "../core/cloud/config.js";
export type { ForegroundCloudStore, CloudLedger, CloudRecord } from "../core/cloud/ledger.js";

/** Public ctx.storage only; plugin namespace + hashed session isolate ledger keys. */
export function createHostForegroundCloudStore(ctx: Pick<Plugin.Context, "storage">, sessionExists: ForegroundCloudStore["sessionExists"]): ForegroundCloudStore {
  const key = (sessionID: string) => `foreground-cloud:v1:${createHash("sha256").update(sessionID).digest("hex")}`;
  return {
    sessionExists,
    read: sessionID => ctx.storage.get(key(sessionID)),
    write: (sessionID, ledger) => {
      if (ledger.sessionID !== sessionID || ledger.records.some(entry => entry.sessionID !== sessionID)) throw new CloudRuntimeError("ledger_scope_invalid", "Cloud ledger cannot cross host sessions.");
      return ctx.storage.set(key(sessionID), {
        version: ledger.version, sessionID: ledger.sessionID,
        records: ledger.records.map(entry => ({ operationID: entry.operationID, sessionID: entry.sessionID, phase: entry.phase,
          ...(entry.agentID ? { agentID: entry.agentID } : {}), ...(entry.runID ? { runID: entry.runID } : {}) })),
      });
    },
  };
}
