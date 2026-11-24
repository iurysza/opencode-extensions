import type { SystemPart } from "./inject.js";

/** One model request, as the context, compaction, and generate hooks deliver it. */
export interface VendorRequest {
  readonly sessionID?: string;
  readonly agent?: string;
  readonly model?: { readonly id?: string; readonly providerID?: string };
  system?: SystemPart[];
}

/**
 * The public context members this plugin uses. `test/types` proves both
 * `@opencode/plugin` 2.0.0 and 2.2.5 contexts satisfy this shape.
 * The callback input is `any` so the generic host `hook` stays assignable.
 */
export interface ModelContextHost {
  readonly options?: Readonly<Record<string, unknown>>;
  readonly agent: {
    get(input: { readonly agentID: string }): Promise<{ readonly data: { readonly system?: string } }>;
  };
  readonly session: {
    hook(
      name: "context" | "compaction" | "generate",
      callback: (input: any) => void | Promise<void>,
    ): Promise<{ readonly dispose: () => Promise<void> }>;
  };
}
