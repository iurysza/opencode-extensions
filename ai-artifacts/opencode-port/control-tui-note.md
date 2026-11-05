# Control and TUI integration

## Stable ports

Each package owns an independent `src/control-contract.ts` and `src/plugin/control-rpc.ts`. Production imports only public OpenCode exports. No Cursor import, credential read, tool dispatch or shell runner enters these modules.

```ts
const registration = await registerControls(ctx, actions);
await registration.publish(scope); // scoped status invalidation after an external state change
await registration.dispose();       // abort actions, stop publishing, unregister RPC
```

`createControls` aliases `registerControls`. The context uses public `rpc`, `location` and `session` ports. Each call rechecks `ctx.session.get({ sessionID }, { signal })`, its returned ID and directory against the backend location. Caller paths never become filesystem operations. Both caller and backend workspace IDs fail closed. Attached local backends are allowed.

`ControlActions` is a mapped optional action table. Each callback receives its parsed input and an `AbortSignal`, and returns `Promise<SnapshotInput | void | ActionRefusal>`. Omitted callbacks return `not_implemented`. Return `{ refused: "scope" }` for resource ownership failures, or `{ refused: "unavailable" }` for unavailable service operations. Raw exceptions become a fixed failure without copying messages. Every agent or ledger action must enforce ID ownership within the verified session. Verification does not make a globally indexed agent belong to that session.

SDK actions:

- Read-only `status`, `models`, `ledger`: `{ scope }`.
- `archive`, `delete`: `{ scope, id, confirmed: true }`. Both have native confirmations. Archive was tightened at the integrator's request.
- `runtime`: `{ scope, runtime: "local" | "cloud", acknowledgement? }`. Cloud requires the exported `REMOTE_ACK` literal. The TUI displays remote execution, billing, persistent session scope and the fact that switching local does not stop existing agents.
- `fast`, `resumeCleanup`: `{ scope, enabled }`; `mode`: `{ scope, mode: "agent" | "plan" }`; `tools`: `{ scope, tools: "native" | "bridge" | "both" }`; `http`: `{ scope, http: "auto" | "http1" }`.
- `refreshModels`, `refreshConfig`: `{ scope }`.

Background Cloud actions:

- Read-only `status`, `models`, `ledger`: `{ scope }`.
- `spawn`: `{ scope, prompt, repository, model? }`, bounded GitHub HTTPS repository and 16,000-character prompt.
- `followup`: `{ scope, id, prompt }`.
- `cancel`, `delete`: `{ scope, id, confirmed: true }`, each with a native confirmation.

`scope` contains `sessionID` and `location.directory`, plus optional `location.workspaceID`. Use the parsed callback scope, not a global session selection. Map background service `send` to `followup`, and session-filtered `status` to `ledger`. Use `LocalControls.status(sessionID).pending` to distinguish a live run from idle. Its `active` field means an agent is pooled, which can be idle. Do not map reset to a nonexistent settings action. Missing fast/mode/tools/http/resume-cleanup/refresh functionality must stay unavailable until implemented.

`SnapshotInput` accepts optional `state`, `runtime`, `items`, `fast`, `mode`, `tools`, `http`, `resumeCleanup`. Items are `{ id, state }`, at most 100. States are `idle | running | finished | failed | cancelled | archived | unknown`. Model IDs can use items with state `unknown`. Project service replies into these fields; do not forward text, prompts, URLs, credentials or raw errors. Unknown fields are dropped; invalid or secret-like identifiers fail the output. Events contain only verified scope and `state: "changed"`.

## TUI entry and peers

Both `src/tui.ts` wrappers export the default definition, `createTui` and `createTuiControls` from `src/tui/index.ts`. Export `./tui` as `./dist/tui.js`. Directory-based host loading can use `package: /absolute/package/dist`, alongside `dist/server.js`.

The UI uses public `@opentui/solid` `createElement`, `insert`, `setProp`, and its JSX type. Development types are 0.8.0; the host shares its own renderer instance. These imports are UI-only. The native factory returns `BaseRenderable`, while its JSX alias uses Solid's DOM element type; one documented `unknown`-to-JSX cast isolates that declaration mismatch, without `any`.

Keymaps register inside an `app` slot render with `mode: "global"`, matching host command plugins. Setup-root registration fails on 2.0.0, and base-mode commands are not discoverable from the prompt. Native footer text needs a text node; a plain string crashes under the footer box. Cursor leader categories live under `<leader>z c`, because the host reserves `<leader>c` for compact. There are no prompt templates. Cleanup aborts RPC calls/subscriptions and releases both slots.

## Verification

Run from the repository root:

- `node packages/opencode-cursor-sdk/test/control/run-host.mjs 2.0.0 2.2.5`: covers **both** packages. Compiles only owned control/TUI files into `.fixtures/control-build`, then runs isolated actual servers. Both versions passed authorization, fixed methods, bounds, session/location/remote refusal, cross-session agent refusal, output projection, honest unavailable actions, two-client public RPC event delivery and Effect-interruption-to-action abort. There is no separate Cloud runner.
- `node packages/opencode-cursor-sdk/test/control/run-tui.mjs 2.0.0 2.2.5`: actual terminal-control keyboard/rendered tests with fake backend actions, both standalone and attached-local. Native status, keyboard RPC, runtime disclosure, declined-runtime non-mutation, pushed status, honest unavailable actions, Cloud cancel/delete confirmations, and foreground archive confirmation passed in all four endpoint/topology combinations. These are rendered TUI proofs, not fake-context tests. The fixtures need no package manifests.
- Targeted Vitest: both `test/unit/control-rpc.test.ts` files, 12 tests passed, including action refusals, reply bounds and post-disposal non-execution.
- Both packages' `test/control/tsconfig.min.json` and `tsconfig.latest.json` files compile the actual production modules and TUI wrappers against public 2.0.0 and 2.2.5 exports. Both package build-type checks pass. The earlier `LocationPublicRef.workspaceID` and native renderer type errors are fixed.

Evidence is under `.fixtures/control-host/<version>/` and `.fixtures/control-tui/<version>-<topology>/`, including summaries and native screen text. All hosts use isolated HOME/XDG, `env -i`, positive EPERM checks and loopback-only sandboxing. No model prompt, Cursor SDK operation, live configuration or real credential is used. Attached-local tests use generated disposable host passwords. All terminal sessions and server groups are stopped after testing. Endpoint G6 transport and attached-local TUI behavior are proven with fake action owners; root verification, intermediate OpenTUI lines and live-action parity remain with the parent/integrator.
