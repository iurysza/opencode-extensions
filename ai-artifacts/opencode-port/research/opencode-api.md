# OpenCode API research for the Cursor SDK and Cursor Cloud port

> **Historical, superseded.** This report studied OpenCode 1.18.33, which is now excluded. The current evidence is the [OpenCode 2.x boundary report](./opencode-v2-boundary.md). Its `promptAsync` dispatcher and `parentID` reply correlation do not apply to 2.x: 2.x assistant messages have no `parentID`. The text below is kept unchanged as evidence.

Retrieved 2026-11-05. Phase 1, read-only. This report records evidence; the lead decides the architecture.

## Summary

The installed OpenCode is **1.18.33**, but its global plugin package is **1.18.2**. Upstream `dev` has moved to **2.2.5**, a rewrite with a new `packages/core` runtime and a v2 plugin model. A Cursor-backed model fits the 1.18.33 AI SDK path. OpenCode loads any `create*` AI SDK v3 provider from npm or `file://`. It honors `providerExecuted: true` on tool calls: it does not re-execute them, it stores the provider's tool result, and it replays the result to the model as provider-executed. Cloud features fit backend plugin tools plus the SDK's `promptAsync`/`abort`. Rich UI requires the separate TUI plugin API (slots, routes, dialogs, keymap layers); it has no slot for custom chat-message cards.

The largest risks: (1) 1.18 and 2.x have different plugin and runtime APIs, so we must pick one target; (2) provider-executed tools must still pass AI SDK's tool parsing, which shapes how we name Cursor tools; (3) TUI plugins cannot render inline transcript cards.

## Versions and pins

| Item | Value | Evidence |
|---|---|---|
| Binary | `opencode-ai` 1.18.33, darwin-arm64 Mach-O | `~/.local/bin/opencode` symlinks to `~/.local/share/agents2/tools/opencode/1.18.33/node_modules/opencode-ai/bin/opencode.exe`; `opencode --version` prints `1.18.33` |
| Global plugin types | `@opencode-ai/plugin` 1.18.2, `@opencode-ai/sdk` 1.18.2 | `~/.config/opencode/node_modules/@opencode-ai/{plugin,sdk}/package.json`; `~/.config/opencode/package.json` pins `1.18.2` |
| Plugin deps | `@ai-sdk/provider` 3.0.8, `effect` 4.0.0-beta.83, `zod` 4.1.8 | plugin `package.json` |
| Tag v1.18.33 | `51ef4be1d3c122f18fefb510dca8d778571f4f18` | `git ls-remote https://github.com/sst/opencode` |
| Tag v1.18.2 | `70b56a0a93d366889cae950379cc9d2537148fa2` | same |
| Upstream `dev` HEAD | `893e8dc43f05e872d4cac603486ce8a7181170fa` (2026-11-05), `packages/plugin` 2.2.5; latest tag v2.2.5 | same |
| AI SDK in 1.18.33 | `ai` 6.0.168 (root catalog), `@ai-sdk/provider` 3.0.16 | `git show v1.18.33:package.json`, `packages/opencode/package.json` |
| License | MIT, both tags | `LICENSE` in repo |

Pinned links below use `T=https://github.com/sst/opencode/blob/51ef4be1d3c122f18fefb510dca8d778571f4f18` and `M=https://github.com/sst/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa`.

**Mismatch.** The 1.18.2 declarations match the 1.18.33 hook names I checked (`index.d.ts`, `tool.d.ts`, `tui.d.ts`, `v2/*`). The binary embeds its own plugin runtime, so the npm type version only affects authoring. Pin types to 1.18.33 for the port. Main 2.2.5 has a different layout: `packages/opencode/src` is gone, with runtime in `packages/core/src`, TUI in `packages/tui`, and a GUI plugin API in `packages/plugin/src/gui`. Docs on `dev` (`packages/web/src/content/docs/plugins.mdx`) still describe the v1 `Hooks` shape, so docs and main source disagree.

Local sparse source copies: `ai-artifacts/opencode-port/research/sources/opencode-v1.18.33` and `.../sources/opencode-main` (blobless, sparse; about 46 MB together).

## Gate: provider-executed tool calls (1.18.33)

Pi's Cursor SDK model lets Cursor run tools itself; Pi records and replays the results. OpenCode supports the same contract on its default AI SDK path. Each step below is code-backed.

1. **Stream path.** Unless `experimentalNativeLlm` is set, OpenCode calls AI SDK `streamText` with its own tools, `abortSignal: input.abort`, and a `wrapLanguageModel` middleware. The comment says "AI SDK owns provider execution and tool dispatch". `T/packages/opencode/src/session/llm.ts#L224-L330`. It sets no `stopWhen`, so AI SDK's default `stepCountIs(1)` applies (https://unpkg.com/ai@6.0.168/src/generate-text/stream-text.ts, line 304). OpenCode runs its own outer loop.
2. **AI SDK skips execution.** In `ai` 6.0.168, `runToolsTransformation` executes only when `tool.execute != null && toolCall.providerExecuted !== true`. It forwards provider `tool-result` chunks with `providerExecuted: true`, and error results as `tool-error`. https://unpkg.com/ai@6.0.168/src/generate-text/run-tools-transformation.ts lines 291-400.
3. **Parsing still applies.** `parseToolCall` validates input against the OpenCode tool's schema when the name matches. An unknown name passes only if the call is `providerExecuted && dynamic`. Otherwise OpenCode's `experimental_repairToolCall` lowercases the name or rewrites the call to the `invalid` tool. https://unpkg.com/ai@6.0.168/src/generate-text/parse-tool-call.ts; `T/packages/opencode/src/session/llm.ts#L296-L313`. **Implication:** emit Cursor tool calls with `providerExecuted: true, dynamic: true` and Cursor-specific names (for example `cursor_read`), or exact OpenCode names with schema-valid input. Inference: a dynamic provider-executed call still gets parsed against a same-named OpenCode tool, so name collisions risk `invalid`.
4. **Event mapping.** `toLLMEvents` keeps `providerExecuted` on `tool-call` and `tool-result`. `T/packages/opencode/src/session/llm/ai-sdk.ts#L223-L264`.
5. **Persistence.** `ensureToolCall` writes a `tool` part with `metadata.providerExecuted = true`; `tool-call` sets it to `running` with input; `tool-result` maps output to `{title, metadata, output, attachments}` and completes the part. `T/packages/opencode/src/session/processor.ts#L216-L252`, `#L255-L278`, `#L331-L415`. A result shaped `{output: string, title?, metadata?}` gets a proper title and metadata; any other value is stringified (`#L257-L276`).
6. **Loop does not wait for local results.** The prompt loop ignores tool parts with `providerExecuted` when deciding whether tool results are owed. `T/packages/opencode/src/session/prompt.ts#L1104-L1110`. Inference: the provider must finish the step with a final reason such as `stop`. A `tool-calls` or `unknown` finish reason keeps the loop running (`#L1111-L1115`) and calls the model again.
7. **Replay.** `toModelMessages` rebuilds tool parts as `output-available` or `output-error` with `providerExecuted: true`, and strips the flag from `callProviderMetadata`. `T/packages/opencode/src/session/message-v2.ts#L125-L130`, `#L300-L362`. Next turn, the provider receives the prior Cursor tool call and result in the prompt, so it can skip re-sending them to Cursor.
8. **Native runtime.** The opt-in native runtime skips local dispatch for `providerExecuted` calls. `T/packages/opencode/src/session/llm/native-runtime.ts#L105-L125`. Main keeps the same rule: `M/packages/core/src/session/runner/step.ts#L119`, `M/packages/core/src/session/runner/publish-llm-event.ts#L288-L296`, `#L481-L505`.
9. **Abort.** `streamText` gets the session abort signal. On interrupt, the processor waits up to 250 ms per open tool call, marks each `error: "Tool execution aborted"` with `metadata.interrupted`, and closes the message. `T/packages/opencode/src/session/processor.ts#L585-L612`, `#L650-L670`. Our provider must honor `options.abortSignal` and cancel the Cursor run.
10. **Compaction.** A tool call during summary generation throws "Tool call not allowed while generating summary". `T/packages/opencode/src/session/processor.ts#L315-L335`. The Cursor provider must emit no tool calls when used as the compaction model. Compaction uses `agent.compaction.model`, falling back to the user's model, not `small_model` (corrected in Round 2, item 5).

**Verdict:** feasible, medium-high confidence, from code reading only. To confirm, a spike with a mock `LanguageModelV3` should emit provider-executed `tool-call` and `tool-result` events plus a `stop` finish, then inspect the DB parts and the next turn's prompt.

## Provider supply and model execution

| Question | 1.18.33 answer | Evidence |
|---|---|---|
| Custom AI SDK provider? | Yes, through config: `provider.<id>.npm` names an npm package or a `file://` path. OpenCode imports it, picks the first export whose name starts with `create`, and calls it with `{name, ...options}`. | `T/packages/opencode/src/provider/provider.ts#L1785-L1890` (see `#L1864-L1881`) |
| Plugin-registered provider object? | No v1 hook returns a `LanguageModel`. The v1 `provider` hook only supplies `models()`; `auth.loader` returns provider options. | `~/.config/opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts` (`ProviderHook`, `AuthHook`); `T/.../provider.ts#L1505-L1530` |
| Intercept execution? | v1: `chat.params`, `chat.headers`, `experimental.chat.messages.transform`, `experimental.chat.system.transform`, `tool.definition`. No stream replacement. v2 types declare `aisdk.sdk` and `aisdk.language` hooks that can set `language?: LanguageModelV3`. | plugin `dist/index.d.ts`; `dist/v2/promise/aisdk.d.ts`; `M/packages/plugin/src/effect/aisdk.ts`; `M/packages/core/src/aisdk.ts#L241-L312` |
| Is the v2 `aisdk.language` hook live in 1.18.33? | Only for the v2 `/api/session` runtime, **not** for the TUI's default prompt path. See Round 2, item 1. | `T/packages/core/src/aisdk.ts`; `T/packages/opencode/src/provider/provider.ts#L1-L33` |
| Custom stream protocol? | Only as an AI SDK `LanguageModelV3`. A gateway with an OpenAI-compatible HTTP API can use `@ai-sdk/openai-compatible`, but standard chat completions cannot mark tool calls provider-executed. | `BUNDLED_PROVIDERS`, `T/.../provider.ts#L148-L175` |
| Auth | v1 `auth` hook: `api` or `oauth` methods, prompts, `authorize`, and a `loader(auth, provider)` that returns provider options. v2 replaces it with `integration` methods and `connection.resolve`. | plugin `dist/index.d.ts`; `dist/v2/effect/integration.d.ts` |

**Provider package or HTTP bridge.**
- *Provider package* (`LanguageModelV3`, loaded by `npm` or `file://`): in-process, can emit `providerExecuted`, gets `abortSignal`, and fits the gate above. It must bundle or depend on the Cursor SDK and run in Bun.
- *HTTP bridge* (a local OpenAI-compatible server): reuses bundled providers but cannot express provider-executed tools through standard chat completions. OpenCode would then try to run Cursor's tool calls locally, or they would turn into text. It also adds a process to manage. Not recommended for the SDK port unless the bridge returns only text.

## Tools, commands and events

- **Custom tools.** The `tool({description, args: zod, execute(args, ctx)})` context carries `sessionID`, `messageID`, `agent`, `directory`, `worktree`, `abort`, `metadata({title, metadata})` for live progress, and `ask()` for permission. Results may be a string or `{title, output, metadata, attachments}`. `dist/tool.d.ts`. Tools also load from `.opencode/tool(s)/*.ts` (docs `custom-tools.mdx`).
- **Tool ownership.** The `tool.execute.before/after` hooks can mutate args and output; `tool.definition` can rewrite the description and schema. No hook replaces another tool's executor. `dist/index.d.ts`.
- **Async events.** The backend `event` hook receives every bus event. Plugins also get `client` (an SDK client bound to `serverUrl`) and can call `session.promptAsync` (`/session/{id}/prompt_async`), `session.abort`, `session.command`, `session.summarize`, `tui.appendPrompt`, `tui.showToast`, and `tui.executeCommand`. `~/.config/opencode/node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.js`. Background follow-ups for Cursor Cloud can therefore post into a session when a cloud run finishes. Inference: this needs the server alive, so it fails after OpenCode exits.
- **Slash commands.** Backend commands are prompt templates from config `command` or `commands/*.md`, with `$ARGUMENTS`, `!shell`, and `@file` expansion (docs `commands.mdx` §Prompt config). `command.execute.before` can rewrite the parts a command produces, but the command still runs as a prompt. Arbitrary code-backed slash commands exist only in the TUI plugin, through `keymap.registerLayer({commands, bindings})`, or the deprecated `api.command.register` with `slash: {name, aliases}`. `dist/tui.d.ts` (`TuiCommand`, `TuiCommandApi`); `T/packages/plugin/src/tui.ts#L89-L115`.

## TUI plugin API (separate from backend plugins)

A module exports either `server` (backend `Plugin`) or `tui` (`TuiPlugin`), never both (`PluginModule.tui?: never`, `TuiPluginModule.server?: never`, in `dist/index.d.ts` and `dist/tui.d.ts`). The local config already uses this split (`~/.config/opencode/plugins/moshi-hooks.ts` and `moshi-hooks-tui/`).

`TuiPluginApi` offers:
- `ui`: `Dialog`, `DialogAlert`, `DialogConfirm`, `DialogPrompt`, `DialogSelect`, `Prompt`, `Slot`, `toast`, and the `dialog` stack;
- `slots.register` (Solid/OpenTUI) for `app`, `app_bottom`, `home_*`, `session_prompt`, `session_prompt_right`, `sidebar_title`, `sidebar_content`, `sidebar_footer`;
- `route.register/navigate` for full custom screens;
- `keymap` (OpenTUI keymap, with leader timeout in `tuiConfig.leader_timeout`), `mode.push`, `kv`, `state` (sessions, messages, parts, status), `event.on`, `client`, `renderer`, `attention.notify`, and `lifecycle`.

All from `dist/tui.d.ts`.

**Hard limit:** no slot renders inside the message transcript. Cursor Cloud status can appear in the sidebar, a prompt-side slot, a dialog, or a custom route. Tool parts render through OpenCode's built-in renderer, fed by `title`, `output`, and `metadata`. I found no API for custom per-tool renderers (medium confidence).

## Session persistence, compaction, resume

- Sessions persist in SQLite (`~/.local/share/opencode/opencode.db` exists; not opened). Tool parts, including provider-executed ones, survive restarts and are replayed (Gate step 7).
- `experimental.session.compacting` can add context strings or replace the compaction prompt. `experimental.compaction.autocontinue` can disable the synthetic "continue" turn. `dist/index.d.ts`. Compaction keeps the summary and drops earlier messages from the prompt (`T/packages/opencode/src/session/compaction.ts#L87-L111`, `#L292`). Inference: a Cursor-side conversation ID kept in `providerMetadata` would drop along with the compacted messages. The provider should handle "no prior Cursor state" by starting fresh.
- Attach: `opencode attach <url>` and `serve` expose the HTTP server (docs `server.mdx`, `cli.mdx`); not exercised.

## Capability matrix

| Need (from Pi packages) | 1.18.33 | Main 2.2.5 | Confidence |
|---|---|---|---|
| Custom model backed by Cursor SDK | Yes, `LanguageModelV3` via `provider.npm`/`file://` | Yes; plus `aisdk.language` hook | High / Medium |
| Plugin provides model without config entry | No on the legacy path; v2 `aisdk.language` works only on the `/api/session` runtime | Yes (`aisdk`, `provider.add`) | Medium |
| Provider-executed tools, no re-execution | Yes | Yes | High (code), unspiked |
| Persist and replay provider tool results | Yes, as `providerExecuted` parts | Yes (`to-llm-message.ts`) | High |
| Abort propagates to provider | Yes, `abortSignal` | Likely | High / Medium |
| Provider auth flow | `auth` hook (api/oauth, loader) | `integration` | High |
| Custom tools with progress | Yes, `ctx.metadata` | Yes (`effect/tool.ts`) | High |
| Code-backed slash command | TUI plugin only | TUI/GUI plugin | High |
| Prompt-template command | Yes | Yes | High |
| Inline transcript cards | No | Not found | Medium |
| Sidebar/panel, dialogs, routes, keymap | Yes (TUI plugin) | Yes | High |
| Background follow-up into session | Yes, `client.session.promptAsync` while server runs | Yes | Medium |
| Compaction hooks | Prompt/context and autocontinue only | Unchecked | High |

## Sources

Kept:
- Installed declarations in `~/.config/opencode/node_modules/@opencode-ai/plugin/dist` and `.../sdk/dist`: the authoring surface actually installed.
- Tag `v1.18.33` source (`51ef4be`): matches the binary; covers processor, prompt loop, provider loader, and message replay.
- `dev` HEAD (`893e8dc`): shows the 2.x direction and that `providerExecuted` handling survives.
- `ai@6.0.168` source on unpkg: the exact AI SDK version OpenCode bundles; proves the execute-skip and parse rules.
- `dev` docs (`plugins.mdx`, `commands.mdx`, `tui.mdx`, `custom-tools.mdx`, `server.mdx`): user-facing contract, though they lag the 2.x source.

Dropped:
- opencode.ai rendered docs and blog posts: duplicate the repo `.mdx` files and carry no version pin.
- `~/.config/opencode/opencode.json` values and all `auth*.json` files: not needed; I inspected only key names.

## Round 2: resolved unknowns (tag v1.18.33, `51ef4be`)

These answers come from reading the source, not from runs. `T` is the pinned tag prefix defined above.

### 1. Which runtime is active: legacy, core, or both

**Both ship in the binary.** The TUI's prompts run through the legacy `packages/opencode` runtime. The `packages/core` runtime serves only the newer `/api/session/*` routes.

- The CLI package depends on `@opencode-ai/{core,llm,plugin,server,tui,...}` as workspace packages, and its build runs `script/build.ts` (`git show 51ef4be:packages/opencode/package.json`).
- **Legacy path (default for TUI and `sdk.session.prompt/promptAsync`).**
  - The routes `/session/:id/prompt` and `prompt_async` call `SessionPrompt.Service` (`T/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts#L295-L329`).
  - `SessionPrompt` → `SessionProcessor` → `LLM.stream` → AI SDK `streamText`, as traced in the Gate section above.
  - The TUI submits through `sdk.client.session.prompt` / `.command` / `.shell` / `.abort` (`T/packages/tui/src/component/prompt/index.tsx#L1060-L1100`, `#L415`).
  - The TUI uses `client.v2.*` only for reads: session, messages, agents, commands, models (`T/packages/tui/src/context/data.tsx#L422-L513`).
- **Core path.**
  - `server.ts` mounts `SessionV2` with `SessionExecution` → `SessionExecutionLocal` → `SessionRunner` (`T/packages/opencode/src/server/routes/instance/httpapi/server.ts#L298-L303`; `T/packages/core/src/session/execution/local.ts#L16-L20`).
  - The v2 SDK exposes it as `/api/session/{id}/prompt`, `/interrupt`, `/compact`, `/wait` (`git show 51ef4be:packages/sdk/js/src/v2/gen/sdk.gen.ts`, around L5647-L5790).
- **`aisdk.language` wiring.**
  - The `AISDK` service lives in `packages/core/src/aisdk.ts`. It is registered by `core/src/plugin.ts#L8,L147,L160`, `core/src/plugin/host.ts#L6,L22`, and `core/src/location-services.ts#L3,L51`.
  - Built-in core provider plugins call `ctx.aisdk.language(...)`, for example `core/src/plugin/provider/openai.ts#L182`.
  - The legacy runtime does not import it. A tag-wide grep finds no `aisdk` import under `packages/opencode/src`, and `provider.ts` imports only `ai`, `@ai-sdk/provider`, `core/npm`, and `core/provider` (`T/packages/opencode/src/provider/provider.ts#L1-L33`).
  - The legacy runtime gets its language model from `resolveSDK` plus `modelLoaders` (`#L1918-L1935`).
- **Two plugin loaders.**
  - Legacy: config `plugin` (singular). `readV1Plugin` accepts `{server}` exports or bare functions (`T/packages/opencode/src/plugin/index.ts#L88-L124`).
  - Core: config `plugins` (plural). It also globs `{plugin,plugins}/*.{ts,js}` and requires a `default` export of `{id, effect}` or `{id, setup}` (`T/packages/core/src/config/plugin/external.ts#L15-L86`; `T/packages/core/src/config.ts#L102`).
  - Inference: v1 files in `plugins/` may also hit the v2 loader. Its failures are swallowed by `Effect.ignoreCause` (`external.ts#L85`).
- **Feature flag.** `OPENCODE_EXPERIMENTAL_NATIVE_LLM` switches only the legacy LLM adapter (`@opencode-ai/llm`) and falls back to the AI SDK when unsupported (`T/packages/opencode/src/session/llm.ts#L224-L270`). No flag routes TUI prompts to the core runner.

**Consequence for the port.** On 1.18.33, the provider package loaded via config `provider.<id>.npm` is the reliable path. A v2 `aisdk.language` plugin would not affect the TUI chat. Confidence: high.

### 2. TUI rendering: slots and custom tool renderers

- **Host slots actually placed:** `app`, `app_bottom` (`T/packages/tui/src/app.tsx#L1127-L1129`); `home_logo`, `home_prompt`, `home_prompt_right`, `home_bottom`, `home_footer` (`routes/home.tsx#L76-L91`); `session_prompt_right` (`routes/session/index.tsx#L1330`); `sidebar_content` and `sidebar_footer` (`routes/session/sidebar.tsx#L85-L90`). Built-in sidebar widgets use the same `api.slots.register` (`feature-plugins/sidebar/*.tsx`).
- **Tool parts:**
  - `ToolPart` is a hard-coded `Switch` on `toolDisplay(part.tool)`. It covers bash, glob, read, grep, webfetch, websearch, write, edit, task, execute, apply_patch, todowrite, question, and skill. Every other tool falls to `GenericTool` (`T/packages/tui/src/routes/session/index.tsx#L1709-L1790`).
  - `GenericTool` shows a one-line `⚙ tool input`. Full output appears only when the user toggles "Show generic tool output", and it collapses at three lines (`#L1798-L1830`, `#L268`, `#L743-L747`).
  - No slot exists inside messages, and no renderer registry exists.
- **Verdict.** Custom inline cards have **no public API**, but they are not technically impossible. A Cursor tool reusing a built-in name gets that renderer (`toolDisplay` mapping), but the name also selects schema parsing (Gate step 3). The renderer reads `input`, `metadata`, and `output`. The other options are forking the TUI or using sidebar slots, routes, and dialogs.

### 3. `promptAsync` on a busy session, and exactly-once follow-ups

- `prompt_async` forks `SessionPrompt.prompt` and returns 204 at once. Errors are only logged and published as `session.error` (`T/.../handlers/session.ts#L311-L329`).
- `prompt()` always **persists the user message first**, then calls `loop()` (`T/packages/opencode/src/session/prompt.ts#L1052-L1071`).
- `loop()` calls `SessionRunState.ensureRunning` (`#L1343-L1347`). If a run is already active, `Runner.ensureRunning` **joins it** (`awaitDone(st.run.done)`) and starts no new work (`T/packages/opencode/src/effect/runner.ts#L115-L135`).
- The active loop re-reads messages from the DB each iteration (`prompt.ts#L1088-L1095`), so the queued message is seen only if the loop takes another iteration.
- **Race (inference, high confidence).** If the current turn is on its final step, the loop exits on `lastAssistant.parentID === lastUser.id` (`prompt.ts#L1111-L1115`). A message inserted after that check gets no reply until another prompt arrives: no drop, but no reply either. Shell runs queue properly (`ShellThenRun`, `runner.ts#L123-L130`).
- **Idempotency.**
  - `messageID` is client-suppliable (`prompt.ts#L657`; `PromptInput` `#L1501`).
  - The projector upserts on `MessageTable.id` (`T/packages/core/src/session/projector.ts#L269`), so a retried post with the same `messageID` does not duplicate the message.
  - Part ids are also accepted (`prompt.ts#L696`), and parts upsert too (`projector.ts#L320`).
- **Exactly-once design, built only from public APIs.** The lead should decide whether to adopt it.
  1. Derive a deterministic `messageID` per cloud event. It must be a valid ascending `MessageID`, generated once and stored with the event.
  2. Wait for idle, via `session.status` or `session.idle`/`session.status` events, before `promptAsync`.
  3. After posting, check that the session went busy, or that an assistant message with `parentID === messageID` appears. If neither happens, re-post the same id; the upsert stays harmless, and an empty `loop` via `/session/:id/...` triggers the reply.
  4. Alternatively, post with `noReply: true` and drive the reply separately.
- The plugin runs in-process, so delivery stops when the server stops. Persist pending events and replay them on the next start.

### 4. Provider request identity

What a custom `LanguageModelV3` receives on the legacy path:

- **Headers.**
  - For non-`opencode*` providers: `x-session-affinity: <sessionID>`, `X-Session-Id: <sessionID>`, `User-Agent`.
  - For subagent sessions only: `x-parent-session-id`.
  - Then `model.headers` and whatever `chat.headers` adds.
  - **No message ID, agent name, or purpose header.** `opencode*` providers get `x-opencode-request: <user message id>`. Source: `T/packages/opencode/src/session/llm/request.ts#L180-L205`.
  - These reach `doStream(options.headers)` through `streamText({headers})` (`llm.ts#L322`; `LanguageModelV3CallOptions.headers`, https://unpkg.com/@ai-sdk/provider@3.0.16/src/language-model/v3/language-model-v3-call-options.ts L114-L117).
- **providerOptions.**
  - `ProviderTransform.providerOptions` nests options under `providerID` for unknown npm packages (`T/packages/opencode/src/provider/transform.ts#L1462-L1471`).
  - The options are `ProviderTransform.options` (or `smallOptions` when `small`), merged with model, agent, and variant options (`request.ts#L80-L91`), then passed through `chat.params` (`#L114-L131`).
  - `promptCacheKey = sessionID` is set only for specific providers (`transform.ts#L1334`, `#L1381`).
- **`chat.params` and `chat.headers` inputs.** `{sessionID, agent: agent.name, model, provider, message: user}` (`request.ts#L114-L145`). A plugin can stamp `options.opencode = {sessionID, agent, userMessageID}` or headers such as `x-cursor-agent` and `x-cursor-user-message`.
- **Forks.** `Session.fork` copies parts, metadata included, under new ids and a new session id (`T/packages/opencode/src/session/session.ts#L691-L726`). Any Cursor conversation ID stored in part `providerMetadata` therefore travels into the fork, while `X-Session-Id` changes. The provider must treat a header/metadata session mismatch as a fork. It can either continue a cloned Cursor agent or start fresh.

### 5. Compaction, title, and other helper model calls

My earlier `small_model` claim was **wrong for compaction**.

| Helper | Model | Agent name sent to hooks | Tools | `small` | Path |
|---|---|---|---|---|---|
| Compaction | `agent "compaction".model`, otherwise **the user's current model** | `compaction` | `{}` | false | `T/packages/opencode/src/session/compaction.ts#L358-L361`, `#L393-L430` (assistant `mode:"compaction"`, `summary:true`) |
| Title | `agent "title".model`, otherwise `getSmallModel(provider)`, otherwise the user's model | `title` | `{}` | true | `T/packages/opencode/src/session/prompt.ts#L216-L236` |
| Project-copy name | small model or fallback | `project-copy-name` | `{}` | true | `T/.../handlers/project-copy.ts#L11-L46` |
| Session "summary" | No LLM call; it computes diffs only | — | — | — | `T/packages/opencode/src/session/summary.ts#L102-L125` |
| Normal turn | user/agent model | the user's agent name (`build`, `plan`, custom) | full tool set | false | `prompt.ts#L1265-L1285` |

Core seeds the helper agents `compaction`, `title`, and `summary` (`T/packages/core/src/plugin/agent.ts#L180-L194`).

- **Helper detection.**
  - An empty `tools` set alone **is not** a reliable signal: a user agent can disable tools, and `json_schema` turns change `toolChoice`.
  - The reliable signal is `chat.params`/`chat.headers` `input.agent ∈ {compaction, title, project-copy-name}`. Optionally combine it with `input.message` and the compaction assistant's `summary:true`, which is not passed to the hooks.
  - Compaction sends one synthetic user message containing the serialized history (`compaction.ts#L425-L440`). Title sends the "Generate a title..." prefix.
- **Recommendation for the lead.** A companion backend plugin stamps `agent` and purpose into `providerOptions` via `chat.params`. The provider runs helper calls as stateless, tool-less completions on a separate Cursor session. It never reuses the live coding agent and never emits tool calls, since compaction throws on any tool call (Gate step 10). Without the plugin, the provider sees only `X-Session-Id` and cannot tell a title call from a turn.

### 6. Backend-to-TUI channel for deterministic `/cloud` commands

- **Backend plugins cannot register TUI commands, routes, or RPC.** Their only reachable channels are server HTTP routes through `client`:
  - `tui.executeCommand({command})` publishes `tui.command.execute`, and the TUI calls `keymap.dispatchCommand(command)`, but only when the workspace matches (`T/packages/tui/src/app.tsx#L987-L990`);
  - `tui.publish`, limited to the union PromptAppend, CommandExecute, ToastShow, and SessionSelect (`T/.../groups/tui.ts#L12-L34`);
  - `appendPrompt`, `submitPrompt`, `clearPrompt`, `showToast`, `selectSession`;
  - `tui.control.next/response` (`groups/tui.ts#L113-L191`).
- **Inbound path from the TUI to the backend.**
  - A TUI plugin registers a `/cloud` command with `keymap.registerLayer` (or the deprecated `slash`). Its handler can call `api.client.*`, which is the same server, plus `session.command` for prompt-template commands.
  - The server exposes **no public route that runs a plugin tool directly**. `experimental` offers only `tool.list`/`tool.ids` (`groups/experimental.ts#L158-L170`).
  - TUI plugins receive no event stream from custom backend code. Both sides see bus events, and `api.event.on` covers only the SDK `Event` union.
- **Options for a deterministic `/cloud`:**
  - (a) Implement the logic **in the TUI plugin itself** (it is plain JS/Bun with `client`, `kv`, dialogs, and routes). It can call Cursor Cloud directly and share a module with the backend plugin, but the two run in different processes when attached.
  - (b) Run a loopback HTTP server inside the backend plugin, reached by the TUI plugin. It is not a public API; it needs a port and token handshake via `kv` or a file.
  - (c) Use a prompt-template command that asks the model to call a `cursor_cloud_*` tool. This is not deterministic.
  - (d) Have the TUI plugin write a user message with `noReply` carrying a marker, which the backend plugin's `event` or `chat.message` hook acts on. This is a hack and exactly-once is unproven.
- Inference: backend and TUI plugins share a process only in the default local `opencode` run; with `attach`, they do not. Use (a) for determinism, with backend tools for model-driven cloud use.
- **Lead decision (supersedes the recommendation above):** option (a) is rejected. A Cursor owner in the TUI splits state from the backend tools, even when both share a process. The default-run topology is unverified, so the plan assumes no shared singleton. The plan proposes one backend owner with a local authenticated adapter, a variant of (b). The token discovery via `kv` or a file is the plan's own design. This report found no OpenCode feature for it. Remote-attached TUIs fail closed. See `../plan.md`.

## Gaps and suggested next steps

1. **Spike the gate.** Use a mock `LanguageModelV3` loaded via `file://`. Emit a provider-executed dynamic `tool-call`, then a `tool-result`, then `finish: stop`. Check for no local execution, a stored part, replay on the next turn, and the `GenericTool` rendering.
2. Confirm the name-collision parse behavior (Gate step 3) in the same spike.
3. Confirm the busy-session race (Round 2, item 3) with two quick `promptAsync` calls. Measure whether the second gets a reply without a nudge.
4. Confirm whether `{plugin,plugins}/*.ts` v1 files also produce v2-loader noise. This is cosmetic.
5. Target choice: v1.18.x (legacy runtime, v1 hooks, provider package) or 2.x (core runtime, `aisdk.language`, Effect plugins). The evidence favors building the provider as a plain `LanguageModelV3` package, which both runtimes accept, with thin version-specific plugin shells.
6. Packaging: OpenCode imposes no keyword rule; a dedicated `opencode-extensions` repo is unconstrained by OpenCode.
