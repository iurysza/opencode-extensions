import { unavailableTurnSource } from "./core/turn-events.js";
import { createCursorPlugin } from "./plugin/create.js";
import { codingOnly } from "./provider/language-model.js";

export { createCursorPlugin, PLUGIN_ID } from "./plugin/create.js";
export type { CursorTurnEvent, CursorTurnSource } from "./core/turn-events.js";
export type { HelperLane, TurnLanes } from "./core/lanes.js";
export type { RequestContext, RequestKind } from "./core/request-context.js";

/**
 * Backend entry. Until the real Cursor SDK adapter lands (M1), turns fail closed
 * with a fixed error and no Cursor contact. Loading this module imports no SDK,
 * opens no network connection and starts no agent (F-44).
 */
export default createCursorPlugin({
  lanes: codingOnly(unavailableTurnSource),
  models: [{ id: "unavailable", name: "Cursor (adapter not implemented)", context: 200_000, output: 32_000 }],
});
