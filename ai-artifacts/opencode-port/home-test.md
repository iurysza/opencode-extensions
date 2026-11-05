# Prepare an isolated manual preview

This private alpha is ready for Iury's first manual home smoke test. The combined build, checks, package inspections, isolated host probes and rendered TUI tests pass. The actual generated configuration also loaded on OpenCode 2.0.0 and 2.2.5 without importing or calling the SDK. Runtime tests so far use macOS ARM64.

No live Cursor prompt ran during implementation. A manual prompt can cost money. This is not full parity or a release-ready build. Agents still need separate approval for live calls.

## Prepare the config without starting OpenCode

From this worktree, build both packages and print the local-only config:

```sh
npm run build
node scripts/home-preview.mjs
```

To save it under this worktree:

```sh
node scripts/home-preview.mjs --write
```

The script checks `dist/server.js` and `dist/tui.js`, then targets each package's `dist` directory. OpenCode's directory loader probes `server.js` and `tui.js` directly there; a filesystem package-root target does not resolve through package exports. The generated file is `.fixtures/home-preview/opencode.json`, mode `0600`. It contains paths and a model ID, never a key. The script creates preview HOME and XDG directories, reads no key, starts no process, and changes no live OpenCode config.

The default config loads only the SDK package, with local runtime selected. Background delegation tools are absent. To expose the separately billable background Cloud tools deliberately:

```sh
node scripts/home-preview.mjs --write --include-cloud
```

This opt-in prints a Cursor Max Mode billing warning. It still starts nothing. A model using the local SDK bridge can call those background tools once they are loaded, so keep them out of the first hello smoke.

## Run the first manual test

Use the verified local OpenCode 2.2.5 binary, so no global installation or update is needed. From the worktree, put it first on this shell's path:

```sh
export PATH="$PWD/.fixtures/inspect/bin-2.2.5/package/bin:$PATH"
opencode --version
```

The output must be `opencode v2.2.5`. This changes only the current shell, not a profile or live config. Do not paste a key into config files, commands, or shell history. In Bash or zsh, read it silently:

```bash
set +x
printf 'Personal Cursor API key: '
IFS= read -r -s CURSOR_API_KEY
printf '\n'
export CURSOR_API_KEY
```

The host-stored personal key wins over `CURSOR_API_KEY`. Team Admin keys are not supported. These plugins never read Pi, Cursor CLI, or Cursor Desktop credential files.

From the worktree, record the preview path, then change to the directory you actually want Cursor to work on:

```sh
PREVIEW="$PWD/.fixtures/home-preview"
cd /path/to/your/checkout
env -u PI_CURSOR_RUNTIME -u PI_CURSOR_CLOUD_ACK \
HOME="$PREVIEW/home" \
XDG_CONFIG_HOME="$PREVIEW/config" \
XDG_DATA_HOME="$PREVIEW/data" \
XDG_STATE_HOME="$PREVIEW/state" \
XDG_CACHE_HOME="$PREVIEW/cache" \
OPENCODE_CONFIG="$PREVIEW/opencode.json" \
OPENCODE_DISABLE_PROJECT_CONFIG=1 \
OPENCODE_DISABLE_MODELS_FETCH=1 \
OPENCODE_DISABLE_AUTOUPDATE=1 \
opencode
```

The launch command clears inherited runtime and acknowledgment selectors without pinning `PI_CURSOR_RUNTIME=local`. A later runtime control can therefore select Cloud. Use a new preview session for the first local smoke; an earlier explicitly acknowledged session retains its stored runtime.

This is a manual command, not an instruction for the implementation agent to execute. Preview isolation separates config and storage; it is not a filesystem or network sandbox. Cursor native tools can edit files and run commands in your checkout without OpenCode permission prompts. Cursor SDK sandbox and autoReview controls are not OpenCode enforcement. Their setting adapters are unavailable in this build.

After the manual test, exit OpenCode and run `unset CURSOR_API_KEY`. The preview directory remains under the worktree. Nothing copies it to `~/.config/opencode`.

## First manual local smoke

After parent review and explicit live-run approval, use a disposable checkout or scratch directory, not a checkout with valuable uncommitted work. Keep the SDK-only preview config and start a new session.

1. Open the model selector and select the configured `cursor/composer-2.5` model.
2. Send only: `Reply READY without using tools`.
3. Check the response and the prompt footer's `Cursor:` status. After the run finishes, the status should return to `idle`. This is the status display; there is no `/cursor-status` palette command.
4. Open the native command palette. Under the **Cursor** group, choose `/cursor-runtime` and keep `local`. The direct palette command `/cursor-runtime-local` also selects local. Do not select `/cursor-runtime-cloud` for this first smoke.

This is a supervised private-alpha SDK trial, not full live parity. A no-tools request is guidance, not a permission boundary. Helpers still refuse, and settings marked unavailable remain unavailable. Stop and record any helper, SDK, or UI failure rather than switching on Cloud or changing safety settings to work around it.

## Enable foreground Cloud deliberately

Foreground Cloud is part of the SDK package. It does not require the background Cloud package. Start local, then use the runtime control and accept its disclosure:

> Cursor executes remotely. Runs use Cursor API Max Mode pricing and can require a spend limit. Cloud sees remote Git state, not local or unpushed changes. Local tools, MCP, skills, and environment variables are not forwarded. Agents persist until you explicitly archive or delete them. Cursor can branch, commit, push, and open PRs.

The fixed RPC requires the acknowledgment token and persists consent in host session storage before switching. Cancelling writes nothing. Project options and project acknowledgments never grant consent. A failed settings write prevents the switch. A pending local run blocks it; an idle pooled agent does not.

For an explicit remote repository and ref, set these non-secret environment values before starting OpenCode:

```sh
export PI_CURSOR_CLOUD_REPO=https://github.com/OWNER/REPO
export PI_CURSOR_CLOUD_BRANCH=main
```

The pure resolver also supports `PI_CURSOR_CLOUD_CONTEXT=fresh|bootstrap|never`. `fresh` is the default. Leave `PI_CURSOR_RUNTIME` unset for the local-first preview. Consent in `PI_CURSOR_CLOUD_ACK` is deliberately ignored by this composition. The user confirms through RPC instead.

Use a clean tracked checkout with current remote-tracking evidence and no unpushed commits. Foreground Cloud runs the full local Git-state preflight before create. Do not bypass dirty or unpushed state to make a preview pass. Environment forwarding remains rejected, including aliases. Project runtime, repository, and safety overrides fail closed because OpenCode has no proven trust API.

Foreground archive and delete require explicit confirmation and a ledger-recorded `bc-` ID owned by this session. Background cancellation and deletion require confirmation over RPC and operate only on this process's agents. Plugin shutdown detaches from Cloud; it never automatically cancels or deletes remote work.

## Known beta gaps

- Helpers refuse until G4b passes. Select a separately approved non-Cursor helper model if needed. The 2.2.5 generate endpoint retries the refusal until interrupted.
- Durable local resume and confirmed resume cleanup are unavailable. Local ownership starts fresh after restart.
- Fast, mode, tools, HTTP, resume-cleanup settings, and explicit model-cache refresh return `not_implemented`. They do not pretend to save ignored options.
- Models and status reads never start an SDK or Cloud operation. RPC model lists are bundled real fallback IDs, not live discovery. Foreground selection accepts only fallback-catalog parameters and the default variant.
- `refreshConfig` rereads and validates host storage and project options. This is not an editor for local SDK settings. Environment values are captured at setup.
- Public RPC transport and state pushes have isolated real-host evidence. The control owner separately proved rendered standalone and attached-local TUI behavior at 2.0.0 and 2.2.5 with fake action owners. Intermediate OpenTUI lines and live-action parity remain unverified. See [control evidence](./control-tui-note.md). No exact Pi transcript-card parity is claimed.
- Background service ports and foreground cleanup lack an AbortSignal parameter. RPC validates abort before dispatch and suppresses aborted replies, but cannot cancel an in-flight SDK create/delete. SDK create is not claimed cancelable. Shutdown never turns an interrupted RPC into remote auto-cancellation.
- G1, G4b, G7 live behavior, the complete compatibility matrix, terms review, and release approval remain separate gates. T1 fake-SDK results are not live Cursor proof.

See [runtime composition evidence](./runtime-composition-note.md) for exact ports and test commands.
