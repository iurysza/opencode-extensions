# Local settings slice

Implemented from `ed754c2`, uncommitted. The optional typed `LocalRuntimeDependencies.getOptions(request)` preserves existing fake SDK ports. `composeRuntime.getOptions(sessionID, signal?)` exposes resolved settings for the next resume slice.

Mode reaches public `AgentOptions.mode` and `SendOptions.mode`. Tools default to `both`. Native-only starts no OpenCode MCP listener and attaches no bridge endpoint. Bridge-only supplies `tools: ["mcp"]`; both retains the standard SDK toolset and OpenCode MCP. Neither path uses `customTools`.

Trusted user settings and existing env settings resolve through `core/cloud/config.ts`. Auto-review and sandbox reach `AgentOptions.local`; env force reaches `SendOptions.local.force`. Resume is exposed but durable resume remains unimplemented. Existing per-field precedence is unchanged. Explicit session safety overrides, host-stored force, malformed values, and project runtime, repo, mode, tools, or safety overrides fail closed.

Controls refuse changes while local work, an MCP continuation, a settings action, or Cloud work owns the session. Settings validate before writes. Runtime switches retain the complete validated session record. Changed options invalidate idle agents; unchanged mode and tools preserve them. Abort and shutdown checks guard async reads, writes, option resolution, and SDK entry. An already-started host storage write cannot be rolled back on abort; no reset or SDK work follows it.

## Verification

- `npm test -w @iurysza/opencode-cursor-sdk`: 348 tests in 15 files
- `npm run build`: both packages
- `npm run typecheck`: minimum and latest contracts for both packages
- `git diff --check`

Fake SDK tests cover option delivery, native-only bridge exclusion, pending-run refusal, project restrictions, persistence failure, complete session preservation, and abort or shutdown during settings reads and option resolution.

## Remaining limits

Fast stays `not_implemented`. The RPC boundary has no shared public catalog mapping; this slice adds no discovery cache. HTTP `auto` and `http1` remain `not_implemented`; process-global SDK transport configuration is not qualified for session controls. Resume cleanup and helpers are unchanged.

Cross-turn SDK behavior remains a qualification task, not an established bug. Parent review confirmed that the original send path already supplies a fresh `mcpServers` override and public `SendOptions` supports it. Add a two-user-turn regression and actual SDK qualification rather than assuming the create-time URL stays in force.

No real Cursor calls, native permission proof, live configuration changes, dependency changes, or commits occurred. Cursor native tools still bypass OpenCode permission prompts; sandbox and auto-review are Cursor controls.
