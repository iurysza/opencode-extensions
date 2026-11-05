# OpenCode 2.x plan review

> **Historical, superseded.** The revised [plan](./plan.md) replaces the recommendations below. The [OpenCode 2.x boundary report](./research/opencode-v2-boundary.md) shows two claims here are wrong at every 2.x tag. A different payload under the same synthetic ID does **not** raise `SyntheticConflictError`: admission checks only ID, session and type. A hash of agent and run IDs is not a safe synthetic ID, and admission alone is not exactly-once delivery. It also corrects the support policy: 2.0.0 is a practical floor. The text below is kept unchanged as evidence.

Status: review complete; the old 1.x plan needs revision. No implementation is approved.

Reviewer: `claude-code/claude-opus-5-5`, thinking high, confirmed from execution metadata. Reviewed on 5 November 2026. The independent report follows unchanged after the lead's verification notes.

## Lead verification and disposition

The review's main conclusion stands. OpenCode 2.x has public APIs that the 1.x plan missed. I checked the following in the same 2.2.5 source snapshot:

- `packages/plugin/src/promise/session.ts:200-220` exposes `synthetic` in the public `SessionDomain`. The review's access question is resolved for this snapshot.
- `packages/plugin/src/promise/session.ts:63-75` defines request kinds `primary`, `compaction`, `title` and `generate`. Helpers should use this explicit identity, not infer it from absent tools.
- `packages/plugin/src/promise/rpc.ts:19-31` exposes RPC registration and event emission. `packages/plugin/src/tui/context.ts:544-550` gives the TUI an OpenCode client. Host RPC is the simpler transport candidate; topology and authorization tests remain necessary.
- `packages/core/src/plugin/provider/claude-agent/aisdk.ts:10-35` registers a custom agent-backed language model through the public SDK hook.
- `packages/core/src/session/session.ts:286-327` admits a synthetic input using its ID and wakes the session unless resume is disabled or the session is reverted.

All paths above are relative to `research/sources/opencode-main/`. These are source checks, not runtime tests.

Two review recommendations must not be adopted as written:

1. Stable-ID synthetic admission is not proof of exactly-once assistant execution. Keep busy-session, crash/restart, replay, conflict and reply-acknowledgment tests in G5. Do not reduce G5 to checking whether an API exists. Synthetic IDs must satisfy OpenCode's ID schema.
2. Studying 2.2.5 does not establish support for 2.0 onward. Do not silently raise the minimum to 2.2.x. Verify the required APIs at the 2.0 boundary and across relevant minor changes, then document compatibility adapters or concrete blockers. Future releases need compatibility checks, not an untested promise.

Other qualifications:

- Claude Agent is an architectural reference, not proof that Cursor supports the same SDK hooks or tool-call correlation.
- Keep the separate T2 real-SDK/Bun load gate. Loading a mock V3 provider in T1 does not exercise Cursor's native dependencies.
- Public RPC does not by itself prove remote-attached Cursor operation. Preserve the distinction between the transport and the provider's process/workspace requirements.

## Accepted decisions

Iury settled these in the Inbox:

- OpenCode 2.0 onward is mandatory; ignore 1.x
- use a new `opencode-extensions` repository with two packages
- local TUI equivalents are acceptable; a custom control adapter is permitted only if needed
- retain Cursor-native safety with clear disclosure and isolated tool-disabled helpers

The overall revised plan and implementation authorization remain pending. Existing fact IDs should survive revision. In particular, F-14, F-30/F-31/F-58, F-38/F-59/F-60 and F-61 need new host-specific contracts.

## Independent Opus report

# Opus review: OpenCode 2.0 onward

I didn't edit any files, run any builds, or post anything. Everything below comes from reading the source snapshot.

**Verdict: revise before approval.** The plan's design was sound, but its entire runtime contract assumes OpenCode 1.18.33. Since 2.x is mandatory and 1.x is excluded, the gates and milestones have to be rewritten. The 2.x API also makes three of the plan's hardest pieces simpler.

## Inherited decisions (accepted constraints)
- **OpenCode version:** 2.0 onward is mandatory and 1.x is excluded. This replaces the plan's Pending decision 2, which recommended 1.18.33.
- **Repo:** a new `opencode-extensions` repo holding two packages. This replaces Pending decision 1.
- **UI:** local TUI equivalents are acceptable. The token-protected control adapter is allowed *if needed*. It is not required.
- **Permissions:** Cursor-native safety stays as it is, with clear disclosure. Helper requests run isolated with tools disabled.
- **Not yet approved:** implementation and the revised overall plan.
- **Still in force:** Phase 1 is read-only, there are no live Cursor calls, and the SDK is only an npm dependency (G8 publish gate).

## What I checked
- `research/sources/opencode-main`: the upstream `dev` branch at commit `893e8dc4`, with `@opencode/*` packages at 2.2.5.
- CHANGELOG entries from v2.0.26 through v2.2.5.
- 2.x source: `session/runner/{step,publish-llm-event}.ts`, `session/{inbox,prompt,session,subagent-completion,compaction}.ts`, `plugin/provider/{dynamic,sdk-factory}.ts`, `plugin/provider/claude-agent/**`, `plugin/src/promise/{aisdk,provider,rpc,command,session,tool,integration}.ts`, `plugin/src/tui/context.ts`, `server/src/handlers/{rpc,session}.ts`.

## Diagnosis
2.x ships a first-party plugin that does almost exactly what we want to build: **Claude Agent** (`core/src/plugin/provider/claude-agent/`). It wraps an external agent SDK that runs its own native tools. It uses only the public plugin `Context` from `@opencode/plugin/effect/plugin`:
- `ctx.aisdk.hook("sdk")` returns a custom `languageModel(id)`.
- `ctx.provider.transform` registers the provider.
- `ctx.integration` handles auth.
- `ctx.session.hook("model.request" | "context" | "retry")` adjusts requests.
- An in-process MCP server named `opencode`, plus a `PendingTools` table, brings OpenCode tools into the agent:
  1. The tool call is emitted to OpenCode.
  2. OpenCode runs it through its normal permission pipeline.
  3. The result resolves the pending MCP call, so the agent continues.
- The plugin skips itself when there's a remote workspace or no process spawner.

This is the G2 design, already working upstream. Our port should copy this structure rather than invent one.

## Findings, by priority

**P0-1. Every proof tier, gate, harness and type pin names 1.18.33.** This covers M0's `test/harness/opencode-1.18.33/`, G2's "real OpenCode 1.18.33", the `@opencode-ai/plugin` pin, the "Version drift" risk, and Pending decision 2. In 2.x:
- The package is `@opencode/plugin`, with `.`, `./effect`, `./tui`, `./host` and `./runtime` entry points.
- The provider path is the `aisdk:`/`aisdk.hook("sdk")` route.
- The 1.x `chat.params` and `provider.<id>.npm` assumptions no longer apply. Re-check G4a against `session.hook("model.request")`, whose `kind` field covers `primary`, compaction and title requests.

**P0-2. The language-model contract is stricter in 2.x. G2 must be re-proven against these rules, which are better defined than in 1.x.** From `step.ts` and `publish-llm-event.ts`:
- A `tool-call` with `providerExecuted: true` is never run locally (`step.ts:119`).
- Each provider-executed call must be settled by a provider `tool-result`. If not, it fails with `tool.result-missing` (`failUnsettledTools(..., "hosted")`).
- A duplicate success result kills the run (`Duplicate tool result`). A late error result is ignored.
- A name mismatch between `tool-input-start`, `tool-call` and `tool-result` kills the run.
- `needsContinuation` is true only for calls that were **not** provider-executed. Native Cursor calls therefore don't trigger another loop step. OpenCode tools that reach Cursor through MCP do, which makes this the re-entry point for the bridge.
- An unknown finish reason produces `InvalidProviderOutput`. Every stream must end with a valid `step-finish`.

The Cursor stream converter has to follow these rules, which means it needs strict mock tests.

**P0-3. The AI SDK bridge supports only v6, which is `LanguageModelV3`** (`sdk-factory.ts:19-21`). The plan already targets `LanguageModelV3`, so this is compatible. Pin the `@ai-sdk/provider` major version and add a load test for both `file://` and npm.

**P1-1. The loopback control adapter is not needed on 2.x.** 2.x has plugin RPC:
- `ctx.rpc.register(definition, handlers)` returns `events.emit`.
- The server exposes it as `rpc.call` (`server/src/handlers/rpc.ts`), behind the server's own auth.
- TUI plugins get an `OpenCodeClient` (`tui/context.ts:549`).

Typed backend commands plus push events can replace the bearer-token file, the port listener and worktree binding. This probably also removes the "remote attach unsupported" exclusion. **Recommendation:** drop the adapter from the baseline. Keep it as a documented fallback only if a spike shows RPC can't carry the needed events. Under your clarification, this is a simplification, not a change to the approved decision.

**P1-2. The completion dispatcher can mostly reuse upstream.** `Session.synthetic({ id, text, delivery, resume })`:
- It is idempotent by `id`: the first admission wins, and a different payload with the same id raises `SyntheticConflictError`.
- It queues into the session inbox in steer or queue mode and wakes the session.
- Built-in subagents deliver completion this way (`subagent-completion.ts`).

Use a stable id per Cloud run, such as a hash of the agent id plus the run id, to get exactly-once delivery even when the session is busy. Gate G5 then shrinks to one check: does the plugin context expose `synthetic`? I saw `ctx.session` used five times in Claude Agent, but I didn't confirm that `synthetic` is in the public `SessionDomain`. If it isn't, use `rpc` or the server `session.synthetic` HTTP route. There's also the experimental `experimental.idle` Session hook from 2.2.x, which is worth a look but shouldn't be relied on.

**P1-3. Tool naming and permissions should follow Claude Agent.** It sets `allowedTools: ["mcp__opencode__*"]` and `strictMcpConfig`, and OpenCode tools appear as `mcp__opencode__<name>`. For Cursor, check against `research/sdk-controls.md` whether `customTools` or an MCP server config can match this. Native tools stay under Cursor's own safety, as you decided. Keep the earlier finding: SDK `customTools` skip approval, so OpenCode tools must use the MCP-through-OpenCode path, never `customTools`.

**P1-4. Compaction changed in 2.1.** It now uses `native` instead of `providerState`, `SessionCompactionResult.native`, and a `compaction` agent with `kind`-tagged model requests. Re-map the Pi summarize/compaction facts to these names. Isolated helper requests (title, compaction) should be detected through `model.request.kind` and run with tools disabled, as you decided.

**P2-1. 2.x has frequent breaking changes between minors.** Since 2.0.26, the CHANGELOG lists breaking changes in 2.1.0, 2.2.0, 2.2.1 and 2.2.3. Examples: OpenTUI 0.7, then 0.8 for TUI plugins; `native` renames; `@opencode/ai` entry points; policy actions. "2.0 onward" therefore needs a concrete support policy, for example: build on the current 2.x minor, CI against the latest 2.x, and declare a minimum peer version. Literal support back to 2.0.0 is likely impractical.

**P2-2. Auth should go through `ctx.integration`** (oauth, key, env and external methods, plus `Credential`). Its status should flow through a provider status the way `ClaudeStatus` works. Never log secrets.

## What still holds from the plan
- Two packages, and the Pi packages stay untouched.
- Native Cursor tools run inside Cursor and appear in OpenCode as provider-executed calls.
- OpenCode tools reach Cursor through MCP and OpenCode's permission pipeline. There's no text-only fallback and no HTTP facade.
- The proof-tier discipline (T1 mock before any live call) and gate G8 (SDK only as an npm dependency).
- Full parity scope, including the SDK foreground Cloud runtime.

## Revised milestones and gates
- **M0 (T1):** Build the harness against a pinned 2.2.x. Spikes:
  - G1: Bun/runtime load of a `file://` V3 model through `aisdk.hook("sdk")`.
  - G2: the stream contract from P0-2, using a mock native call plus a mock MCP-bridged call with pending re-entry, modelled on `PendingTools`.
  - G4a: `model.request.kind` detection.
  - G5: `synthetic` idempotence on a busy session.
  - G6′: an RPC round-trip from a TUI plugin with backend push events. This replaces the adapter spike.
- **M1–M4:** Same scope, rebased onto the Claude Agent structure: provider, integration, aisdk, session hooks, tool server.
- **M5:** Build the TUI using slots plus RPC, against OpenTUI 0.8.
- **M6:** Add a CI matrix over the minimum and latest 2.x.

## Risks and open questions
- Whether `synthetic` is in the public `SessionDomain`.
- Whether RPC works in remote-attached topologies.
- Whether Cursor's SDK supports a PreToolUse-style hook that ties an MCP call to its tool-call id. Claude Agent depends on this to match `before(id)` with `call(name)`. If Cursor can't, matching must use name plus order, which is a G2 risk.
- Whether `tools: []` actually disables tools at runtime for isolated helpers. This is still unverified.
- 2.x minor churn (P2-1).

## Need from the main agent
1. Rewrite the plan's target, gates, M0 harness and type pins for 2.x, using P0-1 to P0-3.
2. Make RPC the baseline transport and the adapter a documented fallback.
3. Propose a concrete "2.0 onward" support policy for Iury to accept. It shouldn't be raised as a new design question, but the policy itself is not decided yet.
4. Before you post, verify that `synthetic` is in the public `SessionDomain`.

## Suggested execution prompt
No worker handoff is warranted. This is still Phase 1, and implementation isn't approved. The next step is the plan revision listed above.
