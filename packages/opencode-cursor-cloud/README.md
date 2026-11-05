# Cursor Cloud for OpenCode

Private beta background delegation for OpenCode `>=2.0.0 <3`. The backend provides `cursor_cloud_spawn`, `cursor_cloud_send`, `cursor_cloud_status`, and `cursor_cloud_cancel`, plus fixed RPC controls and a confirmed delete command. Tools and TUI RPC share one backend service and Cursor client. Entry load imports no Cursor SDK or TUI and starts no network operation.

## Safety and billing

Loading this package exposes background Cloud tools to the local SDK bridge. A model can request billable remote work through them. Keep this package out of the first local hello preview. The repository's [preview guide](../../ai-artifacts/opencode-port/home-test.md) requires explicit `--include-cloud` opt-in.

Cloud uses Cursor API Max Mode pricing and can require a spend limit. It sees remote GitHub state, not local, uncommitted, or unpushed changes. Remote agents persist. Shutdown detaches and never automatically cancels or deletes them.

The host-stored personal key wins over `CURSOR_API_KEY`. No Pi, Cursor CLI, or Desktop credentials are read. Remote workspaces fail closed. Follow-ups refuse while an agent starts or runs. Cancellation and deletion through RPC require confirmation. Only agents created by this process and originating session are actionable. Delete refuses active agents.

Cursor native tools bypass OpenCode permission prompts. SDK sandbox and autoReview are Cursor controls, not OpenCode enforcement. Background agents do not inherit local tools or environment variables.

## Completion and controls

Each observed completion gets a durable receipt before synthetic notification admission to its originating session. Receipt recovery never adopts or polls remote agents. Notification admission is deduplicated, but host restart recovery is at-least-once and may rerun interrupted assistant work. Answer status remains unknown without direct host evidence. Ambiguous receipts are held instead of replayed blindly.

Models report a bundled fallback without a network request. Status is read-only. Fixed controls provide spawn, follow-up, status, ledger, confirmed cancel, and confirmed delete. The TUI has native dialogs and status slots, not exact Pi tidy transcript cards. Endpoint standalone and attached-local rendered tests use fake action owners; live-action parity and intermediate OpenTUI versions remain unqualified.

Background action ports cannot cancel an SDK create in flight. RPC abort checks do not imply remote cancellation. Complete host compatibility, live SDK qualification, and release approval remain pending.

## Provenance

The port adapts the MIT-licensed Pi Cursor Cloud extension. See [LICENSE](./LICENSE). `@cursor/sdk` remains a pinned normal proprietary dependency, not vendored code. Terms review is required before publication.
