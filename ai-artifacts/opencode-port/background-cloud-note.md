# Background Cloud implementation

## Scope

The new production entry is `packages/opencode-cursor-cloud/src/server.ts`. Its default definition attaches completion receipts, recovers receipts only, registers the host `cursor` key method, and installs four fixed tools through public `tool.transform`. Loading the entry imports no Cursor SDK or TUI code and performs no Git, credential, or network operation.

`core/cloud-service.ts` exposes `spawn(sessionID, params)`, `send(sessionID, id, prompt)`, `status(sessionID, id?)`, `cancel(sessionID, id)`, `delete(sessionID, id, confirmed)`, and `dispose()`. Actions return a tagged `Result`. Successful replies contain text, session-filtered agent snapshots, and receipt diagnostics. `createCloudPlugin({ serviceReady })` exposes the same backend owner to a later control adapter.

The state reducer, SDK event mapping, GitHub repository parser, ref inference, and text rendering come from Pi. As the parent clarified, accepted F-34 wins over the stricter initial brief: tracked current branches are inferred, while untracked and detached branches fall back to `main`. Explicit repositories work outside Git. Launch notices exclude local, uncommitted, and unpushed commits.

Jobs capture the originating session before asynchronous work. Follow-ups reserve `starting` synchronously. Old callbacks and duplicate terminal events cannot settle a later run. A terminal result awaits `receipts.submit({ sessionID, agentId, runId, text })`. Failed or held receipts leave status diagnostics and the result, without a fallback synthetic notification. There is no remote adoption, attach, listing, polling, or agent recovery.

Shutdown closes handles and rejects new actions. A create that resolves after shutdown closes its handle without sending, cancelling, or deleting. That can leave an unused remote agent, matching Pi's detach-only rule. Delete is available to user commands as `/cloud-delete <id> --confirm`, never as a model tool. Active agents cannot be deleted.

## Initial evidence

All commands ran from the target OpenCode worktree, with no real Cursor calls.

- `npm run build -w packages/opencode-cursor-cloud`: passed.
- `npm run typecheck -w packages/opencode-cursor-cloud`: passed. New compile-time assertions assign the production plugin and context against both public 2.0.0 and 2.2.5 types.
- `npm test -w packages/opencode-cursor-cloud`: 76 tests passed across eight files, including 32 new background Cloud tests.
- `node packages/opencode-cursor-cloud/test/t1/run-cloud-tools.mjs`: passed on pinned OpenCode 2.0.0 and 2.2.5. Evidence is in `.fixtures/cloud-tools/<version>/summary.json`, `tools.jsonl`, and `run.out`.

The real-host fixture uses the built production tools, service, and receipt adapter with an injected fake Cloud client and the SDK package's scripted provider. Both hosts execute all four tools, reject a busy follow-up, report running and terminal status, request cancellation once, and submit one completion to the originating session. The shared isolation wrapper supplies `env -i`, isolated HOME/XDG, positive EPERM checks, and a loopback-only sandbox. No shared fixture or harness was edited.

Unit coverage includes shutdown during create and send, deletion reservations, stale streams, receipt failure and rejection, session and location binding, immutable snapshots, fixed SDK errors, literal-key redaction, host-key precedence, and default-entry load isolation. This is T1 evidence, not live Cloud parity or completion of the separate G5 gate.

## Initial integration handoff

No manifests, root lockfile, existing receipt modules, completion adapter, receipt tests, control modules, or dev log were edited by this worker.

The integrator must add the normal runtime dependency `"@cursor/sdk": "1.0.37"` to the Cloud manifest and update the root lockfile. Public type imports and the lazy `import("@cursor/sdk")` are already visible in `core/cloud-client.ts`; they are not hidden behind an alias. Compilation used the existing root development installation.

At the initial handoff, the layout guard rejected every Cloud SDK dependency as premature. Replace that obsolete rule with an exact 1.0.37 dependency check and retain the two-package and private-root checks. Do not suppress the import or bypass the guard. This worker does not claim a root `check` result.

Expose `".": "./dist/server.js"` and `"./server": "./dist/server.js"` in the Cloud package exports. Existing completion and receipt exports remain. The existing `tsconfig.build.json` includes all new source modules, so no build configuration change is needed. Add `node test/t1/run-cloud-tools.mjs` to the desired host-test script without dropping the receipt runner. The fixture directory needs no package manifest.

RPC and TUI integration remain with their owners. Bind their caller scope before invoking this service. No generic HTTP tool runner was added.

## P1 split-key remediation

Review `82b9012f` reproduced a credential leak when two text deltas held consecutive halves of the configured key. The reducer joined them, and an empty final SDK result let that text reach status metadata and durable completion receipts.

`core/cloud-client.ts` now creates a known-key sanitizer for each run. It emits useful text immediately and retains only the longest suffix that could become the key, bounded by `key.length - 1` characters. Complete matches become `[redacted]` before any stream event reaches the reducer. A replacement discards the superseded pending prefix and sanitizes the new snapshot. Follow-ups get fresh sanitizer state.

Completion, failed send, failed wait, successful cancellation, and handle close seal the run against later callbacks before flushing a harmless incomplete prefix. This preserves ordinary trailing text without allowing it to join a later chunk. The completion flush occurs before `cloud-service.ts` reads its empty-result fallback. No service or receipt implementation change was needed.

`test/unit/cloud-stream-redaction.test.ts` adds 113 deterministic fake-SDK cases. Every key split boundary is covered for in-flight status, empty-result fallback, persisted receipts, step replacement, and follow-up reset. Additional cases cover character-at-a-time output, normal-text progress, tool progress during buffering, empty replacement, failed send and wait, cancellation, close, and late callbacks. The first 75 regression cases all failed before the adapter change. All 113 pass afterward.

Verification at the split-key handoff:

- `npm test -w packages/opencode-cursor-cloud`: 189 tests pass across nine files.
- Targeted strict `tsc --noEmit` over the new regression file, plugin contract tests, and minimum/latest receipt type contracts: passes.
- The unchanged `test/t1/run-cloud-tools.mjs` fixture passes on isolated OpenCode 2.0.0 and 2.2.5. The emitted adapter contains the new sanitizer.
- Whole Cloud `build` and `typecheck` were attempted but are temporarily blocked by the unrelated `src/tui/index.ts:44` renderer type error. The parent routed that error to its owner. These commands are not reported as passing for this remediation.

Only the owned client, new regression test, and this note changed for the P1 fix. There were no real SDK calls, external network requests, commits, manifest edits, control edits, or receipt edits. The metadata owner has separately handled the SDK dependency and layout guard; this remediation requires no packaging change.

## P1 terminal-normalization ordering remediation

The bounded follow-up review found that a terminal sequence between two key halves escaped literal matching. Later `formatCompletion` cleanup removed that sequence and reconstructed the key in a durable receipt.

The client now imports the renderer's pure `cleanText` helper and normalizes terminal text before streaming key matching. A per-run terminal buffer retains incomplete ESC and CSI tails across callbacks, including a callback ending in ESC alone. Replacements discard superseded terminal fragments. Ordinary normalized text remains incremental. Unterminated fragments longer than 4096 characters become a stable visible marker, bounding buffering without creating text that later cleanup could remove to reconnect key halves.

Terminal SDK result text, branch metadata, and tool activity also pass through `cleanText` before known-key redaction. On termination, the client normalizes pending terminal fragments, flushes the sealed key sanitizer, and re-redacts the complete cleaned snapshot. An empty SDK result uses that safe private snapshot at the client boundary. Failed waits and failed sends likewise flush a safe replacement before the service reads its fallback. No key was added to service, RPC, or status interfaces, and no service, composition, rendering, or receipt implementation was edited.

The regression file now has 191 security tests, preserving the previous 113. It covers ANSI at every key split, every callback split inside a CSI sequence, all control characters removed by the renderer, character-at-a-time escapes, empty-result fallback, in-flight status, durable receipts, terminal SDK results, branch metadata, replacement and follow-up reset, incomplete ESC tails, tool progress, failed waits, and bounded malformed fragments. Before the fix, all 76 initial ordering regressions failed while the previous 113 still passed. All 191 expanded cases now pass.

Scoped verification after this fix:

- `npm run build -w packages/opencode-cursor-cloud`: passes.
- `npm run typecheck -w packages/opencode-cursor-cloud`: passes for minimum and latest host contracts.
- `npm test -w packages/opencode-cursor-cloud`: 269 tests pass across ten files.
- `npm run test:hosttools -w packages/opencode-cursor-cloud`: passes on isolated OpenCode 2.0.0 and 2.2.5 with the unchanged fake-client fixture.

Only `core/cloud-client.ts`, its existing regression test file, and this note changed in this remediation. Tests use a synthetic fixture key and injected fake SDK objects. No real SDK calls, external network requests, commits, manifest edits, or root checks ran.
