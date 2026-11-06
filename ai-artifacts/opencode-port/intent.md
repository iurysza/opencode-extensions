# Intent

Status: **approved** with the revised package (Plannotator Inbox message `msg_redacted`). The location grant is approved (Plannotator Inbox message `msg_redacted`, see [goal autonomy](./goal.md#autonomy)). M0 is in progress. Read it with [the goal](./goal.md), [the readback](./readback.md), [the accepted facts](./facts.md) and [the plan](./plan.md).

## Outcome

OpenCode 2.0.0 onward supports Cursor SDK models and Cursor Cloud agents as completely as Pi does today, through two installable packages in a new `opencode-extensions` repository:

- `@iurysza/opencode-cursor-sdk`: Cursor models in OpenCode. Cursor's agent loop runs locally through `@cursor/sdk`. Cursor runs its native tools, and OpenCode tools reach Cursor through an MCP bridge that keeps OpenCode's permission pipeline. The package also covers the SDK's foreground Cloud runtime.
- `@iurysza/opencode-cursor-cloud`: background Cursor Cloud delegation. You spawn a remote agent, keep working, and get exactly one follow-up when it finishes.

Where OpenCode cannot match Pi, the gap is written down with an equivalent or an upstream dependency.

Scope basis: Iury asked for both packages "as completely as Pi does today". `packages/pi-cursor-sdk` already ships the foreground Cloud runtime, so full Cloud runtime parity (M3) is in scope. The settings-only first slice in `research/sdk-cloud-settings.md` is superseded. Phase 1 is study only. It is not a partial release.

## Audience and problem

Iury uses Pi and OpenCode side by side. Today only Pi can drive Cursor models and Cloud agents. The Pi packages depend on Pi hooks, Pi TUI components and Pi session entries, so they cannot load into OpenCode as they are.

## Scope

- A backend plugin (`@opencode/plugin` `define({ id, setup })`) that registers a `cursor` provider and returns an AI SDK `LanguageModelV3` from the public `aisdk` hook. Evidence: [2.x boundary report](./research/opencode-v2-boundary.md).
- Compatibility modules for each 2.x API boundary, from 2.0.0 to the latest qualified 2.x.
- Model discovery, variants (context and fast), and a fallback catalog.
- Native Cursor tools reported as provider-executed calls that OpenCode never runs.
- The MCP bridge for OpenCode tools, through OpenCode's tool and permission pipeline.
- Abort, error classification, secret redaction and context-overflow mapping.
- Per-session agent state, fork and compaction resets, and local resume where OpenCode supports it.
- Isolated helper requests. Every non-primary `model.request` kind (`title`, `compaction`, `generate`) runs in a local `tools: []` helper lane, or on a separately approved non-Cursor model. Never a Cloud helper.
- SDK foreground Cloud runtime at full parity: runtime command, acknowledgment, settings precedence, the full Git preflight probe, a durable cleanup ledger, list, archive and delete, context handoff, PR and environment controls. One improvement on Pi: check session and ledger persistence before `Agent.create`.
- Background Cloud delegation: spawn, send, cancel, status, list, delete, open and model selection, with completion receipts delivered through `session.synthetic`.
- Every Pi local command, flag and leader key mapped to an OpenCode surface: plugin options, env, or a TUI keymap command over plugin RPC.
- TUI equivalents: slot status, dialogs, toasts, keymap commands and structured tool output.
- Headless operation (`opencode run` and server mode) without TUI code.

Full mapping: [feature map](./feature-map.md).

## Non-goals

- OpenCode 1.x. It is excluded.
- Changing `packages/pi-cursor-sdk`, `packages/pi-cursor-cloud` or `packages/pi-ext`. No shared-code extraction until OpenCode parity is verified.
- A third package. TUI entries live inside the two packages.
- An HTTP OpenAI-compatible facade or a text-only Cursor model.
- Attaching to Cloud agents, resuming Cloud runs after a restart, or listing, polling or adopting remote agents. Completion receipts cover only completions this process observed.
- Env forwarding to Cloud agents.
- Weakening the Git preflight, for example by requiring `allow-local-state` in place of the probe.
- Exact Pi tidy cards inside the OpenCode transcript. 2.x has no transcript slot.
- Importing OpenCode internals, including the internal Claude Agent plugin.
- Reading, printing or copying Pi credentials.
- A guarantee for unseen breaking OpenCode releases. New releases are qualification targets.

## Constraints

- Phase 1 permits local reads, the artifacts listed in the [README](./README.md), and the repository's required install/build/test checks for the documentation commit. Those checks do not verify the port. No port implementation, OpenCode installs, port runtime probes, Cursor calls or live config changes.
- Runtime: OpenCode 2.x runs plugins in Bun (`bun@1.4.2` at 2.0.0, `bun@1.4.4` at 2.2.5). Under Bun, `@cursor/sdk` 1.0.37 loads a separate `connect-web` build that Pi's Node stack-matching heuristics skip. Native SQLite under Bun is unproven.
- `@cursor/sdk` is proprietary (© Anysphere Inc., use subject to Cursor's Terms of Service). The packages depend on it from npm and never vendor or re-bundle it. Publishing waits on a terms review.
- Backend and TUI plugins are separate entry modules and may run in separate processes. The backend owns all Cursor state and credentials. The TUI talks to it over plugin RPC and never runs its own Cursor client.
- Billable or destructive actions never run through prompt-template commands that a language model interprets.
- Loading a package has no silent side effects.
- After approval: branches only, no merges, no force push. Commits by `iury souza <iurysza@gmail.com>` with no trailers. Push, PR, live apply, external posting and paid runs each need a separate approval. The implementation handoff must name the repository path and worktree.
- Keep original MIT notices and provenance (`packages/pi-cursor-sdk/LICENSE`, Mitch Fultz). If history is imported, use `git subtree`, never submodules.

## Decisions

Accepted by Iury:

1. A new `opencode-extensions` repository with two installable packages.
2. OpenCode 2.0.0 onward. 1.x is excluded.
3. Local TUI equivalents now. A custom control adapter only if needed.
4. Cursor-native safety, clearly disclosed, with isolated tool-disabled helpers.

5. Approve the revised package (readback, intent, facts, feature map and plan), and implement it end to end. Plannotator Inbox message `msg_redacted`.

6. Grant the implementation repository path, worktree and local write scope listed in [goal autonomy](./goal.md#autonomy). Plannotator Inbox message `msg_redacted`.

## Assumptions

Each assumption is proposed. Iury can accept or reject each one.

- A1. The support floor is OpenCode 2.0.0 (`63f7ceec`). The peer range `>=2.0.0 <3` is a safety bound, and each new 2.x release is qualified before it is listed.
- A2. Auth uses the public `integration` `key` and `env` methods. The host-stored key wins over `CURSOR_API_KEY` on every surface.
- A3. Sensitive project-level overrides fail closed until OpenCode exposes a project-trust API.
- A4. Background Cloud keeps Pi's ownership rule. Only agents created by the current process can be cancelled or deleted.
- A5. Shutdown detaches from Cloud agents and never cancels them, matching Pi.

## Open gates

These do not block review. They block implementation, and the plan treats each as a gate.

- Does `@cursor/sdk` work under OpenCode's Bun, including native SQLite and the MCP timeout patch? (G1, T2.)
- Does our `aisdk` hook load in both registration modes and in either order against `DynamicProviderPlugin`? Can a pending MCP call survive re-entry, and can Cursor's MCP calls be correlated with its tool-call IDs? (G2.)
- Where does fork lineage come from, given that `model.request` does not carry it? (G3.)
- Does every request kind arrive with a valid stamp? (G4a.)
- Does the local `tools: []` helper lane really produce text only? (G4b, T2 and T3.)
- Can receipts plus `session.synthetic` deliver exactly once with no duplicate assistant turn, given that admission ignores text, every call wakes, and there is no `parentID`? (G5.)
- Does plugin RPC meet its authorization, binding, event and topology conditions? (G6.)
- Does Cloud behavior evidenced against `@cursor/sdk` 1.0.23 hold on 1.0.37? (G7.)
- Are the Cursor terms compatible with publishing? This plan does not assert it. (G8.)

Known research gaps are listed in the [plan](./plan.md#known-research-gaps).
