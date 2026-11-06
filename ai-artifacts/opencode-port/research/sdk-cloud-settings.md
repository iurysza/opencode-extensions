# Pi Cursor SDK: Cloud runtime, settings, commands and tools

Scope: `packages/pi-cursor-sdk` only. This is the SDK's `/cursor-runtime cloud` and `/cursor-cloud` surface. It is **not** the background `/cloud` package covered in `research/pi-cursor-cloud.md`. All paths below are relative to `packages/pi-cursor-sdk/` unless they start with `ai-artifacts/`. Method: I read the source, tests, docs and git history. I ran nothing: no tests, no scripts, no Cursor calls.

## Conclusion

1. **Cloud has no attach and no resume after a restart.** Every Cloud turn calls `Agent.create` (`src/cursor-provider-turn-prepare.ts:158-165`). The only `Agent.resume` call is local (`src/cursor-session-agent.ts:467`). The roadmap marks Cloud resume "Intentionally deferred/rejected" (`docs/plans/cursor-sdk-capability-roadmap-2026-07-04.md:57,92`). What exists is local resume plus a durable Cloud *cleanup* ledger. That ledger only supports `/cursor-cloud list`, `archive` and `delete`. It never reattaches to a run.
2. **Cloud is fail-closed opt-in.** It needs an explicit runtime choice, a first-use acknowledgement that project config cannot grant, a Git local-state preflight, a persisted Pi session and a durable ledger write before `send`. Normal exit leaves the remote agents alive, and nothing cleans them up automatically.
3. **Superseded by the lead and user scope.** Iury asked for both packages "as completely as Pi does today", so the plan ports the full Cloud runtime in M3, and Phase 1 is study only, not a release. Original suggestion, kept for the record: port the cloud runtime as a later, separable slice, where a "Phase 1 parity" port needs only the settings resolver and the safety contracts. The ledger and the Git probe are large, platform-sensitive code with strong tests: about 900 lines of tests for the local-state probe alone.

## 1. Command inventory

| Command | Source | Behavior |
|---|---|---|
| `/cursor-runtime [local\|cloud] [--save-user\|--save-project]` | `src/cursor-runtime-state.ts:365-475` | With no argument it shows the effective runtime and its source. `cloud` triggers the acknowledgement confirm (`:344-358`). In non-UI mode it refuses and directs you to `--cursor-cloud-ack`. `--save-user` writes `runtime` and `cloud.acknowledged` to user config with mode 0600. `--save-project` writes only `runtime`, and only when cwd matches the trust-recorded cwd and the project is trusted (`:391-397`). It then appends a session `cursor-runtime-state` entry. Both save flags together is an error. Invalid CLI/env overrides block any change. |
| `/cursor-cloud list` | `src/cursor-cloud-lifecycle.ts:650-667` | First reconciles orphaned durable records, then lists the session branch's recorded non-deleted agents, capped at 25 lines plus "+N more" (`:570-575`). |
| `/cursor-cloud archive <bc-id>` | `:668-679`, `:602-648` | Checks the ID syntax, then auth, reconciles, and validates that the agent is recorded on this branch, has no pending action, and is not already archived (`:537-551`). It fsyncs `archive_intent`, calls `Agent.archive`, then fsyncs `archive`. |
| `/cursor-cloud delete <bc-id> --yes` | `:680-692` | Same as archive but requires exactly `--yes`. It writes `delete_intent`, calls `Agent.delete`, then writes `delete` (a tombstone). Archived agents can still be deleted. |
| `/cursor-fast`, `/cursor-mode`, `/cursor-tools`, `/cursor-http`, `/cursor-local-resume-cleanup`, `/cursor-refresh-config` | `src/cursor-state.ts:394-560` | Local-runtime controls (the other report covers them). |
| `/cursor-refresh-models` | `src/index.ts:79` | Model catalog. |

When a mutation fails, the error is the point of the design. If the SDK call throws after the intent was written, the record stays `pending` and blocks retries ("Inspect it in the Cursor Cloud dashboard", `:629-635`). If the result fsync fails after the SDK call succeeds, the agent remains pending too (`:637-643`). Auth comes from `ctx.modelRegistry.getApiKeyForProvider("cursor")`, so another provider's key cannot leak in (`:595-600`).

## 2. Flag inventory

Cloud and local runtime flags live at `src/cursor-runtime-state.ts:251-339`; fast and mode flags at `src/cursor-state.ts:376-392`.

| Flag | Type | Env var | Config key (user / project) |
|---|---|---|---|
| `--cursor-runtime local\|cloud` | string | `PI_CURSOR_RUNTIME` | `runtime` (user / project) |
| `--cursor-cloud-repo <https-url>` | string | `PI_CURSOR_CLOUD_REPO` | `cloud.repo` (user only) |
| `--cursor-cloud-branch <branch\|refs/heads/x\|sha>` | string | `PI_CURSOR_CLOUD_BRANCH` | `cloud.branch` (user) |
| `--cursor-cloud-context never\|fresh\|bootstrap` | string | `PI_CURSOR_CLOUD_CONTEXT` | `cloud.contextHandoff` (user) |
| `--cursor-cloud-direct-push` | bool | `PI_CURSOR_CLOUD_DIRECT_PUSH` | `cloud.directPush` (user); maps to SDK `workOnCurrentBranch` (`src/cursor-cloud-options.ts:81`) |
| `--cursor-cloud-auto-create-pr` | bool | `PI_CURSOR_CLOUD_AUTO_CREATE_PR` | `cloud.autoCreatePR` (user); omitted from SDK options unless set (`:82-87`) |
| `--cursor-cloud-skip-reviewer-request` | bool | `PI_CURSOR_CLOUD_SKIP_REVIEWER_REQUEST` | `cloud.skipReviewerRequest` (user) |
| `--cursor-cloud-allow-local-state` | bool | `PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE` | `cloud.allowLocalState` (user) |
| `--cursor-cloud-env <names>` | string | `PI_CURSOR_CLOUD_ENV` | `cloud.envNames`. **Reserved: preflight rejects it** (`env_forwarding_not_implemented`) |
| `--cursor-cloud-env-from-files` | bool | `PI_CURSOR_CLOUD_ENV_FROM_FILES` | `cloud.envFromFiles`. **Reserved: rejected** |
| `--cursor-cloud-env-type cloud\|pool\|machine` | string | `PI_CURSOR_CLOUD_ENV_TYPE` | `cloud.environment.type` (user) |
| `--cursor-cloud-env-name <name>` | string | `PI_CURSOR_CLOUD_ENV_NAME` | `cloud.environment.name` (user) |
| `--cursor-cloud-ack` | bool | `PI_CURSOR_CLOUD_ACK` | `cloud.acknowledged` (user or session; **never project**) |
| `--cursor-auto-review` | bool | `PI_CURSOR_AUTO_REVIEW` | `local.autoReview` |
| `--cursor-sandbox` | bool | `PI_CURSOR_SANDBOX` | `local.sandbox` / `local.sandboxOptions.enabled` |
| `--cursor-local-force` | bool | `PI_CURSOR_LOCAL_FORCE` | `local.force` (one-shot; consumed once, `src/cursor-runtime-state.ts` reset fields) |
| `--cursor-local-resume` / `--cursor-no-local-resume` | bool | `PI_CURSOR_LOCAL_RESUME` | `local.resume` |
| `--cursor-fast` / `--cursor-no-fast` | bool | (none) | `fastDefaults` (legacy shape kept) |
| `--cursor-mode agent\|plan` | string | (none) | session |
| (none) | n/a | `PI_CURSOR_HTTP_1_1` | `local.useHttp1ForAgent` (user; `/cursor-http`) |

Other environment variables grep finds in `src/` (outside the Cloud scope; listed for completeness): `PI_CURSOR_ASK_QUESTION`, `PI_CURSOR_EXPOSE_BUILTIN_TOOLS`, `PI_CURSOR_MCP_CONNECT_TIMEOUT_{MS,SECONDS}`, `PI_CURSOR_MCP_TOOL_TIMEOUT_{MS,SECONDS}`, `PI_CURSOR_NATIVE_TOOL_DISPLAY`, `PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS`, `PI_CURSOR_PI_TOOL_BRIDGE`, `PI_CURSOR_PI_TOOL_BRIDGE_DEBUG[_FILE]`, `PI_CURSOR_PRESERVE_PI_AGENTS_MD`, `PI_CURSOR_REGISTER_NATIVE_TOOLS`, `PI_CURSOR_SDK_DISABLE_MODEL_CACHE`, `PI_CURSOR_SDK_MODEL_CACHE_TTL_MS`, `PI_CURSOR_TASK_PRESENTATION`, `PI_CURSOR_TOOL_MANIFEST`, `PI_CURSOR_BRIDGE_TOOL_CALL_ID`, `PI_CURSOR_SETTING_SOURCES` (docs only; see the spec at `docs/cursor-model-ux-spec.md:22`).

## 3. Settings file and precedence

- **File:** `cursor-sdk.json`. User copy: `~/.pi/agent/cursor-sdk.json`. Project copy: `.pi/cursor-sdk.json`, loaded only from a snapshotted trust decision (`src/cursor-config.ts`; schema at `:50-77`). Writes are atomic, take a lock with a timeout, preserve unknown fields, and create user files as 0600 (tests at `test/cursor-config.test.ts:168-320`).
- **Sources:** `cli`, `environment`, `project`, `user`, `session`, `model-alias`, `builtin`. Each value carries a resolved `{value, source}` pair, which `/cursor-runtime` reports.
- **Per-field precedence**, from the roadmap (`docs/plans/cursor-sdk-capability-roadmap-2026-07-04.md:33-41`), confirmed in tests:
  - Runtime: CLI > env > session > trusted project > user > builtin (`local`).
  - Acknowledgement: CLI > env > session > user > builtin. Project is excluded.
  - Other cloud fields: CLI > env > user > builtin. Project and session are excluded (`test/cursor-config.test.ts:357,561`).
  - Local safety: CLI > env > project > user > builtin (`:574`).
  - HTTP/1.1: session > env > user > unset (`:102`).
- **Safety caps:** a stricter *user* value caps a riskier env or project value. A one-shot CLI value wins over the cap (`test/cursor-config.test.ts:321-444`). The user-config allowlist filters env-supplied cloud env names (`:444`).
- **Invalid explicit values fail closed** instead of falling through to lower layers (`:130-152`). An invalid env-type survives into preflight so the user sees a precise error (`:501-509`).
- **Trust:** project config counts only when Pi's `project_trust` event recorded the cwd and `ctx.isProjectTrusted()` is true, or when `--approve` was parsed (`src/cursor-session-scope.ts`). `/cursor-runtime --save-project` enforces the same rule.

## 4. First-use acknowledgement, billing and security

- **Disclosure text:** `CURSOR_CLOUD_ACK_DISCLOSURE`, `src/cursor-runtime-state.ts:40`, shown through `ctx.ui.confirm("Enable Cursor Cloud runtime?", …)` (`:356`). It covers remote execution; fresh context by default, with bootstrap opt-in; the Pi tools and bridge being unavailable; Pi env vars not being forwarded; that Cursor may branch, commit, push or open PRs; that cloud agents persist until archived or deleted; Max Mode; Cursor API pricing; and possible spend-limit setup.
- **Scope:** the acknowledgement is per-branch session state. It is monotonic across cloud → local → cloud switches and restored on tree navigation (`test/cursor-runtime-state.test.ts:270-330`). CLI and env acknowledgements do not re-prompt (`:353`). Non-interactive cloud selection without an acknowledgement is refused (`:364`). A project-only acknowledgement fails provider preflight before `Agent.create` (`test/cursor-project-trust-contract.test.ts:342`).
- **Billing:** the extension does no metering. Raw cloud usage is display-only and never fed into Pi's usage or compaction accounting (`test/cursor-provider-cloud-reporting.test.ts:33`; CHANGELOG line 36).
- **Credential hygiene:** the repo URL must be HTTPS with no userinfo, query or fragment, and is never echoed back (`test/cursor-provider-cloud-env-validation.test.ts:50`). API keys are scrubbed from errors, reports and debug output (`test/cursor-cloud-reporting.test.ts:147-163`).
- **Excluded from Cloud:** the Pi bridge, local MCP, `local.customTools`, setting sources, skill metadata and inline cloud MCP. `buildCursorCloudAgentOptions` emits no local tools, MCP servers or agent IDs (`test/cursor-cloud-options.test.ts:33`).

## 5. Preflight (all checks run before `Agent.create`)

`preflightCursorCloudRuntime`, `src/cursor-cloud-options.ts:98-177`. Issue codes:

| Code | Trigger |
|---|---|
| `cloud_ack_required` | No effective acknowledgement |
| `context_handoff_required` | `contextHandoff=never` with prior context (`:111`) |
| `local_state_not_allowed` | Local Git state is dirty, unpushed or unverifiable, and `allowLocalState` is off |
| `env_forwarding_not_implemented` | Any `envNames` / `envFromFiles` |
| `cloud_repo_invalid` | Not HTTPS, or carries credentials, query or fragment |
| `cloud_branch_repo_required` | Branch set without a repo; the SDK takes `startingRef` only on `cloud.repos` (`:150-151`) |
| `cloud_branch_invalid` | Not a branch, `refs/heads/x` or full SHA |
| `cloud_environment_type_invalid` / `_required` / `_repo_conflict` | Env type invalid; env name given without a type; named environment plus an explicit repo |

There is also a runtime guard: Cloud refuses to start while a local live run is pending (`src/cursor-provider-turn-prepare.ts:141-143`).

**Git local-state probe** (`src/cursor-cloud-local-state.ts`): the probe is hermetic. It ignores ambient `GIT_*` redirection. User URL rewrites may veto a match but never authorize one. Replacement refs and grafts disable the check. Exactly one remote must match on both effective fetch and push URL. GitHub SSH and scp forms count as the same HTTPS identity. The result is either `contains_head` or `unpushed`, with typed "unknown" reasons. Without an explicit repo, the probe compares against the current branch's upstream. It never fetches (README:372-380).

## 6. Durable lifecycle ledger

- **Entry type:** `cursor-cloud-lifecycle`. Agent IDs must match `bc-<uuid>` (`shared/cursor-cloud-lifecycle-constants.mjs`). Actions: `record`, `archive_intent`, `delete_intent`, `archive`, `delete` (`src/cursor-cloud-lifecycle.ts:39`).
- **Two stores:**
  - A Pi session custom entry, which is branch-scoped.
  - A sidecar journal in the session directory, named by a SHA-256 of the session ID (`:177-178`). It is newline-framed, fsynced, created exclusively with mode 0600, and opened no-follow with fd/path identity checks (`src/cursor-durable-fs.ts`).
  - The Pi session JSONL is fsynced *before* the journal (`test/cursor-cloud-lifecycle.test.ts:91`).
- **Write order on a turn:**
  1. `Agent.create`.
  2. Record the agent ID, before debug work or abort checks (`src/cursor-provider-turn-prepare.ts:167-170`). If this fails, the turn errors with "No run was started", the dashboard hint and an `asyncDispose`.
  3. `send`.
  4. Record the run ID. If this fails, bounded `run.cancel()` runs and the turn errors (`src/cursor-provider-turn-send.ts:118-126`).
  5. On success, merge branch and PR details from the report (`src/cursor-provider-turn-finalize.ts:156-176`).
- **Fileless first turns** use an orphan marker (`anchorEntryId: null`). A restart with the same session ID claims it onto exactly one matching branch; sibling branches never see it (`test/cursor-cloud-lifecycle.test.ts:179-360`).
- **Caps:** agent and run IDs at 256 characters, timestamps at 64, branches at 160, PR URLs at 240. Malformed lines are skipped one at a time.
- **No Cloud resume:** the ledger stores IDs only so the user can clean up. The provider never reads it to continue a conversation.
- **Not cleaned up:** normal exit, session deletion and any bulk or global sweep. The roadmap rejects all three on purpose (`docs/plans/...:91`).

## 7. Context handoff and run reporting

- `fresh`, the default, sends only the last user message. `bootstrap` sends the full Pi context. `never` fails preflight when prior context exists. The send plan is always `{mode: "bootstrap", resetAgent: false}` against a brand-new agent (`src/cursor-provider-turn-prepare.ts:81`).
- The cloud agent's name comes from the Pi session title.
- The completion report (`src/cursor-cloud-reporting.ts`) holds bounded agent and run IDs, branches, repo and PR URLs, passive artifacts and raw usage. Raw usage comes from a separate timed `fetch` against the captured official route (`test/cursor-cloud-reporting.test.ts:16-76`). The report is skipped on `error` or `cancelled` runs (`test/cursor-provider-cloud-reporting.test.ts:244`).
- Activity streams through the shared coordinator with native replay disabled. The fixture is `test/fixtures/cursor-cloud-activity-callbacks-2026-07-19.json`.

## 8. Question and skill tools under Cloud

- **`cursor_ask_question`** (`src/cursor-question-tool.ts:193-211`): active when the model is a Cursor model, the bridge is on and `PI_CURSOR_ASK_QUESTION` is not 0. The tool takes **no runtime check**. In Cloud, the prompt omits ask-question guidance (`includePiAskQuestionGuidance: false`, `src/cursor-provider-turn-prepare.ts:150`) and the cloud agent has no bridge, so it cannot call the tool. The Pi tool stays registered and harmless. This is inferred from source; no test covers it.
- **`cursor_activate_skill`** (`src/cursor-skill-tool.ts:120,249`): in Cloud runtime the tool is inactive and the skill catalog is removed from the system prompt (`test/cursor-skill-tool.test.ts:87,181`).

## 9. Source vs docs drift

| # | Drift | Evidence |
|---|---|---|
| D1 | **A `--no-session` Cloud turn creates a remote agent before failing.** The spec says "`--no-session` and durable-ledger failures fail closed before send". That is literally true, but the session/ledger check runs *after* `Agent.create`. The `bc-` agent exists remotely, is disposed locally, and is left for manual dashboard cleanup. No test runs `streamCursor` with `--no-session`; `test/cursor-cloud-lifecycle.test.ts:119` tests only the recorder returning `false`. | `src/cursor-provider-turn-prepare.ts:158-170`; `src/cursor-cloud-lifecycle.ts:261,344`; `docs/cursor-model-ux-spec.md:21` |
| D2 | The evidence is older than the pinned SDK. Evidence files cite `@cursor/sdk@1.0.23` and extension 0.1.62; `package.json` pins `@cursor/sdk` 1.0.37 and the package is at 0.2.0. Merge `489b6e9` edited the smoke JSON, but the file still says `2026-07-29` and 0.1.62. | `docs/evidence/cursor-cloud-smoke-matrix-latest.json:3-8`; `package.json:3,159` |
| D3 | `--cursor-cloud-context` accepts `never`; the README documents only fresh and bootstrap. | `src/cursor-config.ts:43`; README:384 |
| D4 | `--cursor-cloud-env` and `--cursor-cloud-env-from-files` are registered flags that always fail preflight. Their help text says so; the README frames env as Cursor-managed only. Not a bug, but a port should not copy reserved flags. | `src/cursor-runtime-state.ts:292-300` |
| D5 | The roadmap cites `test/cursor-provider-stream-config.test.ts` for env selection; the coverage there is real (`:254,286`). No drift. | n/a |
| D6 | The PR-control evidence shows that the API *accepted* the request, not that a PR was created. The docs state this honestly. | `docs/evidence/cursor-cloud-pr-controls-2026-07-19.md` |

## 10. Test coverage (read, not run)

| File | Cases | Covers |
|---|---|---|
| `test/cursor-cloud-lifecycle.test.ts` | 21 + 1 skipIf | Ledger, fsync order, no-follow symlink, orphan claim, sibling isolation, intent/result failures, ID validation, auth, list cap |
| `test/cursor-cloud-local-state.test.ts` | 56 | Git probe matrix |
| `test/cursor-cloud-options.test.ts` | 16 | Option mapping, refs, preflight messages |
| `test/cursor-cloud-reporting.test.ts` | 7 | Usage route, timeouts, sanitizing |
| `test/cursor-provider-cloud-reporting.test.ts` | 8 | Record ordering, intent/run-ID failure, cancel |
| `test/cursor-provider-cloud-env-validation.test.ts` | 7 | Preflight before `Agent.create` |
| `test/cursor-provider-cloud-activity.test.ts` | 1 | Captured callbacks through the coordinator |
| `test/cursor-provider-stream-config.test.ts` | 7 cloud cases (`:196-375`) | Fresh context, env selection, naming, dispose on abort before send |
| `test/cursor-runtime-state.test.ts` | 26 | `/cursor-runtime`, acknowledgement, saves, trust |
| `test/cursor-config.test.ts` | 30 | Precedence, caps, atomic writes |
| `test/cursor-project-trust-contract.test.ts` | 8 | Non-interactive trust, project-only ack fails |
| `test/cursor-sdk-cloud-list-runs-contract.test.ts` | 1 | Installed SDK `listRuns` shape (regex on the bundle; brittle) |
| `test/cursor-skill-tool.test.ts` | 10 | Cloud hides the skill tool |

**Omissions:**
- (a) No end-to-end `--no-session` Cloud turn (see D1).
- (b) No test for the question tool under Cloud.
- (c) No test for deleting an already-archived agent.
- (d) No test that `--save-project` with cloud omits the acknowledgement. Inferred from `:410-413`; `test/cursor-runtime-state.test.ts:580` covers the trusted save, not the field omission.
- (e) The live Cloud smoke (`scripts/cloud-runtime-smoke.mjs`; lanes: cancel, repo/startingRef branch, lifecycle-delete, direct-push, missing-branch, artifacts/usage; optional `--context-matrix` for fresh vs bootstrap) is maintainer-only. It needs `gh` private-repo rights and spends money.

## 11. Parity-map rows to add

| Feature | Pi source | OpenCode port note | Priority |
|---|---|---|---|
| Runtime selector local/cloud with source reporting | `src/cursor-runtime-state.ts:365` | Plugin config + command; local default | P2 |
| Cloud first-use acknowledgement (session/user, never project) | `src/cursor-runtime-state.ts:40,344` | Needs a confirm UI; non-UI must refuse | P2 |
| `cursor-sdk.json` per-field precedence + safety caps | `src/cursor-config.ts` | Port as a pure resolver; tests port directly | P1 (local fields) / P2 (cloud) |
| Trust-gated project config | `src/cursor-session-scope.ts` | Map to OpenCode's project trust, if it has one | P1 |
| Cloud preflight codes (10) | `src/cursor-cloud-options.ts:98-177` | Pure; port with tests | P2 |
| Git local-state probe | `src/cursor-cloud-local-state.ts` | Large; consider "allow-local-state required" as an MVP | P3 |
| Durable lifecycle ledger + `/cursor-cloud list/archive/delete` | `src/cursor-cloud-lifecycle.ts` | Needs persisted sessions and a sidecar dir | P2 |
| Check session persistence **before** `Agent.create` | Gap D1 | Improve on Pi: check first | P2 |
| Fresh/bootstrap/never context handoff | `src/cursor-provider-turn-prepare.ts:81` | Pure | P2 |
| PR controls, direct push, env type/name | `src/cursor-cloud-options.ts:46-90` | Omit unset fields | P2 |
| Display-only completion report + raw usage | `src/cursor-cloud-reporting.ts` | Never feed into token accounting | P3 |
| Cloud resume / attach | Not implemented (rejected) | Out of scope; record as an explicit non-goal | n/a |
| Skill tool hidden in Cloud; ask-question inert | `src/cursor-skill-tool.ts:249`; `src/cursor-question-tool.ts:193` | Gate both on runtime explicitly | P2 |
| Reserved env-forwarding flags | `src/cursor-runtime-state.ts:292-300` | Do not port | n/a |

## Sources

- **Kept:** the source and test files cited above; `AGENTS.md:83-89,167-168,205-217`; README:326-404; `docs/cursor-model-ux-spec.md:19-41`; the roadmap plan; the three `docs/evidence/cursor-cloud-*` files; CHANGELOG cloud entries; git log (the Cloud work predates the subtree import `4281d2a`; later commits only lazy-load the ledger and command, `dbc00d2`, and touch the question tool, `a941c70`).
- **Dropped:** `ai-artifacts/opencode-port/research/pi-cursor-cloud.md` (the `/cloud` package, out of scope); `scripts/debug-*.mjs` beyond grep (debug only).

## Gaps

- Whether Cursor bills for an agent that was created but never sent a message (relevant to D1). Next step: check Cursor's pricing docs, or ask Cursor.
- Whether `@cursor/sdk` 1.0.37 still matches the 1.0.23 evidence for PR controls and the usage route. Next step: the maintainer runs `npm run smoke:cloud`. I did not run it.
- The SDK license is now known (`pi-cursor-sdk.md` §11): proprietary, "© Anysphere Inc. All rights reserved. Use is subject to Cursor's Terms of Service." No redistribution right is granted.
- SDK `tools` and `disallowedTools` cannot restrict Cloud agents: combining them with `cloud` throws (`sdk-controls.md`).

## Start here

`src/cursor-runtime-state.ts`, then `src/cursor-cloud-options.ts`, then `src/cursor-cloud-lifecycle.ts`.
