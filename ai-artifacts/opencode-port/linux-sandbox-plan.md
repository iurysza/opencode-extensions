# Linux host sandbox plan

Branch: `linux-sandbox`, based on `cursor-port` at `97933a8`. Worktree: `~/dev/worktrees/opencode-extensions/linux-sandbox`.

This changes the test harness, not Cursor-native permission enforcement. Production currently does not invoke `sandbox-exec`. No live Cursor calls or installed configuration changes are authorized.

## Backend and policy

Keep the existing isolation interface. Define filesystem read denials, clean HOME/XDG environment, network and executable rules once. Map that policy to macOS sandbox profiles and Linux bubblewrap arguments. Select by platform and fail closed on missing tools, unsupported platforms or unusable namespace capabilities.

Linux must put the whole trusted host-test driver and its children in one private loopback namespace. Per-child `--unshare-net` would break driver/backend communication; bare host `--share-net` would permit external traffic. Never trust an environment marker as proof of isolation. Validate bootstrap namespace evidence, loopback reachability and external-network denial. Carry the original HOME/denied-path policy through bootstrap rather than recomputing it after HOME is isolated.

Use private PID/proc views to prevent `/proc/<host-pid>/root` aliases. Read-denied targets must fail positively, not merely return empty content or disappear. Drop capabilities and make denial masks immutable. Support the exact Node executable when it lives under an otherwise denied tool directory, without exposing that directory or credentials. TUI starts must use the same command builder and a private termctrl runtime.

## Fixtures and CI

Select integrity-checked CLI packages by OS/architecture rather than assuming Darwin ARM64. Reject mismatched cached fixture metadata. Add bubblewrap and its live capability/host probes to the existing Ubuntu job; keep the existing optional macOS runner, without inventing another macOS matrix. Missing optional terminal-test tooling may skip only its own tests with a concrete reason. Required sandbox capabilities must not become an unsandboxed fallback or a green CI skip.

## Verification and commits

Unit-test shared policy, macOS profiles, Linux argument order, capability failures and bootstrap guards on this Mac. Run the portable build/check/pack loop and available macOS host regressions. Gate actual bubblewrap execution on Linux and its capability probe. No Linux runtime pass is claimed here.

Commit dependency-coherent slices as `iury souza <iurysza@gmail.com>` without co-author trailers. Report progress and the final commit in the existing `opencode port` Inbox thread. Do not modify `cursor-port`, the frozen alpha, other worktrees or panes. No merge, publish, tag, push, remote creation or history rewrite.
