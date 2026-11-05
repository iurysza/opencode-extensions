// T2 type evidence (G4b), compiled against the installed @cursor/sdk 1.0.37 declarations.
// Type-only: no runtime import. Proves the published AgentOptions accepts the helper-lane shape
// (local agent, `tools: []`, no MCP, no customTools). It does NOT prove runtime tool denial.
import type { AgentOptions, LocalAgentOptions, ToolName } from "@cursor/sdk";

export const helperLane = {
  model: { id: "composer-2" },
  tools: [],
  local: { cwd: "/fixture" },
} satisfies AgentOptions;

const noTools: ToolName[] = [];
export const toolsSlot: AgentOptions["tools"] = noTools;
export const localSlot: LocalAgentOptions = { cwd: "/fixture" };

// @ts-expect-error tools must be a list of names, not a single name.
export const notAList: AgentOptions = { tools: "shell" };
