# Dev Log

Status: M0 in progress. No gate or milestone has passed.

## Contract approval

- Iury approved the revised Phase 1 package through Plannotator Inbox message `msg_redacted`. He wrote "Approve the revised package" and "Try to implement this end to end".
- The goal contract was finalized in this directory: [goal](./goal.md), [facts](./facts.md) and [fact metadata](./facts.meta.json). The facts reproduce F-01 to F-63 from the [reviewed draft](./proposed-facts.md) word for word.
- The implementation location and write scope were pending at that point. They are granted below.

## 2026-11-05: location grant

- Iury granted this worktree (`~/dev/worktrees/opencode-extensions/cursor-port`, branch `cursor-port`) and local write scope in Inbox message `msg_redacted`. Local edits, pinned development installs, builds, tests and offline probes are allowed. Only the lead commits. Pushes, PRs, publishing, live home configuration changes and live or paid Cursor calls are not allowed.
- Copied the Markdown and JSON contract documents and `.gitignore` from the old planning worktree. No source caches or logs were copied. The old `goal.md` and `README.md` now point here.

## 2026-11-05: G5 revision approved

- Iury approved the G5 revision in Inbox message `msg_redacted`: "Revise G5 to deduplicated notifications, conservative recovery and explicit unknown answer status, but be pragmatic."
- F-31 and F-58 in `facts.md` and `facts.meta.json` now guarantee plugin-controlled deduplicated notifications, not exactly-once assistant execution. Receipts, IDs, text hash, session binding and no blind replay stay. The host may rerun interrupted model work on restart. Admission and delivery stay separate. Answer status is `unknown` without direct evidence. No provider-specific stamping or correlation. All other facts are unchanged. Plan G5 and receipt wording follow. Evidence: [g5-correlation-limit](./research/g5-correlation-limit.md).
- No G5 code exists yet.

## 2026-11-05: first M0 slice (workspace and T1 provider harness)

Done:
- Private npm workspace with exactly `@iurysza/opencode-cursor-sdk` and `@iurysza/opencode-cursor-cloud` (Cloud is an empty placeholder for M4). One root lockfile. `npm install --ignore-scripts`.
- SDK package: fail-closed host parser (`src/compat/host.ts`), provider registration that uses `catalog.*.update` before 2.0.4 and `provider.add` from 2.0.4 (`src/compat/provider-registration.ts`), host-neutral turn events and a pure V3 stream translator (`src/core`), a `LanguageModelV3` (`src/provider`), and `sdk` plus `language` hooks scoped to provider `cursor`. The default entry fails closed with a fixed error. It imports no `@cursor/sdk`.
- Type contracts compile against `@opencode/plugin` 2.0.0 and 2.2.5.

Validation:
- `npm run check`: layout ok, typecheck ok against both host versions, 23 unit tests pass. The unit tests use hand-written fake hosts. They are not real-host proof.
- Real-host T1 (`npm run test:host`): pinned `opencode` CLI binaries 2.0.0 and 2.2.5, `env -i`, isolated HOME and XDG under `.fixtures/t1/<version>`, and a macOS sandbox that denies non-loopback network and reads of real agent config directories. The runner first proves curl to the npm registry and `ls ~/.config` both fail. A fixture plugin (built package plus scripted fake Cursor events) loaded on both versions. The model `cursor/fake` streamed text. A provider-executed `write` call was stored exactly once with `executed: true` and the Cursor result. The local sentinel file was never written. The stored finish was `stop`. Both versions passed.
- Hook order: on 2.0.0 the SDK came from the `create*` package factory (internal dynamic loader ran first). On 2.2.5 it came from the plugin `sdk` hook. The plugin `language` hook supplied the model on both.

Found during T1: real hosts expose `rpc` as a callable with `register` attached. The first host parser wrongly refused it. Fixed, and the unit fake now uses that shape.

Not done: G1, G4b, G5, G6, G8, the full version matrix, the real Cursor adapter, persistence, Cloud, TUI and the context hook. M0 has not passed.

## 2026-11-05: review fixes before real-SDK probes

- `scripts/check-layout.mjs` now fails on a missing child `package.json` (it skipped it before). The check is exported as `checkLayout(root)`. `scripts/check-layout.test.mjs` (`node:test`, run first in `npm run check`) covers a valid temp fixture tree and a missing manifest. It never touches the live workspace.
- `@iurysza/opencode-cursor-sdk` now has `dependencies: { "@ai-sdk/provider": "3.0.8" }`, because `dist/provider/language-model.d.ts` imports it. The root lockfile was refreshed with `npm install --ignore-scripts --package-lock-only --offline`. The only diff is the new child dependency, and `@ai-sdk/provider` and one transitive package are no longer `devOptional`. There are no child lockfiles.
- The T1 isolation self-check now needs positive proof that the sandbox denies access. Each probe must fail with `Operation not permitted` (EPERM). If it fails in any other way, the runner fails closed with the exit code and output.
  - Network: `/usr/bin/perl` connects to TEST-NET-1 `192.0.2.1:80`. Inside the sandbox it gives `connect: Operation not permitted`. Outside the sandbox it gives `Operation timed out`. curl was dropped because it reports both cases as "Couldn't connect".
  - File read: the profile denies a probe file under `.fixtures/t1/<v>/` by its literal real path. Outside the sandbox the runner checks that the file is readable. Inside the sandbox, `cat` must fail with EPERM.
  - `~/.config`: the runner still checks for EPERM when the directory exists.
  - The credential-directory bans, `env -i`, the isolated HOME and XDG directories and the loopback-only network rules are unchanged.
- Validation: `npm run build` passed. `npm run check` passed: 2 layout tests, layout ok, typecheck ok and 23 unit tests. `npm run test:host` passed on 2.0.0 and 2.2.5, with exit code 0.

## 2026-11-05: T2 offline real-SDK probe (partial G1, G4b typings)

- `@cursor/sdk` 1.0.37 is now an exact, normal dependency of `@iurysza/opencode-cursor-sdk`. It was installed with `npm install --ignore-scripts`. There is still one root lockfile and no child lockfile. The SDK pulled `@cursor/sdk-darwin-arm64` 1.0.37 (optional, platform binaries) and `@connectrpc/connect` and `connect-web` 1.7.0.
- Production entries still import no SDK. `test/unit/load-boundary.test.ts` loads `dist/server.js` and `dist/provider/factory.js` in a fresh Node process. A resolve hook records every specifier, and fetch, `net` and `http(s)` throw. It finds no `@cursor/sdk`, Pi or OpenCode-internal import and no network call. Negative controls prove that the hook catches an SDK specifier and the deny hooks fire. A source scan of `src/` checks the same import rule.
- The isolation code moved to `test/isolation.mjs`, so T1 and T2 use one copy. T1 behaviour is unchanged.
- `npm run test:t2` (`test/t2/run-offline.mjs`) loads a test-only plugin (`test/t2/fixture-plugin`) in the pinned `opencode` 2.0.0 and 2.2.5 binaries. It uses the same `env -i`, isolated HOME and XDG, loopback-only sandbox and positive EPERM self-check. It makes no `Agent.create`, resume or send call, uses no key and opens no real store. Evidence is in `.fixtures/t2/<v>/{probe.json,summary.json,run.out,run.err}`.
- Measured on both hosts. The host Bun is 1.4.2 on 2.0.0 (rev 744846f8) and 1.4.4 on 2.2.5 (rev 38afee6c). This is the CLI's own runtime, not a system Bun.
  - `import.meta.resolve` selects the `bun` export condition: `@cursor/sdk/dist/bundled/index.js` and `dist/bundled/sqlite.js`, not `dist/esm`.
  - The main import succeeds, and all required exports exist (76 in total).
  - `SqliteLocalAgentStore.open({ workspaceRef, stateRoot })` in the fixture works. The probe writes an agent row, a checkpoint blob and a run event. It then disposes the store, reopens it and reads all three back. The bundled driver is `bun:sqlite`. `index.db` and a per-agent `store.db` were created inside the fixture.
  - Harness mistake, fixed: checkpoint `blobId` must be hex, because blobs are content-addressed. The first probe used `"t2-blob"` and got `Invalid hex string length`. It now uses the sha256 hex.
  - Manufactured offline errors: `convertConnectError` maps Unauthenticated to `AuthenticationError`, Unavailable and DeadlineExceeded to `NetworkError`, and ResourceExhausted to `RateLimitError`. All are `CursorSdkError` instances. This shows how the classes are wired. It is not evidence of real transport errors.
- Transport, from reading the code. Not proven at runtime. The bundled build uses `@connectrpc/connect-web` only when `globalThis.Deno` is defined. Otherwise it uses its own Node-HTTP/2 "safe" transport. Under the host Bun, `Deno` is undefined. So the plan's "Bun loads `connect-web`" premise looks wrong for 1.0.37: Bun takes the `bundled` entry but the Node-style transport. This affects how F-57 classification must be checked. It needs a real RPC to confirm.
- G4b typings: `test/types/sdk-agent-options.ts` compiles against the installed declarations. `{ model, tools: [], local: { cwd } } satisfies AgentOptions`. A non-list `tools` value is rejected. This is type evidence only, not proof that native tools are denied.
- Validation: `npm ci --ignore-scripts`, `npm run build` and `npm run check` all pass (layout ok, typecheck ok, 27 unit tests). `npm run test:host` passes on 2.0.0 and 2.2.5. `npm run test:t2` passes on 2.0.0 and 2.2.5.

Still open:
- G1: real auth, network, abort and stall error classification under Bun (F-57).
- G1: the local MCP bridge call held past 60 s. Every public path found needs an agent run, so it needs `Agent.create` with approval.
- G1: remote timeouts (T3).
- G4b: runtime text-only proof of the helper lane (T2 with an agent, then T3).
- G1 and G4b are not passed.
