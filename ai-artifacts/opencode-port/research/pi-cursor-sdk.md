# pi-cursor-sdk: evidence report for the OpenCode port

Revision: `1241c763bf3d5b86e7ce6353dc86eb93106acbb5` (branch `opencode-port`). Package `@iurysza/pi-cursor-sdk` 0.2.0, MIT. Paths starting with `src/`, `test/` or `docs/` are relative to `packages/pi-cursor-sdk/`; all others are relative to the repo root.

Revision 2 of this report. It adds full reads of the turn pipeline (prepare, send, coordinator, live-run coordinator, drain, emit, finalize, finalizer, outcome), resume, usage, model cache and transcript budget code, and the assertions of the matching tests. Cloud runtime, config, commands, trust, question/skill tools, debug and scripts belong to the sibling report `sdk-cloud-settings.md` in this folder and are cited here only where the turn pipeline forks. (`pi-cursor-cloud.md` covers the separate background `/cloud` package.) SDK tool controls (`tools`, `disallowedTools`, `customTools`) are in `sdk-controls.md`.

## Summary

pi-cursor-sdk runs Cursor's own agent loop through `@cursor/sdk` (`Agent.create` or local `Agent.resume`, then `agent.send`). pi adapts that loop's output; it does not translate Cursor into a chat-completions API. Cursor owns its native tools. pi owns two extra surfaces: a loopback MCP bridge that lets Cursor call active pi tools, and display-only replay that shows Cursor tool activity as pi cards without re-running it.

The hard part is a **live-run state machine** that keeps one SDK run open across several pi provider calls. Each bridged or replayed tool batch ends the pi turn with `toolUse`; the next provider call drains the same run instead of sending a new prompt. That design answers a pi constraint. OpenCode's `providerExecuted: true` + `dynamic: true` path (`research/opencode-api.md`, Gate steps 2, 3 and 6) means OpenCode will not execute a provider-reported tool and will not wait for a local result. Several pi mechanisms therefore become **implementation-specific**, not port requirements. §15 labels each constraint.

Local resume is a strictly scoped `Agent.resume()` of a recorded local `agent-*` ID. Cloud has **no resume or attach**: every cloud turn creates a new cloud agent, and restart handling covers only the durable lifecycle ledger used for list/archive/delete (§8.4).

## Coverage and method

- Reads only. No install, build, test, smoke run or Cursor call. No test results exist from this session; every test claim below comes from reading assertions.
- Installed `@cursor/sdk` was not found on disk. I read SDK 1.0.37 metadata, `LICENSE.md`, bundled notice files, `package.json` exports and a string count of `dist/bundled/index.js` by streaming the public npm tarball to stdout (no install, no execution, nothing saved). Other SDK behavior claims rest on this package's code and docs.

### Read (ranges noted)

Rows with a partial range were read only in that range.

| File | Lines | Role |
| --- | --- | --- |
| `src/cursor-provider-turn-runner.ts` | 175 | Phase order: drain → prepare → send → live emit or direct finalize → cleanup |
| `src/cursor-provider-turn-prepare.ts` | 461 | Local vs cloud fork, agent lease, send plan, live-run start |
| `src/cursor-provider-turn-send.ts` | 159 | `agent.send`, abort listener, local force, lineage |
| `src/cursor-provider-turn-coordinator.ts` | 336 | SDK `InteractionUpdate`/step → pi events or live-run queue |
| `src/cursor-live-run-coordinator.ts` | 547 | Live-run registry, leases, idle dispose, release/abandon |
| `src/cursor-provider-live-run-drain.ts` | 256–503 (body); 1–255 read in revision 1 | Drain loop, pre-send drain, tool-use emission |
| `src/cursor-provider-turn-emit.ts` | 59 | Live emit under lease; abort flush |
| `src/cursor-provider-turn-finalize.ts` | 211 | `run.wait()` → outcome, transcript web-tool replay, context-window cache |
| `src/cursor-provider-run-finalizer.ts` | 255 | Terminal event once; error/abort mapping; cleanup ordering |
| `src/cursor-provider-run-outcome.ts` | 159 | `finished`/`cancelled`/`error` classification |
| `src/cursor-session-compaction-prep.ts` | 19 | Pre-compaction release and reset |
| `src/cursor-usage-accounting.ts` | 164 | SDK usage vs estimate |
| `src/model-list-cache.ts` | 179 | Model catalog cache |
| `src/cursor-session-agent-resume.ts` | 1–330 of 482 | Resume entry schema, branch fold, handle matching |
| `src/cursor-session-agent.ts` | 440–530 (create/resume) | `Agent.resume` attempt and fallback |
| `src/context.ts` | 138–240, 340–445 | Formatting, budget, fingerprint, bootstrap/incremental prompts |

Read in an earlier revision of this report and not re-read for revision 2 (no saved copy of that revision exists, so treat these as lower-confidence reads): `index.ts`, `cursor-provider.ts`, bridge files (`cursor-pi-tool-bridge*.ts`), `cursor-mcp-timeout-override.ts`, `cursor-session-agent-lifecycle.ts`, `cursor-provider-overflow.ts`, `cursor-provider-errors.ts`, `cursor-session-store.ts`, `cursor-native-replay-routing.ts`, `cursor-native-tool-display-tools.ts`, `cursor-session-send-policy.ts`, `cursor-api-key.ts`, `shared/cursor-model-selection-identities.mjs`.

### Tests read by body (assertions, not titles)

| Test file | Ranges | What the assertions prove |
| --- | --- | --- |
| `test/cursor-live-run-coordinator.test.ts` | 117–357 | Expired bridge calls dropped; no empty `toolUse` turn; scope index survives older release; split-turn usage ignored; leases serialize; idle dispose deferred while leased; success release keeps session agent; failure release cancels SDK run and abandons agent; abort errors suppressed |
| `test/cursor-provider-run-finalizer.test.ts` | 26–137 (assert lines) | Wait failure marks live run `done` with error before debug writes; throwing debug sinks do not change the outcome |
| `test/cursor-provider-bridge-session.test.ts` | 49–119, 227–326 (assert lines) | Agent survives text turn; send error disposes and next turn recreates; divergence and branch shrink force a new agent and full bootstrap prompt; API key change recreates |
| `test/cursor-provider-local-resume.test.ts` | 69–205 (assert lines) | Resume uses recorded `agent-old` with current bridge MCP and bootstraps the transcript; `bc-` ID never reaches local `Agent.resume`; resume failure falls back to create with a thinking-only notice, not in final content |
| `test/cursor-session-agent-resume.test.ts` | 140–216 (assert lines) | Trailing user persisted before a crash blocks resume, including a real hard-killed child process |
| `test/cursor-usage-accounting.test.ts` | 142–173 | A real poisoned-usage fixture (`input 1,125,429`) is rejected and falls back to estimates under the context window |

### Tests mapped by title only

`model-discovery.test.ts` (34 cases), `context.test.ts` (41), `cursor-session-agent-cleanup.test.ts` (17), `cursor-session-agent-local-resume.test.ts` (7), `cursor-provider-incomplete-tools-live-run.test.ts` (7), `cursor-provider-replay-idle-dispose.test.ts` (3), `cursor-provider-turn-finalize.test.ts` (5), `cursor-provider-errors.test.ts` (19). Titles and line numbers are listed in §13; their bodies were not read, so §13 marks them "title only".

### Not read, by design (not silently exhaustive)

- **Generated/data:** `src/cursor-fallback-models.generated.ts` (2,837 lines), `test/fixtures/*` (one fixture used indirectly above).
- **Owned by the cloud/settings report:** `src/cursor-cloud-*.ts` (beyond the greps in §8.4), `cursor-config.ts`, `cursor-runtime-state.ts`, `cursor-state.ts`, `cursor-setting-sources.ts`, `cursor-session-scope.ts`, `cursor-question-tool.ts`, `cursor-skill-tool.ts`, `cursor-tool-manifest.ts`, debug (`cursor-sdk-event-debug.ts`, `debug-*`), `scripts/`, and their tests.
- **Low-risk display code:** transcript formatters (`cursor-transcript-*.ts`, `cursor-tool-transcript*.ts`), display router and lifecycle emitter (`cursor-provider-turn-display-router.ts`, `-lifecycle-emitter.ts`), shell-output tracker, tool ledger, incomplete-tool visibility, final-text selection (`cursor-run-final-text.ts`), `cursor-live-run-accounting.ts`, `context-window-cache.ts`, `cursor-http1.ts`, `cursor-ripgrep-path.ts`, `cursor-sdk-output-filter.ts`, `cursor-sdk-process-error-guard.ts` (behavior seen only through tests).
- **Test boilerplate and smoke:** `platform-smoke-*`, `smoke-*`, `maintainer-scripts-*`, `package-metadata`, `validate-smoke-jsonl`, `cloud-smoke-helpers` tests.
- **Remaining source:** `cursor-session-agent.ts` outside 154–220 and 440–530; `cursor-session-agent-resume.ts` 331–482 (persistence scheduling); `cursor-session-agent-cleanup.ts` beyond greps; `model-discovery.ts` beyond revision-1 ranges.

## 1. Features: documented, implemented, tested

| Feature | Documented | Implemented | Test evidence |
| --- | --- | --- | --- |
| Cursor models as provider `cursor`, api `cursor-sdk` | README L5–22 | `src/index.ts:35-48,101` | `index-registration.test.ts` (title) |
| Live catalog + fallback + `/cursor-refresh-models` | README L191, L512 | `src/index.ts:67-99`; `model-list-cache.ts` | `model-discovery.test.ts:60-968` (title) |
| Loopback MCP bridge | README L443–447 | `src/cursor-pi-tool-bridge*.ts` | `cursor-live-run-coordinator.test.ts:117-176` (body) |
| Display-only replay | `docs/cursor-native-tool-replay.md` | `cursor-native-tool-display-tools.ts:41-69` | `cursor-provider-replay-*.test.ts` (title) |
| Agent reuse + incremental sends | README L521 | `context.ts:348-404`; `cursor-session-send-policy.ts:12,28` | `cursor-provider-bridge-session.test.ts` (body) |
| Local resume (default on) | README L302–311 | `cursor-session-agent.ts:461-508` | `cursor-provider-local-resume.test.ts` (body) |
| Usage mapping (local only) | README L408, L527 | `cursor-usage-accounting.ts:149-164` | `cursor-usage-accounting.test.ts:142-173` (body) |
| Cloud runtime (opt-in) | README L326–420 | `cursor-provider-turn-prepare.ts:119-237` | sibling report |

## 2. Auth

- Key from `CURSOR_API_KEY` or pi `/login` (README L106), resolved by `requireCursorApiKey` (`cursor-provider-turn-prepare.ts:457-461`), which throws `MISSING_CURSOR_API_KEY_MESSAGE`.
- The runner resolves the key **after** the pre-send drain (`cursor-provider-turn-runner.ts:83-86`), so a pending live run can finish without a key lookup.
- The pool key includes the API key; a key change recreates the agent (`cursor-provider-bridge-session.test.ts:304-325`, asserts `mockedCreate` twice).
- The model cache never stores the key: it stores `sha256(apiKey)[:16]` (`model-list-cache.ts:46-48`).
- **Port note (implementation-neutral):** the key goes straight into `Agent.create({ apiKey })` and `Cursor.models.list`. OpenCode needs a provider auth slot that is not an HTTP bearer.

## 3. Model discovery and cache

- Cache file `<agentDir>/cursor-sdk-model-list.json`, version 1, mode `0600` (`model-list-cache.ts:9-10,155-171`).
- TTL 24 h, override `PI_CURSOR_SDK_MODEL_CACHE_TTL_MS`; disable with `PI_CURSOR_SDK_DISABLE_MODEL_CACHE` (`:11-14,32-42`).
- Two read modes: `loadFreshCachedModels` on the startup hot path (key and TTL must match), and `loadAnyCachedModelCatalog` as a fallback when live discovery fails, regardless of age (`:136-153`).
- Every cached item is schema-checked; any invalid item rejects the whole file. `fetchedAt` may be at most 5 min in the future (`:87-122`).
- Selection: `buildCursorModelSelection(model.id, reasoning, fast)` per turn (`cursor-provider-turn-prepare.ts:447-449`). Cloud ignores `fast` (`:448`).
- Tested by title only: alias collisions skipped (`model-discovery.test.ts:279-322`), one pi model per context value (`:343`), reasoning not encoded in IDs (`:431`), fallback with redacted failure detail (`:897-943`).
- **Port note (implementation-neutral):** OpenCode's model list must express context/fast variants, per-variant context windows and reasoning mappings.

## 4. Turn pipeline (stream protocol)

### 4.1 Phase order

`CursorProviderTurnRunner.run` (`cursor-provider-turn-runner.ts:55-158`):

1. Resolve config once (`:77-79`) so drain and prepare agree.
2. **Local only:** install the EPIPE guard that marks the pooled transport dead (`:84-88`), then `drainExistingCursorLiveRunBeforeSend`. If it returns `stream_ended`, the turn is over and nothing is sent (`:89-94`).
3. Resolve key, `prepareCursorProviderTurn`, `sendCursorProviderTurn` (`:97-115`).
4. Live run → `startLiveRunCompletion` (background wait) + `emitCursorLiveTurn` (`:118-132`). Direct → `awaitFinalizeCursorRunOutcome`, then one terminal event (`:134-153`).
5. Any throw → `applyTerminalEvent({kind:"error"})`; `finally` → `cleanup` (`:154-158`).

### 4.2 Prepare

- Local (`cursor-provider-turn-prepare.ts:239-438`): ensure ripgrep, HTTP/1 config, MCP timeout patch, output filter; acquire a pooled agent lease; plan the send (`planCursorSessionSend`). A freshly **resumed** agent forces `bootstrap` with reason `process_resume` (`:315-317`). `resetAgent` disposes and force-creates (`:320-329`).
- A live run starts only when native replay is on **or** a bridge run exists (`:365-377`). Otherwise the turn is "direct": deltas stream straight to pi.
- Bridge requests that arrive before the live run exists are buffered and re-queued (`:266,279-285,378-383`).
- On any prepare failure the live run is released or the agent abandoned (`:426-437`).
- Cloud (`:119-237`) fails if a local live run is pending (`:141-143`), sends only the last user message unless `contextHandoff` is `bootstrap` (`:81-88,153-156`), and never enables bridge or replay (`:149-151,181,219-220`).

### 4.3 Send and SDK event adaptation

- `agent.send(payload, { mode, model, onDelta, onStep, local? })` (`cursor-provider-turn-send.ts:101-117`). `local.force` is one-shot (`:114-116`).
- `CursorSdkTurnCoordinator.handleDelta` (`cursor-provider-turn-coordinator.ts:150-262`) maps SDK updates:

| SDK update | Direct turn | Live run |
| --- | --- | --- |
| `text-delta` | `appendTextDelta` | queue `text-delta` |
| `thinking-delta` / `thinking-completed` | thinking block | queue |
| `turn-ended` (+usage) | stores usage | `recordSdkTurnEnded` |
| `tool-call-started` | ledger + lifecycle scheduling; bridge MCP calls tracked separately (`:185-211`) | same |
| `tool-call-completed` / step `toolCall` | `resolveCursorToolCompletion` → dedupe by identity and fingerprint → display router (`:212-238,264-335`) | display router queues `tool` events |
| `shell-output-delta` | progress as thinking text (`:239-253`) | queued as thinking |
| `summary` | `Cursor summary: …` thinking (`:254-261`) | queued |

- Bridge MCP completions are ignored for display (`ignore-bridge`, `:226-229`); pi renders those from its own tool result.
- After a successful local run, web tool calls missing from the stream are recovered from the SDK transcript after a recorded message offset (`cursor-provider-turn-finalize.ts:74-99,186-195`; offset counted before send, `cursor-provider-turn-send.ts:78-84`).

### 4.4 Prompt shape and budget

- Text transcript only: `User:`, `Assistant:` (text and tool calls; thinking dropped), `Tool result|Tool error (name, call id):` (`context.ts:154-179`).
- pi's tool catalog and guidelines are stripped from the system prompt; the skills catalog stays (`context.ts:138-152`).
- Budget: `contextWindow − min(maxTokens, 20% of window)` tokens at 4 chars/token (`cursor-usage-accounting.ts:25-36`). The latest user message, boundary text and tail guard are always kept; older messages are dropped newest-first with a `[Earlier transcript omitted: N messages …]` notice (`context.ts:192-238`). Only the latest user message's images are sent, with 1,200 tokens reserved each (`context.ts:25,103,425-430`).
- Bootstrap vs incremental: rebootstrap when not bootstrapped, system hash changes, history shrinks, any prior message hash changes, or a new `branchSummary`/`compactionSummary` appears (`context.ts:348-370`), and after 20 incremental sends (`cursor-session-send-policy.ts:12,28`). Incremental prompts carry only the latest user message plus tail guard (`context.ts:379-404`).

## 5. Live-run state machine and tool ownership

### 5.1 Live-run coordinator (`src/cursor-live-run-coordinator.ts`)

- State per run: queued events (`thinking-delta`, `thinking-completed`, `text-delta`, `tool`, `bridge-tool`), `done`/`cancelled`/`disposed`/`errorMessage`, accounting, `chainUserInputAfterCompletion` (`:26-59`).
- One active run per session scope (`pendingRunIdsByScopeKey`, `:188-189,310`); an older release does not clear a newer run (`:275-281`; test `:178-191`).
- **Leases** serialize access to a run across concurrent provider calls; abort rejects waiting leases (`:251-273,477-486`; test `:207-229`).
- **Idle dispose:** after finish, cancel or error, the run is released after an idle timeout, deferred while leased (`:488-501`; test `:231-260`).
- **Release:** cancels the bridge run, deletes recorded replay displays, unbinds the session bridge, disposes a non-session bridge. If the run was not successful, it cancels the SDK run (if still running) and **abandons the pooled session agent** (`:503-539`; tests `:262-313`).
- Matching tool results to runs: replay ID first, else bridge pending call ID (`:173-181,419-439`).

### 5.2 Drain (`src/cursor-provider-live-run-drain.ts`)

- `drainCursorLiveRunTurn` (`:293-425`) loops: emit queued text/thinking; on a `tool` or `bridge-tool` batch, wait for SDK `turn-ended` (or ignore future usage if it never comes), close open blocks, emit `toolCall` blocks and end the pi turn with `toolUse` (`:257-291`). Inactive-only native batches emit a trace and no `toolUse` (`:274-279`). Then it handles `disposed` → aborted, `cancelled` → aborted, `errorMessage` → error, `done` → final text minus already-emitted text, usage, resume notice, `done/stop`, release (`:345-398`).
- `drainExistingCursorLiveRunBeforeSend` (`:427-483`): under a lease, consumes matching `toolResult`s from context, resolves pending bridge MCP calls, waits for progress, then drains. If the user typed a new message after tool results, the mode becomes `chain_user_input`: release the run and **continue with a normal send** (`:446-449,459`).

### 5.3 The three ownership surfaces

1. **Cursor-native tools:** executed by the SDK local agent. pi never executes them.
2. **Bridge (pi executes):** Cursor calls `pi__<tool>` over loopback MCP; pi gets a real `toolCall` and runs its own tool; the next provider call returns the result to the open MCP request. Details and line refs in revision 1 (`cursor-pi-tool-bridge-run.ts:93-103,168-184,267-327`).
3. **Replay (nobody executes):** completed Cursor tools become pi `toolCall`s with `cursor-replay-*` IDs whose overridden `execute` returns a recorded result and throws if none exists (`cursor-native-tool-display-tools.ts:41-69`).

### 5.4 Comparison with OpenCode (`research/opencode-api.md`)

- OpenCode/AI SDK skip execution for `providerExecuted: true` tool calls, accept unknown names when `dynamic: true`, persist them as tool parts and do not wait for local results (`opencode-api.md` lines 35–41).
- Consequence for **replay**: a provider can emit Cursor-native activity as `tool-call` + `tool-result` with `providerExecuted: true` in the same stream. No `toolUse` turn end, no recorded-result store and no built-in `execute` override is needed. Pi's override (`cursor-native-tool-display-tools.ts`) and the `cursor-replay-*` ID machinery are **implementation-specific to pi**.
- Consequence for the **bridge**: the opposite case. Here the host must actually run its own tool. A `providerExecuted` call will not be executed by OpenCode, so the bridge still needs either (a) ending the provider turn with a normal tool call and re-entering the same SDK run on the next call (pi's model), or (b) running the OpenCode tool in-process from the MCP handler. This remains a **real port design question**, unresolved by the API report.
- Unverified on OpenCode: tool-call name collisions with built-ins and schema failures (`opencode-api.md` line 124).

## 6. Permissions

Unchanged from revision 1: Cursor-native tools bypass host permissions; only SDK `autoReview`, `sandbox` and one-shot `force` apply (`cursor-provider-turn-prepare.ts:252-255`; `cursor-provider-turn-send.ts:114-116`). Bridged tools pass through the host's normal tool path. Config trust details belong to the sibling report.

## 7. Abort and errors

- **Abort wiring:** the signal listener suppresses SDK abort errors, cancels the bridge run and calls `sdkRun.cancel()` (`cursor-provider-turn-send.ts:62-75`). If the signal fired during `send`, the run is cancelled and `CursorLiveRunAbortError` is thrown (`:142-147`).
- **Outcome classification:** caller abort or SDK status `cancelled` → `cancelled`; status `error` → sanitized failure detail; otherwise `finished` with final text chosen from result, deltas and plan text (`cursor-provider-run-outcome.ts:77-141`).
- **Terminal event exactly once:** `CursorRunFinalizer.applyTerminalEvent` guards with `terminalApplied` (`cursor-provider-run-finalizer.ts:129-138`). Direct `cancelled`/`failed` abandon the agent before pushing `error` (`:172-180`); `finished` commits the send state, flushes text, applies usage, emits notices, pushes `done/stop` (`:181-193`).
- **Error path:** discard incomplete started tools, release the live run or abandon the agent, then push `aborted` or a sanitized `error` (`:197-225`).
- **Live wait failures** mark the live run errored, and debug-sink failures cannot reclassify the turn (`:109-122`; test `cursor-provider-run-finalizer.test.ts:26-137`).
- **Cleanup order:** restore output filter, remove abort listener, clear debug ref. A live run defers debug finalization and guard disposal until `run.wait()` settles; a direct run disposes the lifecycle (cloud agent dispose) first (`:140-163`).
- **Cloud send ledger:** if the cloud run ID cannot be persisted, the run is cancelled with a 5 s bound and the turn fails (`cursor-provider-turn-send.ts:28-44,124-127`).
- Error string shapes for pi retry/overflow were covered in revision 1 (`cursor-provider-errors.ts:14-19`; `cursor-provider-overflow.ts`).

## 8. Sessions and resume

### 8.1 Pooling

- One agent per session scope; any send error, cancel or failed live run **abandons** it, and the next turn recreates it (`cursor-provider-bridge-session.test.ts:71-117`).
- `trackRunCompletion` marks the pooled agent busy until `run.wait()` settles, so compaction summarization waits instead of hitting `AgentBusyError` (`cursor-provider-run-finalizer.ts:123-125`).

### 8.2 Local resume

- Entry type `cursor-sdk-agent-resume`, versions 1 and 2; version 2 requires a store identity (`cursor-session-agent-resume.ts:8-10,136-180`).
- Only IDs matching `^agent-[A-Za-z0-9_-]+$` (≤256 chars) qualify (`:13-16`); a crafted `bc-` cloud ID never reaches `Agent.resume` (`cursor-provider-local-resume.test.ts:139-157`).
- A handle stays valid only across custom, label, session_info and user-message entries; any assistant or tool entry clears it until a newer handle appears (`:204-208,257-279`). A user message persisted before a crash blocks resume (`cursor-session-agent-resume.test.ts:140-215`, including a real hard-killed child).
- Match requires pool key, scope key, session file and id, cwd, repo root and compaction generation (`:300-330`).
- Attempt: `Agent.resume(agentId, sameOptionsAsCreate)` with the **current** bridge MCP servers; on failure, create a new agent and show a display-only notice (`cursor-session-agent.ts:461-508`; tests `cursor-provider-local-resume.test.ts:69-205`). A resumed agent always receives a full bootstrap prompt (`cursor-provider-turn-prepare.ts:315-317`).

### 8.3 Cleanup

`/cursor-local-resume-cleanup` deletes only recorded `agent-*` candidates from their recorded per-session store, with durable intent before `Agent.delete` and result after (`cursor-session-agent-cleanup.ts:219,326`; test titles `cursor-session-agent-cleanup.test.ts:112-565`, title only).

### 8.4 Cloud: no attach or resume

- No cloud code calls `Agent.resume`, `Agent.get` or any attach/reconnect API (grep of `src/` for those names finds only local `Agent.resume` in `cursor-session-agent.ts:136,467,498`, and `Agent.archive`/`Agent.delete` in `cursor-cloud-lifecycle.ts:586-587`).
- Every cloud turn calls `Agent.create` (`cursor-provider-turn-prepare.ts:158-166`) and disposes the local handle at cleanup (`:96-105`).
- The roadmap states it directly: "Cloud resume | Every cloud turn creates a new cloud agent. | Intentionally deferred/rejected" (`docs/plans/cursor-sdk-capability-roadmap-2026-07-04.md:57,92`); also `docs/evidence/cursor-local-resume-decision-evidence-2026-07-08.md:14,214-218`.
- What survives a restart is the **lifecycle ledger** (custom entries, fsync'd), re-read on `session_start` and used only for `/cursor-cloud list|archive|delete` (`cursor-cloud-lifecycle.ts:297-331,429,494-510,650`; `cursor-cloud-lifecycle-session.ts:27-29`). That is durable cleanup, not reattachment.
- The SDK declares resume/list/get publicly (`roadmap:237`, citing `stubs.d.ts` of 1.0.23). Whether `Agent.resume` works for cloud IDs is **unverified**; the package deliberately never tries it.

## 9. Compaction and summarization

- Before compaction: release every live run in scope, then reset the pooled agent (`cursor-session-compaction-prep.ts:10-19`), so summarization uses a fresh agent.
- After compaction: the resume generation increments, so old handles stop matching (`cursor-session-agent-resume.ts:268-273`), and a new `compactionSummary` forces a bootstrap send (`context.ts:360-363`).
- Summarization itself is pi's, run through the same provider. The package ships no summarizer.
- OpenCode forbids tool calls during summary generation (`opencode-api.md` line 43). A port must make the summary turn emit no bridge or replay tool calls. Pi gets this for free from the reset agent having no live run; whether Cursor's agent itself calls native tools during a summary turn is unverified.

## 10. Usage accounting

- Only **local** `turn-ended` usage is trusted; cloud usage is never applied (`cursor-usage-accounting.ts:149-164`).
- Mapping: `input = inputTokens − cacheRead − cacheWrite`; `totalTokens = inputTokens + outputTokens` as context occupancy (`:88-114`).
- Sanity gate: rejects negative or non-finite counts, `output > maxTokens`, or `input + output > contextWindow` (`:94-104`). A real 1.1 M-token fixture proves the gate stops compaction poisoning (`cursor-usage-accounting.test.ts:142-173`).
- Fallback: estimate at 4 chars/token, floored at the last accepted same-model occupancy (`:120-147`).
- Live runs that end a pi turn before SDK `turn-ended` ignore later usage for that run (`cursor-live-run-coordinator.ts:345-358`; test `:193-205`).
- **Port note (implementation-neutral):** OpenCode compaction triggers depend on reported usage. Port the sanity gate, not just the mapping.

## 11. Compatibility and licensing

- **This package:** MIT, "Copyright (c) 2026 Mitch Fultz" (`packages/pi-cursor-sdk/LICENSE`). A port that copies code must keep the notice.
- **`@cursor/sdk` 1.0.37 is proprietary, not open source.** Public npm metadata (fetched read-only from `https://registry.npmjs.org/@cursor%2Fsdk/1.0.37`, nothing installed or run) declares `"license": "SEE LICENSE IN LICENSE.md"`. The tarball's `package/LICENSE.md` reads in full: "# Cursor SDK License — © Anysphere Inc. All rights reserved. Use is subject to Cursor's Terms of Service (https://cursor.com/terms-of-service)." It grants no redistribution right.
- **Licensing consequence (evidence, not a decision):** the current package already avoids redistribution. It lists `@cursor/sdk` as a normal dependency resolved from npm at install time and bundles only MIT/Apache deps (`@modelcontextprotocol/sdk`, `@hono/node-server`) (`package.json` 158–166). An OpenCode plugin that does the same (depend, do not vendor or re-bundle the SDK) follows the same pattern. Vendoring the SDK's `dist/` into a plugin bundle would copy "all rights reserved" code; that path would need Anysphere's permission or a ToS reading, which I did not do.
- Third-party notices bundled inside the SDK (`dist/*/250.js.LICENSE.txt`, `801.js.LICENSE.txt`) are MIT and BSD-3-Clause (ieee754); they travel with the SDK package itself.
- **SDK dependencies (1.0.37):** `zod`, `@bufbuild/protobuf`, `@statsig/js-client`, `@connectrpc/connect`, `@connectrpc/connect-web`; native platform packages are `optionalDependencies` (`@cursor/sdk-{darwin-arm64,darwin-x64,linux-arm64,linux-x64,win32-x64}`); `engines.node >=22.13`. The package pins the SDK at 1.0.37 while docs and evidence cite 1.0.23.
- **Bun:** the SDK ships an explicit `bun` export condition for `.`, `./agent` and `./sqlite`, pointing at a single-file `dist/bundled/index.js` (and `sqlite.js`). That bundle references `connect-web` (3 hits) and `connect-node` once. So Bun loads a different SDK build than Node. This package's error classification, abort suppression and `setTimeout` timeout patch match `@connectrpc/connect-node` and `node_modules/@cursor/sdk` stack strings and state that connect-web "is intentionally not classified" (`cursor-provider-errors.ts:184-188`). Under OpenCode/Bun these heuristics are likely not to match. Static inspection only; no Bun run.
- Deep pi coupling remains: peer deps `@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui`, `typebox`; pi built-in tool factories used for replay.

## 12. Historical fixes worth carrying forward

Commit lessons, from the commit subjects (`git log -1 --format=%s`). Commit bodies were not re-read:

- `5b9ff53`: keep Cloud usage fetches out of provider tests.
- `6b10dd3`: guard lazy modules out of the startup import graph (relevant to F-44).
- `9427b85`: keep bridge diagnostics out of the startup graph.
- `749d457`: lazy-load the `/cursor-tools` debug report.
- `a2cca96`: lazy-load the fallback warning registration.
- `a941c70`: draw Cursor cards through tidy.

CHANGELOG 0.1.61-0.1.62 entries were not re-read for this revision. Contracts encoded in code comments read this round:

- Live-run idle dispose must not raise unhandled rejections (`cursor-live-run-coordinator.ts:495-498`).
- Pooled agent is marked busy as soon as the SDK run exists, to avoid `AgentBusyError` during auto-compaction (`cursor-provider-run-finalizer.ts:123-125`).
- Local EPIPE from a closed executor pipe marks the transport dead so the next acquire recreates it (`cursor-provider-turn-runner.ts:80-88`).
- Published SDK `toTokenUsage` sums all four fields; the package deliberately does not use it (`cursor-usage-accounting.ts:89-91`).

## 13. Test coverage map and gaps

| Contract | Evidence level |
| --- | --- |
| Live-run leases, idle dispose, release/abandon | Body read; unit-level with mocks |
| Finalizer terminal-once and debug isolation | Body read |
| Agent reuse, divergence, key change | Body read (assert lines) |
| Local resume, fallback, cloud-ID rejection, crash safety | Body read (assert lines) |
| Usage poison gate | Body read |
| Transcript budget and bootstrap rules | Title only (`context.test.ts:412-806`) |
| Model discovery, aliases, fallback | Title only (`model-discovery.test.ts`) |
| Incomplete tools on abort in live runs | Title only (`cursor-provider-incomplete-tools-live-run.test.ts:28-346`) |
| Cleanup durability | Title only (`cursor-session-agent-cleanup.test.ts`) |
| Cloud attach/resume | **No tests; feature absent by design** |

Gaps:

- All tests mock the SDK. Live behavior rests on dated evidence docs and smoke scripts that need a real key.
- No test runs the bridge or the timeout patch under Bun.
- No test covers a summary turn that receives Cursor-native tool activity.
- `chain_user_input` (user types during a pending tool turn) has no body-read test in this report; titles suggest coverage in `cursor-provider-replay-post-tool.test.ts` (unread).

## 14. Acceptance tests for the port

1. **Bridge round trip:** Cursor calls a host tool; the host runs it exactly once; the same SDK run continues and finishes with text.
2. **Native activity, no execution:** a Cursor-native edit appears as a provider-executed tool part and never reaches an OpenCode executor (OpenCode equivalent of `cursor-native-tool-display-tools.ts:63-65`).
3. **Abort mid-run:** cancels the SDK run and any pending bridge call, emits one aborted terminal event, and the next turn creates a fresh agent.
4. **Send error recovery:** an error turn disposes the agent; the next turn recreates it and succeeds.
5. **Divergence:** editing or shrinking history forces a new agent and a full bootstrap prompt.
6. **Compaction:** after compaction the next send is a bootstrap on a fresh agent, and the summary turn emits no tool calls.
7. **Usage gate:** the poisoned-usage fixture produces estimated usage under the context window.
8. **Resume (if ported):** restart reuses the agent only on exact scope match; a trailing unanswered user message blocks resume; failure falls back with a display-only notice.
9. **Cloud (if ported):** restart lists and cleans up recorded cloud agents; no turn attempts to reattach.
10. **Runtime:** MCP calls longer than 60 s survive on the target runtime with the real SDK.

## 15. Constraints for the lead (no decisions made)

| Constraint | Status |
| --- | --- |
| Cursor-native tools bypass host permissions; only `sandbox`/`autoReview`/`force` gate them | Inherent to the SDK |
| SDK agent keeps its own history; host compaction and history edits must reset it or rebootstrap | Inherent |
| Bridge needs either provider re-entry into an open SDK run or in-process tool execution from the MCP handler | Inherent to the bridge feature; mechanism open |
| Live-run registry, leases and `toolUse` turn splitting for replay | **Implementation-specific (pi).** OpenCode's `providerExecuted` + `dynamic` stream removes the need for replay; it may still be needed for the bridge if re-entry is chosen |
| Built-in tool `execute` override for replay | **Implementation-specific (pi).** Not an OpenCode requirement |
| Resume via custom session entries, branch hash and compaction generation | **Implementation-specific (pi tree model).** OpenCode needs its own scope key and invalidation hooks |
| Retry/overflow error strings | **Implementation-specific (pi classifier)** |
| Node-stack heuristics and global `setTimeout` patch | Runtime risk: SDK has a separate `bun` export build using connect-web, which the heuristics skip (static evidence) |
| `@cursor/sdk` license: Anysphere proprietary, "all rights reserved", use under Cursor ToS | Inherent. Depending on it from npm mirrors the current package; vendoring/bundling it would not |
| Cloud resume/attach | Not implemented and intentionally deferred; only ledger cleanup exists |

## Sources

- **Kept:** package source and tests at the pinned revision; README; `docs/plans/cursor-sdk-capability-roadmap-2026-07-04.md` (cloud-resume status); `docs/evidence/cursor-local-resume-decision-evidence-2026-07-08.md`; `research/opencode-api.md` for the OpenCode comparison.
- **Kept (SDK):** npm registry metadata and tarball `LICENSE.md`/`package.json` for `@cursor/sdk@1.0.37`.
- **Dropped:** generated catalog (data), smoke and maintainer scripts (release gates), OpenCode snapshots under `research/sources` (another report), cloud/settings internals (sibling report).

## Gaps

- SDK license is closed (§11). Tool controls are now read from the published declarations (`sdk-controls.md`): `tools` and `disallowedTools` are local-only and throw with `cloud`. Still unverified: cloud `Agent.resume` semantics and runtime behavior under Bun. Next step: read the 1.0.37 tarball's `dist/esm/stubs.d.ts` and `cloud-agent.d.ts`, then a sandboxed Bun import probe once execution is approved.
- Title-only tests (§13) need body reads before they serve as port templates; start with `context.test.ts:412-806` and `cursor-provider-incomplete-tools-live-run.test.ts`.
- `cursor-session-agent-resume.ts:331-482` (handle persistence scheduling) is unread; test `cursor-session-agent-resume.test.ts:216` says persistence waits for turn end.

## Start here

`packages/pi-cursor-sdk/src/cursor-provider-turn-runner.ts` (175 lines) for the phase order, then `src/cursor-provider-live-run-drain.ts:256-483` for the live-run loop that the OpenCode design will either keep for the bridge or drop.
