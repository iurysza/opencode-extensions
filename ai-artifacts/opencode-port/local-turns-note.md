# Local turns handoff

## Implementation

Production `server.ts` now composes a local runtime. SDK and SQLite imports occur only on a stamped primary request. The adapter passes an explicit host-first API key, model selection, cwd, per-session SQLite store and `settingSources: []`. Helpers still refuse until G4b passes. It never resumes or adopts an agent ID.

`core/bridge.ts` exposes only function tools from the active request over a random-path loopback MCP endpoint. Each callback gets an independently minted `oc-bridge-*` ID. The V3 stream ends with a normal tool call; the next request validates that exact ID and tool name, resolves MCP, and drains the same SDK run. No bridge code executes host tools. Native calls use `cursor_*` names and provider-executed call/result pairs, with delta/step deduplication and bridge-echo suppression.

Abort and malformed continuation invalidate the agent, cancel its run, settle pending MCP calls with errors and close the listener. Public session get/context observations reset handles on fork, model, history divergence and completed compaction changes. Session queues serialize provider reentry.

## Public integration ports

- `createCursorPlugin({ local?, onLocalControls?, lanes?, models? })`. Existing scripted `lanes` injection still works. `local.loadSdk` injects `LocalSdkPort`; tests use no real SDK.
- `createLocalRuntime(deps)` returns `{ source, controls }`, exported by `server.ts`.
- `LocalControls.status(sessionID)` returns `{ active, pending, generation }`; `reset(sessionID)` cancels and invalidates; `dispose()` shuts down local ownership.
- `composeLocal(ctx, options)` returns `{ lanes, controls, dispose }`. `resolveHostKey(ctx, env)` uses public integration methods only.
- No fast/mode/config/resume-cleanup actions are implemented by these controls. RPC must report them unavailable rather than pretend success.

## Evidence

`node packages/opencode-cursor-sdk/test/bridge/run-host.mjs` passes 14 isolated real-host scenarios on 2.0.0 and 2.2.5. Optional positional arguments select versions. Fixture: `test/bridge/fixture-plugin/server.js`, without an extra manifest. Evidence: `.fixtures/bridge/<version>/<scenario>/summary.json`, `bridge.jsonl`, `run.out`, `run.err`, `export.json`.

Each host covers permission allow/deny, native/bridge mixing, one send across reentry, native-name and SDK-ID collisions, missing/malformed/wrong-ID/wrong-name results, and interrupted pending tools. Empty host output becomes OpenCode's `(no tool output)` text; unit tests also cover genuinely empty V3 output. Permission failures arrive as text JSON envelopes and retain MCP error status. Minimum-host fixtures use built-in read permissions because 2.0.0 has no `permission.assert`.

Final scoped checks passed: package typecheck against minimum/latest contracts, package build, and 256 package unit tests at the time of this run. The bridge runner passed all 14 scenarios again after the final production changes. Other workers contributed some tests in that package total. Root checks belong to the parent after writers settle.

## Remaining qualification

G2 remains open for the full compatibility matrix, both real-host hook orders, hostile/non-loopback and disposed-route probes, and the full negative native-stream failure matrix. Durable resume, disk model-cache qualification, live SDK execution, the long MCP timeout, helper safety and complete lifecycle controls remain gaps. Model discovery is request-only with in-memory caching and bundled real fallback IDs. No live calls, credential files, live config changes or commits were made.

## Local security followup

The local runtime now buffers possible API-key prefixes across text and thinking callbacks before emitting anything. It preserves mismatched ordinary prefixes, masks complete keys, and conservatively masks incomplete prefixes at completion, errors, bridge splits, replacements, abort and reset. Cumulative step/final text uses the same redactor. Native and bridge argument values, property names, tool names and native results use structural redaction rather than serialized-JSON replacement. Late callbacks cannot revive a cancelled run.

Acquisition checks now follow async key lookup, session inspection, SDK loading, model discovery, bridge startup, store opening and agent creation. Shutdown or abort prevents subsequent create/send operations. A late-created agent closes without entering the session map, its store disposes, and preparation bridges close even while creation remains deferred.

Verification after these changes:

- Local auth/runtime/security tests: 41 passed. Security tests iterate every two-callback split, one-character/cross-channel streams, empty finals, step/final echoes, errors, replacements, bridge splits, followup/reset, metadata and six deferred acquisition boundaries under both shutdown and abort.
- Scoped minimum/latest typechecks and build passed.
- Isolated bridge runner: 14/14 passed again on 2.0.0 and 2.2.5.
- The latest package suite passed 277/278. Its one failure is the integration-stage load-boundary guard rejecting transitive `@opencode/schema/*` imports through public `@opencode/plugin`. Reported to the parent/integrator; this followup does not modify composition or relax that guard. Before concurrent integration, the package suite passed 278/278.

No real SDK execution, credentials, manifests, live configuration or commits were used. Foreground Cloud and TUI composition remain with the integration owner.
