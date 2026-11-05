# Run the Linux sandbox tests

Run these commands from the `linux-sandbox` repository root on a Linux x64 or ARM64 glibc host. These tests use fake Cursor responses or offline SDK storage. They do not authorize live Cursor calls, `Agent.send`, real resume, Cloud execution, or real credentials.

## Prepare the host

Use Node.js 22.22.3, as pinned in CI, and npm. Node 22.18.0 also passed the full Linux run on 2026-11-05. Keep system `tar` available for fixture extraction. On Debian or Ubuntu, install the sandbox tools:

```sh
sudo apt-get update
sudo apt-get install -y bubblewrap perl
```

The sandbox needs unprivileged user, mount, PID, and network namespaces, a private `/proc`, and working IPv4 and IPv6 loopback. Perl is required by the denial checks. If Node lives under a denied tool directory, its alias check needs system `ldd`, provided by Debian's `libc-bin` package. Node's shared libraries must remain available from system library directories.

AppArmor can forbid bubblewrap's user namespace creation. Containers and managed hosts can also restrict namespace operations. Installing `bubblewrap` alone does not prove that the sandbox works. Do not disable AppArmor, change security sysctls, grant broad container privileges, or remove namespace flags to force a pass. Use a host whose administrator permits the required isolated execution.

## Require the sandbox proof

Before acquiring CLI fixtures or running host tests, run the probe:

```sh
node packages/opencode-cursor-sdk/test/isolation/probe.mjs
```

Require exit status 0 and a JSON result containing `"pass": true` and `"backend": "bubblewrap"`. The probe must establish namespace capabilities, positive read and external-network denials, and private-loopback communication. A missing tool, denied namespace operation, or failed proof is a failure, not a skip. The probe needs neither the Cursor SDK nor an OpenCode CLI fixture.

The trusted test driver and its children share one private loopback network. The checks must reject external access without exposing host loopback services. DNS errors, timeouts, and missing files alone are not denial proof. Fixture HOME and XDG paths remain isolated from your real OpenCode and agent configuration.

## Build and acquire the endpoint fixtures

Install dependencies without lifecycle scripts, then build and check:

```sh
npm ci --ignore-scripts
npm run build
npm run check
```

Acquire only the two pinned endpoint versions before runtime isolation:

```sh
node packages/opencode-cursor-sdk/test/matrix/acquire.mjs 2.0.0 2.2.5
```

Acquisition uses network access to public npm metadata and `npm pack --ignore-scripts`. It does not install the CLI or execute it. On Linux, expect `target.package` to be `@opencode/cli-linux-x64` or `@opencode/cli-linux-arm64`, matching your Node OS and architecture. Each result must report `fetched`, `extracted`, or `reused` with matching registry sha512 integrity.

The binary path remains `.fixtures/inspect/bin-VERSION/package/bin/opencode`. `acquired.json` records the selected package, OS, architecture, registry integrity, and binary integrity. Missing, malformed, or mismatched cache metadata cannot authorize binary reuse. A verified target tarball can be re-extracted without downloading it again. Do not copy a Darwin binary into the Linux fixture path.

## Run the required offline tests

```sh
npm run test:host
npm run test:req
npm run test:t2
```

Require every command to exit 0 with passing per-version checks at `2.0.0` and `2.2.5`. Inspect `.fixtures/t1`, `.fixtures/req`, and `.fixtures/t2` for summaries and captured output. These commands enforce isolation themselves. Passing unit tests alone does not qualify Linux runtime isolation.

Do not substitute `test:t2-create` or a live Cursor run for the offline `test:t2` command.

## Run terminal tests when available

`termctrl` is optional terminal-test tooling. Its absence permits only a terminal-test skip:

```sh
if command -v termctrl >/dev/null 2>&1; then
  npm run test:tui
else
  printf '%s\n' 'SKIP test:tui: termctrl is not installed; required sandbox and offline tests remain mandatory'
fi
```

If `termctrl` exists but the sandbox or terminal test fails, report the failure. Do not turn that failure into a platform skip.

## Verification status

The acquisition and target-selection units run on the development Mac with fake npm and extraction boundaries. Public npm metadata confirms both endpoint packages for Linux x64 and ARM64. No Linux runtime, container execution, or live bubblewrap proof was run there. The Ubuntu CI steps and this procedure still need a successful Linux execution. See [Fixture and CI evidence](./linux-fixtures-ci-note.md).
