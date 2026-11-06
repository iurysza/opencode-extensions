# Receipt persistence review fix

Implemented in `~/dev/worktrees/opencode-extensions/cursor-port`, base `3171bbb`. Changes remain uncommitted.

## Changed files

- `packages/opencode-cursor-cloud/src/core/receipts.ts`
- `packages/opencode-cursor-cloud/src/plugin/completion.ts`
- `packages/opencode-cursor-cloud/test/unit/receipts-races.test.ts`
- `packages/opencode-cursor-cloud/test/unit/receipts-delivery-storage.test.ts`
- `ai-artifacts/opencode-port/receipt-final-note.md`

`receipt.ts` and its validated-admission guard are unchanged. No manifests, lockfiles, shared isolation code, fixture plugin entries, or dev log edits belong to this worker.

## Behavior

Eligible delivered-event evidence clears only after a successful durable delivery write. The adapter reports failed event updates and continues subscribing. Reconciliation retries persistence without another admission.

A small process-local map retains validated admission responses until their result write succeeds. This also covers delivery arriving during the failing write. Event transitions still call `markDelivered` with validated admission. Unattempted receipts, mismatched identities or text, and failed host calls gain no event authority.

Pending evidence is not crash-durable. If the process stops before persistence and history disappears, existing recovery holds the durable intent as `uncertain-attempt` with a diagnostic. It never readmits blindly.

## Evidence

Before implementation, the deterministic adapter regression failed twice: diagnostics were `[]`, and reconciliation after hidden history returned `admitted` with `delivery: null`. The original 32 tests passed in that same run.

Final checks passed:

- `npm run build --workspace=@iurysza/opencode-cursor-cloud`
- `npm run typecheck --workspace=@iurysza/opencode-cursor-cloud`, both 2.0.0 and 2.2.5 public type contracts
- `npm test --workspace=@iurysza/opencode-cursor-cloud -- --reporter=verbose`, 51 tests including 39 receipt tests and 12 sibling lifecycle tests
- `node --test scripts/check-layout.test.mjs` and `node scripts/check-layout.mjs`
- `npm run test:host --workspace=@iurysza/opencode-cursor-cloud`, 16 scenarios per host on 2.0.0 and 2.2.5, all invariants true, no orphan processes

Host summaries are `.fixtures/receipts/2.0.0/summary.json` and `.fixtures/receipts/2.2.5/summary.json`. Host tests used the existing isolated HOME/XDG and loopback-only sandbox. No real Cursor calls ran. The new storage-failure regression is adapter-level unit evidence, not an added real-host scenario.

The first package build and typecheck encountered sibling `src/core/repo.ts:11` TS2532. Its owner fixed it; final package checks passed. No sibling file was edited here.
