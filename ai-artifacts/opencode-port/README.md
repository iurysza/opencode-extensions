# OpenCode port of Cursor SDK and Cursor Cloud

Status: **contract approved; location grant approved; M0 in progress**. Iury approved the revised package through Plannotator Inbox message `msg_redacted` and granted the implementation location and local scope through `msg_redacted` (see [goal autonomy](./goal.md#autonomy)). At the start of M0, no port implementation, runtime probe or Cursor call had run; the [dev log](./dev-log.md) records progress since. The 2.x evidence is source reading at pinned tags, not runtime proof.

## The point

Build two packages in a new `opencode-extensions` repository so OpenCode 2.0.0 onward can use Cursor models, the SDK's foreground Cloud runtime and background Cloud agents as completely as Pi does today. Cursor runs its own native tools, and OpenCode records them without running them again. OpenCode's own tools reach Cursor through an MCP bridge that keeps OpenCode's permission flow. Background completions arrive through `session.synthetic` with durable receipts. TUI commands reach the backend through public plugin RPC.

Every risky assumption is a gate with a proof tier: mock (no SDK code), offline real-SDK probe (no external network), or live (paid, separately approved). Release gate G8 covers the proprietary `@cursor/sdk` terms.

## Read in this order

1. [Goal](./goal.md): the approved outcome, the contract links, the granted location and the done condition.
2. [Readback](./readback.md): what I think you asked for, and what you already decided.
3. [Plan](./plan.md): compatibility policy, proof tiers, gates G1 to G8, milestones and authorization.
4. [Facts](./facts.md) and [fact metadata](./facts.meta.json): accepted F-01 to F-63 and their verification labels.
5. [Feature map](./feature-map.md): each Pi feature with its OpenCode 2.x equivalent or gap.
6. [Intent](./intent.md): scope, non-goals, constraints and assumptions.
7. [Dev log](./dev-log.md): execution progress and evidence.

## Evidence

- [OpenCode 2.x boundary report](./research/opencode-v2-boundary.md): all 44 `v2.*` tags, pinned citations. v2.0.0 is `63f7ceec`. v2.2.5 is tag `9bbb8ce1`, not the `dev` snapshot `893e8dc4`, which reports 2.2.5 but differs.
- [Pi Cursor SDK report](./research/pi-cursor-sdk.md)
- [Pi Cursor SDK Cloud settings report](./research/sdk-cloud-settings.md)
- [Pi Cursor Cloud report](./research/pi-cursor-cloud.md)
- [SDK tool-controls source note](./research/sdk-controls.md): published `@cursor/sdk` 1.0.37 declarations, not a runtime test

## Verification

[Phase 1 verification](./verification.md) records the document checks and repository checks. Type checks, tests and pack checks passed. The combined check failed on paths in ignored source caches and the preserved user brief. These checks do not prove OpenCode runtime compatibility.

## Historical

These record earlier rounds. They are superseded and kept as evidence.

- [OpenCode API report](./research/opencode-api.md): studied 1.18.33. Its `parentID` and `promptAsync` delivery design does not apply to 2.x.
- [First review](./review.md): reviewed the 1.x plan.
- [Proposed facts](./proposed-facts.md): the reviewed draft of F-01 to F-63, with the original verification table. [Facts](./facts.md) is the accepted copy.
- [Opus 2.x review](./review-opus-v2.md): its claims that a different payload raises a conflict, and that a hashed ID gives exactly-once delivery, are wrong. See the boundary report §4.

Source clones under `research/sources/` are local evidence caches. They are git-ignored and never committed.

## Not in this package

No implementation code. Code lives in this repository's `packages/`. The Phase 1 [verification](./verification.md) record and the user-owned `ai-artifacts-brief-oc1.md` refer to the old planning worktree, `~/dev/worktrees/pi-extensions/opencode-port`.
