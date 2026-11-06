# Foreground Cloud runtime

Implemented within `opencode-cursor-sdk/src/core/cloud/**` and `src/plugin/cloud-runtime.ts`. No background Cloud, bridge, provider, RPC, TUI or manifest wiring changed.

## Integration API

Import from `src/plugin/cloud-runtime.ts`:

- `createForegroundCloudSource(deps)` returns a callable `CursorTurnSource` with `list(sessionID)`, `cleanup(sessionID, bcID, "archive" | "delete", { confirmed })`, and `shutdown()`.
- Required dependencies: `cwd`, `getConfig(sessionID)`, `getApiKey(sessionID)`, `isLocalRunPending(sessionID)`, and `store`. Optional dependencies: `selection(request)`, `loadAgentFactory()`, `inspectLocalState()`, `cancelTimeoutMs`.
- `getConfig` returns raw `ResolveCursorSdkConfigOptions` layers. `cli` means an explicit one-shot host control, not a new OpenCode CLI flag. Pass the intended environment snapshot. Project acknowledgment never authorizes Cloud; sensitive project overrides fail closed. Ambient environment alone cannot grant the local-state bypass.
- `createHostForegroundCloudStore(ctx, sessionExists)` adapts public `ctx.storage`. Supply `sessionExists` using public `ctx.session.get`; lookup failures must reject. Store writes must resolve only after persistent storage succeeds. No SDK database is used.
- Supply async `selection` from the validated model catalog for variants and parameters. The same selection reaches create and send. Without it, only a plain model ID is accepted.
- Route primary requests here only when the resolved runtime is Cloud. Keep helper requests local. Bind local pending-run detection, integration-key-first credential lookup, and shutdown through the existing owner.
- Bind acknowledgment UI to `acknowledgeForegroundCloud({ confirm, persist })`; persist the patch in user/session host settings. Declining or headless acknowledgment writes nothing.

## Behavior and evidence

Each turn creates a fresh agent. Prepared storage precedes create; agent ID precedes send; run ID precedes wait. Failed run persistence attempts bounded cancellation. Cleanup is session-owned, intent-first, and pending intents block retries. Shutdown only closes local handles. Streams/reporting redact credentials and terminal controls; usage remains text-only. Bootstrap includes textual tool history but excludes local skill/question guidance. Unsupported image/file content fails explicitly.

Passed SDK scoped build and both host typechecks against public SDK 1.0.37. Passed 170 fake/local-fixture Cloud tests, including 107 ported strict Git cases. No real SDK execution or network calls occurred. Provider/RPC/TUI integration, real-host storage durability evidence, artifact fetching, and live G7 Cloud requalification remain unverified.

Review fix: shutdown/abort during deferred selection prevents creation after release. Both regressions failed before the guard; ordinary selection passes. Other pre-create awaits remain guarded.
