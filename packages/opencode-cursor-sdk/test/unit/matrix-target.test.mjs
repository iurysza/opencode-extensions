import { describe, expect, it } from "vitest";
import { binPath, cliTarget } from "../matrix/versions.mjs";

describe("CLI fixture targets", () => {
  it.each([
    ["darwin", "arm64", "@opencode/cli-darwin-arm64"],
    ["linux", "x64", "@opencode/cli-linux-x64"],
    ["linux", "arm64", "@opencode/cli-linux-arm64"],
  ])("selects the published %s/%s package", (platform, arch, name) => {
    expect(cliTarget(platform, arch)).toEqual({ platform, arch, package: name });
  });

  it("defaults to the current host, not Darwin", () => {
    expect(cliTarget()).toEqual(cliTarget(process.platform, process.arch));
  });

  it.each([["darwin", "x64"], ["win32", "x64"], ["linux", "riscv64"], ["freebsd", "arm64"], ["linux", "__proto__"]])("fails closed on unsupported %s/%s", (platform, arch) => {
    expect(() => cliTarget(platform, arch)).toThrow(new RegExp(`unsupported CLI fixture target ${platform}/${arch}`));
  });

  it("preserves the host runners' binary layout", () => {
    expect(binPath("/repo", "2.2.5")).toBe("/repo/.fixtures/inspect/bin-2.2.5/package/bin/opencode");
  });
});
