# Cursor SDK for OpenCode

Private beta for OpenCode `>=2.0.0 <3`. The default backend entry composes local Cursor turns, a loopback MCP bridge to OpenCode tools, optional fresh foreground Cloud turns, and fixed backend RPC controls. Helpers refuse until G4b safety qualification passes. Loading the package imports no Cursor SDK or TUI and starts no network operation.

## Safety

Cursor native tools bypass OpenCode permission prompts. SDK sandbox and autoReview are Cursor controls, not OpenCode enforcement. Their setting adapters are unavailable in this build. Bridged OpenCode tools run through the host tool and permission pipeline.

The host-stored personal key wins over `CURSOR_API_KEY`. No Pi, Cursor CLI, or Desktop credential files are read. Remote workspaces fail closed. Project runtime, repository, and safety overrides are refused.

Local is the default. Foreground Cloud requires explicit session acknowledgment persisted before switching. Cloud executes against remote Git state at Cursor Max Mode pricing, does not receive local tools or environment variables, and leaves agents until confirmed archive or delete. Shutdown detaches without cancelling remote work.

## Preview and controls

Use the repository's [isolated preview guide](../../ai-artifacts/opencode-port/home-test.md). Built directory targets use `dist/server.js` and `dist/tui.js`. Do not point the first preview at your live OpenCode config.

Status, fallback models, runtime choice, host-config validation, and session ledger controls are wired to the backend owner. Foreground archive and delete require confirmation and recorded session-owned IDs. Fast, mode, tools, HTTP, resume cleanup, and model-cache refresh return `not_implemented`; they do not save ignored settings.

RPC push events and native dialogs replace Pi command displays. OpenCode 2.x has no transcript-card slot, so exact Pi tidy-card parity is not claimed. The control owner proved endpoint standalone and attached-local rendered behavior with fake action owners. Intermediate OpenTUI lines and live-action parity remain unqualified.

Durable local resume, helper execution, full settings, model-cache persistence, the complete host matrix, and live SDK behavior remain beta gaps. Foreground model selection supports bundled catalog parameters and the default variant, not undiscovered variants. Isolated fake-SDK host tests do not establish live parity.

## Provenance

The port adapts the MIT-licensed Pi Cursor SDK extension. See [LICENSE](./LICENSE). `@cursor/sdk` is a normal pinned proprietary dependency, not vendored code. Terms review and release approval remain required before publication.
