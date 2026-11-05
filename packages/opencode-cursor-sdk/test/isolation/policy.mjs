import { isAbsolute, join, relative } from "node:path";

export const credentialDirs = [".config", ".pi", ".claude", ".agents", ".cursor", ".local", ".codex", ".ssh", ".npmrc"];
export const networkPolicy = Object.freeze({ outbound: "loopback-only", unixSockets: true });

export function createPolicy(originalHome, deniedFixture, extraReadDenials = []) {
  const paths = [originalHome, deniedFixture, ...extraReadDenials];
  if (paths.some(p => !isAbsolute(p) || /[\0\n\r]/u.test(p))) throw new Error("isolation policy requires absolute, single-line paths");
  return Object.freeze({ originalHome, readDenials: [...credentialDirs.map(d => join(originalHome, d)), deniedFixture, ...extraReadDenials], network: networkPolicy, exec: "allow", write: "allow" });
}

export function macProfile(policy) {
  if (policy.write !== "allow") throw new Error("unsupported isolation write policy");
  // JSON quoting escapes backslashes and quotes in SBPL string literals.
  const rules = policy.readDenials.map(p => `(subpath ${JSON.stringify(p)})`).join(" ");
  return `(version 1)\n(allow default)\n(deny network-outbound)\n(allow network-outbound (remote ip "localhost:*"))\n(allow network-outbound (remote unix-socket))\n(deny file-read* ${rules})\n`;
}

export function isWithin(parent, child) {
  const part = relative(parent, child);
  return part === "" || (!part.startsWith("../") && part !== ".." && !isAbsolute(part));
}

/** Only call after live bootstrap validation. Never share the ordinary host network. */
export function linuxArgs({ base, policy, masks, maskRoot, nodeAlias, command, args, validated }) {
  if (policy?.write !== "allow") throw new Error("unsupported isolation write policy");
  if (validated !== true) throw new Error("Linux sandbox requires a validated private network bootstrap");
  const out = ["--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--share-net", "--cap-drop", "ALL", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--bind", base, base];
  if (nodeAlias) {
    if (!isWithin(base, nodeAlias.target) || nodeAlias.target === base) throw new Error("Node alias must stay inside fixture base");
    out.push("--ro-bind", nodeAlias.source, nodeAlias.target);
  }
  // Protect the sources as well as their destinations against chmod/replacement.
  out.push("--ro-bind", maskRoot, maskRoot);
  for (const mask of masks) out.push("--ro-bind", mask.source, mask.target);
  out.push("--", command, ...args);
  return out;
}

export function bootstrapArgs(node, bootstrap, payload) {
  return ["--die-with-parent", "--new-session", "--unshare-user", "--unshare-net", "--unshare-pid", "--cap-drop", "ALL", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--", node, bootstrap, JSON.stringify(payload)];
}

export function isolatedEnv(base) {
  return {
    HOME: join(base, "home"), XDG_CONFIG_HOME: join(base, "config"), XDG_DATA_HOME: join(base, "data"),
    XDG_CACHE_HOME: join(base, "cache"), XDG_STATE_HOME: join(base, "state"), PATH: "/usr/bin:/bin",
    OPENCODE_CONFIG: join(base, "oc/opencode.json"), OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1",
  };
}
