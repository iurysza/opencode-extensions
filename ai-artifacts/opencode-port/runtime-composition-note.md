# Runtime composition handoff

Changes remain uncommitted. This worker changed only the assigned integration files, new scoped tests, preview script, and documentation. The parent transferred the Cloud plugin disposal assertion and SDK load-boundary guard explicitly. The parent later transferred root and child package scripts. SDK `test:control`, `test:tui`, and `test:composition` now have root aggregators. No dependency, lockfile, provider-runtime, stream, bridge, foreground core, Cloud client, TUI, or fixed-control implementation was edited.

## Production ports

`createCursorPlugin()` lazily imports `plugin/runtime.ts` during setup. Its default entry composes the real local adapter, fresh foreground Cloud source, host storage, and fixed RPC. `createCursorPlugin({ lanes })` remains the legacy scripted seam and needs no Cloud or RPC implementation in mock contexts. Options retain `local`, `models`, and `onLocalControls`; `foreground` injects only external factory, Git inspection, and selection boundaries for T1.

`composeRuntime(ctx, options)` returns `{ lanes, controls, foreground, getConfig, dispose }`. `controls` is the existing local controller, including reset. Primary routing uses the pure resolved runtime. Helpers remain unavailable. The composition checks `controls.status(sessionID).pending`, not pooled-agent existence. A successful switch resets idle local ownership only after its durable write. Reads never import the SDK or start work.

Settings and foreground ledger use public `ctx.storage`, and session verification uses public `ctx.session.get`. The user defaults key is `settings:user:v1`; session settings use `settings:session:v1:<sha256(sessionID)>`. The session control persists only runtime and explicit acknowledgment. Project options are untrusted. The composition ignores environment and user-config acknowledgment, requiring verified RPC consent persisted in the host session record. Invalid explicit settings fail before routing or mutation. `refreshConfig` rereads and validates storage and project options; environment values are captured at setup.

Foreground archive and delete call the same source's confirmed cleanup. The control owner supplied the archive confirmation schema. Models report fallback IDs without network. Fast, mode, tools, HTTP, resume cleanup, and model-cache refresh remain `not_implemented`. Foreground selection validates the bundled catalog, accepts the host's default variant, and refuses unknown parameters or variants.

Cloud `createCloudPlugin()` binds fixed RPC directly to its existing service. Tools, commands, and RPC share the same client, process-owned agent map, and completion receipts. A new optional service `onChange(sessionID)` callback publishes safe state-change events without coupling core code to OpenCode. Reads have no state side effects. Cloud RPC models report `composer-2.5` as a fallback, never call a second client.

Shutdown disposes local ownership and RPC, and shuts down foreground handles. Cloud shutdown remains detach-only. Entry imports stay SDK-, TUI-, and network-free. The SDK load guard now separates forbidden direct project imports from the public plugin's own transitive dependencies.

## Evidence

At the latest verification snapshot:

- Both package builds passed.
- Both public minimum and latest type contracts passed.
- SDK unit suite passed 284 tests and Cloud passed 269 at the latest snapshot. Other owners contributed tests in those totals.
- `node packages/opencode-cursor-sdk/test/integration/run-composition.mjs` passed on isolated actual OpenCode 2.0.0 and 2.2.5. It loads both production composition roots with fake external SDK and Cloud factories only. Evidence is `.fixtures/composition-host/<version>/summary.json`, `actions.jsonl`, `server.out`, and `probe.out`.
- The host probe verifies local then foreground routing, actual `session.generate` helper refusal, failed acknowledgment persistence before create, host authorization, cross-scope refusal, confirmed ledger cleanup, honest unavailable controls, shared Cloud service ownership, public client state pushes, and a durable completion receipt.
- Composition unit tests cover active foreground disposal without auto-cancel and shared tool/RPC ownership. Host helper requests are aborted after observing the fixed refusal, because 2.2.5 retries that error. This is not a claim that helper safety or host retry policy is qualified.
- `node scripts/home-preview.mjs` and `--write` ran without launching OpenCode. The saved config was mode `0600`, SDK-only. The printed command removes inherited runtime and acknowledgment environment selectors. `--include-cloud` is an explicit billing-warning opt-in.

No real Cursor SDK calls, external network calls, live configuration writes, commits, or publication occurred. Parent combined verification is still required.

## G6 and beta gaps

RPC adapters propagate AbortSignal to public session verification and reject pre-dispatch aborts. Local and foreground model requests receive the real abort signal. Background service actions and foreground cleanup expose no signal parameter, so in-flight create, cancel, and delete cannot be declared cancelable. No RPC abort automatically cancels remote work. SDK create itself is uncancelable through these ports.

The control owner separately passed actual rendered standalone and attached-local endpoint tests with fake action owners. See [control evidence](./control-tui-note.md). This composition run does not repeat that walkthrough. Real-host composition disposal was not invoked as a host lifecycle scenario; the active-run detach assertion is unit evidence. Full compatibility, durable local resume, model-cache persistence, complete local setting adapters, live timeout behavior, G4b, G7, and G8 remain open. This handoff does not claim release readiness or live parity.


## Generated-path correction and default-entry load proof

The preview now generates absolute `packages/opencode-cursor-sdk/dist` and optional `packages/opencode-cursor-cloud/dist` targets. A filesystem directory target is probed for `server.js` and `tui.js` directly, not resolved through package-root exports. The earlier package-root target was wrong.

- `node --test scripts/home-preview.test.mjs`: 3 tests passed. They check exact dist paths, SDK-only default, explicit Cloud warning, mode `0600`, no auth fields, no credential reads, and tripwires for process launch, SDK imports, and network access.
- `node packages/opencode-cursor-sdk/test/integration/run-preview-load.mjs`: all 4 cases passed, local-only and Cloud opt-in on actual OpenCode 2.0.0 and 2.2.5. Each case runs the actual generator, clones only its config into isolated HOME/XDG, and loads the actual default entries. No fixture plugin, factory injection, prompt, generate request, credential, or SDK operation is used.
- The loopback-only sandbox additionally denies reads of the real SDK directory, with a positive EPERM probe before startup. Successful public session creation and read-only status/models RPC show registered controls, local idle state, fallback models, and optional empty owned Cloud status while SDK loading is blocked.

Evidence is `.fixtures/preview-load-local-only/<version>/` and `.fixtures/preview-load-with-cloud/<version>/`, including `summary.json`, generated config, `generator.out`, `sdk-denial.txt`, `probe.out`, and redacted `server.out`. This proves default-entry loading without model work, not live Cursor behavior.
