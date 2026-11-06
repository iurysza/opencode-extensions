# Linux fixture and CI evidence

Scope: fixture acquisition, the existing verification workflow, and Linux test instructions on branch `linux-sandbox`, based on `97933a8`. This note does not claim Linux runtime proof.

## Public package evidence

Read-only registry queries confirmed the actual target names at both pinned endpoints:

```sh
npm view @opencode/cli@2.0.0 name version optionalDependencies --json
npm view @opencode/cli@2.2.5 name version optionalDependencies --json
```

Both versions declare exact-version optional dependencies on `@opencode/cli-darwin-arm64`, `@opencode/cli-linux-x64`, and `@opencode/cli-linux-arm64`. Each package was also queried at both versions:

```sh
for target in darwin-arm64 linux-x64 linux-arm64; do
  for version in 2.0.0 2.2.5; do
    npm view "@opencode/cli-$target@$version" name version os cpu dist --json
  done
done
```

All six responses matched the requested package, version, OS, and CPU and supplied sha512 integrity with an npm registry tarball URL. All six also passed the new `validatePackageMetadata` parser. The four Linux integrity strings below were compared directly with fresh exact-version registry responses and matched:

| Package | Version | `dist.integrity` |
| --- | --- | --- |
| `@opencode/cli-linux-x64` | `2.0.0` | `sha512-JoSDM2QGQj7tmWqXef5n1en6q1hPr62dO97Q96ii876pTxq63ldT3ttjs2wxvC+gYHzG3RDlToXKMQquUlhgkg==` |
| `@opencode/cli-linux-x64` | `2.2.5` | `sha512-BkHAfTqNsg/qphyHNrnH+DGkOxZsGjamNpM5DvwoEvz7ZAPNw8mEbMXGTCDOAH+/+40Eqeie6KNZBZZQwPCjaA==` |
| `@opencode/cli-linux-arm64` | `2.0.0` | `sha512-BmziWii5hf49tYFiwddATm4/iUMyJMZQr+6fg65uQQJbI9nK8H8zzrAwzY9tHpOm8Si4+A2E9MvbG6I5YXUB9w==` |
| `@opencode/cli-linux-arm64` | `2.2.5` | `sha512-O4qOy/WRYQmhClMB/5qBaoYfzaDK1+PJRQOfU80ixyj5ruQbCxraH+VW2UyHb6RWOlUv41fec+isd62LvCuwuA==` |

Acquisition reads exact-version metadata again and verifies the downloaded bytes. This table is evidence, not an alternative trust source. No Linux CLI tarball was downloaded or executed during this worker's verification.

## Acquisition changes

`cliTarget` selects only the existing macOS ARM64 target and the confirmed Linux x64 and ARM64 targets. Other OS and architecture pairs fail before acquisition. Linux selection uses the published glibc package names, not musl or baseline variants.

Registry package identity, exact stable 2.x version, OS, CPU, tarball URL, and sha512 integrity must validate before cache use. A cached binary also needs matching target metadata and matching tarball and binary hashes. Old metadata without the target fields cannot authorize reuse. A verified tarball can repair a stale extracted fixture without another download. Extracted package identity is checked before writing fresh metadata.

The shared binary layout remains `bin-VERSION/package/bin/opencode`. Target-specific tarball names can coexist under `cli-VERSION`. Endpoint-only acquisition does not query or download a moving latest version. The full matrix retains its existing declared-version and latest-stable-2.x selection.

## CI changes

The existing `portable` job still uses `ubuntu-latest` and Node 22.22.3. It now installs `bubblewrap` and Perl and runs `test/isolation/probe.mjs` as a mandatory command. There is no skip, `continue-on-error`, or security-policy weakening around that proof.

After the build and portable checks, CI acquires only `2.0.0` and `2.2.5` for its actual Linux target. It then runs `test:host`, `test:req`, and offline `test:t2` under their required isolation. No live Cursor creation, resume, send, or Cloud run was added. The optional self-hosted macOS ARM64 job and its existing activation gate remain unchanged. No new macOS job or matrix was added.

Release workflows, activation gates, and secret references are unchanged. Release automation remains disabled unless its existing repository-variable gate is enabled. No secret values were read.

## Verification

On macOS, this scoped command passed with two files and 52 tests:

```sh
node_modules/.bin/vitest run --root packages/opencode-cursor-sdk \
  test/unit/matrix-acquire.test.mjs test/unit/matrix-target.test.mjs
```

The tests cover host-default and injected Linux selection, explicit unsupported targets, registry validation at both endpoints, npm arguments, cross-platform cache replacement, malformed metadata, corrupted tarballs and binaries, and extracted package identity. Npm and extraction are fake boundaries. No SDK or CLI is executed.

`node --check` passed for `acquire.mjs` and `versions.mjs`. The existing workflow-policy test also passed without running its unrelated pack cases:

```sh
node --test --test-name-pattern='grouped release PR' scripts/release-policy.test.mjs
```

`git diff --check` passed.

The isolation worker owns dependency installation, the probe implementation, and runtime verification. This worker did not run installation, the root build/check, host probes, Linux commands, or containers. Linux namespace behavior and actual Ubuntu CI results remain unverified. Follow [Run the Linux sandbox tests](./linux-test.md) on the Linux host.
