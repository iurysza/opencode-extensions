import { describe, expect, it } from "vitest";
import { bootstrapArgs, createPolicy, credentialDirs, isolatedEnv, linuxArgs, macProfile } from "../isolation/policy.mjs";
import { acceptBootstrap, ensureLinux, linuxFailure, requirePrivateLinux, validateNamespaceEvidence } from "../isolation/linux.mjs";

const policy = createPolicy('/original/home "quoted"', "/fixture/denied", ["/sdk/real"]);
const linux = { base: "/fixture", policy, maskRoot: "/fixture/masks", masks: [{ source: "/fixture/masks/file", target: "/secret", kind: "file" }], command: "/usr/bin/node", args: ["-e", "process.exit(0)", "$(no-shell)"], validated: true };
const evidence = { original: { net: "net:[1]", pid: "pid:[2]" }, actual: { net: "net:[3]", pid: "pid:[4]" }, initPid: "pid:[4]", interfaces: ["lo"], routes: [], routes6: ["00000000000000000000000000000000 00 00000000000000000000000000000000 00 00000000000000000000000000000000 ffffffff 00000001 00000000 00200200 lo"] };

describe("shared isolation policy", () => {
  it("carries original credential paths independently of clean HOME/XDG", () => {
    const clean = isolatedEnv("/fixture");
    expect(clean.HOME).toBe("/fixture/home");
    expect(policy.originalHome).toBe('/original/home "quoted"');
    for (const dir of credentialDirs) expect(policy.readDenials).toContain(`${policy.originalHome}/${dir}`);
    expect(policy.readDenials).toContain("/fixture/denied");
    expect(policy.readDenials).toContain("/sdk/real");
    expect(policy.network).toEqual({ outbound: "loopback-only", unixSockets: true });
    expect(policy.exec).toBe("allow");
    expect(policy.write).toBe("allow");
    expect(clean).not.toHaveProperty("CURSOR_API_KEY");
  });
  it("escapes SBPL strings and includes common SDK policy extensions", () => {
    const profile = macProfile(policy);
    expect(profile).toContain(String.raw`(subpath "/original/home \"quoted\"/.config")`);
    expect(profile).toContain('(subpath "/sdk/real")');
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:*"))');
    expect(profile).toContain('(allow network-outbound (remote unix-socket))');
    const backslash = macProfile(createPolicy("/home/back\\slash", "/fixture/deny"));
    expect(backslash).toContain(JSON.stringify("/home/back\\slash/.config"));
  });
  it("rejects ambiguous or relative policy paths", () => {
    for (const path of ["relative", "/line\nbreak", "/null\0path"]) expect(() => createPolicy(path, "/fixture")).toThrow("absolute, single-line");
  });
});

describe("bubblewrap argv", () => {
  it("refuses ordinary host share-net regardless of marker strings", () => {
    expect(() => linuxArgs({ ...linux, validated: undefined })).toThrow("validated private network");
    expect(() => linuxArgs({ ...linux, validated: "true" })).toThrow("validated private network");
    process.env.OPENCODE_SANDBOX_BOOTSTRAPPED = "1";
    try { expect(() => requirePrivateLinux()).toThrow("refusing host --share-net"); }
    finally { delete process.env.OPENCODE_SANDBOX_BOOTSTRAPPED; }
  });
  it("drops caps, replaces proc/dev, binds fixtures and protects mask sources before destinations", () => {
    const args = linuxArgs(linux);
    expect(args).toContain("--unshare-user"); expect(args).toContain("--unshare-pid");
    expect(args.slice(args.indexOf("--cap-drop"), args.indexOf("--cap-drop") + 2)).toEqual(["--cap-drop", "ALL"]);
    expect(args).not.toContain("--unshare-user-try");
    expect(args).not.toContain("--unshare-net");
    expect(args.join(" ")).toContain("--proc /proc --dev /dev");
    expect(args.indexOf("/fixture/masks")).toBeLessThan(args.indexOf("/fixture/masks/file"));
    expect(args.join(" ")).toContain("--bind / / --proc /proc");
    expect(args.join(" ")).not.toContain("--ro-bind / /");
    expect(args).not.toContain("--tmpfs");
    expect(args).not.toContain("/tmp");
    expect(args.join(" ")).toContain("--bind /fixture /fixture");
    expect(macProfile(policy)).toContain("(allow default)");
    expect(args.slice(args.indexOf("--") + 1)).toEqual([linux.command, ...linux.args]);
  });
  it("aliases only the exact canonical Node file before denied parents are mounted", () => {
    const nodeAlias = { source: "/home/user/.local/mise/node/bin/node", target: "/fixture/.isolation-node" };
    const args = linuxArgs({ ...linux, nodeAlias, command: nodeAlias.target });
    expect(args.join(" ")).toContain(`--ro-bind ${nodeAlias.source} ${nodeAlias.target}`);
    expect(args).not.toContain("/home/user/.local/mise");
    expect(args.indexOf(nodeAlias.source)).toBeLessThan(args.indexOf("/secret"));
    expect(args.slice(-4)).toEqual([nodeAlias.target, ...linux.args]);
    expect(() => linuxArgs({ ...linux, nodeAlias: { ...nodeAlias, target: "/tmp/outside-node" } })).toThrow("inside fixture base");
  });
  it("unshares the outer network and never shares host networking", () => {
    const payload = { originalHome: "/home/user", argv: ["/usr/bin/node", "/repo/runner.mjs"], guard: "one-reexec" };
    const args = bootstrapArgs("/usr/bin/node", "/repo/bootstrap.mjs", payload);
    expect(args).toContain("--unshare-net"); expect(args).toContain("--unshare-pid");
    expect(args).not.toContain("--share-net");
    // bwrap inherits supplied descriptors by default; --preserve-fds is not a bwrap option.
    expect(args).not.toContain("--preserve-fds");
    expect(JSON.parse(args.at(-1))).toEqual(payload);
  });
});

describe("live namespace evidence validation", () => {
  it("accepts only distinct original/current namespaces, private proc and lo-only routes", () => {
    expect(() => validateNamespaceEvidence(evidence)).not.toThrow();
    for (const patch of [
      { actual: evidence.original }, { initPid: "pid:[2]" }, { interfaces: ["lo", "eth0"] },
      { original: { net: "marker", pid: "pid:[2]" } }, { routes: ["eth0 00000000 00000000 0001"] },
      { routes6: ["00000000 eth0"] },
    ]) expect(() => validateNamespaceEvidence({ ...evidence, ...patch })).toThrow("Linux isolation unavailable");
  });
  it("rejects a marker-only or repeated bootstrap before accessing descriptors", async () => {
    await expect(acceptBootstrap({ guard: "already-bootstrapped", originalHome: "/home/user", argv: [] })).rejects.toThrow("invalid or repeated bootstrap");
    await expect(acceptBootstrap({ guard: "one-reexec", originalHome: "/home/user", argv: ["node"] })).rejects.toThrow("invalid or repeated bootstrap");
  });
  it("hard-fails missing bubblewrap even with a spoofed bootstrap marker", () => {
    const path = process.env.PATH;
    process.env.PATH = "";
    process.env.OPENCODE_SANDBOX_BOOTSTRAPPED = "1";
    try { expect(() => ensureLinux("/original/home")).toThrow("bwrap is missing"); }
    finally { if (path === undefined) delete process.env.PATH; else process.env.PATH = path; delete process.env.OPENCODE_SANDBOX_BOOTSTRAPPED; }
  });
  it("names required packages and administrator capability checks without changing sysctls", () => {
    const message = linuxFailure("bwrap is missing").message;
    expect(message).toContain("apt install bubblewrap libc-bin");
    expect(message).toContain("AppArmor"); expect(message).toContain("administrator");
    expect(message).toContain("Do not weaken sysctls automatically");
  });
});
