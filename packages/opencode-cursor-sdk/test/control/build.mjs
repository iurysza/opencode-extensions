import { spawnSync } from "node:child_process";
import { join } from "node:path";
export function buildControls(repo) {
  for (const lane of ["sdk", "cloud"]) {
    const source = `packages/opencode-cursor-${lane}/src`;
    const result = spawnSync(process.execPath, [join(repo, "node_modules/typescript/bin/tsc"),
      "--strict", "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext",
      "--rootDir", source, "--outDir", `.fixtures/control-build/${lane}`,
      `${source}/control-contract.ts`, `${source}/plugin/control-rpc.ts`, `${source}/tui.ts`],
      { cwd: repo, encoding: "utf8", timeout: 30000 });
    if (result.status !== 0) throw new Error(`targeted control compile failed: ${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
}
