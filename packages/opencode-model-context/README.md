# @iurysza/opencode-model-context

Server plugin for OpenCode 2.x. On each `context`, `compaction`, and `generate` request it reads `map.json` and one markdown file, then inserts that text at system index 1: after the harness base prompt, before the instructions part that contains AGENTS.md.

There is no TUI and no `@cursor/sdk` dependency. Loading the package does not read the map and does not touch the network.

## Where the files live

The directory is the first of:

1. plugin option `dir`
2. environment variable `OPENCODE_MODEL_CONTEXT_DIR`
3. `~/.agents/model-context`

That last path is where agents2 deploys `content/agents/model-context/`. This package does not ship those prompts. A missing `map.json` does nothing. Invalid JSON is an error: the hook logs it once and does not insert a part. A missing or empty prompt file does nothing. The map and the prompt are read on every request. Nothing is cached.

## Which file is chosen

Exact model id wins over a family regex, and a family wins over nothing. `modelFileStem` drops a provider prefix, a `:variant` suffix, and an `@...` suffix (`claude-opus-5-5@300k` looks for `claude-opus-5-5.md`). The full id is still an exact key. When the id contains `@`, that full key is tried before the stripped stem, so a map entry that keeps the suffix wins.

Lookup otherwise follows the Pi order: `provider/stem`, `stem`, `provider/id`, `id`, then the first matching family. Family patterns are case-insensitive. An invalid pattern is skipped.

## What is skipped

The plugin always skips provider `claude-agent`. It also skips every name in the option `skipProviders` and every name in the map's `skipProviders` (the shared map lists `claude-code`). Names are compared case-insensitively.

`cursor` is not in the default skip list. The local Cursor bridge forwards `system`: OpenCode joins the system parts into one `{ role: "system" }` message, and the bridge sends that prompt. Add `"cursor"` to `skipProviders` if a deployment should stay on the Pi path only. Cloud's default `fresh` handoff does not include system text; that is a handoff choice, not the bridge dropping the field.

An agent with its own `system` string is skipped. Both OpenCode 2.0.0 and 2.2.5 expose this as `ctx.agent.get({ agentID }).data.system`, and the plugin calls it on both.

## Hooks

`context`, `compaction`, and `generate` exist on 2.0.0 and 2.2.5, and the plugin registers all three. `title` is not hooked: a title request has no room for this part. If `session.hook` is missing, the plugin logs one line and does nothing. A hook that the host rejects is logged once and skipped. A thrown error inside a hook is logged once per distinct message and the request continues with no insert.

The public plugin context has no logger. Messages go to stderr.

## Built-in OpenCode prompts

This plugin does not remove the built-in provider prompts. They run before user plugins and rewrite system index 0. Remove them in `opencode.json` when you want only the agents2 text:

```json
{
  "plugins": ["-opencode.prompt.openai", "-opencode.prompt.anthropic"]
}
```

OpenCode 2.0.0 resolves a local directory as `server.js` and does not read `package.json` exports. This package keeps that file at the root for a directory load. It is not in the published tarball. An installed copy is resolved by package name, and both 2.0.0 and 2.2.5 follow the `./server` export to `dist/server.js`.

## Install

Point OpenCode at this package after `@iurysza/opencode-model-context` is on the machine, and keep the agents2 `model-context` directory in place:

```json
{
  "plugins": ["@iurysza/opencode-model-context"]
}
```
