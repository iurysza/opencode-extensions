# Package integration evidence

## Solid peer conflict resolved

Root development pin and lock now use `solid-js@1.9.16`, after `npm view` confirmed that exact version. Script-disabled installation succeeded. Both `npm ls` and the scoped recursive UI dependency check pass. No Babel override was added.

TUI owner handoff through parent: native types now use Solid `1.9.16` with unchanged OpenTUI `0.8.0` pins. All 52 layout/release tests, layout validation, exact metadata assertions, and whitespace checks pass.

Core's Node engine warning remains documented. Runtime uses host-shared OpenCode Bun, not standalone Node UI execution. Full build and root check remain with the parent.

Remote choice `iurysza/opencode-extensions` is confirmed by Inbox `msg_redacted`. No repository creation, remote configuration, release-variable activation, publication, push, or commit occurred. Root and children remain private.


## Native TUI metadata followup

Native types are available. Approved script-disabled installation added pinned root development dependencies `@opentui/solid@0.8.0`, `@opentui/core@0.8.0`, and `solid-js@1.9.12`.

Both children now declare optional UI peers: OpenTUI `>=0.5.10 <0.9`, Solid `>=1.9.0 <2`. The minimum host's public manifest supplies the Solid minimum. Both add `.` mapped to `./dist/server.js`, preserving existing exports.

Added SDK `test:bridge` and Cloud `test:hosttools`, plus root workspace aggregators. Existing `test:host` remains unchanged. Control runner wiring awaits owner proof.

The lock adds 103 entries versus `bc62186`, with no removed entries or existing version changes. Installation added 96 local packages. All 52 layout/release tests, declaration-file resolution from both children, layout, and whitespace checks passed.

Warnings remain: core requires Node `>=26.4.0` versus local `22.22.3`. Parent retained the pins because runtime uses host-shared Bun. `npm ls` fails because transitive `babel-preset-solid@1.9.16` requires Solid `^1.9.16`. Parent direction on this conflict is pending.

All manifests remain private. No runtime import, SDK execution, build, host test, lifecycle script, or commit ran. Final integration remains with the parent.


## Initial integration record

The following records the first metadata pass in `~/dev/worktrees/opencode-extensions/cursor-port`, based on `33191c2`, before the native TUI followup above. Source writers retain their files. Final build, root check, and workspace tarball verification remain pending with the parent.

## Manifest and layout changes

- Both child packages declare the normal runtime dependency `@cursor/sdk` at exactly `1.0.37`. The SDK package retains `@ai-sdk/provider` at `3.0.8`.
- Cloud adds `./server` mapped to `./dist/server.js`. Both packages add `./tui` mapped to `./dist/tui.js`. Existing exports remain unchanged, including Cloud `./completion` and `./receipts`.
- Both children list `dist`, `LICENSE`, and `README.md` as package files. Each child now contains an exact copy of the full root MIT license. No README was created.
- Both children specify public access, `https://registry.npmjs.org`, and provenance in `publishConfig`. Root and children remain `private: true`. Production validation still refuses both children.
- The layout guard replaces the obsolete Cloud SDK prohibition with an exact `dependencies["@cursor/sdk"] === "1.0.37"` check in both children. It also rejects dependencies between the two workspace packages. Existing private-root, exact-package-name, two-package, and single-root-lock checks remain.
- Root `check` now runs the layout and release test files before the existing layout, typecheck, and unit-test commands. Root `check:packs` runs `node scripts/release-check.mjs pack` separately and requires a completed build. No host command or existing test was removed.

## Lockfile and tests

`npm install --package-lock-only --ignore-scripts --no-audit --no-fund` succeeded. The root lockfile diff adds only the Cloud workspace's three-line `@cursor/sdk: "1.0.37"` dependency block. No package version, resolution, integrity, or transitive dependency changed.

Verified commands and assertions:

- `node --test scripts/check-layout.test.mjs scripts/release-*.test.mjs` passed all 52 tests, with no skips. This includes 35 layout tests and 17 release tests. Release fixtures use local tarballs and fake GitHub responses.
- `node scripts/check-layout.mjs` passed.
- `git diff --check` passed.
- Both child license files match root `LICENSE` byte for byte.
- `checkPackage` accepts both private children for local checks and rejects both in production mode with their matching `0.0.0` component tags.

No SDK execution, host tests, full build, full root check, or current-workspace tarball check ran in this lane. No child install, node_modules deletion, live configuration change, publication, commit, push, or tag occurred.

## Host runner handoff

These actual runner files exist and default to OpenCode `2.0.0` and `2.2.5`:

- SDK bridge: `node packages/opencode-cursor-sdk/test/bridge/run-host.mjs`
- SDK control: `node packages/opencode-cursor-sdk/test/control/run-host.mjs`
- Cloud tools: `node packages/opencode-cursor-cloud/test/t1/run-cloud-tools.mjs`

At the first pass, proposed separate child script names were SDK `test:bridge`, SDK `test:control`, and Cloud `test:hosttools`. They were not installed or run pending runner-owner stability confirmation. The followup above records the two confirmed commands now wired. Cloud `test/control` currently contains only `tsconfig.min.json`, not a runner. Existing child `test:host` commands remain unchanged.

The runners require the existing pinned CLI fixtures and fail-closed isolation. Their presence does not establish passing host evidence.

## Remaining integration

The parent owns final `npm run build`, `npm run check`, and `npm run check:packs` after source writers settle. The TUI worker owns `src/tui.ts` export targets.

Existing portable CI already builds before checking and packing. Both release and verification workflows separately invoke release tests after `npm run check`, so those invocations become redundant. The workflow owner was notified to remove duplicates. No workflow file was edited here, and the root check does not trigger another build or workspace pack.

Release activation and the Cursor terms review remain separate approval gates. This change does not configure the user's home setup or establish live Cursor behavior.
