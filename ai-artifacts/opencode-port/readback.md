# Readback: Cursor SDK and Cursor Cloud for OpenCode 2.x

Status: **approved** with the rest of the package (Plannotator Inbox message `msg_redacted`). The location grant is approved (Plannotator Inbox message `msg_redacted`, see [goal autonomy](./goal.md#autonomy)). M0 is in progress.

## What I think you want

You want OpenCode, from 2.0.0 onward, to support both Pi packages "as completely as Pi does today". That is three behaviors:

1. **Cursor SDK models.** You pick a Cursor model in an OpenCode session. Cursor's own agent loop runs underneath, as in `packages/pi-cursor-sdk`, including its native tools. OpenCode tools reach Cursor through an MCP bridge that keeps OpenCode's permission flow.
2. **SDK foreground Cloud runtime (opt-in).** The same model slot can run each turn on a fresh remote Cursor agent, with a first-use acknowledgment, a strict Git preflight and a cleanup ledger.
3. **Background Cloud delegation.** You hand work to a remote Cursor agent, keep working, and get one follow-up when it finishes, as in `packages/pi-cursor-cloud`.

Where OpenCode cannot match Pi, the gap is named, not hidden. Cloud attach and resume remain out of scope.

## What you already decided

- A new `opencode-extensions` repository with two installable packages.
- OpenCode 2.0.0 onward. 1.x is excluded.
- Local TUI equivalents. A custom control adapter only if plugin RPC is not enough.
- Cursor-native safety, clearly disclosed, with isolated tool-disabled helpers.

## Conditions I am keeping

- **Phase 1 is study only.** No port implementation, OpenCode installs, port runtime probes, paid Cursor calls or live config changes. The repository's required dependency install and checks are commit hygiene, not port verification.
- **One submission.** You approve or revise the readback, intent, facts, feature map and plan together.
- **No silent downgrade.** A failed gate stops work. No text-only model, no HTTP chat facade and no weaker G5 criteria.
- **No Pi credential reuse.** The port never reads `~/.pi/agent/auth.json`.
- **Deterministic billable and destructive actions.** They never depend on a language model reading a prompt template.
- **Safe helper requests.** Title, compaction and generate requests never reuse the coding agent and must not run Cursor native tools. If that cannot be proven, they do not run on Cursor.
- **Pi packages untouched** until OpenCode parity is proven.
- **No new write authority.** Writes stay inside the granted worktree listed in [goal autonomy](./goal.md#autonomy).

Gates and the compatibility policy are in the [plan](./plan.md).
