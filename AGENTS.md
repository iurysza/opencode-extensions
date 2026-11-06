# OpenCode extensions

OpenCode 2.x ports of Iury's Cursor extensions.

## Map

| Topic | Rule |
| --- | --- |
| Contract | The execution contract lives in `ai-artifacts/opencode-port/`. Start with `goal.md`, `facts.md` and `plan.md`. Do not edit `facts.md` or `facts.meta.json` without Iury's approval. Append progress to `dev-log.md`. |
| Packages | Exactly two: `@iurysza/opencode-cursor-sdk` and `@iurysza/opencode-cursor-cloud`. The root workspace stays private. |
| Lockfile | One root `package-lock.json`. Child lockfiles are forbidden. Install with `npm install --ignore-scripts`. |
| Host API | Production code uses public `@opencode/plugin` exports only. OpenCode internals may be read for test analysis, never imported. |
| Hosts | Supported: OpenCode `>=2.0.0 <3`. Type contracts compile against 2.0.0 (`opencode-plugin-min`) and 2.2.5. |
| Cursor | No real Cursor `Agent.create` or `send`, and no paid or live calls, without Iury's explicit approval. Package load must not import `@cursor/sdk` or touch the network. |
| Keyless Agent.create exception | Approved by Iury (Inbox msg_redacted, 2026-11-05): keyless `Agent.create` probes only, with no real credentials, under the existing `env -i` isolated HOME/XDG network-blocked sandbox, local runtime only. No Cloud runtime and no prompt `send`. Anything wider still needs a new approval. |
| Runtime probes | Run only under isolated HOME/XDG in `.fixtures/`, with `env -i` and the loopback-only sandbox (see `packages/opencode-cursor-sdk/test/t1/run-host.mjs`). Fail closed if isolation cannot be enforced. Never load `~/.config/opencode` or real credentials. |
| Commits | Never add Cursor or any agent as author, committer or `Co-authored-by`. |

## Closed loop

Before committing: `npm ci --ignore-scripts`, `npm run build`, `npm run check`.
Real-host T1 (needs pinned binaries in `.fixtures/inspect/bin-<version>/`): `npm run test:host`. Real-host request stamping (G4a, G3 prerequisites): `npm run test:req`.
Full T1 matrix: `npm run fixtures:acquire` (network allowed; `npm pack --ignore-scripts` into `.fixtures/inspect`, integrity-checked), then `npm run test:matrix` (loopback-only; runs `test:host` and `test:req` per version, report in `.fixtures/matrix/report.json`).
