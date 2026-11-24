# OpenCode per-model prompts: implementation plan (ocpp1)

Written 2026-11-24 by the ocpp1 research lead (Fable 5.2). Research only: nothing was built, committed or installed.

## Verdict: build

Build a small new plugin, `@iurysza/opencode-model-context`, in the OpenCode extensions repo. No existing plugin does what the Pi extension does, and the gap is the part that matters: placement before AGENTS.md and reuse of the agents2 files.

| Fact | Value |
|---|---|
| Repo (home Mac) | `/Users/iurysouza/dev/personal/tools/opencode-extensions` |
| GitHub remote | `https://github.com/iurysza/opencode-extensions` (`origin`) |
| Branch agents2 installs | `cursor-port` at `ebdd234` (agents2 `lock.json`, tool `opencode-extensions`) |
| `main` | `1a66a88`. It has diverged from `cursor-port` (42 files differ; `cursor-port` carries the native tool card and model catalog work that `main` lacks) |
| Live OpenCode | CLI 2.2.5. The repo supports hosts 2.0.0 to 2.2.5 (`peerDependencies: "@opencode/plugin": ">=2.0.0 <3"`) |
| Pi reference | agents2 PR #43, merge `b852545`: `pi/agent/extensions/model-context.ts`, `content/agents/model-context/`, `test/model-context.test.ts` |

**Base branch: `cursor-port`**, because that is the ref agents2 pins. Building on `main` would ship a plugin that agents2 cannot pick up without also changing which Cursor code is live.

## Why not adopt

| Plugin | What it does | Why it does not fit |
|---|---|---|
| [acramsay/opencode-models-md](https://github.com/acramsay/opencode-models-md) (MIT, 0 stars, Oct 2026) | Per-model `.md` files under `<config>/opencode/models-md/`, matched by id prefix | Calls `event.system.push(...)`, so the text lands **after** AGENTS.md. Own directory and filename matching, no `map.json`, no exact-then-family order, no skip list. Depends on `@opencode/plugin: latest` and drags in a TUI. |
| [optix2000/opencode-provider-system-prompts](https://github.com/optix2000/opencode-provider-system-prompts) (no licence, 0 stars) | One YAML rule per provider | Per provider, not per model. Also pushes at the end. No licence, so it cannot be vendored. |
| [kmcquade/opencode-sysprompt-override-plugin](https://github.com/kmcquade/opencode-sysprompt-override-plugin) (no licence, 3 stars) | Replaces the whole system prompt | Wrong goal, older hook API, no licence. |

The plugin is about 120 lines. Adopting any of these would need a fork to fix placement and lookup, which is more work than writing it.

OpenCode itself has built-in per-model prompts (`packages/core/src/plugin/optimize.ts`), but they are compiled in, cover only its own picks (GPT, Astra, Claude, Kimi, Trinity, Meta) and cannot be pointed at files. See "Built-in prompts" below.

## How OpenCode builds the system prompt (v2.2.5, sst/opencode `9bbb8ce`)

1. `baseTranscript` in [`packages/core/src/session/model-request.ts`](https://github.com/sst/opencode/blob/v2.2.5/packages/core/src/session/model-request.ts) builds `system` as **two parts**:
   - `system[0]`: the agent's own `system` if it has one, else the harness base prompt (`SessionSystemPrompt.make`).
   - `system[1]`: all instruction sources joined, with each source kept in `metadata.experimental.instructions`. Order from [`session/context.ts`](https://github.com/sst/opencode/blob/v2.2.5/packages/core/src/session/context.ts): code-mode catalog, MCP, references, skills, **discovery (global and project AGENTS.md)**, built-ins (date, env), config `instructions` entries.
   - Empty parts are dropped, so `system` can have one part.
   - v2.0.0 has the same two-slot layout (base, then instructions). v2.4.1 too.
2. The request is then passed through plugin hooks. `session.hook("context")` runs for primary turns, `"compaction"` for compaction, `"generate"` for generate, `"title"` for titles (`model-request.ts`, the `prepare(...)` table near the end of the file). The event is mutable: `{ sessionID, model: { id, providerID, variant? }, agent, system: SystemPart[], messages, tools, options }` ([`packages/plugin/src/promise/session.ts`](https://github.com/sst/opencode/blob/v2.2.5/packages/plugin/src/promise/session.ts), documented in [`packages/plugin/src/README.md`](https://github.com/sst/opencode/blob/v2.2.5/packages/plugin/src/README.md): "Session context is mutable immediately before provider dispatch").
3. Hook order is plugin order: built-in `pre` plugins, then user packages in config order, then built-in `post` ([`plugin/supervisor.ts`](https://github.com/sst/opencode/blob/v2.2.5/packages/core/src/plugin/supervisor.ts), the `ordered` array). The built-in prompt plugins are in `pre`, so they have already rewritten `system[0]` when a user plugin runs.
4. `SystemPart` is `{ type: "text", text, metadata? }`.
5. The `system` array is rebuilt from scratch on every request and `event.model` is the model of that request.

**Answers to the brief's questions**

- *Can a plugin inject after the base prompt and before global AGENTS.md?* Yes. `event.system.splice(1, 0, part)` puts a new part between the base prompt and the instructions part. AGENTS.md lives in the instructions part, so Iury's rules come later and win. This is the same position the Pi extension uses.
- *Does a mid-session model switch swap it?* Yes, with no extra code. The hook runs per request with that request's `model`, and nothing persists between requests. There is no cached block to remove, unlike Pi's `appendSystemPrompt`.
- *`experimental.chat.system.transform` and the `instructions` config?* The first is the OpenCode 1.x hook and does not exist in 2.x. The `instructions` config is static, not per model, and lands at the very end of the instructions part, after AGENTS.md. Neither fits.

## Design

One server plugin, no TUI, no dependencies beyond the host types.

### Behaviour

On each `context`, `compaction` and `generate` event:

1. Load `map.json` from the model-context directory. Missing file: do nothing.
2. If the provider is skipped, do nothing.
3. If the agent has its own `system` prompt, do nothing (same rule as the built-in prompt plugins; custom agents own their whole prompt).
4. Resolve a file: exact model id, then first matching family pattern, then none.
5. Read the file. Missing or empty: do nothing.
6. If `event.system` is empty, do nothing. Otherwise remove any part with `metadata.modelContext === true`, then `splice(1, 0, { type: "text", text, metadata: { modelContext: true, file } })`.

Do not hook `title`. It is a tiny utility call and the vendor prompt would only cost tokens.

Errors never break a turn: catch everything inside the hook, log once per distinct message through the host logger, and continue without injection. Invalid JSON in `map.json` counts as an error, not as "no map" (the Pi extension throws here; in OpenCode a throw would fail the request).

### Lookup (port of the Pi functions, same names)

Copy these pure functions from `agents2/pi/agent/extensions/model-context.ts` into `src/resolve.ts` and keep the names so the two stay comparable: `modelFileStem`, `lookupKeys`, `modelMatches`, `resolveContextFile`, `shouldSkipVendorPrompt`, `parseModelContextMap`.

- Exact: try `provider/stem`, `stem`, `provider/id`, `id` against `map.models`.
- Family: first entry in `map.families` whose case-insensitive regex matches `provider/stem`, `stem` or `provider`. Invalid regex: skip that entry.
- None: no injection.

One deliberate difference: **`modelFileStem` also strips an `@...` suffix**, as well as Pi's `:...` suffix. Cursor model ids in OpenCode look like `claude-opus-5-5@300k` and `gpt-5.6-sol@272k`. Without this, `claude-opus-5-5@300k` matches nothing. The full id is still tried as an exact key, so a map entry for the suffixed name wins if someone adds one. OpenCode keeps reasoning effort in `model.variant`, not in the id, so there is no `:high` suffix to worry about; stripping it stays harmless.

`skipSoul` in the map is Pi-only. Ignore it.

### Reusing the agents2 files

The plugin reads the **same deployed directory as Pi**: `~/.agents/model-context/` (symlinks into `~/.local/share/agents2/current/agents/model-context/`, which agents2 already installs for every runtime, see `src/adapters/shared.ts`). It bundles no prompt files.

That makes sync automatic: `scripts/refresh-vendor-model-context.ts` updates `content/agents/model-context/`, `agents2 apply` deploys it, and both Pi and OpenCode read the result on the next request. No second refresh path.

Directory resolution, first hit wins:

1. plugin option `dir`
2. env `OPENCODE_MODEL_CONTEXT_DIR`
3. `~/.agents/model-context`

Read the map and the prompt file on every request, like Pi does. The files are small and this means an apply takes effect without restarting OpenCode. Do not add a cache.

### Providers that ship their own prompt

`map.json` has `skipProviders: ["claude-code"]`, which is a Pi provider name. OpenCode's equivalents have different ids, so the plugin has its own option `skipProviders`, **added to** the map's list:

- default `["claude-agent", "cursor"]`
- `claude-agent` is OpenCode's Claude Agent SDK provider (`Provider.ID.claudeAgent`), the counterpart of Pi's `claude-code`.
- `cursor` is this repo's Cursor SDK provider (`PROVIDER_ID = "cursor"`). The Cursor agent runs its own harness. **Builder: confirm before keeping it in the default.** Check in `packages/opencode-cursor-sdk/src` whether the bridge forwards `system` to the Cursor agent. If it does, drop `cursor` from the default and rely on the `@` suffix handling above.

Do not edit the shared `map.json` for OpenCode-only needs.

### Built-in prompts

OpenCode already swaps `system[0]` for its own GPT prompt on GPT models and appends its Anthropic text on Claude models. The vendor prompt then sits next to it, so GPT models get two Codex-style prompts. This is not a blocker and v1 leaves it alone. If Iury wants one prompt only, the built-ins can be removed in `opencode.json` with the remove syntax (`"-opencode.prompt.openai"`, `"-opencode.prompt.anthropic"`; parsed in `packages/core/src/config/plugin/source.ts`). That is an agents2 profile change, out of scope here. Record it in the package README.

## Files

All paths relative to the repo root, on a new branch off `cursor-port`.

Add `packages/opencode-model-context/`:

| File | Content |
|---|---|
| `package.json` | name `@iurysza/opencode-model-context`, `type: module`, exports `.` and `./server` to `./dist/server.js`, scripts `build`, `typecheck`, `test`, `test:host` copied from `opencode-cursor-cloud`. Peer dep `@opencode/plugin: ">=2.0.0 <3"` only. No `@cursor/sdk`, no TUI peers. |
| `tsconfig.base.json`, `tsconfig.json`, `tsconfig.build.json`, `tsconfig.min.json` | Copy from `opencode-cursor-cloud`. |
| `src/resolve.ts` | Pure functions listed above. No I/O. |
| `src/files.ts` | `modelContextDir(options)`, `loadMap(dir)`, `readPrompt(dir, name)`. ENOENT returns undefined. |
| `src/inject.ts` | `applyVendorPart(system, text, file)`: pure, returns nothing, mutates the array as in step 6. |
| `src/server.ts` | Default export: the plugin. Registers the three hooks. Follow `opencode-cursor-cloud/src/server.ts` and `plugin/create.ts` for the definition shape. Probe the host like `opencode-cursor-sdk/src/compat/host.ts` does and disable with one log line if `session.hook` is missing. |
| `test/unit/resolve.test.ts`, `test/unit/inject.test.ts`, `test/unit/files.test.ts` | See Tests. |
| `test/types/min.ts`, `test/types/latest.ts` | Type contract against `@opencode/plugin` 2.0.0 and latest, same pattern as the cloud package. |
| `test/t1/run-model-context.mjs`, `test/t1/model-context-plugin/` | Real-host run, see Tests. |
| `README.md`, `CHANGELOG.md` | What it does, the directory order, options, the built-in prompt note. |

Change:

| File | Change |
|---|---|
| `package.json` (root) | Add the workspace. |
| `scripts/check-layout.mjs` | It enforces "exactly two packages" and requires `@cursor/sdk 1.0.37` in each. Allow the third package and exempt it from the `@cursor/sdk` rule. Update its test in `scripts/`. |
| `AGENTS.md` | Row "Packages: Exactly two" becomes three, and name the new one. This is Iury's rule file: change only that row, and call it out in the PR description. |
| `release-please-config.json`, `.release-please-manifest.json` | Add the package. |
| `.github/workflows/verify.yml` | Add the new host test next to the existing matrix steps. |
| `package-lock.json` | Regenerate with `npm install --ignore-scripts`. |

Use only public `@opencode/plugin` exports (repo rule). No Cursor calls anywhere, so no Cursor approval is needed.

Follow-up, **not part of the cloud agent's PR**: in agents2 `lock.json`, bump `opencode-extensions` `rev` and add `packages/opencode-model-context/dist` to `opencodePlugins` and `payloadBuild`; update the golden files in `test/adapters/golden/opencode-*.json`. Then apply on both Macs.

## Tests

Unit (vitest, `npm test`):

- Port the lookup cases from `agents2/test/model-context.test.ts`: exact id, `provider/id`, family, first family wins, invalid regex skipped, no match, skip provider, missing map, missing prompt file, empty prompt file.
- New: `claude-opus-5-5@300k` resolves to `claude-opus-5-5.md`; `gpt-5.6-sol@272k` resolves to `gpt-5.6-sol.md`; a map key with the suffix beats the stripped one.
- New: a copy of the real `map.json` as a fixture, asserting `gpt-6.2-sol`, `claude-fable-5-2`, `gemini-2.5-pro` (legacy), `gemini-4-pro`, `kimi-k3` (budget) resolve to the expected files.
- Inject: `[base, instructions]` becomes `[base, vendor, instructions]`; `[base]` becomes `[base, vendor]`; `[]` stays empty; running twice leaves one vendor part; a second run with a different text replaces the first.
- Invalid JSON map: no throw from the hook, no injection.

Real host (`npm run test:host`, OpenCode 2.0.0 and 2.2.5), modelled on `packages/opencode-cursor-cloud/test/t1/run-receipts.mjs` and its shared isolation helpers:

- Fixture plugin loaded **after** the model-context plugin. It registers a `context` hook that writes `event.model` and `event.system` to a log file, and a fake provider so no network is used.
- Temp model-context dir passed through `OPENCODE_MODEL_CONTEXT_DIR`, and a temp global `AGENTS.md` containing a marker string.

## Verification (what the builder must show)

1. **Load order.** In the logged `system`, the vendor part is at index 1, the base prompt at index 0, and the AGENTS.md marker appears only in a later part. Run on 2.0.0 and 2.2.5.
2. **Exact.** Model `gpt-6.2-sol`: vendor part text equals `gpt-6.2-sol.md`.
3. **Family.** Model `gpt-9-unknown`: vendor part text equals `gpt.md`.
4. **None.** Model `mystery-1`: `system` has no part with `metadata.modelContext`.
5. **Mid-session switch.** One session, prompt on `gpt-6.2-sol`, call the public `session.switchModel` to a Claude model, prompt again. Second log entry has the Claude file and no trace of the GPT file. Then switch to `mystery-1`: no vendor part.
6. **Skip.** Provider `claude-agent`: no vendor part.
7. **Custom agent.** Agent with its own `system`: no vendor part.
8. **Live edit.** Change the prompt file between two prompts without restarting: second request has the new text.
9. `npm run build && npm run check` green.

Manual check after the agents2 follow-up, on the home Mac: start OpenCode, pick a GPT model, and confirm with the fixture-style log or `opencode` debug output that the vendor block sits before the AGENTS.md text.

## Out of scope for this step

Implementing, committing, opening a PR, launching the Cursor cloud agent, changing agents2, changing either Mac's config, removing OpenCode's built-in prompts.

## Things for the builder to confirm, not assume

- Whether the Cursor bridge forwards `system` (decides the `cursor` default skip).
- The exact promise-API call to read an agent's `system` (`ctx.agent.get`) on 2.0.0 and on 2.2.5; the signature may differ between them. If 2.0.0 cannot answer, skip step 3 of Behaviour on that host and say so in the README.
- That `"compaction"` and `"generate"` hooks exist on 2.0.0. `"context"` does. Register the others only if present.

## Notes

- Scratch clone used for the research: `/tmp/ocpp1-clone/opencode` (sst/opencode at v2.2.5). Safe to delete.
- The live home config loads this repo's plugins from `~/.local/share/agents2/tools/opencode-extensions/<rev>/packages/<pkg>/dist`, listed in `~/.config/opencode/opencode.json` under `plugin`. agents2 writes that list from `opencodePlugins` in `lock.json`.
----
BRIEF.md
LEAD.md
PLAN.md
