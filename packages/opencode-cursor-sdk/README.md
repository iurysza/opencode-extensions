# Cursor SDK for OpenCode

Private beta for OpenCode `>=2.0.0 <3`. The default backend entry composes local Cursor turns, a loopback MCP bridge to OpenCode tools, optional fresh foreground Cloud turns, and fixed backend RPC controls. Helpers refuse until G4b safety qualification passes. Loading the package imports no Cursor SDK or TUI and starts no network operation.

## Safety

Cursor native tools bypass OpenCode permission prompts. SDK sandbox and autoReview are Cursor controls, not OpenCode enforcement. Their setting adapters are unavailable in this build. Bridged OpenCode tools run through the host tool and permission pipeline.

The host-stored personal key wins over `CURSOR_API_KEY`. No Pi, Cursor CLI, or Desktop credential files are read. Remote workspaces fail closed. Project runtime, repository, and safety overrides are refused.

Local is the default. Foreground Cloud requires explicit session acknowledgment persisted before switching. Cloud executes against remote Git state at Cursor Max Mode pricing, does not receive local tools or environment variables, and leaves agents until confirmed archive or delete. Shutdown detaches without cancelling remote work.

## Preview and controls

Use the repository's [isolated preview guide](../../ai-artifacts/opencode-port/home-test.md). Built directory targets use `dist/server.js` and `dist/tui.js`. Do not point the first preview at your live OpenCode config.

Status, fallback models, runtime choice, host-config validation, and session ledger controls are wired to the backend owner. Local mode (`agent` or `plan`) and tool policy (`native`, `bridge` or `both`) persist through confirmed scope-bound controls and reach the SDK. User/env sandbox and auto-review settings retain their existing precedence. Foreground archive and delete require confirmation and recorded session-owned IDs. Fast, HTTP, resume cleanup, and model-cache refresh still return `not_implemented`; they do not save ignored settings.

RPC push events and native dialogs replace Pi command displays. OpenCode 2.x has no transcript-card slot, so exact Pi tidy-card parity is not claimed. The control owner proved endpoint standalone and attached-local rendered behavior with fake action owners. Intermediate OpenTUI lines and live-action parity remain unqualified.

Durable local resume, helper execution, full settings, model-cache persistence, the complete host matrix, and live SDK behavior remain beta gaps. Foreground model selection supports bundled catalog parameters and the default variant, not undiscovered variants. Isolated fake-SDK host tests do not establish live parity.

## Linux test requirements

The host-test sandbox requires `bubblewrap` and Perl. On Debian or Ubuntu, install them with `sudo apt-get update && sudo apt-get install -y bubblewrap perl`. Use Node.js 22.22.3, the CI version, and npm. Fixture extraction also requires system `tar`. A Node executable under a denied tool directory requires system `ldd`, provided by `libc-bin` on Debian and Ubuntu.

The kernel and host policy must allow unprivileged user, mount, PID, and network namespaces, with private `/proc` and working IPv4 and IPv6 loopback. AppArmor or container restrictions can block bubblewrap even when it is installed. A failed capability probe stops the tests. The harness never disables AppArmor, changes security sysctls, or runs unsandboxed as a fallback.

Fixture acquisition supports macOS ARM64 and Linux x64 or ARM64 using the published glibc Linux packages. It does not auto-select musl or baseline builds. Unsupported OS and architecture pairs fail explicitly. Follow [Run the Linux sandbox tests](../../ai-artifacts/opencode-port/linux-test.md) for exact commands, expected results, and the optional terminal-test requirement. Linux runtime behavior is not verified on the development Mac.

## Provenance

The port adapts the MIT-licensed Pi Cursor SDK extension. See [LICENSE](./LICENSE). `@cursor/sdk` is a normal pinned proprietary dependency, not vendored code. Terms review and release approval remain required before publication.
