# Plan: Cursor SDK and Cursor Cloud for OpenCode 2.x

Status: **approved, location grant approved, M0 in progress**. Iury approved it together with the [readback](./readback.md), [intent](./intent.md), [facts](./facts.md) and [feature map](./feature-map.md) through Plannotator Inbox message `msg_redacted`. The [goal](./goal.md) holds the contract. At approval no port implementation or runtime probe had run; the [dev log](./dev-log.md) records progress since. The 2.x evidence is source reading only: see the [boundary report](./research/opencode-v2-boundary.md). Source evidence is not runtime proof.

## Approach in one paragraph

Build two OpenCode 2.x packages in a new `opencode-extensions` repository. Do not refactor the Pi packages. `@iurysza/opencode-cursor-sdk` is a backend plugin built with `@opencode/plugin` `define({ id, setup })`. It registers a `cursor` provider and returns an AI SDK `LanguageModelV3` from the public `aisdk.hook("sdk")` or `aisdk.hook("language")`. Cursor runs its own native tools, and the model reports them as provider-executed calls that OpenCode stores and never runs. OpenCode tools reach Cursor through an MCP bridge whose calls come back to OpenCode as normal tool calls, so they go through OpenCode's permission pipeline. The same package carries the SDK's foreground Cloud runtime at full parity. `@iurysza/opencode-cursor-cloud` adds background Cloud delegation tools, completion receipts delivered through `session.synthetic`, and a TUI surface. Both packages support OpenCode 2.0.0 onward through small compatibility modules. Every risky assumption is a gate with a named proof tier. If a gate fails, work stops and Iury chooses between bounded alternatives.

## Accepted decisions

Iury settled these. They are inputs to this plan, not open questions.

| Decision | Consequence here |
|---|---|
| New `opencode-extensions` repository with **two** installable packages | No third package. TUI code ships as entry modules inside the two packages. |
| Local TUI equivalents are acceptable. A custom control adapter only if needed. | Public plugin RPC is the baseline. A loopback adapter is a gated fallback, not built up front. |
| Cursor-native safety, clearly disclosed, with isolated tool-disabled helpers | Native tools stay under Cursor's controls. Every non-primary request runs in a `tools: []` helper lane. |
| OpenCode 2.0.0 onward is mandatory. 1.x is excluded. | Floor is v2.0.0 (`63f7ceec`). No 1.x code path, harness or type pin. |

The repository path and write authority were granted separately (see [Authorization](#authorization)).

## Package layout (future paths)

```text
opencode-extensions/
├── packages/opencode-cursor-sdk/
│   ├── src/plugin/        define({id, setup}): provider registration, aisdk hook,
│   │                      model.request stamp, integration, RPC, tools
│   ├── src/provider/      LanguageModelV3 adapter, real create* export (hedge, see G2)
│   ├── src/compat/        one tiny module per OpenCode API boundary
│   ├── src/tui/           TUI entry modules (per OpenTUI line only if needed)
│   ├── src/core/          host-neutral: bridge, session pool, errors, cloud ledger, preflight
│   └── test/
└── packages/opencode-cursor-cloud/
    ├── src/plugin/        backend: four tools, completion receipts, RPC
    ├── src/compat/
    ├── src/tui/           status slot, dialogs, keymap commands over RPC
    ├── src/core/          host-neutral: state reducer, client, repo, render text, receipts
    └── test/
```

Rules:

- `src/core` imports nothing from Pi, OpenCode or OpenTUI.
- Backend and TUI code are separate entry modules. Peer dependencies belong to the package, not an entrypoint. Keep UI-only peers optional and the backend import graph free of OpenTUI so headless runs load no TUI code (F-36). Distinct TUI entries still need compatible package-level dependency resolution.
- No import of `@opencode/plugin/runtime` (first in 2.0.25) or deep `./*` paths.
- No import of OpenCode internals, including the internal Claude Agent plugin. Claude Agent first ships in 2.2.3 and is only a reference for the pending MCP call pattern.
- TUI code uses the host `slot`, `keymap`, `dialog`, `toast` and `router` APIs first and avoids direct `@opentui/*` imports where it can.
- Loading either package has no silent side effects: no Cursor agent, no network call, no SDK import (F-44) and no Cloud work until a user action or model turn asks for it.

## Compatibility policy

The floor is OpenCode **2.0.0**. Iury asked for support "from 2.0 onward", so new 2.x releases are qualification targets, not out of scope. The peer range `@opencode/plugin >=2.0.0 <3` is a safety bound. It does not promise that unseen breaking changes will work, and it does not permit dropping forward support. A new major is a new qualification, not a blanket guarantee.

Version differences live in `src/compat/`, one module per boundary. Each module detects the feature, not the version string, and has one test per side of its boundary.

| Module | Boundary | Rule |
|---|---|---|
| `provider-registration` | 2.0.4 | Before: `ctx.catalog.transform` with `provider.update` (which creates a missing provider) and `model.update`. From 2.0.4: `ctx.provider.transform` with `add({ info, models })`. |
| `request-stamp` | 2.0.0 (avoids 2.0.21) | Our `session.hook("model.request")`, filtered to our provider, reads `kind` and writes private session and purpose headers. Never read `X-Session-Id`: from 2.0.21 it carries session affinity, not the session ID. |
| `replay-native` | 2.1.0 | Map `providerState` (before) to `native` (from 2.1.0) for compaction results and stored replay data. |
| `connection-status` | 2.0.20 | Use `integration.connection.status` when present. Otherwise report status with an RPC event and a toast. |
| `integration-setup` | 2.1.0 | Key setup answers moved from `configuration` to `metadata`. Address this only if setup answers are used. |
| `session-ops` | 2.0.22 and 2.2.1 | Never require `session.compact` (2.0.22), `session.wait` (moved to experimental in 2.2.1) or `experimental.idle` (2.2.1). |
| `location` | 2.0.0 | Read `ctx.location.workspaceID`. Refuse the Cursor provider when it is set (F-60). |

Avoid APIs absent at 2.0.0: the `external` integration method (2.0.25), `ctx.credential` (2.0.28) and `./runtime` (2.0.25).

**TUI lines.** OpenCode's OpenTUI peer moves from `>=0.5.10` (2.0.0) to `>=0.6.6` (2.1.0), exactly `0.7.0` (2.2.0) and `>=0.8.0` (2.2.3). A union range such as `0.7.0 || >=0.8.0` can cover the declarations, so the boundary report's claim that one range cannot satisfy both is wrong. The real risk is runtime and API compatibility despite a broad range: renderable hooks changed in 2.2.0 and ScrollBox facades in 2.2.3. If one TUI entry cannot pass every line, ship distinct tested TUI entry modules for 0.5, 0.6, 0.7 and 0.8 inside the same two packages. A TUI entry that does not match the host's line disables itself with a message.

**Fail closed at load.** Refuse to activate when `@opencode/plugin` is below 2.0.0 or at 3 or above, when neither `provider` nor `catalog` exists, or when `session.synthetic` or `rpc.register` is missing. Each refusal shows a fixed message.

**Type checks.** Type-check against 2.0.0 types for the minimum entry contracts and against the latest qualified types for modern entry contracts. Any symbol newer than 2.0.0 sits behind a compat feature check.

## Proof tiers

Each gate names the tier that can prove it. No tier has run.

| Tier | What runs | Network | Approval |
|---|---|---|---|
| **T1 mock** | No `@cursor/sdk` code. A scripted fake SDK inside a real `@opencode/cli` at each matrix version. | Loopback only, after installing the pinned CLI versions | Installs and loopback tests are covered by the implementation handoff |
| **T2 offline real SDK** | Real `@cursor/sdk` 1.0.37 under OpenCode's Bun (`bun@1.4.2` at 2.0.0, `bun@1.4.4` at 2.2.5): import, `@cursor/sdk/sqlite` store, error shapes, a local MCP stall. No key. | No external network | Needs install approval after Phase 1 |
| **T3 live** | A real key and Cursor's servers | External | Each run needs Iury's explicit yes. May cost money. |

A T1 mock provider loading in OpenCode proves nothing about Cursor's native dependencies under Bun. That stays G1 at T2. A mocked clock does not prove a remote transport timeout.

**T1 compatibility matrix.** Real `@opencode/cli` at:

- 2.0.0 (minimum)
- 2.0.3 and 2.0.4 (provider registration split)
- 2.0.20 and 2.0.21 (connection status, host header change)
- 2.0.32 (last `providerState`)
- 2.1.0 (`native`, OpenTUI 0.6)
- 2.2.0 (OpenTUI 0.7)
- 2.2.3 (OpenTUI 0.8)
- 2.2.5 (pinned latest at the time of study)
- the latest 2.x at run time

A new 2.x release gets a matrix run before it is listed as qualified.

## Technical gates

| Gate | Question | Pass condition | If it fails |
|---|---|---|---|
| **G1** Runtime (T2, then T3 for remote timeouts) | Does `@cursor/sdk` 1.0.37 load and run under OpenCode's Bun? Bun loads the SDK's separate `connect-web` build. Pi's error classification, abort guard and MCP timeout patch match Node stack strings and skip `connect-web`. | A T2 probe imports the Bun build, opens a `@cursor/sdk/sqlite` store, classifies the offline error shapes and holds a local MCP call past 60 s, at the minimum and latest Bun versions. Anything that needs Cursor's network waits for an approved T3 run. | STOP and replan: Bun-specific heuristics, a Node worker that owns the SDK, or an upstream fix. A Node worker is a replan, not a silent switch. |
| **G2** Tool ownership and registration (T1) | Does the provider load through the public registration path at both sides of 2.0.4? Does our `aisdk` hook win against the internal `DynamicProviderPlugin` in any order? Can the stream follow the [2.x streaming contract](#streaming-contract)? Can a pending MCP bridge call survive an OpenCode tool turn and re-entry? | Mock tests for F-06 to F-13 pass across the matrix. A hook-order test passes in both orders. Registering our real npm package with a `create*` export is a hedge for the order problem, not a proven fix. | STOP. Options: an upstream re-entry or ordering hook, or in-process bridge execution only if it keeps OpenCode's permission pipeline. Never a text-only fallback or an HTTP facade. |
| **G3** Session identity (T1) | Can the provider get a stable session ID, fork lineage, model change and compaction generation? The session ID comes from our stamp. The `model.request` hook does **not** carry fork lineage. The session schema has a `fork` field at 2.0.0, but reading it at request time is unproven. | Mock tests for F-22 to F-24 pass across the matrix, including `providerState` and `native` replay. | STOP. Options: drop resume, or ask upstream for request-time lineage. |
| **G4a** Helper identification (T1) | Our `model.request` hook sees `kind` (`primary`, `title`, `compaction`, `generate`) from 2.0.0 and stamps private headers. Does every non-primary request reach the provider with a valid stamp? | All four kinds are identified by the stamp (F-14). A missing or unknown kind is rejected before any Cursor run (F-17). | STOP. Ask upstream. Never infer purpose from an empty tool list. |
| **G4b** Helper native-tool safety (T2, then T3) | The published 1.0.37 contract offers local-only `AgentOptions.tools`, where `[]` means text only ([source note](./research/sdk-controls.md)). `tools` with `cloud` throws. Can the helper lane be proven text-only? | A T2 probe and a separately approved T3 run show no native calls in the helper lane (F-16). | STOP and replan. Fallback: a separately approved non-Cursor helper model, recorded as a parity gap. Until a lane passes, helper requests refuse to start. |
| **G5** Completion handling (T1, full spike) | `session.synthetic` admits by message ID, session and type. It does **not** compare text, and it wakes the session even on a no-op replay. Can the [receipt design](#completion-receipts) admit each completion's notification at most once per receipt, with conservative recovery and an explicit `unknown` answer status? Amended by Iury, Inbox `msg_redacted`: the gate no longer requires exactly-once assistant execution, because host restart recovery is at-least-once ([evidence](./research/g5-correlation-limit.md)). | Every case in the [G5 spike list](#g5-spike-cases) passes at the minimum and latest versions (F-30, F-31, F-58). | STOP and replan. Do not weaken deduplicated admission, text-hash refusal, session binding or no blind replay. |
| **G6** TUI command transport (T1) | Can public plugin RPC (`rpc.register`, server `rpc.call`, TUI `ctx.client`) carry deterministic commands and push events? | Every condition in [TUI command transport](#tui-command-transport) passes, locally and with a TUI attached to a supported local backend (F-38, F-59, F-60). | Try the gated loopback adapter fallback. If that also fails its conditions, STOP and replan. Never prompt-template execution and never a second Cursor owner in the TUI. |
| **G7** SDK requalification (T1 typings, then T3) | Cloud docs and live evidence cite `@cursor/sdk` 1.0.23. 1.0.37 is pinned. Do the `ToolType` matrix, stall heuristics, PR controls and usage route still hold? | Contract tests against 1.0.37 typings pass. Only an approved T3 smoke confirms remote behavior. | STOP before release. Report changes, then pin or adapt. |
| **G8** SDK terms (release gate) | `@cursor/sdk` 1.0.37 is proprietary: "© Anysphere Inc. All rights reserved. Use is subject to Cursor's Terms of Service." | The packages list the SDK as a normal npm dependency and never vendor or re-bundle it. Iury reviews the terms before any publish. | STOP before publish. This plan does not claim redistribution is permitted. |

## Streaming contract

The `LanguageModelV3` adapter converts Cursor SDK stream events into V3 stream parts. OpenCode's step runner then turns those parts into its own internal events. The two are different layers: a V3 `finish` part is ours, and the host's internal step-finish is OpenCode's.

From 2.0.0 the host enforces these rules (boundary report §3.3):

- A `tool-call` with `providerExecuted: true` is never executed locally.
- Each provider-executed call needs exactly one provider `tool-result`. A missing hosted result fails with `tool.result-missing`.
- A duplicate success result, a tool name that changes between input start, call and result, or a result before its call kills the run. A late error result is ignored.
- `needsContinuation` is true only for calls that are not provider-executed. That is the bridge re-entry point.

The adapter therefore emits exactly one valid V3 `finish` per `doStream`, never a duplicate or an invalid finish reason, and never any of the failure shapes above. Tests assert each failure shape as a host rejection, so the adapter's guards are proven necessary.

Still open in G2: correlating a Cursor MCP call with its Cursor tool-call ID. Claude Agent correlates through a `PreToolUse` `tool_use_id`. Cursor may have no equivalent. Abort, empty valid results, permission prompts and continuation tests stay in M1.

## Helper policy

Iury approved this policy with the package. Approval accepts the design only. It does not prove the lane is text-only: G4b stays open, and helper requests refuse to start, until T2 and an approved T3 run pass.

- Our `model.request` hook stamps `kind`. Every non-primary kind (`title`, `compaction`, `generate`) runs in a separate **local** helper lane: `Agent.create({ tools: [] })` with no MCP, no `customTools` and no `task`. The lane never uses the coding pool and never uses a Cloud helper.
- The lane runs even when the foreground runtime is Cloud, if the chosen model supports local runs.
- A missing or unknown `kind` is rejected before any Cursor run.
- If the lane is unavailable, the alternative is a separately approved non-Cursor helper model. No silent fallback.
- Only T2 and an approved T3 run can prove the lane is text-only. G4b stays open until then.

## Completion receipts

This design is proposed, not proven. It replaces the 1.x `promptAsync` dispatcher.

**Host facts (source only, boundary report §3.7 and §4a).**

- `session.synthetic({ sessionID, id?, text, description?, metadata?, delivery?, resume? })` is public from 2.0.0.
- `id` must be a `SessionMessage.ID` starting with `msg_`. There is no caller-controlled part ID.
- Admission matches on ID, session and type, **not text**. A replay with different text returns the existing row with no error. Only a different session, a different type or a compaction row raises `SyntheticConflictError`. ID lookup is global.
- Every call wakes the session unless `resume: false` or the session is reverted, even when admission was a no-op replay.
- Promotion inserts a `synthetic` message with the same ID and publishes `session.inbox.delivered`.
- 2.x assistant messages have **no `parentID`**. Nothing links a reply to the input that caused it.

**Receipt record.** Before the first admission, persist one durable receipt per observed completion:

| Field | Rule |
|---|---|
| `id` | One host-valid `msg_` ID, minted once with the host generator or an identical one. Never a hash of agent or run IDs. |
| `sessionID` | The originating session |
| `text` | Immutable completion text |
| `textHash` | Hash of `text`. Our check, because the host does not compare text. |
| `agentId`, `runId` | For metadata and diagnostics |
| `state` | `observed` → `admitted` → `delivered`. Answer status is `unknown` unless the host offers direct evidence. |

**Rules.**

1. Create a receipt only for a completion this process has observed. Recovery after restart covers only those receipts. Never list, poll, adopt or attach old remote agents. F-32 and F-33 are unchanged.
2. Run one queue per session.
3. Before every admission, including the first retry, reconcile: look for a `synthetic` message with the receipt ID, a recorded `session.inbox.delivered` event and the current receipt state.
4. If the input was promoted or delivered, mark the receipt `delivered` and **never** admit it again. Re-admitting would wake the session and could start an extra turn.
5. Retry only an un-promoted receipt, with the same ID and the same text. Refuse to send if the text hash differs from the receipt.
6. Answer status is `unknown` unless the host offers direct evidence. A later assistant message by `seq` is not proof, because unrelated prompts can come between. A busy status is not proof. No provider-specific stamping or correlation machinery is required or planned.
7. If acknowledgment or a crash before wake is ambiguous, keep the receipt state and show a diagnostic. Never replay blindly.
8. A receipt for a deleted session fails closed with a diagnostic. A reverted session admits without waking, and that state is surfaced, not retried.

### G5 spike cases

All run in T1 at the minimum and latest versions:

- a completion on a busy session, including one that lands on the final step;
- several sessions open, completion delivered to the originating one;
- duplicate and late terminal events;
- two completions in one session;
- a payload mismatch under an existing receipt ID;
- the same ID used from another session (host conflict);
- a crash before admission, after admission, after wake and after promotion, each followed by restart;
- `resume: false`;
- reverted and deleted sessions;
- delayed replies and intervening user prompts.

Pass means one stored synthetic message per receipt in every case, admission and delivery recorded separately, answer status `unknown` without direct evidence, and no blind replay. The host may rerun interrupted model work on restart; that is disclosed, not a failure of this gate.

## TUI command transport

Pi's `/cloud`, `/cursor-cloud` and local commands run code directly. In OpenCode, the backend plugin owns Cursor state, SDK handles and credentials. The TUI plugin must not hold a second Cursor owner.

Baseline: public plugin RPC, available from 2.0.0.

```text
TUI plugin (/cloud, /cursor-cloud, /cursor-runtime, leader keys)
   │  ctx.client → server rpc.call (/api/rpc/:rpcID/:method)
   ▼
backend plugin: rpc.register(definition, handlers)
   │  fixed methods, bounded schema; events.emit for push updates
   ▼
backend state: Cloud agents, ledger, receipts, SDK handles, key
```

G6 must prove, at the minimum and latest versions:

- server authorization applies to `rpc.call`;
- each call binds to one session and location, and a request for another is refused;
- fixed method names, bounded argument schemas and size limits; no generic "run tool" method;
- read-only status methods are separate from mutating ones;
- aborts reach the backend action;
- push events from `events.emit` reach the TUI through `event.subscribe`;
- the transport works in a default local run and with a TUI attached to a supported local backend;
- no response or event carries the key or another secret.

Destructive calls keep Pi's confirmation rules. Extra confirmations, such as for `/cloud cancel`, are proposed additions.

**Remote topologies.** A TUI attached to a supported **local** backend is not the same as a remote workspace. Remote-attached UI is not excluded. It must pass the same G6 tests. A remote **workspace** is different: when `ctx.location.workspaceID` is set, the Cursor provider fails closed unless that case is separately proven safe. Public RPC does not prove that a process spawner is available. If the first SDK spawn fails, show the error and do not retry blindly.

**Fallback.** A custom loopback adapter (random token, owner-only file, worktree binding) is built only if G6 shows RPC cannot carry the needed calls or events. It is not built preemptively. Backend `ctx.command` definitions also exist at 2.0.0. They were not studied as a transport and are not the baseline.

## Milestones

Every milestone lists future modules, acceptance checks and STOP criteria. All tests are proposed. None has run.

### M0. Baseline harness and spikes (T1, loopback only)

- **Modules:** `test/harness/mock-cursor-sdk.ts`, `test/harness/opencode-matrix/` (installs and starts each pinned `@opencode/cli`), `src/compat/*` skeletons, `test/spikes/`.
- **Checks:** a mock `LanguageModelV3` loads through both registration paths and both hook orders. A mock native call is stored and never run. Load-time fail-closed checks refuse unsupported hosts.
- **Spikes:** `model.request` stamping for all four kinds (G4a); the G5 spike cases; the G6 RPC conditions; the G3 lineage probe.
- **T2 follow-on, after install approval:** the G1 probe and the G4b typings check.
- **STOP if:** the provider cannot load at 2.0.0 or latest, G5 deduplicated admission fails, or G6 and its fallback both fail.

### M1. Local provider, bridge and helper requests

- **Modules:** `src/plugin/`, `src/provider/`, `src/compat/{provider-registration,request-stamp}.ts`, `src/core/bridge/`, `src/core/stream/`, `src/core/errors.ts`, `src/core/purpose.ts`, `src/plugin/auth.ts`.
- **Facts:** F-01 to F-21, F-44.
- **Tests (proposed):**
  - native provider-executed calls mixed with real bridge calls in one turn;
  - every host failure shape in the streaming contract;
  - a native call named like an OpenCode tool, with malformed input;
  - an abort while an MCP call is pending;
  - a valid empty tool output succeeds; a missing or malformed bridge result fails closed;
  - bridged calls trigger OpenCode permission prompts;
  - helper kinds refuse to start unless G4b passed or a non-Cursor helper is approved;
  - auth precedence: host key wins over `CURSOR_API_KEY`; env alone works; neither gives the fixed error; no Pi credential file is opened;
  - redaction of the key and auth headers in errors, logs and stderr.
- **STOP if:** G2, G4a or G4b fails.

### M2. Persistence and safety

- **Modules:** `src/core/session-pool.ts`, `src/core/resume.ts`, `src/compat/replay-native.ts`, `src/plugin/events.ts`, `src/core/config.ts`.
- **Facts:** F-22 to F-24, F-40, F-41, F-61 to F-63.
- **Tests (proposed):** reset on fork, model change and compaction; `providerState` and `native` replay; parallel sessions with separate stores; project overrides failing closed; model cache TTL and stale fallback; local resume cleanup deletes only recorded IDs.
- **STOP if:** G3 fails.

### M3. SDK foreground Cloud runtime

Full parity. Each turn creates a fresh Cloud agent. The ledger is for cleanup only. The settings-only first slice in `research/sdk-cloud-settings.md` is superseded.

- **Modules:** `src/core/config.ts`, `src/core/cloud/ack.ts`, `src/core/cloud/preflight.ts` (ten codes), `src/core/cloud/local-state.ts` (full Git probe), `src/core/cloud/ledger.ts`, `src/core/cloud/options.ts`, `src/core/cloud/reporting.ts`, `src/tui/runtime-command.ts`, `src/tui/cloud-lifecycle-command.ts`.
- **Facts:** F-25 to F-28, F-46 to F-55.
- **Tests (proposed):**
  - the Pi local-state matrix, including unpushed tracked commits and a missing tracking ref;
  - a session or ledger check failure creates no remote agent (F-46);
  - a ledger write failure after create blocks the send; a run-ID write failure cancels the run;
  - an unresolved delete intent blocks retries; deleting an archived agent;
  - env forwarding rejected through every flag, env var, config key and alias;
  - a project-only acknowledgment fails.
- **STOP if:** the ledger cannot be anchored to the OpenCode session, or G7 shows changed SDK behavior.

### M4. Background Cloud delegation

- **Modules:** `packages/opencode-cursor-cloud/src/core/{state,client,repo,render,receipts}.ts`, `src/plugin/tools.ts` (registered with `ctx.tool.transform`, progress through the tool context `progress` callback), `src/plugin/completion.ts`.
- **Facts:** F-29 to F-35, F-58.
- **Tests (proposed):** the full G5 spike list against the real implementation, plus shutdown during create.
- **STOP if:** G5 fails.

### M5. TUI equivalents

- **Modules:** `src/tui/` in both packages, `src/plugin/rpc.ts`.
- **Facts:** F-36 to F-39, F-42, F-59, F-60.
- **Checks:** headless runs load no TUI code. Each TUI entry passes its OpenTUI line. A manual TUI walkthrough covers status, dialogs, commands and leader keys.
- **STOP if:** G6 fails.

### M6. Regression, compatibility and packaging

- **Facts:** F-36 (full matrix), F-43, F-45, F-56.
- **Checks:** the full T1 matrix; type checks at minimum and latest; the Pi test suites still pass in `pi-extensions`; pack checks; license and provenance review. The packed tarball contains no `@cursor/sdk` code (G8).

### M7. Live smoke and rollout (separate approval)

Not part of this approval. Live tests use a real key and may cost money, including Cloud runs at Max Mode pricing. Each run needs Iury's explicit yes. Changing the live OpenCode config also needs a separate yes.

## Coverage of facts

| Facts | Milestone |
|---|---|
| F-01 to F-21, F-44 | M1 (F-16 needs G4b and the helper policy) |
| F-22 to F-24, F-40, F-41, F-61 to F-63 | M2 |
| F-25 to F-28, F-46 to F-55 | M3 (F-55 also M7) |
| F-29 to F-35, F-58 | M4 (G5 spike in M0) |
| F-36 to F-39, F-42, F-59, F-60 | M5 (G6 spike in M0; F-36 matrix also M6) |
| F-43, F-45, F-56 | M6 |
| F-57 | M0 (T2) and M7 (T3) |

## Risks

- **Bun and Node.** Under Bun the SDK loads `connect-web`. Pi's stack-matching code skips it, and native SQLite under Bun is unproven (G1).
- **2.x churn.** Breaking changes landed in 2.0.4, 2.0.21, 2.1.0, 2.2.0, 2.2.1 and 2.2.3. Compat modules and the matrix contain the cost. They do not remove it.
- **Thin early evidence.** No GitHub release objects exist for 2.0.x or 2.1.x, and the changelog starts at 2.0.26. Boundaries before 2.0.26 come from code bisection only.
- **Hook order.** The internal `DynamicProviderPlugin` also hooks `"sdk"`. Order is a G2 test.
- **Completion delivery.** Host admission ignores text and wakes on every call. There is no `parentID`. Our receipts deduplicate notification admission. Host restart recovery is at-least-once, so an interrupted assistant turn may rerun, and answer status stays `unknown` without direct evidence.
- **MCP correlation.** Cursor may have no equivalent of Claude's `PreToolUse` ID (G2).
- **SDK terms.** The SDK is proprietary. Depending on it from npm mirrors Pi. Vendoring would copy all-rights-reserved code (G8).
- **SDK pin drift.** Cloud evidence cites 1.0.23; 1.0.37 is pinned (G7).
- **Probe size.** The Git local-state probe is large and platform-sensitive. It stays strict, because weakening it would let unpushed work silently miss the Cloud agent.
- **Permissions.** Cursor native edits and shell commands bypass OpenCode's permission prompts. This is disclosed (F-40).
- **Helper safety.** Tool denial is local-only. If the `tools: []` lane fails, helpers cannot run on Cursor (G4b).
- **Bridge shortcut.** SDK `customTools` skip approval. The bridge uses MCP through OpenCode's permission pipeline.
- **Tool rendering.** Neither 2.0.0 nor 2.2.5 has a transcript card slot. There is no exact card parity. How 2.x renders unknown tool output was not studied.
- **Spawner.** No public API reports whether a process spawner exists. Fail-closed handling is a mitigation, not a proof.

## Known research gaps

The reports studied end-to-end flows, not every line.

- Pi tests mapped by title only, listed in `research/pi-cursor-sdk.md` §13.
- `cursor-session-agent-resume.ts:331-482` (handle persistence scheduling), `chain_user_input` coverage in `cursor-provider-replay-post-tool.test.ts` and `packages/pi-ext/tests/tool-presentation/tidy/renderer-harness.ts`: unread.
- `@cursor/sdk` 1.0.37 Cloud `Agent.resume` and `close()` semantics: unread.
- Whether Cursor bills for an agent created but never sent a message.
- 2.x, unknown from source: RPC event fan-out to the TUI, server authorization for `rpc.call`, hook order against `DynamicProviderPlugin`, restart handling of pending inbox input, whether an idle wake with no pending input starts a turn, generic tool rendering, question and skill tool equivalents, and a project-trust API.
- Not bisected: when `session.rename` became `update`, and when `list` and `remove` joined the session domain. None is essential.

## Authorization

Iury granted the local implementation scope in [goal autonomy](./goal.md#autonomy) through Plannotator Inbox message `msg_redacted`: local edits, pinned development dependency installs, builds, tests, offline SDK probes and local commits in `~/dev/worktrees/opencode-extensions/cursor-port` on branch `cursor-port`. Push, PR, merge, live apply, external posting, paid runs and SDK installs beyond the handoff stay gated. Branches only, no merges, no force push. Commits by `iury souza <iurysza@gmail.com>` with no trailers.

## Approval

Iury approved this revised package (readback, intent, facts, feature map and plan) and asked for end-to-end implementation. The accepted facts are in [facts.md](./facts.md), and the goal package is written. The location grant in [Authorization](#authorization) is approved. Any later change to intent or facts means a revision and a fresh approval.
