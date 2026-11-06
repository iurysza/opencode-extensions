import { createCursorPlugin } from "./plugin/create.js";

export type { CursorPluginOptions } from "./plugin/create.js";
export type { RuntimeOptions } from "./plugin/runtime.js";
export { createCursorPlugin, PLUGIN_ID } from "./plugin/create.js";
export type { CursorTurnEvent, CursorTurnSource } from "./core/turn-events.js";
export type { HelperLane, TurnLanes } from "./core/lanes.js";
export type { RequestContext, RequestKind } from "./core/request-context.js";

export { createLocalRuntime, type LocalControls, type LocalSdkPort } from "./provider/local-runtime.js";

/** Local-first production composition. Cloud requires durable session consent; helpers refuse. */
export default createCursorPlugin();
