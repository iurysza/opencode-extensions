# OpenCode port execution status

Updated 2026-11-05. The private alpha is ready for Iury's first manual home smoke. It is not full parity or release-ready. No implementation worker remains active.

## Location and commits

- Primary repository: `~/dev/personal/tools/opencode-extensions`.
- Implementation worktree: `~/dev/worktrees/opencode-extensions/cursor-port`, branch `cursor-port`.
- Planning history: `pi-extensions/opencode-port`. Counts from that checkout do not reflect implementation commits.
- `33191c2`: durable deduplicated receipts.
- `bc62186`: disabled release automation.
- `1a5824a`: guarded foreground Cloud core.
- `c8ab863`: integrated local SDK turns, same-run tool bridge, background Cloud, native TUI/RPC and package metadata.

All workers used verified `openai-codex/gpt-6.1-sol`, high. The lead independently reran final checks and committed as `iury souza <iurysza@gmail.com>`, without co-author trailers.

## Verification

Install, dependency tree, build, 55 script tests, 284 SDK unit tests, 269 Cloud unit tests, package inspections, endpoint host/bridge/Cloud/control/composition probes, rendered standalone/attached TUI tests and the ten-version provider/request matrix pass. Actual generated preview targets loaded at both endpoint versions without SDK access or prompts. Details: [home verification](./home-build-verification.md).

## Next action

Iury can use [the home test guide](./home-test.md) and the pinned local OpenCode 2.2.5 binary. The generator starts nothing and keeps config/storage under the worktree. The first smoke loads only the local SDK package. Background Cloud tools are an explicit, billable opt-in.

No live SDK prompt or Cloud run has been verified. Helpers stay disabled; durable resume, full local settings, persistent model cache and further compatibility/live qualification remain open. The accepted end-to-end goal is not complete. A first real SDK result or separately approved live probe is the next verification boundary.

## Release and communication

Iury chose `iurysza/opencode-extensions` as the future remote. It has not been created or configured. Release activation and Cursor terms review remain pending. No push, publish, tag, release, merge, history rewrite or live setup change occurred.

The test-ready handoff goes to the existing `opencode port` Inbox thread.
