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
