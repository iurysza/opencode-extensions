# Phase 1 verification

Verified on 5 November 2026. This is a documentation commit, not an OpenCode port implementation or a runtime compatibility claim.

## Document checks

- F-01 to F-63 each appear exactly once. No acceptance ID was removed or renumbered.
- The plan maps every fact to a milestone and retains G1, G2, G3, G4a, G4b, G5, G6, G7 and G8.
- Relative Markdown links and heading anchors resolve.
- The approval package targets OpenCode 2.0.0 onward. Earlier 1.x research and reviews are marked historical.
- The 2.0.0 tag is `63f7ceecbed2d7d9a627518d935dd963b9d4ac9f`. The 2.2.5 release tag is `9bbb8ce18c80f099e0e448775f59d965ead40a21`, distinct from the earlier dev snapshot.
- The completion contract retains busy-session, crash/restart, replay, payload mismatch, acknowledgment and intervening-prompt tests. None of these port tests has run.

## Repository checks

| Command | Result |
|---|---|
| `npm ci` | Passed. npm reported 3 pending install-script approvals; none was granted. |
| `npm run check` | Failed at the catalog check. All 76 findings concern machine-specific paths in ignored source caches or the preserved user brief. |
| `npm run typecheck` | Passed when run separately after the catalog failure. |
| `npm test` | Passed when run separately after the catalog failure. |
| `npm run check:packs` | Passed for 16 publishable workspaces. |

The catalog checker walks ignored and untracked files. Its findings are under `research/sources/` and in the user-owned `ai-artifacts-brief-oc1.md`; no finding names a document staged for this commit. The checker was not changed or bypassed. The combined check is not green.

Validation logs are local, git-ignored files under `research/npm-*.log` and `research/validation-status.log`. Home paths in those logs were normalized. The Cursor API key was removed from the validation processes' environment. No live-smoke command was run.

## Preserved boundaries

- Package code, manifests, the root lockfile, root ignore rules and validation scripts are unchanged.
- The user brief is unchanged, verified by its before-and-after SHA-256.
- Downloaded source repositories and validation logs are excluded from the commit. Pinned URLs and revisions in the reports preserve the source references.
- No OpenCode installation, new implementation repository, live configuration change, push or PR was made.
- Only this `ai-artifacts/opencode-port/` documentation package belongs in the commit. The unrelated `ai-artifacts/wtf/` files and user brief remain unstaged.
