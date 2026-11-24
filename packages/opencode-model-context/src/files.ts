import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseModelContextMap, type ModelContextMap } from "./resolve.js";

export interface DirOptions {
  dir?: unknown;
}

/** `dir` option, then OPENCODE_MODEL_CONTEXT_DIR, then ~/.agents/model-context. */
export function modelContextDir(
  options: DirOptions = {},
  env: NodeJS.ProcessEnv = process.env,
  home: () => string = homedir,
): string | undefined {
  const fromOption = typeof options.dir === "string" ? options.dir.trim() : "";
  if (fromOption) return fromOption;
  const fromEnv = typeof env.OPENCODE_MODEL_CONTEXT_DIR === "string" ? env.OPENCODE_MODEL_CONTEXT_DIR.trim() : "";
  if (fromEnv) return fromEnv;
  const root = home();
  if (!root) return undefined;
  return join(root, ".agents", "model-context");
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Missing map is "no map". Invalid JSON throws, which the hook treats as an error. */
export function loadMap(dir: string): ModelContextMap | undefined {
  const path = join(dir, "map.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
  return parseModelContextMap(text);
}

/** Absolute paths are used as written. Anything else is joined to the model-context dir. */
export function readPrompt(dir: string, file: string): string | undefined {
  const name = file.trim();
  if (!name) return undefined;
  const path = isAbsolute(name) ? name : join(dir, name);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
