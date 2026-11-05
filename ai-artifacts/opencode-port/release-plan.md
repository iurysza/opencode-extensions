# rel1 release automation

Status: local implementation only. Release activation and the remote choice remain pending in Inbox `msg_redacted`. The proposed remote is `iurysza/opencode-extensions`, not a created or configured repository. The alternative Pi repository remains undecided.

## Release flow

The private root never publishes. The two public npm package identities are fixed:

| Package | Component tag |
| --- | --- |
| `@iurysza/opencode-cursor-sdk` | `opencode-cursor-sdk-vX.Y.Z` |
| `@iurysza/opencode-cursor-cloud` | `opencode-cursor-cloud-vX.Y.Z` |

Release-please v4 follows the Clockwork and Pi Voice house workflows. After activation, a push to `main` updates one grouped Node release PR. Each package keeps its independent version, tag, and changelog. Merging the PR creates a GitHub release and tag for each released component. The `node-workspace` plugin keeps its default candidate merging and updates the shared root lockfile coherently within that PR. The root is not a release component. A real release PR has not been tested.

A published release triggers publication of only its matching package. Repository writers control release ownership. The workflow checks current GitHub release metadata against `context.repository` and resolves the exact tag commit. The release target must be `main` or that commit's canonical full SHA, as release-please uses. Other branches, abbreviated SHAs, and mismatched SHAs fail. After checkout, exact tag/SHA agreement and ancestry on `main` remain authoritative. The workflow checks out the tag, never the current branch tip.

Before the publish step receives `NPM_TOKEN`, validation requires canonical stable semver, exact package name and directory, and agreement among tag, package version, and release manifest. Private children fail. Publication also requires explicit `publishConfig` values for public access, provenance, and `https://registry.npmjs.org`.

Local tarball inspection accepts only compiled `dist` JavaScript and declarations, the package manifest, and named documentation files. It rejects dependency bundles, vendor directories, secrets, source maps, and files without matching local TypeScript sources. It compares archive bytes with the local build. External imports of the npm dependency `@cursor/sdk` are allowed. This is not proof against proprietary code copied into a project source file. G8 still requires manual source and license review.

No lifecycle hooks run during dependency installation, packing, or publication. The publish command uses the inspected tarball with explicit public access and provenance. Unknown tags and mismatched versions fail before npm credentials enter the job. Release tag text never enters shell source.

## Activation requirements

Keep repository variable `RELEASE_AUTOMATION_ENABLED` unset or different from `true` until Iury approves activation. The same explicit guard protects both release-please mutations and npm publication.

Before activation, the integrator must complete these requirements:

- Record Iury's remote choice and separate approval for remote actions.
- Record Cursor G8 terms review, license review, and the manual release gate. Automated pack checks do not satisfy terms review.
- Finish the remaining contract gates. Local release automation does not establish feature parity or live-test approval.
- Prepare approved child publish configuration and remove child `private: true`. Leave the root private. Current children intentionally remain private.
- Integrate `node --test scripts/release-*.test.mjs` and `node scripts/release-check.mjs pack` into the root verification path after a build. This worker does not own root scripts or the lockfile.
- Review the first release PR's package versions, shared lockfile, and separate tags before merging it.
- Configure repository protections and authorized release writers for `main`.
- Provision secret names `RELEASE_PLEASE_TOKEN` and `NPM_TOKEN` only through a separately approved operation. The release-please token must permit repository contents and PR updates and trigger downstream release workflows. No token values are part of this change.

## Verification boundaries

Every PR runs Ubuntu installation, build, workspace checks, release fixture tests, syntax checks, and real local tarball inspection. These checks do not run or claim macOS host probes.

The optional endpoint job requires `HOST_VERIFICATION_ENABLED == 'true'` and a trusted `main` push or dispatch. Its runner labels are `[self-hosted, macOS, ARM64]`. No GitHub-hosted ARM64 capacity is assumed. Provision a dedicated, disposable runner with no personal configuration or credentials and the existing fail-closed macOS sandbox setup before enabling it. PR code never runs on this self-hosted job.

That job acquires integrity-checked `@opencode/cli-darwin-arm64` tarballs for 2.0.0 and 2.2.5 before runtime isolation. Host, request, and offline SDK runners then enforce isolated HOME/XDG, `env -i`, and loopback-only sandbox checks. This endpoint job is not the full compatibility matrix. It makes no real Cursor calls and does not run the keyless Agent.create suite.

This local change creates no remote, secret, tag, release, publication, merge, or live configuration change. See [release build evidence](./release-build-note.md) for verified checks.
