import { resolveCursorSdkConfig, type CursorSdkConfig, type ResolveCursorSdkConfigOptions } from "./cloud/config.js";
import { parseOptionalEnvBoolean } from "./cloud/env-boolean.js";

export interface LocalRunOptions {
  readonly mode: "agent" | "plan";
  readonly tools: "native" | "bridge" | "both";
  readonly autoReview: boolean;
  readonly sandboxEnabled: boolean;
  readonly force: boolean;
  /** Consumed by the durable-resume owner, not an SDK AgentOptions field. */
  readonly resume: boolean;
}
export const DEFAULT_LOCAL_RUN_OPTIONS: LocalRunOptions = {
  mode: "agent", tools: "both", autoReview: false, sandboxEnabled: false, force: false, resume: true,
};
export type HostCursorSettings = Omit<CursorSdkConfig, "local"> & {
  local?: CursorSdkConfig["local"] & Pick<Partial<LocalRunOptions>, "mode" | "tools">;
};
export type HostSettingsLayers = Omit<ResolveCursorSdkConfigOptions, "user" | "session" | "project"> & {
  user?: HostCursorSettings; session?: HostCursorSettings; project?: HostCursorSettings;
};
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const invalid = (): never => { throw new Error("Invalid or unavailable host Cursor setting."); };

/** Host storage is trusted in origin, but still needs strict validation. Project
 * settings cannot authorize local tool policy or safety without a host trust API.
 */
export function parseHostSettings(value: unknown, source: "user" | "session" | "project"): HostCursorSettings | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || Object.keys(value).some(k => !["runtime", "cloud", "local", "fastDefaults"].includes(k))) return invalid();
  // No discoverable catalog at the control boundary yet; no process-global transport changes.
  if (value.fastDefaults !== undefined) return invalid();
  if (value.local !== undefined) {
    const local = value.local;
    if (!record(local) || Object.keys(local).some(k => !["mode", "tools", "autoReview", "sandbox", "sandboxOptions", "force", "resume"].includes(k))) return invalid();
    if (source === "project" && Object.keys(local).length) return invalid();
    if (local.mode !== undefined && local.mode !== "agent" && local.mode !== "plan") return invalid();
    if (local.tools !== undefined && local.tools !== "native" && local.tools !== "bridge" && local.tools !== "both") return invalid();
    for (const key of ["autoReview", "sandbox", "force", "resume"]) {
      if (local[key] !== undefined && typeof local[key] !== "boolean") return invalid();
    }
    if (local.sandboxOptions !== undefined && (!record(local.sandboxOptions) ||
      Object.keys(local.sandboxOptions).some(k => k !== "enabled") ||
      local.sandboxOptions.enabled !== undefined && typeof local.sandboxOptions.enabled !== "boolean")) return invalid();
    // Preserve the core resolver's per-field Pi precedence. Do not accept ignored settings.
    if (local.force !== undefined || source === "session" && Object.keys(local).some(k => k !== "mode" && k !== "tools")) return invalid();
  }
  // Cloud/runtime fields are validated by the shared resolver before this value escapes.
  const config = value as HostCursorSettings;
  resolveCursorSdkConfig({ [source]: config, env: {} });
  return config;
}

export function resolveLocalRunOptions(layers: HostSettingsLayers): LocalRunOptions {
  for (const key of ["PI_CURSOR_AUTO_REVIEW", "PI_CURSOR_SANDBOX", "PI_CURSOR_LOCAL_FORCE", "PI_CURSOR_LOCAL_RESUME"]) {
    if (layers.env?.[key] !== undefined && parseOptionalEnvBoolean(layers.env[key]) === undefined) return invalid();
  }
  if (layers.env?.PI_CURSOR_HTTP_1_1 !== undefined) return invalid();
  const config = resolveCursorSdkConfig(layers);
  return {
    mode: layers.session?.local?.mode ?? layers.user?.local?.mode ?? "agent",
    tools: layers.session?.local?.tools ?? layers.user?.local?.tools ?? "both",
    autoReview: config.local.autoReview.value, sandboxEnabled: config.local.sandboxEnabled.value,
    force: config.local.force.value, resume: config.local.resume.value,
  };
}
