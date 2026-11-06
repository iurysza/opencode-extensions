# OpenCode 2.0 boundary: compatibility evidence

Retrieved 2026-11-05. Phase 1, read-only. Source checks only: nothing was installed, built or run. "Present" means the code exists at that tag. It does not prove runtime compatibility.

## Lead review notes

The plan applies two corrections to the recommendations below. A later assistant message by `seq` is not proof that it answered a particular completion. Unrelated prompts can intervene, so G5 requires consumption or correlation evidence and preserves ambiguous receipts without replay. Also, one union peer range can cover OpenTUI 0.7 and 0.8; the problem is runtime/API compatibility, not the mathematical range. Peers are package-level, not entrypoint-level. See the revised [plan](../plan.md).

## Summary

`v2.0.0` exists. It is git tag `63f7ceecbed2d7d9a627518d935dd963b9d4ac9f`, and npm publishes `@opencode/plugin@2.0.0` and `@opencode/cli@2.0.0`. Almost every API the revised design needs is already public at 2.0.0: `session.synthetic`, `model.request` with `kind` and mutable `headers`, `aisdk.hook("sdk"|"language")`, plugin RPC with a TUI `OpenCodeClient`, `integration`, TUI slots and keymaps, and the provider-executed settlement rules. Supporting "2.0 onward" therefore needs narrow adapters, not a 2.2.5 minimum. The adapters cover five boundaries: provider registration (2.0.4), connection status (2.0.20), session headers (2.0.21), `providerState`→`native` (2.1.0), and OpenTUI peers (2.1.0, 2.2.0, 2.2.3).

Two review claims are wrong at every 2.x tag, and the revision must correct them:

1. **A different payload with the same synthetic ID does not raise a conflict.** The inbox compares only session and type, so the first admission wins without any error.
2. **v2 assistant messages have no `parentID`.** F-58's delivery evidence cannot be built as written.

Claude Agent first ships in 2.2.3. It is a design reference, not a 2.0 API.

## Source method

- Repo: `sst/opencode`, which now redirects to `anomalyco/opencode`. Boundary tags were fetched blobless into `sources/opencode-main` (local tags only; HEAD stays `893e8dc4`, remote config restored). Code was read with `git show <tag>:<path>` and a feature-presence scan over all 44 `v2.*` tags.
- Changelog: `CHANGELOG.md` at v2.2.5. **Its earliest entry is v2.0.26** (line 1296), so boundaries in 2.0.0–2.0.25 come from code bisection alone.
- Registry: `registry.npmjs.org/@opencode%2fplugin` and `@opencode%2fcli`. GitHub Releases API: `/repos/anomalyco/opencode/releases`.
- Pinned URLs use `https://github.com/sst/opencode/blob/<SHA>/<path>#Lx-Ly` with these SHAs:

| Alias | Tag | Commit | Date |
|---|---|---|---|
| `A` | v2.0.0 | `63f7ceecbed2d7d9a627518d935dd963b9d4ac9f` | 2026-09-11 |
| `B` | v2.0.4 | `466b3e594d3df396a57340249590a70c5c358c8a` | 2026-09-16 |
| `C` | v2.0.20 | `84c9be93a56304a108f1a22df0c5d62c26d5b6ca` | 2026-09-29 |
| `D` | v2.0.21 | `8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72` | 2026-09-30 |
| `E` | v2.0.32 | `843a6c514e606b436a7fe713422ace0a93ad3d61` | 2026-10-16 |
| `F` | v2.1.0 | `60c68d145a14127ce633e26aa5fdfb882a7baa6d` | 2026-10-20 |
| `G` | v2.2.0 | `1097e2668b1e08ad63bdf0b1c4860b9bc01e420c` | 2026-10-27 |
| `H` | v2.2.3 | `082ac6281fd395c2d0c17fd3c38214db2f89621f` | 2026-10-30 |
| `Z` | v2.2.5 | `9bbb8ce18c80f099e0e448775f59d965ead40a21` | 2026-10-30 |

Example: `A/packages/plugin/src/promise/session.ts#L112-L129` means `https://github.com/sst/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/plugin/src/promise/session.ts#L112-L129`.

## 1. The 2.0.0 release pin

| Evidence | Result |
|---|---|
| Git tag | `refs/tags/v2.0.0` → `63f7ceec…` (lightweight; commit "fix(release): use V2 Docker artifact paths (#48571)") |
| npm | `@opencode/plugin` 2.0.0 published 2026-09-12T00:15:29Z; `@opencode/cli` 2.0.0 published 2026-09-11T23:44:52Z. Both have 44 `2.x` versions, from 2.0.0 to 2.2.5 |
| Published 2.0.0 manifest | exports `.`, `./*`, `./tui`, `./host`, `./effect`; depends on `@opencode/schema` 2.0.0; peers `@opentui/core|solid >=0.5.10`, `solid-js >=1.9.0` (npm `@opencode/plugin/2.0.0`; source `A/packages/plugin/package.json#L1-L60`) |
| GitHub Releases | **No release object exists for v2.0.x or v2.1.x** (`/releases/tags/v2.0.0` returns 404). The first v2 GitHub release is v2.2.0. Tags and npm are the authoritative 2.0.x release evidence |
| Changelog | Starts at v2.0.26 |

Conclusion: pin **v2.0.0 = `63f7ceec`**. Do not relabel 2.0.26 or 2.2.5 as 2.0.0.

## 2. Compatibility matrix

Legend: ✅ present with the same contract; ⚠️ present but changed (adapter needed); ❌ absent.

| Capability | 2.0.0–2.0.3 | 2.0.4–2.0.19 | 2.0.20–2.0.32 | 2.1.x | 2.2.0–2.2.2 | 2.2.3–2.2.5 |
|---|---|---|---|---|---|---|
| `@opencode/plugin` `.`/`./effect`/`./tui`/`./host` | ✅ | ✅ | ✅ (`./runtime` added in 2.0.25) | ✅ | ✅ | ✅ |
| Plugin `define({id, setup(ctx)})` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Provider registration | ⚠️ `ctx.catalog.transform`, `provider.update` creates | ✅ `ctx.provider.transform` + `add()` | ✅ | ✅ | ✅ | ✅ |
| `aisdk.hook("sdk"\|"language")`, `providerID` filter, `LanguageModelV3` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `providerExecuted` skip, hosted `tool.result-missing`, duplicate-result death, name-mismatch death | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `needsContinuation` only for local calls | ✅ | ✅ | ✅ | ✅ | ✅ (adds `OutputLimit`) | ✅ |
| `session.hook("model.request")` with `kind` + `headers` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Host header `x-opencode-session-id` | ❌ (`X-Session-Id` = session ID) | ❌ | ⚠️ from 2.0.21; `X-Session-Id` becomes affinity | ⚠️ | ⚠️ | ⚠️ |
| `session.synthetic({id?, text, delivery?, resume?})` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `session.compact` in plugin domain | ❌ | ❌ | from 2.0.22 | ✅ | ✅ | ✅ |
| `session.wait` | ✅ in domain | ✅ | ✅ | ✅ | ⚠️ moved to experimental in 2.2.1 | ⚠️ |
| `experimental.idle` hook | ❌ | ❌ | ❌ | ❌ | from 2.2.1 (experimental) | experimental |
| Compaction replay field | `providerState` | `providerState` | `providerState` | ⚠️ `native` | `native` | `native` |
| `rpc.register` → `emit`; server `rpc.call`; TUI `client` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `integration` oauth/command/key/env | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `integration.connection.status` | ❌ | ❌ | from 2.0.20 | ✅ | ✅ | ✅ |
| `external` integration method / `ctx.credential` | ❌ | ❌ | 2.0.25 / 2.0.28 | ✅ | ✅ | ✅ |
| TUI `slot`, `keymap`, `dialog`, `toast`, `router` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (+`home.footer.status`) |
| OpenTUI peer | `>=0.5.10` | `>=0.5.10` | `>=0.5.12…0.5.17` | `>=0.6.6` (`>=0.6.8` in 2.1.4) | `0.7.0` exact | `>=0.8.0` |
| Claude Agent reference (`PendingTools`) | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (internal plugin) |

The scan covered every tag. Each row's first appearance is listed in §3.

## 3. Findings with citations

### 3.1 Package, exports and registration

1. The 2.0.0 plugin package is `@opencode/plugin` with `.`, `./effect`, `./host`, `./tui` and `./*`. `A/packages/plugin/package.json#L1-L20`. `./runtime` first appears at v2.0.25 (`Z/packages/plugin/package.json#L17-L31`). **Do not import `./runtime` or `./*` deep paths** if 2.0.0 is the minimum.
2. Registration is `define({ id, setup(context) })` at both ends. `A/packages/plugin/src/promise/plugin.ts#L55-L60`, `Z/…/plugin.ts#L63-L68`.
3. The plugin context at 2.0.0 has `aisdk`, `catalog`, `integration`, `rpc`, `session`, `storage`, `event`, `mcp` and `tool`, but **no `provider` or `model`**. `A/packages/plugin/src/promise/plugin.ts#L26-L51`. At 2.2.5 it has `provider`, `model` and `credential`, and `catalog` is gone. `Z/…/plugin.ts#L28-L59`.

### 3.2 Provider transform, aisdk hooks and the V3 contract

4. **Boundary v2.0.4 (commit `c62d2e83`, "split provider and model registries", #48901).** From 2.0.0 to 2.0.3, plugins edit providers through `ctx.catalog.transform(editor)` with `provider.update/remove` and `model.update/remove`. There is no `add`. `A/packages/plugin/src/promise/catalog.ts#L12-L33`. The core `update` creates an empty provider when the ID is missing, so `update` can register a new provider. `A/packages/core/src/catalog.ts#L95-L106`. From 2.0.4, `ctx.provider.transform(editor)` offers `add({info, models})`. `B/packages/plugin/src/promise/provider.ts#L15-L32`. The changelog does not cover this boundary, so the evidence is code only.
5. `aisdk.hook("sdk")` and `aisdk.hook("language")` exist at 2.0.0 with `language?: LanguageModelV3`. `A/packages/plugin/src/promise/aisdk.ts#L1-L21`. The host applies an optional `providerID` filter and writes back `evt.sdk` or `evt.language`. `A/packages/core/src/plugin/host.ts#L169-L195`. The shape is unchanged at 2.2.5.
6. The internal `DynamicProviderPlugin` also hooks `"sdk"` and returns early only when `evt.sdk` is already set. `A/packages/core/src/plugin/provider/dynamic.ts#L1-L19`. Claude Agent sets `evt.sdk = { languageModel }` for its own `aisdk:` package. `Z/packages/core/src/plugin/provider/claude-agent/aisdk.ts#L10-L33`, `…/provider.ts#L52-L64`. **Test obligation:** hook order between our external plugin and the internal dynamic loader at each CI boundary. A safe hedge is to make the registered `package` our real npm package with a `create*` export, so either order loads a working factory.
7. AI SDK at 2.0.0 is `ai` 6.0.168 with `@ai-sdk/provider` 3.0.8 in the plugin package. `A/package.json#L82`, `A/packages/plugin/package.json` dependencies. Core calls `language.doStream(options)` at both ends (`A/packages/core/src/aisdk.ts#L638`, `Z/…/aisdk.ts#L720`). The v6-only loader note appears at 2.2.5 (`Z/packages/core/src/plugin/provider/sdk-factory.ts#L19-L23`). Our provider is supplied through the hook, so the loader note matters only for the hedge in item 6.

### 3.3 `providerExecuted` ownership, settlement and replay

8. At 2.0.0, a provider-executed `tool-call` is never run locally. `A/packages/core/src/session/runner/step.ts#L115`. Unsettled hosted calls fail with `RESULT_MISSING`. `…/step.ts#L206-L212`. `needsContinuation` depends only on local calls. `…/step.ts#L259`. At 2.2.5 the same rules sit at `Z/…/step.ts#L122`, `#L224-L230` and `#L279-L281`, plus a new `OutputLimit` outcome.
9. At 2.0.0 the following already kill the run: a result before its call, a changed tool name, a duplicate success result, and a duplicate step finish. A late error result is ignored. `A/packages/core/src/session/runner/publish-llm-event.ts#L458-L469`, `#L516-L520`. The scan finds name-mismatch checks at every tag, from 2.0.0 to 2.2.5.
10. Replay storage changed in **2.1.0**: `providerState`, `providerResultState` and `resultState` became `native`, and tool call and result data now merge into `tool.native`. Changelog `Z/CHANGELOG.md#L847-L922`. Code: `A/packages/plugin/src/promise/session.ts#L38-L40` (`providerState?`) versus `Z/…/session.ts#L45` (`native?`).

### 3.4 Pending MCP re-entry

11. No public API covers MCP re-entry. The reference pattern lives in the provider: an in-process MCP server parks the call in a `PendingTools` table and emits a non-provider-executed `tool-call`. OpenCode then runs the tool through its permission pipeline and calls the model again, and the result resolves the pending call. `Z/packages/core/src/plugin/provider/claude-agent/tools/pending.ts#L11-L51`, `…/claude/sessions.ts#L278-L283`. The OpenCode side of this loop, `needsContinuation` for local calls, exists at 2.0.0 (item 8). **The Cursor-specific gate remains:** Claude correlates calls through `PreToolUse` `tool_use_id` (`…/tools/hooks.ts#L7-L20`). Whether Cursor exposes an equivalent is unproven. Claude Agent being upstream does not close G2.

### 3.5 `model.request` kind

12. At 2.0.0, `SessionRequestKind = "primary" | "compaction" | "title" | "generate"`, and `SessionModelRequest` carries `sessionID`, `agent`, `model`, `kind` and mutable `headers`/`baseURL`. `A/packages/plugin/src/promise/session.ts#L61-L70`, hook key `#L106-L108`. Core emits each kind from its own `prepare` path. `A/packages/core/src/session/model-request.ts#L203-L206`, `#L257`, `#L357-L360`. The same code is at `Z/…/model-request.ts#L244-L247`, `#L318`, `#L427-L430`.
13. **Host header boundary (v2.0.21).** At 2.0.0 the host sends `X-Session-Id: session.id`. `A/packages/core/src/session/model-request.ts#L232-L242`. At 2.2.5 it adds `x-opencode-session-id: session.id`, but `X-Session-Id` now carries `SessionAffinity`, which need not equal the session ID. `Z/…/model-request.ts#L290-L298`. **Adapter:** never read host session headers. Stamp our own headers (`kind`, session ID, fork source) in our `model.request` hook, filtered by our `providerID`. Claude Agent uses the same pattern. `Z/…/claude-agent/session.ts#L11-L22`, `…/language-model/request-kind.ts#L1-L5`. This works unchanged from 2.0.0.

### 3.6 Integration and auth

14. At 2.0.0 the integration methods are `oauth`, `command`, `key` and `env`, plus `connection.resolve`. `A/packages/plugin/src/promise/integration.ts#L9-L31`, `#L87-L89`. `connection.status` arrives in **v2.0.20** (`Z/…/integration.ts#L97-L104`), the `external` method in v2.0.25, and `ctx.credential` in v2.0.28. 2.1.0 moves key setup answers from `configuration` to `metadata` (`Z/CHANGELOG.md`, 2.1.0 section, "Key credential setup answers move to `metadata`"). **Adapter:** use the `key`/`env` methods, and report status through `connection.status` when present. Below 2.0.20, report it through an RPC event and a toast.

### 3.7 Public `session.synthetic`

15. **Admission API at 2.0.0.** `SessionDomain` picks `"synthetic"` from `SessionApi`. `A/packages/plugin/src/promise/session.ts#L112-L129`. The input is `{sessionID, id?: SessionMessage.ID, text, description?, metadata?, delivery?, resume?}`. `A/packages/client/src/effect/api/api.ts#L304-L316`, identical at `Z/…/api.ts#L236-L248`. The plugin adapter encodes and decodes input through the endpoint schema, so a malformed ID is rejected. `A/packages/plugin/src/promise/adapter.ts#L260-L272`, `#L581`.
16. **Typed ID.** `SessionMessage.ID` is a branded string that must start with `msg_`. The host mints it as `"msg_" + ascending()`: a 26-character time-ordered value with a random suffix. `A/packages/schema/src/session-message.ts#L23-L30`, `A/packages/schema/src/identifier.ts#L1-L28`. Same at `Z/…/session-message.ts#L21-L29`. The schema checks only the prefix. History orders by `seq`, not by ID (`A/packages/core/src/session/history.ts#L56`, `#L93`).
17. **Admission semantics (2.0.0 ≡ 2.2.5).** `Session.synthetic` admits `{type: "synthetic", payload, delivery: delivery ?? "steer"}` under the ID. An inbox `LifecycleConflict` maps to `SyntheticConflictError`. It then **calls `execution.wake` unless `resume === false` or the session is reverted, even when admission was a no-op replay**. `A/packages/core/src/session/session.ts#L267-L309`. The only differences at `Z/…/session.ts#L286-L328` are cosmetic.
18. **The idempotency key is (ID, session, type), not the payload.** `matches()` compares only `sessionID` and `type`. `A/packages/core/src/session/inbox.ts#L69-L74`, `Z/…/inbox.ts#L79-L84`. `reconcile` returns the existing row on a match and raises a conflict only on a session or type mismatch, or when the existing row is a compaction. `A/…/inbox.ts#L155-L167`. Lookup by ID is global, not per session (`find`, `#L108-L111`). After promotion, the ID is checked against the message table (`promotedFromMessage`, `#L113-L143`). **The review's claim that a different payload raises `SyntheticConflictError` is false.**
19. **Delivery modes** are `steer | queue`. `A/packages/schema/src/session-inbox.ts#L11-L12`. A steer is promoted at a step boundary during work. A queued input is promoted only at the idle boundary. `A/packages/core/src/session/inbox.ts#L43-L49`. Promotion publishes `session.inbox.delivered` and inserts a `synthetic` message **with the same ID**. `A/packages/core/src/session/projector.ts#L601-L631`.
20. **There is no caller-controlled part ID.** The v2 synthetic message is `{id, metadata?, time, text, description?, type: "synthetic"}` with no parts. `A/packages/schema/src/session-message.ts#L32-L36`, `#L84-L89`. Only the message ID is caller-controlled.
21. **v2 assistant messages have no `parentID`.** Assistant fields are `agent`, `model`, `content`, `snapshot`, `finish`, `providerState|native`, `cost`, `tokens`, `error`, `retry` and `time`. Neither tag has a link to the input that caused the reply (`A/…/session-message.ts`, `Assistant` struct; `git grep parentID` on `Z/…/session-message.ts` finds nothing).
22. **Upstream reference.** Subagent completion calls `sessions.synthetic({ id: notificationID, … })`. `A/packages/core/src/session/subagent-completion.ts#L36-L44`. The `notificationID` is minted once with `SessionMessage.ID.create()` and **persisted on the job record** before use. `A/packages/core/src/job.ts#L327`.

### 3.8 RPC and the TUI client

23. At 2.0.0, `rpc.register(definition, handlers)` returns a registration whose `events.emit(...)` pushes events. `A/packages/plugin/src/promise/rpc.ts#L19-L31`. The server exposes `rpc.call`. `A/packages/server/src/handlers/rpc.ts#L9-L13`. The generated client has `rpc.call` at `/api/rpc/:rpcID/:method` and `event.subscribe` at `/api/event`. `A/packages/client/src/promise/generated/client.ts#L1652-L1670`. TUI plugins receive `client: OpenCodeClient`. `A/packages/plugin/src/tui/context.ts#L508`, `Z/…#L549`. **Test obligations:** whether plugin RPC events reach a TUI through `event.subscribe`, and how the server authorizes calls. Both are unproven in source.

### 3.9 Session persistence and compaction

24. Compaction appears at 2.0.0 as a `compaction` kind and a `SessionCompactionResult` with `providerState`. 2.1.0 renames it to `native`, adds `native.messages` windows and `metadata.keepID`, and removes `session.compacted` (`Z/CHANGELOG.md#L847-L922`). Old rows still decode. **Adapter:** read and write through a small accessor that maps `providerState` (below 2.1) and `native` (2.1 and later). `session.compact` joins the plugin domain only in 2.0.22. Do not depend on it at the minimum version.

### 3.10 TUI extension limits

25. The slot map at 2.0.0 is `app`, `home.footer`, `prompt.footer`, `prompt.footer.status`, `prompt.footer.file`, `session.composer.top`, `session.panel`, `sidebar.content` and `sidebar.footer`. `A/packages/plugin/src/tui/context.ts#L191-L202`. 2.2.5 adds `home.footer.status` (`Z/…#L191-L203`). Neither has a transcript card slot. `slot`, `keymap`, `dialog`, `toast` and `router` are present at both ends (`A/…#L460-L516`, `Z/…#L491-L557`).
26. **OpenTUI peers break three times:** `>=0.5.10` (2.0.0), `>=0.6.6` (2.1.0), exactly `0.7.0` (2.2.0, with renderable-hook changes; `Z/CHANGELOG.md#L392-L412`), and `>=0.8.0` (2.2.3, with ScrollBox facades; `Z/CHANGELOG.md#L118-L127`). 2.2.0's exact `0.7.0` pin and 2.2.3's `>=0.8.0` cannot both be satisfied by one peer range.

### 3.11 Runtime and process constraints

27. Claude Agent skips itself when `location.workspaceID` is set or the environment spawner is unavailable, but it reads these through **internal** services (`../../../environment`, `../../../location`). `Z/packages/core/src/plugin/provider/claude-agent/index.ts#L20-L29`. Public plugins get `ctx.location: Location.Info`, which carries an optional `workspaceID` (`A/packages/plugin/src/promise/plugin.ts#L27`, `A/packages/schema/src/location.ts#L11-L16`). Spawner availability has no public surface. The root `packageManager` is `bun@1.4.2` at 2.0.0 and `bun@1.4.4` at 2.2.5.

## 4. Answers to the two lead checks

### (a) Synthetic IDs and part IDs

**Public guarantees** (source-level, 2.0.0 through 2.2.5):
- `id` must be a `SessionMessage.ID`, meaning a string that starts with `msg_` (item 16). Anything else fails decoding.
- The first admission for (ID, session, type) wins. A replay returns the existing row with any payload. Another session or type, or a compaction, raises `SyntheticConflictError` (items 17–18).
- The promoted message keeps the same ID (item 19).
- No part ID exists (item 20).

**Guidance:**
- When a completion is first observed, mint one ID with the host's `SessionMessage.ID.create()` (`@opencode/schema/session-message`, a plugin dependency at both ends), or with an identical `msg_` + ascending generator. Persist it in the durable receipt **before** calling `synthetic`, and reuse it for every retry. This mirrors `notificationID` (item 22).
- Do not use `agentId`/`runId` hashes as the ID. A `msg_`+hash would pass the prefix check but breaks the host's ID scheme, and IDs are looked up globally (item 18).
- Keep the agent and run IDs in `metadata` for display and diagnostics.
- Because replay ignores the payload, the receipt must store a payload hash and the plugin must refuse to re-send a different text under the same ID. OpenCode will not catch that.
- Drop "part ID" from F-30. It is a 1.x concept.

**Test obligations:**
- Replay wakes the session again (item 17). A replay after the message was promoted and answered might start an extra turn on an idle session. Before any retry, read the session messages: if a `synthetic` message with that ID exists, mark it delivered and never call `synthetic` again. Only an un-promoted receipt may retry, and it uses the same ID.
- A reverted session admits the input without waking.
- `resume: false` admits without waking.
- A crash between admission and wake: does a restart pick up pending inbox input?
- Steer versus queue on a busy session, including a completion that lands on the final step.

**Admission is not proof of exactly-once assistant execution.** Keep the busy-session, duplicate-completion, crash/restart, replay/conflict and acknowledgment tests.

**F-58 must be redefined.** There is no `parentID` (item 21), so the evidence becomes a ladder:
1. Admitted: `synthetic` returned.
2. Delivered: a `synthetic` message with our ID exists, or `session.inbox.delivered` was seen.
3. Answered: an assistant message ordered after it by `seq`.

The "answered" rung is runtime-observed and racy. Ambiguous states stay pending with a diagnostic.

### (b) Process-owned background agents and receipts

**Public guarantees:** none about Cursor. OpenCode has no API for adopting an external run, and none is needed.

**Design rule:** a durable receipt exists only for a completion this process **already observed**. Its states are `observed → admitted → delivered`. On restart, the plugin may finish only `observed`/`admitted` receipts using their stored ID and payload. It never lists, polls, resumes or attaches to remote Cursor runs, and runs not observed before exit stay unknown. This keeps F-32/F-33 (process-owned agents, shutdown detaches) intact.

**Test obligations:**
- A restart with an `observed` receipt admits it exactly once.
- A restart with a `delivered` receipt makes no call.
- A restart never calls Cursor list or resume APIs.
- A receipt for a deleted session fails closed with a diagnostic.

## 5. Revision guidance: 2.0 onward without a silent 2.2.5 minimum

Narrow adapters, each one module with one test per boundary:

| Adapter | Boundary | Rule |
|---|---|---|
| `registerProvider(ctx)` | 2.0.4 | Use `ctx.provider.transform(e => e.add(...))` when present; else `ctx.catalog.transform(e => e.provider.update(id, …) + e.model.update(...))`. Detect by feature, not by version string. |
| `stampRequest` | 2.0.0 (replaces the host-header dependency from 2.0.21) | Our `model.request` hook, filtered by our `providerID`, writes our own `kind`/session/fork headers. The provider rejects requests without them (F-17). |
| `replayNative` | 2.1.0 | Map `providerState` ↔ `native` for compaction results and stored replay data. |
| `connectionStatus` | 2.0.20 | Use `integration.connection.status` when present; otherwise an RPC event and a toast. |
| `sessionOps` | 2.0.22 / 2.2.1 | Do not require `compact` or `wait`. Never rely on `experimental.idle`. |
| TUI entries | OpenTUI 0.5/0.6, 0.7, 0.8 | Separate TUI entrypoints per OpenTUI line, or a TUI that avoids direct `@opentui/*` imports. The backend entry declares no OpenTUI peer, so headless use never loads TUI code (F-36). |

Packaging:
- Peer `@opencode/plugin` with `>=2.0.0 <3`.
- Type-check against 2.0.0 types; a 2.2.x-only symbol must sit behind a feature check.
- No imports of `./runtime` (2.0.25 and later) or deep `./*` paths.

**CI matrix** (T1 mock provider, real `@opencode/cli` from npm):
- 2.0.0 (minimum)
- 2.0.3 / 2.0.4 (provider split)
- 2.0.20 / 2.0.21 (status and headers)
- 2.0.32 (last `providerState`)
- 2.1.0 (`native`, OpenTUI 0.6)
- 2.2.0 (OpenTUI 0.7)
- 2.2.3 (OpenTUI 0.8)
- 2.2.5 and the latest 2.x

New minors get a CI run before the range is widened. Do not promise 3.x.

**Fail closed:**
- At load: refuse when `@opencode/plugin` < 2.0.0 or ≥ 3, when neither `provider` nor `catalog` exists, or when `session.synthetic` or `rpc.register` is missing.
- Refuse the Cursor provider when `ctx.location.workspaceID` is set.
- If the first SDK spawn or initialization fails, surface the error and do not retry blindly. Spawner availability has no public probe (item 27).
- A TUI entry that does not match the host's OpenTUI line disables itself with a message.

## 6. Blockers and remaining gates

No public-API blocker was found for the essential behaviors at 2.0.0. These remain:

- **G2 (Cursor-specific):** correlating MCP calls to Cursor tool-call IDs, and native versus host execution. This is unproven. Claude Agent proves only the OpenCode side.
- **G5:** exactly-once assistant execution is not a public guarantee (items 17, 21). It stays a runtime test gate.
- **T2:** real `@cursor/sdk` under Bun stays separate from T1 mock loading.
- **TUI:** one TUI build across OpenTUI 0.5→0.8 is unproven. Versioned entries may be required. This is a packaging cost, not a scope cut.
- **Spawner detection** has no public API. Fail-closed handling (above) is the mitigation, not a proof.

## 7. Affected fact IDs

| IDs | Change |
|---|---|
| F-14, F-17 | Replace `chat.params` stamping with our `model.request` hook (`kind`, own headers). Available at 2.0.0. |
| F-16 | Kind detection is now public. The text-only `tools: []` lane stays T2/T3. |
| F-22, F-23, F-24 | Session identity comes from our stamped header, not `X-Session-Id` (affinity from 2.0.21). Compaction reset reads `providerState`/`native` through the adapter. |
| F-30 | Persisted host-format `msg_` ID; no part ID; payload hash in the receipt. |
| F-31 | Public dedupe covers admission only. Busy, duplicate, crash and replay tests stay. |
| F-58 | No `parentID` in v2. Use the evidence ladder in §4(a). |
| F-32, F-33 | Unchanged; receipts never adopt remote runs (§4b). |
| F-36, F-37, F-39 | Slot list per item 25; versioned TUI entries. |
| F-38, F-59, F-60 | RPC (2.0.0) replaces the loopback adapter. F-59 becomes RPC authorization and schema bounds. F-60 is rewritten: remote TUIs reach the backend through RPC, and the provider refuses remote workspaces. |
| F-61 | Map Pi commands to TUI keymap commands and RPC. |
| F-06–F-13 (G2) | Re-prove against items 8–11 at the minimum and current versions. |

## Sources

- **Kept:** git tags `v2.0.0`…`v2.2.5` (primary code); `CHANGELOG.md` at v2.2.5 (primary for 2.0.26 and later); npm registry metadata (publication of 2.0.0); GitHub Releases API (shows that no 2.0.x or 2.1.x release objects exist).
- **Dropped:** `packages/web` docs (still describe v1 `Hooks`, per `opencode-api.md`); `review-opus-v2.md` claims about payload conflicts and exactly-once delivery (contradicted by code).

## Gaps

- No runtime execution at any tag. Every "present" cell needs the T1 matrix.
- Not bisected: when `session.rename` became `update`, and when `list`/`remove` joined the session domain. None is essential.
- Unknown from source: RPC event fan-out to the TUI, server authorization for `rpc.call`, hook ordering against `DynamicProviderPlugin`, restart handling of pending inbox input, and whether an idle wake with no pending input starts a turn. Next step: M0 spikes at 2.0.0 and 2.2.5.
- Tags are not ancestry-checked against `dev`, because the snapshot is shallow.
