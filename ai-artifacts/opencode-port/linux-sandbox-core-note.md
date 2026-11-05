# Linux sandbox core evidence

Worker: LinuxSandboxBackend. Checkout: `linux-sandbox`. Changes remain uncommitted.

The existing isolation API now selects sandbox-exec or guarded bubblewrap. Linux reexecs the trusted driver in private user, network, and PID namespaces. Bootstrap validates inherited original namespace descriptors, private proc, loopback-only interfaces and routes, positive external denials, and IPv4 and IPv6 loopback. It closes the descriptors before importing the runner. Original HOME survives the clean bootstrap environment as policy data.

Both backends preserve writable-root, host `/tmp`, Unix sockets, and exec defaults. Linux additionally makes masked read-denied targets and mask sources immutable to prevent chmod or replacement from bypassing denial. Only the canonical Node executable receives a read-only fixture-local alias when needed. Non-system Node libraries fail with an actionable error. No blanket read-only root or temporary-directory mask remains.

TUI uses `sandboxCommand` and a private per-run termctrl runtime. Preview SDK denial uses `extraReadDenials`.

## Verified on macOS

- `npm ci --ignore-scripts` and `npm run build` passed.
- `npx vitest run packages/opencode-cursor-sdk/test/unit/isolation*.test.mjs`: 14 passed, one explicit Darwin-kernel skip for Linux-only live proofs.
- Standalone `test/isolation/probe.mjs` passed, including quoted paths, denials, clean environment, IPv4, IPv6, and Unix sockets.
- Endpoints 2.0.0 and 2.2.5 passed SDK host, Cloud receipts, Cloud tools, requests, bridge, control host, composition, TUI standalone and attached-local, and preview both modes.
- Syntax checks and `git diff --check` passed.

No Linux or container execution, real Cursor calls, SDK calls, installed configuration changes, or root full check ran. Linux bootstrap, masks, Node alias, timeout-descendant cleanup, and host suites still require Linux execution. The CI probe hard-fails unusable required capabilities.
