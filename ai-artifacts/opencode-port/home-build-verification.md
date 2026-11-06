# Home alpha verification

The private alpha is ready for a first manual local smoke. It is not full parity or release-ready. All checks below ran without a real Cursor prompt, Cloud agent or real credential.

## Lead checks

- `npm ci --ignore-scripts`, `npm ls`, `npm run build`, `npm run check`, and `npm run check:packs` pass.
- The standard check includes all script tests, including preview configuration regressions, both package type contracts and unit tests.
- Provider and request compatibility pass on all ten declared OpenCode versions.
- Minimum/latest endpoints, 2.0.0 and 2.2.5, pass receipt, bridge, background-tool, RPC, composition, offline SDK and approved keyless-create probes.
- The 14 bridge scenarios pass on both endpoints, including host permission allow/deny, same-run reentry, native collisions, malformed results and abort.
- Rendered TUI tests pass on both endpoints in standalone and attached-local modes.
- The actual preview generator and default package entries pass four no-SDK load cases: local-only and optional Cloud on both endpoints. SDK filesystem denial is checked positively. No prompt or generation is sent in these load probes.
- Local package inspection passes. Children and root remain private. Release automation remains disabled.

Final command output is under `.fixtures/lead-verification/home-final-*.log`. Runtime evidence is under `.fixtures/{bridge,receipts,cloud-tools,control-host,control-tui,composition-host,preview-load-local-only,preview-load-with-cloud}/`.

## Important fixes verified

Review caught stale receipt writes, unvalidated delivery, lost event evidence, split-key redaction, normalization ordering, and late SDK work after shutdown. Deterministic regressions and host cases cover the applicable fixes. Native text rendering and local-directory package loading were verified through the actual host rather than inferred from typings.

## Remaining limits

Helpers stay disabled pending G4b. Durable local resume, full setting controls and persistent model-cache support are unfinished. Some in-flight Cloud operations cannot be cancelled by the RPC port. Intermediate TUI lines and live SDK transport, timeout and Cloud requalification remain open. The Cursor terms review and release activation are separate gates.

Use [the home test guide](./home-test.md). It defaults to SDK-only local mode, keeps configuration and storage in the worktree, and starts nothing automatically. Cursor native tools are not an OpenCode filesystem sandbox. Use a disposable checkout for the first prompt.

The chosen future remote is `iurysza/opencode-extensions`. It was not created or configured. No push, tag, release, publish, merge, history rewrite or live setup change occurred.
