# Feature map: Pi to OpenCode 2.x

Status: **proposed**. Target: OpenCode 2.0.0 onward ([compatibility policy](./plan.md#compatibility-policy)). Pi rows come from four end-to-end reports and one SDK source note. OpenCode rows come from the [2.x boundary report](./research/opencode-v2-boundary.md), which read code at every 2.x tag. Nothing was run. Known gaps are in the [plan](./plan.md#known-research-gaps).

Sources: [SDK report](./research/pi-cursor-sdk.md), [SDK Cloud settings report](./research/sdk-cloud-settings.md), [Cloud report](./research/pi-cursor-cloud.md), [SDK tool-controls note](./research/sdk-controls.md), [2.x boundary report](./research/opencode-v2-boundary.md). The [OpenCode API report](./research/opencode-api.md) is historical: it studied 1.18.33.

Status key:

- **Yes**: a portable path or a public 2.0.0 API exists, based on source evidence only. No row has been tested.
- **Partial**: an equivalent covers the function but not the exact behavior or visuals.
- **Gate**: feasibility depends on a spike in the plan.
- **No**: no public API. Needs an upstream change or must be dropped.
- **N/A**: Pi does not have this either.

## Three separate products

These three are easy to confuse. They have different owners and lifecycles.

| Product | Package | What it is | Lifecycle |
|---|---|---|---|
| SDK local model | `opencode-cursor-sdk` | A Cursor agent loop on this machine, used as an OpenCode model | Per session. Local resume after restart. |
| SDK foreground Cloud runtime | `opencode-cursor-sdk` | The same model slot, but each turn creates a fresh remote Cursor agent and waits for it | A durable ledger used only for cleanup (list, archive, delete). No attach and no resume. |
| Background Cloud delegation | `opencode-cursor-cloud` | Tools that spawn remote agents while the session continues, with one follow-up on completion | In memory, owned by the process, plus durable completion receipts for observed completions. No attach and no resume. |

Neither Pi path can attach to a Cloud agent or resume one after a restart. The SDK calls `Agent.create` on every Cloud turn, and its only `Agent.resume` call is local (`sdk-cloud-settings.md` §Conclusion). The port keeps that as a non-goal. Completion receipts do not change it: they cover only completions this process already observed.

Three meanings of "remote" need keeping apart:

- A TUI attached to a supported **local** backend. It is supported if it passes G6.
- A **remote workspace** (`ctx.location.workspaceID` set). The Cursor provider fails closed there unless separately proven safe.
- A remote **Cursor Cloud agent**. That is the product above, not an OpenCode topology.

## SDK local model

| Pi feature | OpenCode 2.x equivalent | Status |
|---|---|---|
| Provider `cursor`, api `cursor-sdk` | Backend plugin `define({ id, setup })` registers the provider through the `provider-registration` compat module (`catalog.transform` before 2.0.4, `provider.transform().add()` from 2.0.4) and returns a `LanguageModelV3` from `aisdk.hook("sdk")` or `aisdk.hook("language")` | Gate G2 |
| Plugin registers the model with no config entry | Yes, through the plugin registration above. Hook order against the internal `DynamicProviderPlugin` is a G2 test. Registering our real npm package with a `create*` export is a hedge. | Gate G2 |
| Live model catalog, fallback, refresh command | Models added at registration plus a fallback catalog. The refresh command is a TUI keymap command over RPC (G6). | Partial |
| Model cache: `cursor-sdk-model-list.json`, mode 0600, `sha256(key)[:16]`, 24 h TTL (`PI_CURSOR_SDK_MODEL_CACHE_TTL_MS`), disable switch, stale fallback when live discovery fails | Same design in a package-owned file. Env names renamed. | Yes (portable, unverified) |
| Context and fast variants | Model IDs that carry suffixes, or OpenCode variants | Partial. Mapping to be designed. |
| Thinking and reasoning levels | Translate OpenCode variants or provider options to the parameters each Cursor model advertises. Do not invent unsupported levels. | Partial. Mapping to be designed. |
| Cursor native tools | Emit `providerExecuted: true` calls with exactly one result under `cursor_*` names. From 2.0.0 the host never runs them and kills the run on duplicate results, name mismatches or results before calls ([streaming contract](./plan.md#streaming-contract)). | Gate G2 |
| Display-only replay (Pi overrides built-in `execute`) | Not needed. Provider-executed parts are stored and never run. Replay data sits in `providerState` before 2.1.0 and `native` from 2.1.0. | Yes, if G2 passes |
| Loopback MCP bridge for host tools | The provider emits a non-provider-executed call, OpenCode runs it (`needsContinuation`), and the provider re-enters with the result while the Cursor run stays open. Claude Agent's `PendingTools` (2.2.3, internal) is a pattern reference only. | Gate G2 |
| Bridge through the host permission flow | Re-entry uses OpenCode's normal tool pipeline. Calling executors directly would skip permissions, so that route is rejected. | Gate G2 |
| Correlating an MCP call with Cursor's tool-call ID | Claude uses `PreToolUse` `tool_use_id`. Cursor equivalent unknown. | Gate G2 |
| Hide overlapping built-ins (`read`, `bash` and others) | The tool snapshot comes from the tools OpenCode passes to the model call | Partial |
| Abort | V3 call options `abortSignal` | Yes |
| Error classification and retry | Error shapes must match OpenCode 2.x retry handling, not Pi's | Partial. Mapping to be designed. |
| Context overflow leads to compaction | Must match OpenCode 2.x overflow detection | Unverified |
| MCP timeout patch, error classification, abort guard (Node stack matching) | Bun loads the SDK's separate `connect-web` build, which these heuristics skip. Needs Bun-specific handling, or a Node worker after a replan. | Gate G1 |
| SDK dependency | Normal npm dependency, never vendored. Only MIT or Apache deps bundled. | Yes. Terms review is release gate G8. |
| Per-session agent pool and SQLite store | Keyed by the session ID from our `model.request` stamp. `@cursor/sdk/sqlite` under Bun is unknown. | Gate G1 and G3 |
| Branch-scoped local resume | No Pi-style tree. Use session ID, fork lineage and compaction generation. The `model.request` hook carries no fork lineage, so its source is a G3 question. | Partial. Gate G3. |
| Reset on compaction, tree change and model change | `compaction` request kind, the `session.hook("compaction")` hook and event subscription; model changes detected from the pool key. Compaction data through the `replay-native` compat module. | Partial. Gate G3. |
| Summarization through the Cursor provider | Our `model.request` hook stamps `kind`. `title`, `compaction` and `generate` run in a separate local helper lane with SDK `tools: []` ([source note](./research/sdk-controls.md)), never on Cloud. | Gate G4a and G4b |
| Local safety: autoReview, sandbox, force | Passed to the SDK as before. Cursor controls, not OpenCode enforcement. | Yes, as Cursor-native controls |
| SDK tool controls `tools`, `disallowedTools` | Local agents only. Throw on Cloud. Not persisted: pass again on `Agent.resume`. Used by the helper lane. | Gate G4b |
| SDK `customTools` | Skip approval even under sandbox and autoReview. Not used as a host-enforcement shortcut. | Rejected for the bridge |
| Config layers: CLI, env, project, user | Plugin options plus env. No project-trust API found, so sensitive project overrides fail closed. | Partial |
| `cursor_ask_question`, `cursor_activate_skill` | Adapt to OpenCode 2.x question and skill behavior, with TUI dialogs where needed. The 2.x equivalents were not studied. | Partial. Unverified. |
| Images in the latest message | AI SDK file parts | Yes, unspiked |
| Usage accounting, local turns | V3 `finish` usage, through Pi's sanity gate (rejects poisoned counts) | Yes (portable, unverified) |
| Usage accounting, helper lane | Proposed: report on the helper message only, through the same gate. Never counted as the coding session's context occupancy. | Proposed |
| Usage accounting, Cloud | Display-only. Never enters OpenCode token, cost or compaction accounting (F-52). | Yes (portable, unverified) |

## Auth

Pi's key order differs by surface. The port does not copy it.

| Pi surface | Pi order | Source |
|---|---|---|
| SDK turns | The key Pi's model registry passes in `options.apiKey`. A placeholder value resolves to `CURSOR_API_KEY`. | `cursor-provider-turn-prepare.ts:457-461`, `cursor-api-key.ts:17-22` |
| SDK model discovery and runtime lookup | Pi's stored `/login` credential first, then `CURSOR_API_KEY` | `cursor-api-key.ts:34-36`, `model-discovery.ts:50` |
| SDK `/cursor-cloud` mutations | `ctx.modelRegistry.getApiKeyForProvider("cursor")` | `cursor-cloud-lifecycle.ts:596` |
| Cloud package (standalone) | `CURSOR_API_KEY` first, then `cursor.key` in Pi's `auth.json` | `pi-cursor-cloud/src/cloud-client.ts:30-40` |

Proposed for OpenCode (F-01): the public `integration` `key` and `env` methods, with one order on every surface: the host-stored key first, then `CURSOR_API_KEY`. No v1 `auth` hook. No `external` method or `ctx.credential`, because both are absent at 2.0.0. Connection status through `integration.connection.status` from 2.0.20, otherwise an RPC event and a toast. Pi's `auth.json` is never read (F-02).

## Local commands and flags

OpenCode plugins cannot register CLI flags. Each Pi flag maps to plugin options, an env var, or a TUI keymap command that calls a backend RPC method. `--cursor-fast` becomes an option or env var, not a flag on `opencode`. Env names drop the `PI_` prefix (exact names chosen in M2).

| Pi command or flag | Pi behavior | OpenCode surface | Status |
|---|---|---|---|
| `/cursor-fast`, `--cursor-fast`, `--cursor-no-fast` | Toggle fast defaults (`fastDefaults`) | TUI command over RPC plus options | Gate G6 |
| `/cursor-mode agent\|plan`, `--cursor-mode` | Session mode | TUI command over RPC plus options | Gate G6 |
| `/cursor-tools` | Debug report of offered tools | TUI command, read-only RPC | Gate G6 |
| `/cursor-http`, `PI_CURSOR_HTTP_1_1` | HTTP/1.1 for the agent (`local.useHttp1ForAgent`) | TUI command over RPC plus options and env | Gate G6 |
| `/cursor-refresh-config` | Reload `cursor-sdk.json` | TUI command over RPC | Gate G6 |
| `/cursor-refresh-models` | Refresh the catalog | TUI command over RPC | Gate G6 |
| `/cursor-local-resume-cleanup [--dry-run\|--yes]` | Deletes only recorded `agent-*` IDs, durable intent before `Agent.delete`, deletes only with `--yes` | TUI command with dry run and explicit confirm (F-63) | Gate G6 |
| `--cursor-auto-review`, `PI_CURSOR_AUTO_REVIEW` | `local.autoReview` | Options and env | Yes (portable, unverified) |
| `--cursor-sandbox`, `PI_CURSOR_SANDBOX` | `local.sandbox` | Options and env | Yes (portable, unverified) |
| `--cursor-local-force`, `PI_CURSOR_LOCAL_FORCE` | One-shot force, consumed once | Env or a one-shot TUI command. Never a persistent default. | Partial |
| `--cursor-local-resume`, `--cursor-no-local-resume` | `local.resume` | Options and env | Yes (portable, unverified) |

Cloud runtime flags are in the next section.

## SDK foreground Cloud runtime

Every row is in parity scope. "Phase 1" means this study only, not a settings-only release.

| Pi feature | Pi source | OpenCode equivalent | Status |
|---|---|---|---|
| `/cursor-runtime [local\|cloud]` with source reporting, `--save-user`, `--save-project` | `src/cursor-runtime-state.ts:365-475` | Deterministic TUI command over RPC plus options. `--save-project` needs a trust API. | Gate G6 |
| First-use acknowledgment. Session or user scope, never project. Non-UI refuses without an explicit ack. | `src/cursor-runtime-state.ts:40,344-358` | TUI confirm dialog. `PI_CURSOR_CLOUD_ACK` equivalent for headless runs. Project config can never grant it. | Partial. Gate G6. |
| `cursor-sdk.json` per-field precedence, safety caps, fail-closed invalid values | `src/cursor-config.ts` | Pure host-neutral resolver. Tests ported. The `cli` layer becomes plugin options or a one-shot TUI command. | Yes (portable, unverified) |
| Cloud flags `--cursor-runtime`, `--cursor-cloud-repo`, `-branch`, `-context`, `-direct-push`, `-auto-create-pr`, `-skip-reviewer-request`, `-allow-local-state`, `-env-type`, `-env-name`, `-ack` | `src/cursor-runtime-state.ts:251-339` | Plugin options and env. Not OpenCode CLI flags. | Yes (portable, unverified) |
| Trust-gated project config | `src/cursor-session-scope.ts` | No OpenCode trust API found. Sensitive project overrides fail closed. | Partial |
| Ten preflight codes, all before `Agent.create` | `src/cursor-cloud-options.ts:98-177` | Pure module | Yes (portable, unverified) |
| Full hermetic Git local-state probe: one remote on fetch and push URL, upstream tracking ref, unpushed and dirty detection, `GIT_*` isolation, graft and replacement veto | `src/cursor-cloud-local-state.ts` (56 test cases) | Port the full probe. `--cursor-cloud-allow-local-state` stays an explicit override only. | Yes, large |
| Durable lifecycle ledger: `record`, `archive_intent`, `delete_intent`, `archive`, `delete`. Fsync, mode 0600, no-follow, malformed lines skipped. | `src/cursor-cloud-lifecycle.ts`, `src/cursor-durable-fs.ts` | Package-owned sidecar journal keyed by OpenCode session ID. Plugin `storage` exists at 2.0.0 but was not studied as a durable store. The Pi branch-anchor and orphan-claim design must be redefined (G3). | Partial. To be designed. |
| Check that session and ledger persistence work **before** `Agent.create` | Pi gap D1: a `--no-session` turn creates a remote agent, then fails, leaving an orphan | **Improvement on Pi.** Probe a writable ledger and a persisted session first. | Proposed improvement |
| `/cursor-cloud list`, `archive <bc-id>`, `delete <bc-id> --yes`, recorded IDs only, unresolved intent blocks retry | `src/cursor-cloud-lifecycle.ts:602-692` | Deterministic TUI command over RPC or fixed-argument tool, never a prompt template | Gate G6 |
| Context handoff `fresh` (default), `bootstrap`, `never` | `src/cursor-provider-turn-prepare.ts:81` | Pure | Yes (portable, unverified) |
| PR controls, direct push (`workOnCurrentBranch`), environment type and name. Unset fields are omitted. | `src/cursor-cloud-options.ts:46-90` | Provider options and env | Yes (portable, unverified) |
| Native tool restriction on Cloud | Not offered. SDK `tools` and `disallowedTools` throw with `cloud`. | None | No |
| Env forwarding (`--cursor-cloud-env`, `--cursor-cloud-env-from-files`) | Reserved flags that always fail preflight | Not ported as working options. Any key or alias naming env forwarding is rejected. | Rejected by design |
| Cloud refuses to start while a local live run is pending | `src/cursor-provider-turn-prepare.ts:141-143` | Same guard in the session pool | Yes (portable, unverified) |
| Agent name from the session title | `sdk-cloud-settings.md` §7 | OpenCode session title through `session.get` | Yes, unverified API |
| Display-only completion report and raw usage | `src/cursor-cloud-reporting.ts` | Tool output or text. Never fed into OpenCode accounting. | Yes (portable, unverified) |
| Skill tool hidden in Cloud. Ask-question inert. | `src/cursor-skill-tool.ts:249`, `src/cursor-question-tool.ts:193` | Gate both on runtime explicitly | Yes (portable, unverified) |
| Cloud attach or resume | Not implemented in either Pi path | Non-goal | N/A |

SDK evidence drift: the Cloud docs and live evidence cite `@cursor/sdk` 1.0.23, but the package pins 1.0.37 (`sdk-cloud-settings.md` D2). Gate G7 requalifies them.

## Background Cloud delegation

| Pi feature | OpenCode 2.x equivalent | Status |
|---|---|---|
| Four tools: spawn, send, cancel, status | Backend tools registered with `ctx.tool.transform(e => e.add(...))`, with progress through the tool context `progress` callback (2.0.0). Not the v1 `tool()` helper or `ctx.metadata`. | Yes (source evidence) |
| GitHub repo and ref defaults | Preserve explicit repo and ref, otherwise GitHub origin plus a locally tracked current branch, otherwise `main`. Unpushed commits stay invisible remotely. Never fetch implicitly. | Yes (portable, unverified) |
| Model default and local name | Explicit model, then saved default, then qualified fallback. Keep the local-only name and model picker. | Yes (portable, unverified) |
| Busy reservation, cancel during startup, delete only when idle | Keep synchronous state reservation and owned-agent checks before SDK awaits. Suppress duplicate and late terminal callbacks. | Yes (portable, unverified) |
| Sanitized errors and terminal text | Keep fixed credential-free SDK errors, key redaction and control-character cleaning. | Yes (portable, unverified) |
| Completion triggers a turn | Public `session.synthetic` with a persisted `msg_` ID from a durable receipt ([completion receipts](./plan.md#completion-receipts)). Works only while the server is alive. Receipts for observed completions survive a restart. | Gate G5 |
| Delivery when the session is busy, or several sessions exist | `steer` delivery promotes at a step boundary. Every call wakes the session, even a no-op replay. Final-step and multi-session cases are G5 spike cases. | Gate G5 |
| Exactly one completion per run | Our receipt plus text hash, because host admission ignores text. No `parentID` in 2.x, so "answered" needs separate evidence. | Partial. Gate G5. |
| `/cloud` transport | TUI keymap commands call backend `rpc.register` methods through `ctx.client`. The backend owns all state. A loopback adapter only if RPC fails G6. | Gate G6 |

The seven `/cloud` actions (`pi-cursor-cloud/src/index.ts:251-290`). Pi asks for no confirmation on any of them. Missing IDs open a picker.

| Action | Pi behavior | Proposed OpenCode surface |
|---|---|---|
| `spawn` | Leading flags only (`--repo`, `--ref`, `--model`, `--name`). Billable. | TUI command over RPC and backend tool |
| `list` | Lists this process's agents | TUI command, read-only RPC |
| `send` | Follow-up to an idle agent. Billable. | TUI command over RPC and backend tool |
| `cancel` | Picker of active agents. Owned agents only. | TUI command. A confirm dialog would be a proposed addition. |
| `delete` | Picker of inactive agents. Owned only. Refuses an active agent. Destructive. | TUI command. A confirm dialog would be a proposed addition. |
| `open` | Launches a local browser (`open`, `explorer` or `xdg-open`) with the full `bc-` URL | TUI command. Runs on the TUI's machine. Behavior on a remote-attached TUI to be decided in G6. |
| `model` | Picker or explicit ID. Saves the default model. | TUI command plus options |

Leader Key group `c` (`pi-cursor-cloud/src/menu.ts:21-48`), shown only for loaded commands:

| Keys | Command |
|---|---|
| `c s`, `c l`, `c f`, `c o`, `c m` | `/cloud spawn`, `list`, `send`, `open`, `model` |
| `c p`, `c a` | `/cursor-mode plan`, `agent` |
| `c r l`, `c r c` | `/cursor-runtime local`, `cloud` |
| `c q` | `/cursor-fast` |
| `c z c`, `c z d`, `c z h` | `/cloud cancel`, `/cloud delete`, `/cursor-cloud list` |
| `c z x m`, `c z x c`, `c z x h`, `c z x r`, `c z x t` | `/cursor-refresh-models`, `/cursor-refresh-config`, `/cursor-http`, `/cursor-local-resume-cleanup`, `/cursor-tools` |

OpenCode equivalent: the TUI `keymap` API (present from 2.0.0) with the same sequences, if the leader key does not clash. Status: Partial, Gate G6.

| Pi feature | OpenCode 2.x equivalent | Status |
|---|---|---|
| Widget above the editor and status count | Host slot `sidebar.content`, `prompt.footer.status` or `home.footer` (2.0.0 names; `home.footer.status` from 2.2.5 only) | Partial |
| Shutdown detaches and never cancels | Plugin `setup` cleanup function | Unverified |
| Attach, resume, remote listing | Pi has none of these | N/A |

## Cards and rendering

| Pi feature | OpenCode 2.x equivalent | Status |
|---|---|---|
| Tidy inline tool cards | No transcript card slot at 2.0.0 or 2.2.5. How 2.x renders unknown tool output was not studied. Function moves to slots, dialogs and toasts. | Partial. No exact card parity. |
| Inline completion card and chill folding | No transcript slot. Use a slot entry, a toast and the synthetic message text. Receipts still dedupe the message (G5). Folding after later output or a 5 s grace has no equivalent. | No exact match. Upstream-dependent. |
| OSC 8 links | Link in the tool output text | Partial |

## Permissions

Cursor native tools bypass Pi's permission prompts, and they bypass OpenCode's too. OpenCode's permission settings apply only to bridged tools. Sandbox and autoReview are Cursor's own controls and are not OpenCode enforcement. Iury accepted Cursor-native safety with clear disclosure (F-40). Helper requests run in the isolated `tools: []` lane.
