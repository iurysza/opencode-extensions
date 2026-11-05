# rel1 build evidence

Local release automation is implemented and uncommitted. Activation approval and remote selection are still pending. Neither release workflow mutates anything unless repository variable `RELEASE_AUTOMATION_ENABLED` equals `true`.

## Verified locally

- `node --test scripts/release-*.test.mjs`: 17 passed, none skipped after the compatibility corrections. Fixtures cover root refusal, exact package allowlists, unknown tags, semver mismatch, cross-package tags, private packages, publication configuration, release-manifest mismatch, release ownership, and clean local tarballs without bundled SDK code. New cases accept release-please's exact SHA target and reject mismatched SHAs, abbreviated SHAs, arbitrary branches, and noncanonical resolved commit SHAs.
- `node --check` passed for all four `scripts/release-*.mjs` files, including tests.
- Existing PyYAML parsed all three workflow files. `bash -n` accepted every workflow `run` block. This verifies syntax, not GitHub Actions execution.
- `node scripts/release-check.mjs pack` packed and inspected both current workspace packages at version `0.0.0`. Temporary tarballs were removed. No npm publish command, including dry-run publication, ran.
- Production validation rejected both current child packages because they remain private.
- `git diff --check` passed.

The fixture tests invoke local `npm pack --ignore-scripts`. GitHub API responses are fixtures. No GitHub, npm publication, or Cursor credentials are needed by the tests.

## Integration still required

The parent owns final installation, build, and workspace checks. Add the release tests and local pack check to root verification after a build. Root scripts, root and child manifests, the root lockfile, and `scripts/check-layout.mjs` were not changed by this worker.

Release-please uses one grouped release PR with independent Node component versions, tags, and changelogs. `separate-pull-requests` is false. The `node-workspace` plugin retains its default candidate merging so the shared root-lock update stays coherent. The configuration regression requires this combination. The parent checked the plugin's merging and `postProcessCandidates` implementations. The actual first release PR and resulting lockfile update remain untested.

The metadata check now resolves the tag before validating its target. It accepts `main` or the exact canonical full tag-commit SHA, matching release-please's `target_commitish: release.sha`. Exact tag/SHA checkout checks and ancestry on `main` remain unchanged. No untrusted tag text enters shell source. Final parent snapshot and full checks against baseline `33191c2` remain the parent's verification step.

Keep children private until release-plan activation is approved. Production requires explicit public registry and provenance configuration. Record Cursor G8 terms and license review before enabling release automation. The pack allowlist cannot prove that arbitrary copied proprietary code is absent from otherwise valid project sources.

The optional host job is disabled by default. It needs a dedicated self-hosted macOS ARM64 runner with the existing isolation setup and `HOST_VERIFICATION_ENABLED == 'true'`. Portable CI does not establish host compatibility while that job is disabled. No host probes ran for this change.

No remote was created or configured. No secrets were read or provisioned. No commits, pushes, tags, releases, merges, global configuration changes, or real Cursor calls occurred.
