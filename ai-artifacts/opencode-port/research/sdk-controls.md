# `@cursor/sdk` 1.0.37 tool controls: source note

Status: **published contract evidence only**. I read the public type declarations. I installed nothing, ran nothing and made no Cursor call. This note shows what the SDK says it does. It does not prove runtime behavior.

- Source: https://unpkg.com/@cursor/sdk@1.0.37/dist/esm/options.d.ts
- Retrieved: 2026-11-05, read-only HTTP fetch.

## `AgentOptions.tools` (lines 380-410)

- `undefined` (default): the standard toolset for the selected model.
- `[]`: no built-in tools. "The model can only respond with text."
- A non-empty list: only the listed tools are offered. Names use the public vocabulary (`shell`, `read`, `edit`, `grep`, `glob`, `ls`, `task`, `mcp` and others). Unknown names throw `ConfigurationError` at `Agent.create` or `Agent.resume`.
- `mcp` is a capability group. It grants the whole MCP family, including `customTools`. Omitting `mcp` disables MCP entirely.
- `task` gates subagents. Subagents keep their own curated toolsets, because the restriction applies to the main loop only. Omit `task` to avoid unconstrained children.
- Not persisted on the agent. Pass `tools` again on `Agent.resume`.
- **Local agents only.** Combining `tools` with `cloud` throws `ConfigurationError`.

## `AgentOptions.disallowedTools` (lines 411-436)

- The complement of `tools`: names what goes. Combined with `tools`, deny wins.
- Applies to the main loop only. Disallow `task` to prevent subagents.
- Not persisted. Pass it again on `Agent.resume`.
- **Local agents only.** Combining it with `cloud` throws `ConfigurationError`.

## `LocalAgentOptions.customTools` (lines 186-196)

- In-process callback tools, exposed as the `custom-user-tools` MCP server. Local agents only.
- They "never require interactive approval". They run even on sandboxed or `autoReview` runs.
- Consequence for the port: `customTools` is not a host-enforcement shortcut. Bridged OpenCode tools keep using the loopback MCP bridge through OpenCode's permission pipeline.

## What this changes

- Tool denial exists for **local** agents. Earlier docs called it unknown.
- It does not exist for **Cloud** agents through these options.
- Pi evidence was gathered on 1.0.23. Whether these options existed then was not checked, which is one more reason for gate G7.

## Not proven

- That `tools: []` really yields text-only runs with no native calls. That needs a T2 probe and a separately approved T3 run.
- Behavior under Bun's `connect-web` build (G1).
