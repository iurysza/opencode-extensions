# Dev Log

Status: M0 in progress. No gate or milestone has passed.

## Contract approval

- Iury approved the revised Phase 1 package through Plannotator Inbox message `msg_redacted`. He wrote "Approve the revised package" and "Try to implement this end to end".
- The goal contract was finalized in this directory: [goal](./goal.md), [facts](./facts.md) and [fact metadata](./facts.meta.json). The facts reproduce F-01 to F-63 from the [reviewed draft](./proposed-facts.md) word for word.
- The implementation location and write scope were pending at that point. They are granted below.

## 2026-11-05: location grant

- Iury granted this worktree (`~/dev/worktrees/opencode-extensions/cursor-port`, branch `cursor-port`) and local write scope in Inbox message `msg_redacted`. Local edits, pinned development installs, builds, tests and offline probes are allowed. Only the lead commits. Pushes, PRs, publishing, live home configuration changes and live or paid Cursor calls are not allowed.
- Copied the Markdown and JSON contract documents and `.gitignore` from the old planning worktree. No source caches or logs were copied. The old `goal.md` and `README.md` now point here.

## 2026-11-05: G5 revision approved

- Iury approved the G5 revision in Inbox message `msg_redacted`: "Revise G5 to deduplicated notifications, conservative recovery and explicit unknown answer status, but be pragmatic."
- F-31 and F-58 in `facts.md` and `facts.meta.json` now guarantee plugin-controlled deduplicated notifications, not exactly-once assistant execution. Receipts, IDs, text hash, session binding and no blind replay stay. The host may rerun interrupted model work on restart. Admission and delivery stay separate. Answer status is `unknown` without direct evidence. No provider-specific stamping or correlation. All other facts are unchanged. Plan G5 and receipt wording follow. Evidence: [g5-correlation-limit](./research/g5-correlation-limit.md).
- No G5 code exists yet.

## 2026-11-05: first M0 slice (workspace and T1 provider harness)

Done:
- Private npm workspace with exactly `@iurysza/opencode-cursor-sdk` and `@iurysza/opencode-cursor-cloud` (Cloud is an empty placeholder for M4). One root lockfile. `npm install --ignore-scripts`.
- SDK package: fail-closed host parser (`src/compat/host.ts`), provider registration that uses `catalog.*.update` before 2.0.4 and `provider.add` from 2.0.4 (`src/compat/provider-registration.ts`), host-neutral turn events and a pure V3 stream translator (`src/core`), a `LanguageModelV3` (`src/provider`), and `sdk` plus `language` hooks scoped to provider `cursor`. The default entry fails closed with a fixed error. It imports no `@cursor/sdk`.
- Type contracts compile against `@opencode/plugin` 2.0.0 and 2.2.5.

Validation:
- `npm run check`: layout ok, typecheck ok against both host versions, 23 unit tests pass. The unit tests use hand-written fake hosts. They are not real-host proof.
- Real-host T1 (`npm run test:host`): pinned `opencode` CLI binaries 2.0.0 and 2.2.5, `env -i`, isolated HOME and XDG under `.fixtures/t1/<version>`, and a macOS sandbox that denies non-loopback network and reads of real agent config directories. The runner first proves curl to the npm registry and `ls ~/.config` both fail. A fixture plugin (built package plus scripted fake Cursor events) loaded on both versions. The model `cursor/fake` streamed text. A provider-executed `write` call was stored exactly once with `executed: true` and the Cursor result. The local sentinel file was never written. The stored finish was `stop`. Both versions passed.
- Hook order: on 2.0.0 the SDK came from the `create*` package factory (internal dynamic loader ran first). On 2.2.5 it came from the plugin `sdk` hook. The plugin `language` hook supplied the model on both.

Found during T1: real hosts expose `rpc` as a callable with `register` attached. The first host parser wrongly refused it. Fixed, and the unit fake now uses that shape.

Not done: G1, G4b, G5, G6, G8, the full version matrix, the real Cursor adapter, persistence, Cloud, TUI and the context hook. M0 has not passed.

## 2026-11-05: review fixes before real-SDK probes

- `scripts/check-layout.mjs` now fails on a missing child `package.json` (it skipped it before). The check is exported as `checkLayout(root)`. `scripts/check-layout.test.mjs` (`node:test`, run first in `npm run check`) covers a valid temp fixture tree and a missing manifest. It never touches the live workspace.
- `@iurysza/opencode-cursor-sdk` now has `dependencies: { "@ai-sdk/provider": "3.0.8" }`, because `dist/provider/language-model.d.ts` imports it. The root lockfile was refreshed with `npm install --ignore-scripts --package-lock-only --offline`. The only diff is the new child dependency, and `@ai-sdk/provider` and one transitive package are no longer `devOptional`. There are no child lockfiles.
- The T1 isolation self-check now needs positive proof that the sandbox denies access. Each probe must fail with `Operation not permitted` (EPERM). If it fails in any other way, the runner fails closed with the exit code and output.
  - Network: `/usr/bin/perl` connects to TEST-NET-1 `192.0.2.1:80`. Inside the sandbox it gives `connect: Operation not permitted`. Outside the sandbox it gives `Operation timed out`. curl was dropped because it reports both cases as "Couldn't connect".
  - File read: the profile denies a probe file under `.fixtures/t1/<v>/` by its literal real path. Outside the sandbox the runner checks that the file is readable. Inside the sandbox, `cat` must fail with EPERM.
  - `~/.config`: the runner still checks for EPERM when the directory exists.
  - The credential-directory bans, `env -i`, the isolated HOME and XDG directories and the loopback-only network rules are unchanged.
- Validation: `npm run build` passed. `npm run check` passed: 2 layout tests, layout ok, typecheck ok and 23 unit tests. `npm run test:host` passed on 2.0.0 and 2.2.5, with exit code 0.

## 2026-11-05: T2 offline real-SDK probe (partial G1, G4b typings)

- `@cursor/sdk` 1.0.37 is now an exact, normal dependency of `@iurysza/opencode-cursor-sdk`. It was installed with `npm install --ignore-scripts`. There is still one root lockfile and no child lockfile. The SDK pulled `@cursor/sdk-darwin-arm64` 1.0.37 (optional, platform binaries) and `@connectrpc/connect` and `connect-web` 1.7.0.
- Production entries still import no SDK. `test/unit/load-boundary.test.ts` loads `dist/server.js` and `dist/provider/factory.js` in a fresh Node process. A resolve hook records every specifier, and fetch, `net` and `http(s)` throw. It finds no `@cursor/sdk`, Pi or OpenCode-internal import and no network call. Negative controls prove that the hook catches an SDK specifier and the deny hooks fire. A source scan of `src/` checks the same import rule.
- The isolation code moved to `test/isolation.mjs`, so T1 and T2 use one copy. T1 behaviour is unchanged.
- `npm run test:t2` (`test/t2/run-offline.mjs`) loads a test-only plugin (`test/t2/fixture-plugin`) in the pinned `opencode` 2.0.0 and 2.2.5 binaries. It uses the same `env -i`, isolated HOME and XDG, loopback-only sandbox and positive EPERM self-check. It makes no `Agent.create`, resume or send call, uses no key and opens no real store. Evidence is in `.fixtures/t2/<v>/{probe.json,summary.json,run.out,run.err}`.
- Measured on both hosts. The host Bun is 1.4.2 on 2.0.0 (rev 744846f8) and 1.4.4 on 2.2.5 (rev 38afee6c). This is the CLI's own runtime, not a system Bun.
  - `import.meta.resolve` selects the `bun` export condition: `@cursor/sdk/dist/bundled/index.js` and `dist/bundled/sqlite.js`, not `dist/esm`.
  - The main import succeeds, and all required exports exist (76 in total).
  - `SqliteLocalAgentStore.open({ workspaceRef, stateRoot })` in the fixture works. The probe writes an agent row, a checkpoint blob and a run event. It then disposes the store, reopens it and reads all three back. The bundled driver is `bun:sqlite`. `index.db` and a per-agent `store.db` were created inside the fixture.
  - Harness mistake, fixed: checkpoint `blobId` must be hex, because blobs are content-addressed. The first probe used `"t2-blob"` and got `Invalid hex string length`. It now uses the sha256 hex.
  - Manufactured offline errors: `convertConnectError` maps Unauthenticated to `AuthenticationError`, Unavailable and DeadlineExceeded to `NetworkError`, and ResourceExhausted to `RateLimitError`. All are `CursorSdkError` instances. This shows how the classes are wired. It is not evidence of real transport errors.
- Transport, from reading the code. Not proven at runtime. The bundled build uses `@connectrpc/connect-web` only when `globalThis.Deno` is defined. Otherwise it uses its own Node-HTTP/2 "safe" transport. Under the host Bun, `Deno` is undefined. So the plan's "Bun loads `connect-web`" premise looks wrong for 1.0.37: Bun takes the `bundled` entry but the Node-style transport. This affects how F-57 classification must be checked. It needs a real RPC to confirm.
- G4b typings: `test/types/sdk-agent-options.ts` compiles against the installed declarations. `{ model, tools: [], local: { cwd } } satisfies AgentOptions`. A non-list `tools` value is rejected. This is type evidence only, not proof that native tools are denied.
- Validation: `npm ci --ignore-scripts`, `npm run build` and `npm run check` all pass (layout ok, typecheck ok, 27 unit tests). `npm run test:host` passes on 2.0.0 and 2.2.5. `npm run test:t2` passes on 2.0.0 and 2.2.5.

Still open:
- G1: real auth, network, abort and stall error classification under Bun (F-57).
- G1: the local MCP bridge call held past 60 s. Every public path found needs an agent run, so it needs `Agent.create` with approval.
- G1: remote timeouts (T3).
- G4b: runtime text-only proof of the helper lane (T2 with an agent, then T3).
- G1 and G4b are not passed.

## 2026-11-05: request stamping and real-host G4a evidence (G3 prerequisites)

Code:
- `src/core/request-context.ts` parses an untrusted `{ kind, sessionID, agent, model }` value. The kinds are `primary`, `title`, `compaction` and `generate`. A missing kind is `malformed`. Any other kind is `unknown-kind`. Nothing is guessed.
- `src/compat/request-stamp.ts`: `stampModelRequest` runs in a public `session.hook("model.request", …, { providerID: "cursor" })`. It ignores events for other providers. It deletes any existing stamp header (any case), then writes a fresh `x-iurysza-cursor-request` JSON stamp from the public event fields. If those fields do not parse, it writes no stamp. `readRequestStamp` reads only that header from `doStream(options.headers)`. It never reads `X-Session-Id` or the tool list.
- `src/core/lanes.ts`: the turn source is now `TurnLanes { coding, helper }`. `helper` is `unavailable` or `test-only` (a scripted source for fixtures, documented as no G4b evidence). There is no Cursor helper variant yet. A helper kind never falls back to the coding source.
- `doStream` order: read the stamp (`UnstampedRequestError` if missing, duplicate, malformed or unknown), select the lane (`HelperLaneUnavailableError`), refuse an already aborted signal, then call the source with the parsed `RequestContext`. The source never runs on any failure. Error messages carry the failure reason only, with no header values or session IDs.
- `parseHost` now also needs `session.hook` (new refusal `missing-session-hook`). The plugin registers the stamp hook before provider registration. Production (`server.ts`, `createCursor`) uses `codingOnly(unavailableTurnSource)`, so helper kinds refuse and primary still fails closed. There are no new user settings.

Unit tests (`test/unit/request-stamp.test.ts`, hand-written events, not real-host proof): a spoofed stamp is overwritten and `X-Session-Id` is kept but ignored. A foreign-provider event is left byte-identical, including a forged stamp. All four kinds are stamped. One session keeps one stamp across turns and model changes. Separate sessions are kept apart. An unknown or missing kind writes no stamp and strips a stale one. Eight reject cases (none, only `X-Session-Id`, non-JSON, wrong version, no kind, unknown kind, empty session, duplicate) each fail before the source runs. An empty tool list is not a purpose signal. A pre-aborted request starts no source. Production lanes refuse each helper kind before the coding source. A test-only lane gets exactly the three helper kinds. The existing hedge test now proves unstamped requests are rejected and stamped primary still fails closed.

Real-host evidence, `npm run test:req` (`test/req/run-requests.mjs`, fixture `test/req/fixture-plugin`): pinned `opencode` 2.0.0 and 2.2.5, shared `test/isolation.mjs` (`env -i`, isolated HOME and XDG under `.fixtures/req/<v>`, loopback-only sandbox, positive EPERM self-checks). Every request was driven by a public host route. No hook was called by hand.
1. `run -m cursor/fake` gave a primary turn, and the host's automatic title request followed.
2. `run -s <id>` gave a second turn. The fixture's test-only `language` wrapper reported 199,000 input tokens on primary finishes, so the host compacted automatically (`reason: "auto"` in the export) before the turn.
3. `api POST /api/session/<id>/generate` used the public `session.generate` route. The `session.generate` operation ID is not found at 2.0.0, so the method-and-path form was used.
4. `run -s <id> --fork` forked the session.
5. `run -s <fork> -m cursor/fake2` changed the model.
- Both versions pass all checks. Each of `primary`, `title`, `compaction` and `generate` reached `doStream` with a stamp whose kind and sessionID match the host event. A forged stamp written by an earlier test hook was overwritten on every request, and no source saw it. Every source call was stamped. The primary sessionID stayed stable across turns. The fork had its own sessionID.
- G3 prerequisites, measured: at request time, `ctx.session.get({ sessionID })` in a `model.request` hook returned `fork: { sessionID: <parent>, boundary: { type: "through", messageID } }` for every fork request on both versions (`parentID` unset). The model change was visible in both the hook `model` and the session `model` (`fake2`), and in the parsed stamp at the source.
- Compaction lineage, observed but not solved: the export stores a `compaction` message with `status`, `reason: "auto"`, `model` and `summary`. On 2.0.0 it also stores `providerState` (our finish `providerMetadata`). On 2.2.5 it stores `metadata.keepID` and no `providerState`. Neither host gives the provider a compaction counter or generation at request time. After compaction the next primary prompt contains the summary, and a fork run starts with its own automatic compaction. A provider-side generation (F-23) must be derived, for example from a compaction kind seen for the session or from the summary or checkpoint shape. This is not designed or tested yet. `native` replay was not exercised: the fake model has no `compaction.mode: "provider"`.

Validation: `npm ci --ignore-scripts`, `npm run build` and `npm run check` all pass (2 layout tests, layout ok, typecheck ok against 2.0.0 and 2.2.5, 52 unit tests including load-boundary). `npm run test:host` passes on both versions with strict stamps. `npm run test:t2` passes on both. `npm run test:req` passes on both. The load-boundary regex is unchanged, because no new imports were needed.

Gate status:
- G4a: all four kinds were identified end to end on the minimum (2.0.0) and latest (2.2.5) pinned hosts, and a missing or unknown stamp is rejected before any source (F-14, F-17 at T1). The middle versions of the full matrix have not been run, so G4a is not marked passed.
- G3: the prerequisites are shown (stable session ID from the stamp, fork lineage readable at request time, model change visible). It is not passed: there is no persistence or session pool, F-22 to F-24 are not tested, the compaction generation is unresolved, and `native` replay has not run.
- G4b: unchanged and open. Helper kinds refuse in production.
- G1 and G5 to G8: unchanged.

Release risk (not blocking, no pins changed): the lead ran `npm audit --omit=dev` (evidence in `.fixtures/lead-verification/runtime-audit.json`). It reports `@cursor/sdk` 1.0.37 as high, through a transitive `zod` below 4.6.6 (GHSA-mrhx-c7xc-m3w5: oversized invalid collections can exhaust memory). npm suggests SDK 1.3.1 as the fix. There are also several moderate findings in the OpenCode peer chain. The lead verified the primary advisory at api.github.com. No vulnerable path in this port has been shown, and exploitability is not claimed. An SDK upgrade needs requalification (T2 and later gates), not `npm audit fix`. This does not stop isolated fixtures.

## 2026-11-05: correction, request-stamping evidence had false-positive checks

Review found that `test/req/run-requests.mjs` checked identity only inside hook records (stamp against the same hook), and checked sources only by kind and by counts. A source with the wrong session, or with the wrong executing model, could pass. `stableSessionAcrossTurns` counted primary sources across the whole log, so step-1 retries could stand in for step 2. The earlier entry's "all checks pass" claim relied on these weak checks. The recorded behaviour was correct, but those checks did not prove it.

Test-only fix, no production change:
- New pure helper `test/req/evidence.mjs`. For each CLI step, it does an exact multiset match. Every source context must use up a distinct `model.request` hook in the same step with the same host identity: kind, sessionID, agent, model providerID, id and variant. These values come from the host hook fields, not from a decoded stamp. `source.modelId` must equal the host hook's model id. Every hook must be used. A separate check confirms that each stamp decodes to exactly its hook's identity.
- The runner records fixture log offsets around each CLI step and checks that every log line belongs to a step. `stableSessionAcrossTurns` now needs a matched primary for the original session in step 1 and in step 2. `modelChangeVisibleAtSource` now needs `fake` in step 4 and `fake2` in step 5.
- Fixture change: the hook record now also logs `event.agent`.
- Negative regressions run on each real capture and must fail validation: a wrong helper session (counts unchanged), a wrong executing model (counts unchanged), and step-2 primary records moved into step 1 (totals unchanged). I checked the failing checks for each case on both versions: the first two fail the match and the title kind check, and the third fails only `stableSessionAcrossTurns`.

Validation: `npm run build` and `npm run check` (52 unit tests) pass. `npm run test:req` passes on 2.0.0 and 2.2.5. All four kinds matched (primary 4, title 1, compaction 3, generate 1). Fork lineage and the model change still pass, and all three regressions are rejected. `npm run test:host` and `npm run test:t2` still pass on both versions. Gate status is unchanged from the previous entry. No gate is marked passed. The middle versions of the full matrix have not been run.

## 2026-11-05: approvals recorded (no probe run in this entry)

- Iury approved keyless sandboxed `Agent.create` probes (Inbox msg_redacted). Scope: no real credentials, the existing `env -i` isolated HOME/XDG network-blocked sandbox, local runtime only, no Cloud, no prompt `send`. Added as a narrow exception in `AGENTS.md`. The parent will run that T2 slice later. No such probe has run yet.
- Iury acknowledged the `@cursor/sdk` 1.0.37 audit risk ("its alright", msg_redacted). The pin stays at 1.0.37. No upgrade.

## 2026-11-05: full T1 matrix for provider loading and request identity; G3 compaction token

Acquisition (network allowed, separate from probes): `test/matrix/acquire.mjs` (`npm run fixtures:acquire`). For each version, it runs `npm pack @opencode/cli-darwin-arm64@<v> --ignore-scripts` with the fixture dir as cwd, then checks the tarball's sha512 against the registry `dist.integrity`, extracts it to `.fixtures/inspect/bin-<v>/` and writes `acquired.json` (version, tarball URL, integrity). An existing binary is reused only if its tarball still matches. No install, no lockfile; the script fails if a `package-lock.json` appears under `.fixtures/inspect`. Registry `dist-tags.latest` at run time was 2.2.5, so the deduped matrix is 10 versions: 2.0.0 and 2.2.5 reused, the other 8 fetched, all integrity-matched.

Runtime (loopback only): `test/matrix/run-matrix.mjs` (`npm run test:matrix`) runs the existing `test/t1/run-host.mjs` and `test/req/run-requests.mjs` once per version in separate processes. It reports every version as pass, fail, fail-closed or missing, with failed check names and the evidence dir (`.fixtures/matrix/report.json`). No harness or production change was needed for version-specific CLI shapes in provider loading or request stamping.

Results, 20 of 20 runs pass on 2.0.0, 2.0.3, 2.0.4, 2.0.20, 2.0.21, 2.0.32, 2.1.0, 2.2.0, 2.2.3 and 2.2.5:
- `test:host` (provider loading, native tool, stored finish): pass on all 10.
- `test:req`: pass on all 10. The exact per-step source-to-host-hook matching is unchanged. Every version matched primary 4, title 1, compaction 3, generate 1. Fork lineage and model change passed. All negative regressions were rejected.
- `test:t2`: min and latest only (2.0.0, 2.2.5), both pass. G1 is not claimed as passed.

G3 compaction token (prerequisite only):
- New pure helper `src/compat/compaction-token.ts`. It reads public `ctx.session.context({ sessionID })` output (`SessionMessage.Info[]`, same type at 2.0.0 and 2.2.5). The token is the id of the newest `type: "compaction"` row with `status: "completed"`, or a `none` sentinel. Running and failed rows never advance it. `metadata.keepID` is not used. Request counts are not used. It is not wired into production yet; there is no session pool.
- Unit tests (`test/unit/compaction-token.test.ts`, 6 tests): sentinel, newest completed, a newer running or failed row does not advance it, keepID ignored, malformed input rejected, comparison.
- Real-host fixture: the req fixture's `model.request` hook calls `ctx.session.context` and logs only compaction row ids and statuses plus the derived token. New checks in `test/req/evidence.mjs`: readable on every request; `none` before the first compaction; the token changes exactly once in the main session, and only right after a compaction request; it is unchanged in step 3 (a separate CLI process); the fork gets its own token and never shows the parent's post-compaction token; a running row is never the token.
- Host shape difference, measured: at 2.0.0 to 2.0.4 and 2.2.0 to 2.2.5, `session.context` during the compaction request shows the in-flight compaction as a `running` row, and the next token equals that row's id. At 2.0.20, 2.0.21, 2.0.32 and 2.1.0, no row is visible until it completes. For those, the check requires the new token to be an id never seen in earlier requests. The `runningCompactionAdvancesToken` regression cannot apply there and is reported as not applicable in the summary, not as a pass. Other new regressions (token reset on restart, change without compaction, revert to a stale id) are rejected on all 10.
- A failed compaction was not produced on a real host. "Failed does not advance" is unit-tested only.

Gate status:
- G4a: passed at T1 across the declared matrix (all four kinds identified end to end on all 10 versions; missing or unknown stamps rejected before any source in unit checks).
- G3: still prerequisite only. Token stability and persistence across processes are shown, but no session pool, no persisted generation, no resume, and no F-22 to F-24 tests. `native` replay was not run.
- G1, G2 and G4b to G8 remain open.

Validation: `npm ci --ignore-scripts`, `npm run build`, `npm run check` (layout ok, typecheck at 2.0.0 and 2.2.5, 58 unit tests), `npm run test:t2` (2.0.0, 2.2.5), `npm run test:matrix` (20 of 20 pass). Root lockfile only.

## 2026-11-05: matrix acquisition review fix

- `test/matrix/acquire.mjs` failed on a fresh clone: the first `npm view` ran with cwd `.fixtures` before any fixture dir existed (spawn ENOENT). New exported `resolveLatest2x` creates `.fixtures/inspect` first, then queries npm with that dir as cwd.
- Latest 2.x now comes from the registry's full `versions` list (`latestStable2x` in `test/matrix/versions.mjs`: highest plain `2.Y.Z`, prereleases and 3.x ignored), not `dist-tags.latest`. A future 3.x release no longer stops the matrix from qualifying the latest 2.x. No stable 2.x still fails acquisition. Exact pins and the tarball integrity check are unchanged.
- New `test/unit/matrix-acquire.test.mjs` (4 tests, fake npm, temp dirs): numeric highest stable 2.x, no 2.x rejected, fixture dir exists before the first npm call.
- Validation: `npm run build`, `npm run check` (62 unit tests), `npm run fixtures:acquire` against the registry (latest 2.x = 2.2.5, all 10 binaries reused, integrity-matched). No production code changed.

## 2026-11-05: keyless local `Agent.create` probe (T2, approved slice)

Approval: Iury, Inbox msg_redacted (AGENTS.md exception). Test-only. No production change. SDK stays 1.0.37.

New `test/t2/run-create.mjs` (`npm run test:t2-create`) and fixture `test/t2/create-plugin/server.js`. Same shared isolation as T1 and T2 (`test/isolation.mjs`): `env -i`, isolated HOME/XDG under `.fixtures/t2-create/<v>`, loopback-only sandbox with positive EPERM self-check. The runner checks the fixture HOME is empty, so no `~/.cursor/sdk/auth.json` exists, and `CURSOR_API_KEY` is unset in the host.

Exact call shape, typed as published `AgentOptions` (`dist/esm/options.d.ts`), via public `import("@cursor/sdk").Agent.create`:
`{ name, tools: [], local: { cwd: <fixture project>, store: <fixture SqliteLocalAgentStore>, settingSources: [] } }`, once without `model` and once with `model: { id: "composer-1" }`. No `apiKey`, no `cloud`, no `mcpServers`, no `customTools`, no `agents`, no `agentId`. Never `send`, `resume` or `prompt`. Each call and each dispose is bounded at 20 s and recorded as resolved, rejected or stalled. The host run is bounded at 90 s; a host timeout or surviving process (ps scan of the fixture path) fails the probe.

Result on 2.0.0 and 2.2.5: both cases **resolve** in 0 to 2 ms with an `agent-…` handle (`send` present, unused). `model` is null without a model, `{ id: "composer-1" }` with one. `Symbol.asyncDispose` resolves. The fixture store holds 2 `idle` agents afterwards. No rejection, no stall, no orphan, no network or sandbox denial in `run.err`, HOME still empty.

What this proves: local `Agent.create` is a store-only operation in 1.0.37. It writes an agent row and an initial run row, and does no auth, model or tool-name validation against a backend. Source reading of the bundle agrees: local `createAgent` only writes to `localStore`. `Agent.create` does resolve a key on the local path too (`CURSOR_API_KEY`, then `homedir()/.cursor/sdk/auth.json`, here the empty fixture HOME; the real `~/.cursor` is also sandbox-denied), but an absent key is not an error until a Cloud call or, presumably, `send`.

What it does not prove: authentication refusal, helper tool denial with `tools: []`, MCP behaviour, stall or abort handling, or any transport semantics. Missing-key refusal would only surface at `send`, which is outside this approval. The model id was not validated.

Gaps: the remaining G1 and G4b runtime checks (auth refusal, tool and MCP denial at run time, stall, abort, real error mapping) are **live-dependent**. They need `send`, so they need a new approval. This probe is stopped there. F-57's transport premise remains an observed-source discrepancy; facts and plan unchanged.

Validation: `npm run build`, `npm run check` (62 unit tests), `npm run test:t2`, `npm run test:t2-create`, `npm run test:host`, `npm run test:req` all pass on 2.0.0 and 2.2.5. Full matrix not rerun (only T2 files added).

Follow-up, same day: the first run above was discovery (it recorded any outcome and passed on a stall). Its observed results are now qualified regression expectations in `run-create.mjs`: both cases must resolve, both public disposals must resolve, and the fixture store must hold exactly 2 `idle` rows. A rejected or stalled create or disposal fails the command. A handle without `Symbol.asyncDispose` or `close` is recorded as dispose `unavailable` and fails, instead of counting as cleaned up. All outcomes are still recorded. No `send`, no wider probe.

## 2026-11-05: G5 completion receipts (core, public adapter, real-host T1)

Approved amendment: Inbox msg_redacted (deduplicated notifications, conservative recovery, answer status always `unknown`). No Cursor SDK or Cloud call. Cloud package has no `@cursor/sdk` dependency; lockfile unchanged.

Code in `packages/opencode-cursor-cloud`:
- `src/core/` (host-neutral, no Pi, OpenCode or OpenTUI imports): `message-id.ts` (copy of host `Identifier.ascending`, MIT attribution), `receipt.ts` (states `observed`, `dispatching`, `admitted`, `delivered`, `held`; pure transitions; SHA-256 text hash; stored-record parser rejects changed text, bad IDs, unknown states and misfiled keys; `delivered` never regresses), `keyed-queue.ts` (one queue per session), `receipts.ts` (shell: intent saved before every host call; recovery dispatches only `observed`; `dispatching` without host evidence becomes `held: uncertain-attempt`, never replayed).
- `src/plugin/completion.ts`: adapter over public `ctx.storage`, `ctx.session.get/context/synthetic` and `ctx.event.subscribe` (client-side filter for `session.inbox.delivered`).
- Type tests against 2.0.0 (`tsconfig.min.json`) and 2.2.5.

Real-host T1: `npm run test:host -w packages/opencode-cursor-cloud` (`test/t1/run-receipts.mjs`). Pinned `serve` binaries under the shared isolation (`env -i`, isolated HOME/XDG, loopback sandbox). Added `sandboxedSpawn` to `opencode-cursor-sdk/test/isolation.mjs` for a long-lived server in its own process group. Fixture `test/t1/receipts-plugin/server.js` uses the SDK fake provider and a test-only RPC to observe completions, arm SIGKILL fault points, stage IDs and block a turn. Crash cases kill the host and restart it on the same data dir. Waits are bounded polls on log or host evidence.

Result on 2.0.0 and 2.2.5: all 16 scenarios pass (basic; busy final step plus intervening prompt; two sessions; two completions in one session; duplicate and late events; payload mismatch on promoted and pending rows; cross-session ID conflict; `resume:false`; reverted session; deleted session; crash before attempt, after intent, after host admission, after wake, after promotion; late duplicate after restart). Global invariants hold: at most one host call per receipt, at most one stored synthetic per ID, every answer `unknown`, no corrupt receipts, no orphan process.

Bug found by the real host and fixed: a cached delivered event for a reused ID marked an unattempted receipt `delivered` without any host call. The cache is now keyed by session and inbox ID, cleared when our intent is written, and ignored for `observed` receipts. Unit regression test added (21 unit tests).

Observed host facts: a replayed ID with new text returns the existing row unchanged with no error; a cross-session reuse raises `SyntheticConflictError`. Crash right after host admission leaves the receipt `held: uncertain-attempt` with no row in history; the host did not keep the row (it died before commit) and we did not replay it. After a crash with a pending woken item, restart did not rerun the model for that session in these runs; host recovery is at-least-once by design, so this is disclosed, not guaranteed.

Gaps: compaction hiding a promoted row is unit-tested only (fake host), not on a real host. No real Cloud client, tools or TUI. Held receipts are surfaced through diagnostics and `list`, with no user-facing UI yet. Full 10-version matrix not run for receipts.

Validation: `npm ci --ignore-scripts`, `npm run build`, `npm run check` (exit 0), Cloud `test:host` on 2.0.0 and 2.2.5, SDK `test:host`, `test:req`, `test:t2` all pass.

## 2026-11-05: G5 review fixes and correction (not passed until parent review)

Correction to the entry above: "the host did not keep the row (it died before commit)" was an overclaim. That runner checked only public `context` rows, not the inbox. The scenario now also reads `GET /api/session/:id/inbox`. On 2.0.0 and 2.2.5 the fixture logged `synthetic-return` before the SIGKILL. After restart, the ID was **pending**: one inbox item, not promoted, no context row. The receipt stays `held: uncertain-attempt` and is not replayed. This shows only what was observed after restart; it does not prove the host's write durability.

Reviewer blockers fixed in `packages/opencode-cursor-cloud/src/core`:
1. `recover` and `reconcileSession` used scan snapshots outside the session queue. Now the scan only finds keys. Each receipt is re-read and validated inside its queue before any transition. Corrupt records go into `corrupt`. Storage read or write failures go into a new `RecoveryReport.failed` (recover), or throw (reconcileSession). Nothing is dropped silently.
2. `delivered()` could mark a durable `observed` receipt as delivered with 0 host calls. `markDelivered` now ignores `event` evidence unless a validated admission exists. `context` evidence, from a matching history row whose text was checked, is still accepted. `delivered()` also skips `observed` receipts and events already consumed.
3. `dispatch` applied a racing delivered event before validating the host response. The response's identity, type and text are now checked first. The racing event is consumed, then applied only when the result is `admitted`. Invalid, mismatching or failed responses stay held, even with a concurrent event.

Tests: `test/unit/receipts-races.test.ts`, 11 tests with barriers and no sleeps. On the old code 9 fail and 2 pass (the 2 positive controls). On the fixed code all 32 unit tests pass. Evidence is in `.fixtures/g5-review-fixes/`: `old-code.txt`, `fixed-code.txt`, `old/`, `new/`.

Runner (`test/t1/run-receipts.mjs`): each version run now ends in a `finally` that kills the server process group and waits at most 10 s. A start timeout also kills the child. The child now has an `error` handler. Runner errors are captured per version and the exit stays nonzero. The test-only `--fault=start-timeout|after-start` flag proves this. Both runs exited 1 with 0 orphan processes (`fault-*.txt`).

Provenance: `src/core/message-id.ts` now carries the full upstream MIT notice in a `/*!` header. Verified that it is kept in `dist/core/message-id.js`.

Validation: `npm run build`, `npm run check` (exit 0). Cloud `test:host` on 2.0.0 and 2.2.5: all 16 scenarios and every invariant pass. SDK `test:host`, `test:req` and `test:t2` pass. Shared isolation is unchanged, so `test:t2-create` was not rerun. Nothing committed.

## 2026-11-05: receipt persistence fix independently verified

The remaining delivery-write failure is fixed. Validated event evidence survives a failed storage write, the adapter reports the error, and reconciliation persists delivery without another admission. A process-local validated-response cache covers delivery racing the failed admission-result write. It never authorizes unattempted or mismatching receipts. Evidence remains conservative after a process crash.

Lead verification used `.fixtures/receipt-commit-check`, an export of HEAD overlaid with only the files in this receipt slice. This avoids including concurrent SDK, Cloud client, control and release changes in its proof. `npm ci --ignore-scripts`, `npm run build`, `npm run check`, `npm run test:host` and `npm run test:req` all passed in that export. Receipt unit tests total 39. Both real hosts, 2.0.0 and 2.2.5, passed all 16 receipt scenarios and every invariant, with no orphan processes. The SDK provider and request regression fixtures passed too. The exact commands and logs are in `.fixtures/lead-verification/receipt-snapshot-*.log`.

G5's listed minimum/latest T1 scenarios pass for the receipt implementation. This does not qualify the unfinished Cloud client or TUI, a real-host compaction case, or any live Cursor behavior. No accepted facts or plan were changed. The remaining functional lanes continue separately.

## 2026-11-05: rel1 automation independently verified, inactive

Added per-package release-please manifest/config, portable verification, optional isolated ARM64 host verification, and an allowlisted npm release workflow. One grouped release PR preserves independent component versions and tags while the node-workspace plugin updates the shared root lock. Publishing validates repository/release ownership, tag/version identity, exact commit and main ancestry before using npm credentials. Legitimate release-please releases targeting their full commit SHA are accepted. Both release mutation jobs require `RELEASE_AUTOMATION_ENABLED == 'true'`; no remote or secrets were configured.

Lead verification used a HEAD export at `.fixtures/release-commit-check` with only this release slice overlaid, excluding concurrent runtime and metadata edits. `npm ci --ignore-scripts`, build, check, all 17 release tests, and both local package inspections passed. Every release JavaScript file passed `node --check`; workflow YAML and each Bash run block parsed. These are local checks, not a GitHub Actions run or a publication. Logs: `.fixtures/lead-verification/release-snapshot-*.log`.

Activation, remote choice and the Cursor terms review remain pending. No push, tag, release, publish, merge or history rewrite occurred.

## 2026-11-05: foreground Cloud safety core independently verified

Added the foreground Cloud source, pure layered configuration and acknowledgment rules, strict Git-state probe, durable session-owned lifecycle ledger and public host-storage adapter. Runtime composition is a separate in-progress slice. Each turn creates a fresh agent; there is no Cloud adoption or resume. Agent and run writes precede their dependent actions. Unknown lifecycle intents block retries, and shutdown detaches without cancelling remote work.

Review reproduced a late-create race during deferred model selection. The source now checks interruption, detachment and shutdown immediately after selection resolves and before create. Deferred shutdown and abort tests failed before the fix and pass afterward; no create/send occurs after release. The core has 170 fake/local-fixture tests, including 107 strict Git cases.

The lead verified this slice at `.fixtures/foreground-commit-check`, a HEAD export overlaid only with the core, shared turn event/stream contracts, its tests and the type-erasure/lazy-import guard update. Install, build, check and existing endpoint host regressions passed. The first check exposed the old spike guard rejecting type-only and lazy SDK references; overlaying its revised guard fixed that assertion while preserving fresh-process no-SDK/no-network startup checks. Logs: `.fixtures/lead-verification/foreground-snapshot-*.log`.

This is T1/local evidence only. Real Cloud behavior, live SDK requalification, final provider/control routing and user-facing commands are not claimed here. No Cursor call or external release action ran.

## 2026-11-05: private home alpha integrated and independently verified

Integrated runtime code is committed as `c8ab863`. Local SDK turns, the same-run permission-preserving tool bridge, foreground Cloud routing/ledger, background Cloud tools/receipts, fixed RPC, and native TUI entries now share their intended backend owners. Native rendering uses the host-shared renderer; the backend import graph remains SDK- and TUI-free at entry load. Configuration and consent use public host storage. Unimplemented settings return an explicit unavailable result, never fake success.

Lead combined verification passed: `npm ci --ignore-scripts`, `npm ls`, build, standard check (55 script tests, 284 SDK unit tests, 269 Cloud unit tests), and both package inspections. Every scoped endpoint suite also passed: host, request, offline SDK, approved keyless create, bridge (14 scenarios per endpoint), background tools, RPC, rendered TUI, composition and actual preview loading. Rendered tests covered standalone and attached-local on 2.0.0 and 2.2.5. The provider/request matrix passed all 20 runs across 10 declared versions. Logs: `.fixtures/lead-verification/home-final-*.log`.

Parent review caught that the first preview generator targeted package roots despite the filesystem loader requiring `dist` entry directories. The generator now uses exact `dist` targets. Four actual-default-entry load probes pass, local-only and Cloud opt-in on both endpoints, with SDK filesystem denial checked positively. They use only session creation and read-only status/models RPC, never a prompt or fake external factory. The prepared home config is SDK-only, mode 0600, and starts nothing.

The private alpha is ready for Iury's first manual local smoke using the pinned local OpenCode 2.2.5 binary. It does not modify either live setup. This is not completion of the accepted end-to-end goal: helpers, durable local resume, full local settings, model-cache persistence, further TUI/version qualification and live SDK/Cloud checks remain open. No agent ran a real Cursor prompt or Cloud agent.

The built release plan was refreshed after Iury chose `iurysza/opencode-extensions`. Root and children remain private; release automation remains disabled. No remote creation, push, tag, release, publish, merge or history rewrite occurred. The first real SDK result, or a separately approved live probe, is the next verification boundary.

## 2026-11-05: nudge-2105 controls checkpoint before lnx1

Implemented local mode and tool-policy RPC controls, option-aware pool invalidation, and trusted local-setting mapping. Mode and tools reach public create/send options. Native-only creates no OpenCode MCP bridge; bridge-only offers only MCP. User/env safety precedence is unchanged, and unsupported session safety or host force fields reject rather than silently disappear. Runtime switches preserve the full validated session record. The original per-send MCP override exists; a suspected stale-URL bug was not established and is recorded as a qualification task instead.

Lead checks passed: clean install, build, 55 script tests, 348 SDK unit tests, 269 Cloud unit tests, package inspections, bridge and RPC endpoint probes, production composition on both endpoints, and all four default-preview combinations. Updated composition fixtures now assert the implemented controls rather than expecting unavailable. Evidence: `.fixtures/lead-verification/nudge-2105-*.log`.

The prior ed754c2 alpha is frozen under `.fixtures/home-alpha-ed754c2`, with independent APFS-cloned dependencies, for stable macOS testing while development continues. No live SDK prompt ran. Helpers, durable resume, model cache and remaining controls are parked in `remaining-work.md`. Next: lnx1 on a new linux-sandbox worktree, without changing the cursor-port test target. The user-provided `ai-artifacts-brief-lnx1.md` stays untouched and uncommitted.

## 2026-11-05: cross-turn bridge regression (fake SDK)

Added two offline tests to `packages/opencode-cursor-sdk/test/unit/local-runtime.test.ts`. With a fake pooled agent, two user turns create one agent and send twice. Turn 1's bridge refuses connections after its turn ends. Turn 2's send carries only its own new bridge URL, and the fake reaches that URL. Native-only turns pass no `mcpServers` or `tools` at create or send. No defect found and no production code changed. Real SDK per-send `mcpServers` behaviour on a pooled agent remains unqualified; it needs an approved live probe.
## 2026-11-05 nudge-2233: Linux sandbox committed

- Committed `e19cbef` (fail-closed Linux bubblewrap sandbox) and `9058cde` (Ubuntu CI job, Linux requirements and test steps).
- macOS verification on the exact tree: build, `check` (734 passed, 1 Linux-only skip), `check:packs` and the isolation probe pass. Independent QA passed 36 endpoint scenarios. Static sandbox review found nothing to fix.
- Not verified: any Linux execution. Iury runs `linux-test.md` on a Linux host.
- Refreshed auto release plan posted to the Inbox thread `opencode port`. Release automation stays disabled.

## 2026-11-05 lnx2: Linux run green

- Iury ran `linux-test.md` at `9058cde` on a Linux x64 host (Node 22.18.0, bubblewrap, Perl, user namespaces allowed).
- Probe: `pass: true`, `backend: "bubblewrap"`, all 14 checks true. `check`: 735 passed, 0 failed, including the Linux-only kernel test.
- `acquire.mjs` fetched `@opencode/cli-linux-x64` 2.0.0 and 2.2.5 with matching sha512. `test:host`, `test:req` and `test:t2` passed on both versions.
- `test:tui` skipped: no termctrl on that host, which `linux-test.md` allows. No bugs found.
- Linux ARM64 is still untested.

## 2026-11-06 native tool cards probe (spike, branch `cursor-tool-cards-probe`)

- Added `packages/opencode-cursor-sdk/test/tool-cards/` (fixture plugin plus sandboxed runner). Scripted fake source, no SDK, no network.
- 2.2.5: `cursor_*` names render as generic rows. Built-in names (`edit`, `shell`, `read`) render native cards. 2.0.0 matches for the built-in shape.
- Provider results cannot set `metadata`, so the edit card shows only its header, not the diff.
- `hostNeverExecuted: true` in every run. Evidence and proposal: `ai-artifacts/opencode-port/tool-cards-probe/README.md`.
- No production change: built-in names conflict with accepted fact F-06 and need approval.

## 2026-11-06 native tool cards: built-in names (branch `cursor-tool-cards-probe`)

- Iury approved the F-06 change (Inbox, "opencode cursor parity"). Updated F-06 in `facts.md` and `facts.meta.json`; F-09 unchanged.
- Added `src/provider/native-tools.ts`: Cursor edit/write/shell/read/grep/glob/updateTodos map to OpenCode built-in names and inputs. Invalid input keeps `cursor_<type>`. Readable result text. Edit diffs follow the call as a ```diff text block, because the edit card reads diffs only from metadata.
- `local-runtime.ts`: leaf native calls emit on `tool-call-started`, results on completion. A bridge call is held while a native call in the slice is open.
- Probe `runtime` shape (real runtime, fake SDK) on 2.0.0 and 2.2.5: native cards, diff block visible, cursor_write fallback, all parts completed and provider-executed, host never executed. Evidence in `tool-cards-probe/<ver>/builtin/`.
- Closed loop: `npm ci --ignore-scripts`, `build`, `check` (441 + 269 + 55 pass), `test:bridge` (14/14), `test:host`, `test:req` all green.
