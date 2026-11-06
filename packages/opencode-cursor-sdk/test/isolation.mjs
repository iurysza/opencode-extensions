// Real-host test isolation only. No SDK imports or Cursor calls.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { createPolicy, isolatedEnv, linuxArgs, macProfile } from "./isolation/policy.mjs";
import { bootstrappedHome, ensureLinux, materializeMasks, nodeAliasFor, requirePrivateLinux } from "./isolation/linux.mjs";

// bootstrap validates and installs this value before importing the runner. Never derive
// denial paths from the temporary HOME installed by the clean reexec environment.
export const realHome = bootstrappedHome() ?? homedir();
const policies = new Map();
const fail = message => { throw new Error(message); };
const abort = (die, message) => { die(message); throw new Error(message); };

/** On Linux reexec the whole trusted driver once, never an individual network-isolated child. */
export function requireIsolationTools(die) {
  try {
    if (platform() === "linux") { ensureLinux(realHome); return; }
    if (platform() !== "darwin") throw new Error(`isolation unsupported on ${platform()}; no unsandboxed fallback`);
    if (!existsSync("/usr/bin/sandbox-exec")) throw new Error("/usr/bin/sandbox-exec missing");
  } catch (error) { die(error.message); throw error; }
}

/** Shared argv builder, including env -i. Also used by termctrl, never a shell command. */
export function sandboxCommand(base, cmd, args, extra = {}) {
  const state = policies.get(realpathSync(base));
  if (!state) throw new Error("prepareIsolatedBase must succeed before sandboxCommand");
  const envArgs = Object.entries({ ...isolatedEnv(base), ...extra }).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || String(value).includes("\0")) throw new Error("invalid isolated environment entry");
    return `${key}=${value}`;
  });
  if (platform() === "darwin") return { command: "/usr/bin/env", args: ["-i", ...envArgs, "/usr/bin/sandbox-exec", "-p", macProfile(state.policy), cmd, ...args] };
  if (platform() !== "linux") throw new Error(`isolation unsupported on ${platform()}`);
  const context = requirePrivateLinux();
  let executable = cmd;
  if (state.nodeAlias && (cmd === process.execPath || cmd === state.nodeAlias.source)) executable = state.nodeAlias.target;
  return { command: "/usr/bin/env", args: ["-i", ...envArgs, context.bwrap, ...linuxArgs({ ...state, base: realpathSync(base), command: executable, args, validated: true })] };
}

export function sandboxed(base, cmd, args, cwd) {
  const invocation = sandboxCommand(base, cmd, args);
  return spawnSync(invocation.command, invocation.args, { cwd, encoding: "utf8", timeout: 90_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 });
}

/** Caller owns the detached process group and must kill it in finally. */
export function sandboxedSpawn(base, cmd, args, cwd, extra = {}) {
  const invocation = sandboxCommand(base, cmd, args, extra);
  return spawn(invocation.command, invocation.args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
}

function requireReadDenied(base, path, label, die) {
  const script = `const fs=require('node:fs');try{const p=process.argv[1];if(fs.statSync(p).isDirectory())fs.readdirSync(p);else fs.readFileSync(p);process.exit(10)}catch(e){console.log(e.code);process.exit(['EACCES','EPERM'].includes(e.code)?0:11)}`;
  const result = sandboxed(base, process.execPath, ["-e", script, path], base);
  if (result.error || result.status !== 0 || !/^(EACCES|EPERM)\s*$/u.test(result.stdout ?? "")) abort(die, `${label}: cannot prove filesystem read denial (${result.error?.code ?? result.status}): ${(result.stderr ?? "").slice(0, 300)}`);
}

/** Builds policy once, including optional SDK import denials, then proves positive denials. */
export function prepareIsolatedBase(base, label, die, { extraReadDenials = [] } = {}) {
  // Fail before deleting/creating fixtures if the Linux entrypoint skipped the bootstrap.
  if (platform() === "linux") requirePrivateLinux();
  else if (platform() !== "darwin") fail(`isolation unsupported on ${platform()}`);
  rmSync(base, { recursive: true, force: true });
  for (const d of ["home", "config", "data", "cache", "state", "project", "oc"]) mkdirSync(join(base, d), { recursive: true });
  base = realpathSync(base);
  const deniedFixture = join(base, "denied-probe");
  writeFileSync(deniedFixture, "denied-probe\n");
  if (readFileSync(deniedFixture, "utf8") !== "denied-probe\n") abort(die, `${label}: denial fixture unreadable outside sandbox`);
  // Include symlink destinations on both platforms, not just their lexical spelling.
  const original = createPolicy(realHome, deniedFixture, extraReadDenials);
  const policy = Object.freeze({ ...original, readDenials: [...new Set(original.readDenials.flatMap(path => existsSync(path) ? [path, realpathSync(path)] : [path]))] });
  const state = { policy, ...(platform() === "linux" ? { ...materializeMasks(base, policy), nodeAlias: nodeAliasFor(policy, base) } : {}) };
  policies.set(base, state);
  writeFileSync(join(base, "sb.sb"), macProfile(policy)); // Evidence only; builder uses immutable in-memory policy.
  try {
    const connect = `const net=require('node:net');const s=net.connect({host:'192.0.2.1',port:80});s.on('connect',()=>process.exit(10));s.on('error',e=>{console.log(e.code);process.exit(0)});s.setTimeout(2000,()=>process.exit(11));`;
    const result = sandboxed(base, process.execPath, ["-e", connect], base);
    const codes = platform() === "darwin" ? ["EPERM", "EACCES"] : ["ENETUNREACH", "EHOSTUNREACH", "EPERM", "EACCES"];
    if (result.error || result.status !== 0 || !codes.includes((result.stdout ?? "").trim())) abort(die, `${label}: cannot prove external network denial (${result.error?.code ?? result.status}): ${(result.stderr ?? "").slice(0, 300)}`);
    requireReadDenied(base, deniedFixture, label, die);
    for (const path of [join(realHome, ".config"), ...extraReadDenials]) if (existsSync(path)) requireReadDenied(base, path, label, die);
  } catch (error) { policies.delete(base); throw error; }
}

export function requireBinaryVersion(base, bin, version, die) {
  if (!existsSync(bin)) abort(die, `missing pinned binary ${bin}`);
  const reported = (sandboxed(base, bin, ["--version"], base).stdout ?? "").trim();
  if (reported.replace(/^opencode v?/, "") !== version) abort(die, `binary reports ${JSON.stringify(reported)}, expected ${version}`);
  return reported;
}
