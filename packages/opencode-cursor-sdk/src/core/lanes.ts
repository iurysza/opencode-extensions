import type { RequestKind } from "./request-context.js";
import { err, ok, type Result } from "./result.js";
import type { CursorTurnSource } from "./turn-events.js";

/**
 * Where non-primary requests (title, compaction, generate) may run (F-16).
 * There is no verified Cursor helper lane yet: G4b must pass before one is added as a new
 * variant. Until then production uses `unavailable` and helper requests refuse to start.
 */
export type HelperLane =
  | { readonly _tag: "unavailable" }
  /**
   * TEST ONLY. Lets real-host fixtures record helper requests with a scripted source.
   * It is not a text-only Cursor lane and proves nothing about G4b.
   */
  | { readonly _tag: "test-only"; readonly source: CursorTurnSource };

export interface TurnLanes {
  /** Runs `primary` requests only. Never runs helper requests. */
  readonly coding: CursorTurnSource;
  readonly helper: HelperLane;
}

export const helperUnavailable: HelperLane = { _tag: "unavailable" };

export class HelperLaneUnavailableError extends Error {
  readonly code = "cursor-helper-lane-unavailable";
  constructor(readonly kind: Exclude<RequestKind, "primary">) {
    super(`Cursor ${kind} requests are disabled: no verified helper lane is available.`);
    this.name = "HelperLaneUnavailableError";
  }
}

/** Picks the source for a request kind. A helper kind never falls back to the coding source. */
export function selectLane(kind: RequestKind, lanes: TurnLanes): Result<CursorTurnSource, HelperLaneUnavailableError> {
  if (kind === "primary") return ok(lanes.coding);
  if (lanes.helper._tag === "test-only") return ok(lanes.helper.source);
  return err(new HelperLaneUnavailableError(kind));
}
