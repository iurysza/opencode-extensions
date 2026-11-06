# Native tool cards probe

Date: 2026-11-06. Branch `cursor-tool-cards-probe`. Stage: spike. No production code changed.

## Conclusion

The hypothesis mostly holds. If a provider-executed part uses OpenCode's built-in tool name and input fields, the stock TUI draws its native card. This works on 2.0.0 and 2.2.5. No plugin API is needed.

One limit: a provider `tool-result` cannot set part `metadata`. Cards that need metadata (the edit diff, write diagnostics, grep and glob counts) show a header only.

Adopting this conflicts with accepted fact F-06 (native calls use collision-safe `cursor_*` names). It needs Iury's approval before any production change.

## Evidence

Run: `node packages/opencode-cursor-sdk/test/tool-cards/run-host.mjs 2.2.5` (and `TOOL_CARDS_SHAPES=builtin ... 2.0.0`). Real pinned host, `env -i` plus macOS sandbox, scripted fake Cursor source, no SDK, no network.

| Path | Shows |
|---|---|
| `2.2.5/today/tui.txt`, `tui.png` | Generic rows: `✓ cursor_edit [path=...]`, `✓ cursor_shell [command=..., workingDirectory=...]`, `✓ cursor_read [...]` |
| `2.2.5/builtin/tui.txt`, `tui.png` | `← Edit src/sample.ts` (header, no diff), `$ echo probe && ls src` with stdout, `→ Explored: 1 read` |
| `2.0.0/builtin/tui.txt`, `tui.png` | Same native cards on the 2.0.0 floor |
| `*/*/tui-running.txt` | Mid-call frame: spinner on the open call (`⠇ cursor_read`, `⠏ Exploring: 1 read`) |
| `*/*/tool-parts.json` | Stored parts: `executed: true`, `state.metadata` absent, result text in `state.content` |
| `*/*/summary.json` | `hostNeverExecuted: true` (project file unchanged, every part provider-executed) |

## How the 2.2.5 TUI picks a card (read from the bundled JS)

- Dispatch is by part name only: `KF(name)` normalises `bash→shell`, `task→subagent`, `apply_patch→patch`, then a fixed set (`shell glob read grep webfetch websearch write edit subagent execute patch todowrite question skill`) else `generic`. `executed` (providerExecuted) is not consulted.
- Props: `input = state.input`, `metadata = state.metadata`, `output = state.content` text joined.
- `shell`: `input.command`, `input.workdir`, `output`. Full card from provider data.
- `read`: `input.path`, `input.offset`, `input.limit`; groups into "Explored". Full card.
- `edit`: diff only from `metadata.files[]` (`patch`, `type`, `relativePath`, `additions`, `deletions`); else header `← Edit <input.path>`.
- `write`: `input.path`, `input.content` rendered as code. Full card.
- `grep`/`glob`: `input.pattern`, `input.path`; counts from `metadata.matches`/`metadata.count`.
- `todowrite`: `input.todos[]` with `content` and `status` in `pending|in_progress|completed|cancelled`.
- `patch`: `metadata.files[]`, or `input.patchText` headers (`*** Update File: x`) for a "Patching x" title.

## Metadata path

`session.tool.success` from a provider `tool-result` carries only `content`, `executed`, `native`. `metadata` reaches the part only through local tool execution or `session.tool.progress`, which a provider stream cannot emit. So edit diffs need another route, for example a ```` ```diff ```` block in assistant text or a `write`-style card.

## Start versus end

The stream already emits `tool-input-start` and `tool-call` before the result, so the card shows a spinner. Today `local-runtime.ts` buffers until `tool-call-completed`, so the running window is near zero. Emitting the call on `tool-call-started` and the result on completion would show live progress. It needs care for bridge splits, which is why the buffer exists.

## Proposed mapping (not implemented)

| Cursor | OpenCode name | input | content |
|---|---|---|---|
| `shell` | `shell` | `command`, `workdir ← workingDirectory` | stdout + stderr |
| `read` | `read` | `path` | file text |
| `write` | `write` | `path`, `content ← fileText` | short status |
| `edit` | `edit` | `path` | `diffString` |
| `grep` | `grep` | `pattern`, `path` | match text |
| `glob` | `glob` | `pattern ← globPattern`, `path ← targetDirectory` | file list |
| `updateTodos` | `todowrite` | `todos` (`inProgress → in_progress`) | short status |
| others | `cursor_<type>` | unchanged | unchanged |

Risks: an unparseable or schema-invalid input must stay `cursor_<type>` (F-09). Replay must never treat these as local calls; the probe confirms the host never ran them, but bridge `isEcho` and continuation checks must be re-tested with the new names.
