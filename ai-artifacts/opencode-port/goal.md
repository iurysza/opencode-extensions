# Goal

OpenCode 2.0.0 onward reaches end-to-end parity with Pi for Cursor: local Cursor SDK models, the SDK's foreground Cloud runtime, and background Cloud delegation. It ships as two packages, `@iurysza/opencode-cursor-sdk` and `@iurysza/opencode-cursor-cloud`, in a new `opencode-extensions` repository. Each gap from Pi is written down with an equivalent or an upstream dependency.

Status: **contract approved, location grant approved, M0 in progress**. This file is the canonical execution contract. Iury approved the revised Phase 1 package through Plannotator Inbox message `msg_redacted` ("Approve the revised package", "Try to implement this end to end").

## Contract

- [Intent](./intent.md)
- [Facts](./facts.md)
- [Fact metadata](./facts.meta.json)
- [Plan](./plan.md)
- [Dev log](./dev-log.md)

Context: [readback](./readback.md), [feature map](./feature-map.md), and [proposed facts](./proposed-facts.md), the reviewed draft kept as history.

## Autonomy

Location grant **approved** by Iury through Plannotator Inbox message `msg_redacted`. It authorizes local edits, pinned development dependency installs, builds, tests, offline SDK probes and local commits at the paths below. The Phase 1 planning copy in `~/dev/worktrees/pi-extensions/opencode-port/ai-artifacts/opencode-port/` is history; this worktree holds the canonical execution contract.

| Item | Granted value |
|---|---|
| Primary repository | `~/dev/personal/tools/opencode-extensions` |
| Worktree | `~/dev/worktrees/opencode-extensions/cursor-port` |
| Branch | `cursor-port` |
| Allowed | Local edits, dependency installs, builds, tests, offline SDK probes (T2), commits |
| Not allowed | Pushes, PRs, merges, publishing, live config changes in the home directory, paid or live runs (T3) |

This grant satisfies the [plan's authorization section](./plan.md#authorization). Push, PR, merge, publish, live apply, external posting and each T3 run still need separate approval. Commits use `iury souza <iurysza@gmail.com>` with no trailers.

## Done when

Every accepted fact, F-01 to F-63, is verified with recorded evidence in the dev log, at the proof tier its metadata names, across the plan's compatibility matrix. Every fact whose label includes a manual check, code or terms review, or a T3 run has that check explicitly completed and recorded. Each T3 run has its own approval. Gates G1 to G8 pass, or a failed gate is replanned with Iury. No gate is weakened.

Mock (T1) or offline (T2) results never count as live parity. A fact that needs a live or manual check is not done until that check has run.
