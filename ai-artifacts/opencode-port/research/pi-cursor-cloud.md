# Pi Cursor Cloud: research for the OpenCode port

Revision: `1241c76` on branch `opencode-port` (HEAD, 2026-10-25). Phase 1 evidence only; this report proposes no architecture.

## Summary

`packages/pi-cursor-cloud` is a small, in-memory, fire-and-forget delegator. It owns only the agents it creates in the current process, streams their activity through `@cursor/sdk` callbacks (no polling), and posts a custom follow-up message that triggers a main-agent turn when a run ends. Nothing about agents survives a restart: there is no attach, no resume, no remote listing, and shutdown detaches without cancelling. Only the default model persists, in one JSON file.

The port must reproduce five contracts: four model tools, one `/cloud` command with seven actions, a background completion that triggers a turn, a live widget plus status, and credential-free errors. Two external renderers in `pi-ext` (tidy cards, Leader Key menu) consume this package through event-bus protocols.

## Reading coverage

Read in full (1,796 lines in the package):

| File | Lines | Role |
| --- | --- | --- |
| `packages/pi-cursor-cloud/package.json` | 39 | `@cursor/sdk` pinned `1.0.37`; Pi entry `./src/index.ts` |
| `packages/pi-cursor-cloud/tsconfig.json` | 14 | build config |
| `packages/pi-cursor-cloud/README.md` | 133 | user docs, limits |
| `packages/pi-cursor-cloud/LICENSE` | 21 | MIT |
| `packages/pi-cursor-cloud/src/index.ts` | 323 | tools, command, lifecycle, renderers |
| `packages/pi-cursor-cloud/src/cloud-client.ts` | 152 | SDK wrapper, auth, redaction |
| `packages/pi-cursor-cloud/src/state.ts` | 100 | pure reducer |
| `packages/pi-cursor-cloud/src/render.ts` | 110 | widget, completion, list text |
| `packages/pi-cursor-cloud/src/widget.ts` | 75 | widget timers and status |
| `packages/pi-cursor-cloud/src/repo.ts` | 37 | GitHub origin and ref defaults |
| `packages/pi-cursor-cloud/src/menu.ts` | 49 | Leader Key group |
| `packages/pi-cursor-cloud/src/config.ts` | 19 | default model file |
| `packages/pi-cursor-cloud/scripts/smoke.mjs` | 45 | paid live smoke |
| `packages/pi-cursor-cloud/tests/*.test.mjs` | 8 files, 679 | `cloud-client` 70, `config` 30, `index` 352, `menu` 17, `render` 78, `repo` 29, `state` 52, `widget` 51 |

Also read the cloud-specific consumers:

- `packages/pi-ext/extensions/tool-presentation/tidy/cards/specs/cursor-cloud.ts:1-56` (all)
- `packages/pi-ext/extensions/tool-presentation/tidy/message-cards.ts:1-37` (all)
- `packages/pi-ext/extensions/tool-presentation/tidy/chill.ts:15-100` (cloud parts)
- `packages/pi-ext/extensions/leader-key/contributions.ts:1-110` (collect protocol)
- `packages/pi-ext/tests/tool-presentation/tidy/cloud-cards.test.ts:1-151` (all, 7 tests; see section 8)
- root `package.json:53` (catalog entry)
- git log of all 13 package commits.

Not read: `packages/pi-ext/tests/tool-presentation/tidy/renderer-harness.ts` (imported by the cloud-cards tests), `pi-ext` card internals outside the cloud spec, and `@cursor/sdk` sources. No `node_modules` exists in this worktree, so SDK behaviour is inferred from the call sites. I ran no tests, builds, or Cloud calls.

## 1. Surface inventory

### Model-facing tools

| Tool | Params | Mode | Behaviour | Evidence |
| --- | --- | --- | --- | --- |
| `cursor_cloud_spawn` | `prompt` (min 1), optional `repo`, `ref`, `model`, `name` | sequential | Resolves repo/ref, creates agent, returns at once; prompt is sent in background | `src/index.ts:16-24`, `:127-141`, `:186-191` |
| `cursor_cloud_send` | `id`, `prompt` | sequential | Follow-up on an idle agent; rejects while active or deleting | `src/index.ts:143-154`, `:192-197` |
| `cursor_cloud_cancel` | `id` | sequential | Waits for the run handle, then requests cancel; returns "already X" if idle | `src/index.ts:156-166`, `:198-203` |
| `cursor_cloud_status` | optional `id` | default (no `executionMode`) | JSON rows for one or all local agents; full text, branches, error | `src/index.ts:204-218` |

Each tool returns `{ content: [text], details }`, with `details.agent` or `details.agents` holding an `AgentSummary` (`src/index.ts:184-185`, `src/render.ts:73-80`). Tidy cards read those details.

### `/cloud` command

Parser: first token is the action, default `list` (`src/index.ts:250-253`). All errors become `ctx.ui.notify(..., "error")`; picker or input cancellation becomes an `info` notice "Cancelled." (`:220`, `:292`).

| Action | Args | Behaviour | Evidence |
| --- | --- | --- | --- |
| `list` (or empty) | none; any arg is a usage error | Plain table plus URLs; `details.kind="list"` | `:270`, `src/render.ts:65-70` |
| `spawn` | leading `--repo/--ref/--model/--name` (`=` or space), then prompt; asks for prompt if empty | Same as the tool | `:34-46`, `:271-275` |
| `send` | `<id> <prompt>`; picks idle agent, then asks for prompt | Same as the tool | `:276-279` |
| `cancel` | one id or none (picks among active) | Same as the tool | `:280` |
| `delete` | one id or none (picks among idle) | **Command only.** Remote `Agent.delete`, then local removal | `:168-182`, `:281` |
| `open` | one id or none (picks any) | **Command only.** `open`/`xdg-open`/`explorer` via `pi.exec` on `https://cursor.com/agents/<full id>` | `:282-289`, `src/render.ts:53` |
| `model` | id or none (SDK model picker; falls back to text input if listing fails or is empty) | **Command only.** Saves default; notice only, no message | `:255-269` |

Result messages: `pi.sendMessage({ customType: "cursor-cloud-command", display: true, details: view })` with no `triggerTurn` (`:291`). Comments say the model still reads the plain content (`src/render.ts:98`). `model` and `open` post no message.

Without a UI (`ctx.hasUI` false), missing arguments throw "needs arguments outside the interactive UI" (`:223-237`).

### Features that do NOT exist

- **Attach** to an existing or external agent, or one from a prior process: `find` searches only local state and says "Only agents started in this process are available" (`src/index.ts:67-73`).
- **Resume across restart or reload**: handles live in memory (`README.md:102`).
- **Remote listing** of the Cursor account's agents (`README.md:102`).
- **Polling or refresh**: activity arrives only through `onDelta`/`onStep` callbacks (`src/cloud-client.ts:113-116`).
- **Live steering**: follow-ups only when idle (`src/index.ts:148`).
- **Delete, open, and model as tools**: they are command-only.
- **Cost estimate, artifact download, applying cloud changes locally** (`README.md:105`).
- **PR, branch, environment, or auto-create-PR options**: `create` passes only model, repo URL, and `startingRef` (`src/cloud-client.ts:142-143`). Those flags live in `pi-cursor-sdk`, not here.
- **`name` reaching Cursor**: `SpawnOptions.name` is accepted but never sent to `Agent.create` (`src/cloud-client.ts:13`, `:139-143`). The name is a local label only.
- **Any non-GitHub repo** (`src/repo.ts:5-13`).

## 2. Auth and security

1. **Precedence**: trimmed `CURSOR_API_KEY`, then trimmed `cursor.key` in `$PI_CODING_AGENT_DIR/auth.json` or `~/.pi/agent/auth.json`; otherwise a fixed error (`src/cloud-client.ts:30-40`). Only `cursor.key` is read; parse failures are swallowed so no secret leaks into the error (`:38`).
2. **Lazy, per call**: `getKey()` runs on every `models`, `create`, and `delete` (`:134-150`). A key change applies to the next agent, not to open handles.
3. **Error sanitising**: every SDK failure becomes a fixed sentence per operation; only `[agent_busy]` is recognised (`:46-50`). The comment states the reason: raw SDK errors can serialise a client that holds credentials.
4. **Redaction**: the literal key is replaced in streamed text, tool activity, result text, branch names, and PR URLs (`:42-44`, `:84-96`, `:105-111`). Redaction matches the exact key string only.
5. **Untrusted terminal text**: `cleanText` strips CSI sequences and C0/C1 control characters; `singleLine` also collapses whitespace (`src/render.ts:8-11`). OSC 8 links are generated only from `agentUrl` (`:86-88`).
6. **Repo hardening**: only `github.com` via HTTPS, `git@`, or `ssh://git@`; rejects userinfo, look-alike hosts, local paths, `.` and `..` (`src/repo.ts:6-13`; tests `tests/repo.test.mjs:5-8`).
7. **Ref hardening**: an explicit ref must be non-blank, must not start with `-`, and must not contain controls or spaces (`src/repo.ts:24`). Refs derived from git are not checked.
8. **No writes of credentials or Pi settings** (`README.md:31`). The only write is the model config (`src/config.ts:16-19`).
9. **SDK handles never enter state or tool results** (`src/index.ts:48`).

## 3. Defaults

- **Model**: explicit `model` > saved `defaultModel` > built-in `composer-2.5` (`src/index.ts:15`, `:131`). Config lives at `$PI_CODING_AGENT_DIR/pi-cursor-cloud.json` or `~/.pi/agent/pi-cursor-cloud.json`, loaded once at registration (`src/config.ts:6-14`, `src/index.ts:53`). Invalid or blank JSON falls back silently.
- **Repo**: the cwd's `origin` normalised to `https://github.com/owner/repo`; an explicit repo also works outside git (`src/repo.ts:18-22`).
- **Ref**: explicit ref wins. Otherwise, when the repo equals origin, use the current branch if `refs/remotes/origin/<branch>` exists locally; else `main`. A different explicit repo always gets `main` (`src/repo.ts:23-36`). Each git call has a 5 s timeout and a 64 KB buffer (`:16`).
- **Constraint**: the check reads only the *local* `refs/remotes/origin/<branch>` and never fetches. Two cases follow:
  - A branch with no local `origin` tracking ref (never pushed, or tracking ref pruned) falls back to `main`.
  - A branch that has a local tracking ref but also unpushed local commits still resolves to that branch name. Cursor then checks out the branch as it exists on GitHub, so the unpushed commits are invisible to the cloud agent. No warning is shown.
  - A detached HEAD makes `symbolic-ref` fail, so it also falls back to `main` (`src/repo.ts:30-34`).
- **Name**: `cloud-${state.length + 1}` (`src/index.ts:132`). After a deletion this can repeat an existing name; IDs stay unique.
- **ID matching**: strips `bc-`, then matches unique prefixes; `shortId` shows 8 characters (`src/index.ts:67-73`, `src/state.ts:51`).

## 4. Lifecycle, streaming, and completion

### State machine

Statuses are `starting → running → idle | failed | cancelled`; only `followUp` reopens a settled agent (`src/state.ts:13-18`, `:64-99`). The reducer drops late stream events and duplicate terminal events (`:75`), counts tools once per `callId` (`:91-95`), appends text deltas and replaces them with the final `assistantMessage` step (`:87-90`, `src/cloud-client.ts:77`). Activity keeps the last 240 text characters (`src/state.ts:89`).

SDK mapping (`src/cloud-client.ts:52-82`):

- `thinking-delta` / `thinkingMessage` → "thinking…" (thought text is discarded)
- `text-delta` → append; `assistantMessage` → replace
- `tool-call-started` → tool activity, counted; `toolCall` step → activity text only, not counted
- `shell` becomes `run_terminal_cmd`, with the first of `command|path|pattern|query|globPattern`, capped at 200 characters

### Run flow (`src/index.ts:94-125`)

1. `spawn` awaits `client.create`, stores the handle, dispatches `spawned`, starts the run, and returns before `send` resolves (`:127-141`).
2. `startRun` builds a `Job` whose `ready` promise wraps `handle.send`, and registers it in `jobs` synchronously. Stream events dispatch only while `jobs.get(id) === job`, which drops stale runs.
3. On `ready`: dispatch `running`, await `run.wait()`, then dispatch the terminal event. Zero duration falls back to local elapsed time; empty result text falls back to streamed text (`:107-111`).
4. Any throw from send or wait becomes `failed`, carrying the sanitised message and the streamed text (`:112-119`).
5. `notifyCompletion` sends exactly one completion per run (`:120-123`).

### Background completion message (`src/index.ts:84-92`)

```
pi.sendMessage({ customType: "cursor-cloud-completion", content: formatCompletion(agent), display: true,
  details: { ...AgentSummary, prompt, completionId: randomUUID(), text, error } },
  { deliverAs: "followUp", triggerTurn: true })
```

The content holds header, error, result text, branch/PR lines, and an `Open:` URL (`src/render.ts:55-63`). `completionId` gives tidy and chill a stable identity across live and restored sessions (`packages/pi-ext/extensions/tool-presentation/tidy/chill.ts:19-24`).

### Concurrency guards

- **Follow-up race**: `followUp` is dispatched synchronously before `send` is awaited, so a second send sees `starting` (`src/index.ts:95`, `:151-152`; test `tests/index.test.mjs:98-114`).
- **Cancel while starting**: awaits `job.ready`, then cancels (`:160-164`; test `:187-198`).
- **Delete**: refuses active agents; a `deleting` set blocks concurrent send and delete (`:147`, `:168-182`; test `:210-221`).
- **Shutdown during create**: closes the handle and sends no prompt (`:134`; test `:223-233`). *Constraint*: the remote agent already exists and is never deleted, so it is orphaned.
- Three of the four tools declare `executionMode: "sequential"`; status does not.

### Shutdown and cleanup (`src/index.ts:312-320`)

- `session_start` attaches the widget only.
- `session_shutdown` sets `stopped = true` permanently, disposes the widget, calls `close()` on every handle (detaching listeners), and clears maps. It never cancels remote work (`:316`; test `:171-185`).
- After shutdown, every action throws "has shut down" (`:76`), and late events and messages are dropped (`:62`, `:85`).
- `stopped` never resets on a later `session_start`. Whether Pi re-instantiates extensions per session is unverified here.

### Failure caveat

A network failure during `wait` marks the agent `failed` locally while remote work may continue (`README.md:104`).

## 5. Widget and status

Defined in `src/widget.ts:5-75` and `src/render.ts:17-50`.

- TUI mode only; JSON and RPC modes install nothing (`src/widget.ts:69`; tests `tests/widget.test.mjs:45-51`, `tests/index.test.mjs:152-161`).
- Placement is `aboveEditor` under key `cursor-cloud`; the status bar shows `󰅟 N running` while active (`src/widget.ts:33-34`, `:50`).
- A 150 ms spinner runs only while an agent is active; finished agents linger 60 s through an unref'd expiry timer (`:18-32`, `src/state.ts:55-58`).
- The tree caps at 12 lines, puts active agents first, gives an active agent two lines (header plus `⎿ activity`), and collapses overflow into `+N more` (`src/render.ts:23-48`).
- Every line is truncated to terminal width (`:49`).
- `invalidate` re-registers the widget on theme change (`src/widget.ts:45-48`).

## 6. Renderers and external integrations

- **Completion renderer**: emits synchronous `tidy:message-card:v1` `{version, customType, message, expanded, theme}`; if a listener sets `component`, it uses it, otherwise it shows raw cleaned text (`src/index.ts:296-306`).
- **Command renderer**: `cursor-cloud-command` draws a list or a two-line spawn view, with OSC 8 links when `getCapabilities().hyperlinks` (`src/index.ts:295`, `:307-311`; `src/render.ts:98-110`).
- **Tidy card specs**: specs for the four tools plus `cursor_cloud_completion` cover summaries, failure regexes, expanded metadata, and Open links (`packages/pi-ext/extensions/tool-presentation/tidy/cards/specs/cursor-cloud.ts:28-56`). *Coupling*: the `failed` regex matches this package's error text (`:11`).
- **Message cards**: the listener accepts only version 1 and known `customType`s, feeds chill, and borrows an empty widget as a redraw handle (`.../tidy/message-cards.ts:13-36`).
- **Chill folding**: a completion card folds after a later tool, text, or a 5 s grace period (`.../tidy/chill.ts:27`, `:72-82`).
- **Leader Key**: on `command-menu:collect:v1` (version 1), adds group `cursor` (key `c`) filtered to loaded extension commands, because Leader Key drops a group if any command is missing (`src/menu.ts:12-49`, `src/index.ts:239-244`; consumer `packages/pi-ext/extensions/leader-key/contributions.ts:61-110`).
  - Cloud entries: `s` spawn, `l` list, `f` follow up, `o` open, `m` model, `z c` cancel, `z d` delete.
  - Other entries point at `pi-cursor-sdk` commands: `cursor-mode`, `cursor-runtime`, `cursor-fast`, `cursor-cloud list`, `cursor-refresh-models`, `cursor-refresh-config`, `cursor-http`, `cursor-local-resume-cleanup`, `cursor-tools` (registered at `packages/pi-cursor-sdk/src/cursor-state.ts:394-539`, `cursor-runtime-state.ts:365,480`, `index.ts:79`). The menu therefore spans both packages.
- **Catalog**: root `package.json:53` loads the package; `README.md:29` warns against loading it twice.

## 7. Remote side effects and costs

| Call | Effect | Trigger |
| --- | --- | --- |
| `Cursor.models.list` | read | `/cloud model` without id |
| `Agent.create` | creates a remote agent | spawn |
| `agent.send` | **paid run** at Max Mode pricing (`src/index.ts:188`) | spawn, follow-up |
| `run.cancel` | stops the run | cancel |
| `Agent.delete` | removes the agent | `/cloud delete` |
| `pi.exec(open …)` | opens a local browser | `/cloud open` |

- Cursor may create branches or PRs; the extension only reports them (`src/cloud-client.ts:88-92`).
- Cancelling an input prompt spends nothing (`tests/index.test.mjs:249-256`).
- `scripts/smoke.mjs` makes one paid read-only run against `iurysza/agents2@main`, times out after 180 s, cancels if unfinished, then deletes the agent (`:11-44`). It still uses model `composer-2-5`, the id that `3406f4a` replaced as the default.

## 8. Current behaviour, tests, and aspirations

- **Tested with fakes** (`tests/index.test.mjs`, 21 tests): background spawn, busy reservation, completion options, follow-up reset, cancel, owned-only delete, multiline prompt, flags, JSON mode, ambiguous prefix, shutdown detach, cancel-while-starting, send failure, delete reservation, create-during-shutdown, menu prompts, cancel without spending, menu filtering, open, details, tidy protocol, model precedence, picker, and fallback.
- **Pure units**: `state` (4 tests), `render` (8), `widget` (2), `repo` (3), `config` (1), `menu` (2), and `cloud-client` (6, which mock `Cursor.models.list` and use pure mappers). Eight files in total.
- **External tidy tests** (`packages/pi-ext/tests/tool-presentation/tidy/cloud-cards.test.ts`, 7 tests, fixture details only, no cloud package import):
  - completion summary text for finished, failed (first error line only) and cancelled, with `1 tool` singular (`:17-27`);
  - expanded completion shows `id/repo/model/url` metadata, then the reply as plain unstyled text, with a `│` rail on every wrapped row and `expandedMaxLines` capping (`:29-43`);
  - OSC 8 `Open ↗` / `Open in Cursor ↗` links appear only when hyperlinks are supported, survive widths 20-150, and are omitted for status-of-all (`:45-66`);
  - the `tidy:message-card:v1` listener returns a component only while tidy is enabled, and ignores version 2 and unknown `customType` (`:68-81`);
  - chill folds a cloud completion with earlier tool cards once assistant text arrives (not on thinking), counts cloud failures, uses the error background, and expands on click (`:83-115`);
  - a cloud-only completion folds after the 5 s grace period and requests a redraw through an empty widget (`:117-132`);
  - on `session_start` and `session_tree`, chill restores folded state from `custom_message` branch entries keyed by `completionId`, without mutating the branch (`:134-151`).
- The tidy fixture uses model `composer-2-5` (`cloud-cards.test.ts:8`), only as display data.
- **Untested**:
  - the real `Agent.create`, `send`, `wait`, `cancel`, and `delete` mapping;
  - non-macOS `open`;
  - the `cursor-cloud-command` renderer output;
  - the status-bar count text;
  - name collisions after delete;
  - the remote orphan from create-during-shutdown;
  - `stopped` persisting across sessions;
  - redaction inside streamed tool activity.
- **Aspirations or docs only**: npm publication (`README.md:29`); the live smoke, which is manual and paid.

## 9. Historical fixes

| Commit | Change | Lesson for the port |
| --- | --- | --- |
| `680fbd6` | initial package | — |
| `013f302` | `/cloud spawn` accepts leading flags; flag-like text later in the prompt stays literal | keep flags leading-only |
| `60e69ad` | Leader Key menu; prompt for missing args | menus run commands without args |
| `51d895f`, `29f94f6` | agent URL and `/cloud open` | full `bc-` id in the URL |
| `3d27433` | tidy tool cards, structured `details` | renderers key off `details` |
| `aaf09d5` | larger cloud glyph `󰅟` | cosmetic |
| `5dc1606` | completion via tidy protocol plus chill; `completionId`; default-model picker and config; removed built-in Markdown renderer | raw fallback must stay unstyled |
| `3406f4a` | default id `composer-2-5` → `composer-2.5` | verify model ids against `models.list` |
| `246ffd9`, `83a6623` | dependency bumps | — |

Off-branch drift: `b6c5fe1` and `4d15156` (2026-10-26, not in HEAD) change only `packages/pi-cursor-cloud/package.json` dependency versions.

## 10. Constraints for the port (no design decisions)

1. The completion path needs a way to inject a message that **triggers a new assistant turn** without user input, and to render it with a custom card.
2. Background work outlives the tool call. The host process must keep SDK promises and callbacks alive and notify asynchronously.
3. Security behaviour must carry over: sanitised errors, key redaction, terminal text cleaning, and GitHub-only repos.
4. Auth paths are Pi-specific (`~/.pi/agent/auth.json`, `PI_CODING_AGENT_DIR`). An OpenCode equivalent must choose its own store, and must neither print nor copy that file.
5. Model ids must come from `Cursor.models.list`; the hard-coded default has already drifted once.
6. Concurrency relies on synchronous reservation before `await`. Any event-driven host must preserve that ordering.
7. Shutdown semantics are a product rule: detach, never cancel remote runs.
8. The widget depends on an above-editor slot, a status slot, and redraw handles; the Leader Key menu depends on cross-package command presence.
9. In-process ownership is the security boundary for delete and cancel. Adding attach or remote listing would widen it.

## 11. Acceptance-test suggestions

Fake-client tests (free):

1. Spawn returns before `send` resolves; status shows `starting`; a follow-up during `starting` is rejected.
2. Exactly one completion per run; it triggers a turn and carries `prompt`, a unique `completionId`, `text`, and branches/PR.
3. A follow-up on an idle agent resets tools and text, and a concurrent second follow-up is rejected.
4. Cancel during `starting` waits for the handle; cancel on an idle agent reports "already".
5. Delete refuses active agents, blocks a concurrent send, closes the handle, and removes the agent from status.
6. Shutdown closes handles, never cancels, suppresses late messages, and rejects new spawns.
7. Create resolving after shutdown sends no prompt. Also decide and test whether it deletes the orphan.
8. Unknown or ambiguous prefixes fail; agents from other processes are unknown.
9. Model precedence (explicit > saved > built-in) persists across restarts; invalid config falls back.
10. Repo: SSH to HTTPS; reject tokens, look-alike hosts, local paths, and bad refs. A current branch with no local `refs/remotes/origin/<branch>` falls back to `main`. A current branch with that tracking ref resolves to the branch even when it has unpushed commits; the test should document that those commits are invisible to the cloud agent. A detached HEAD falls back to `main`. An explicit different repo falls back to `main`.
11. Auth: env beats file; the file reads only `cursor.key`; no error contains the key or other secrets; SDK errors that include the key are sanitised.
12. Rendering: ANSI and control characters stripped; width respected; 12-line cap; 60 s linger; widget absent in non-TUI modes.
14. Card parity with `cloud-cards.test.ts`: completion summaries per status, plain unstyled expanded reply, capability-gated links, fold after assistant text or 5 s grace, and restore from stored session entries by `completionId`.
13. Command parity: every `/cloud` action, flags before the prompt, multiline prompts, and pickers and inputs when arguments are missing.

Live smoke (paid; needs Iury's approval): one read-only run on a small repo, then cancel-if-unfinished and delete. Assert the terminal status, result text, and cleanup.

## Sources

- Kept: every file listed under Reading coverage, and `git log` / `git show` for the 13 package commits plus the two off-branch commits.
- Dropped: `pi-cursor-sdk` internals beyond its command registrations, which belong to the separate SDK report.

## Gaps

- `@cursor/sdk@1.0.37` is not installed here, so I could not confirm whether `Agent.create` accepts a name, whether `close()` keeps the remote run alive, what `run.cancel()` does after completion, or whether `wait()` can resolve without a stream. Next step: read the SDK typings in a scratch install, or ask the SDK report owner.
- Unknown whether Pi reuses the extension instance after `session_shutdown`, which would leave `stopped` stuck. Next step: check Pi's extension loader.
- The correct model-id form (`composer-2.5` or `composer-2-5`) is not verified against a live `models.list`.
- Tests were not run; there is no `node_modules`, and installs were out of scope.
- `renderer-harness.ts` was not read, so the exact host events it simulates for chill are inferred from the test calls.

## Start here

`packages/pi-cursor-cloud/src/index.ts`, then `src/cloud-client.ts` and `src/state.ts`.
