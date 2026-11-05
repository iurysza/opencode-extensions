# OpenCode Cursor extensions

Two private beta packages for OpenCode 2.x:

- [`@iurysza/opencode-cursor-sdk`](./packages/opencode-cursor-sdk/README.md) supplies local Cursor turns, the OpenCode tool bridge, and explicitly acknowledged foreground Cloud turns.
- [`@iurysza/opencode-cursor-cloud`](./packages/opencode-cursor-cloud/README.md) supplies optional background Cloud delegation with durable completion receipts.

Loading an entry starts no Cursor operation and imports no Cursor SDK or TUI. The backend owns credentials and SDK handles. TUI controls use fixed public RPC methods, not a second Cursor client.

Cursor native tools bypass OpenCode permission prompts. SDK sandbox and autoReview are Cursor controls, not OpenCode enforcement. Cloud runs can incur Cursor Max Mode charges and leave persistent remote agents.

Start with the [isolated manual preview guide](./ai-artifacts/opencode-port/home-test.md). Its config-generation script starts nothing and defaults to the local SDK package only. Background Cloud tools require `--include-cloud`; foreground Cloud requires session acknowledgment through RPC.

The combined build, offline checks, isolated host probes and rendered endpoint TUI tests pass. This is ready for a first manual home smoke test, not a live-parity or release-ready claim. Helpers, durable local resume, complete local settings, model-cache persistence, intermediate OpenTUI qualification, and live SDK qualification remain gaps. Agents still need separate approval for live calls.

## Local verification

```sh
npm run build
npm run check
node packages/opencode-cursor-sdk/test/integration/run-composition.mjs
```

The composition probe uses pinned actual OpenCode 2.0.0 and 2.2.5 with fake external SDK boundaries, isolated HOME and XDG directories, and a loopback-only sandbox. It needs the existing pinned binaries under `.fixtures/inspect`. See [composition evidence](./ai-artifacts/opencode-port/runtime-composition-note.md).

The accepted contract lives in [`ai-artifacts/opencode-port`](./ai-artifacts/opencode-port). These ports preserve their Pi implementation's MIT provenance. The proprietary Cursor SDK remains a normal pinned dependency and is not vendored. Publication remains blocked pending terms review and release approval.
