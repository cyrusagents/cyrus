# Releasing the Cyrus CLI

Cyrus releases are published on demand by
`.github/workflows/release-cli.yml`. A CLI release is a coordinated monorepo
release: the workflow packages and publishes every public Cyrus workspace in
dependency order before publishing `cyrus-ai`.

The publish boundary uses npm trusted publishing with GitHub Actions OIDC. It
does not read or store a long-lived npm publish token.

## One-time npm configuration

Configure the trusted publisher on every package listed by
`node scripts/release-packages.mjs list` with these exact values:

| npm setting          | Value             |
| -------------------- | ----------------- |
| Publisher            | GitHub Actions    |
| Organization or user | `cyrusagents`     |
| Repository           | `cyrus`           |
| Workflow filename    | `release-cli.yml` |
| Environment          | Leave blank       |
| Allowed actions      | `npm publish`     |

Each npm package permits one trusted publisher. The workflow filename and
repository identity are part of npm's trust policy, so renaming either requires
updating every package's configuration before the next release.

With npm 11.15 or newer, a maintainer can configure each existing package from
the CLI after authenticating with 2FA:

```bash
node scripts/release-packages.mjs list | while IFS=$'\t' read -r _ package; do
  npm trust github "$package" \
    --repo cyrusagents/cyrus \
    --file release-cli.yml \
    --allow-publish \
    --yes
done
```

## Prepare a release

Release preparation remains a reviewed pull request. Start from current
`main`, create a release branch, and complete the existing release checklist:

1. Move both changelogs' Unreleased content into the new version section.
2. Set the same exact version in every package printed by
   `node scripts/release-packages.mjs list`.
3. Run `pnpm install` and commit `pnpm-lock.yaml` if it changes.
4. Run the F1 release test-drive protocol and commit its evidence under
   `apps/f1/test-drives/` with a filename ending in
   `-release-v<version>.md`.
5. Add every `package@version` entry to the release section in `CHANGELOG.md`.
6. Run `node scripts/release-packages.mjs validate <version>`.
7. Run `pnpm test:packages:run`, `pnpm typecheck`, and `pnpm build`.
8. Commit, push, open the release PR, and merge it to `main`.

The validator rejects version drift, missing packages, incorrect dependency
order, stale repository metadata, incomplete changelogs, and missing F1 release
evidence.

Before a release workflow can publish, every package listed by
`node scripts/release-packages.mjs list` must already exist on npm. npm trusted
publishing cannot create a package on its first publish, so adding a new public
workspace requires a one-time bootstrap through the approved npm first-publish
process. After that initial version exists, configure the package's GitHub
Actions trusted publisher with the exact `cyrusagents/cyrus` repository and
`release-cli.yml` workflow:

```sh
npm trust github <package-name> \
  --repo cyrusagents/cyrus \
  --file release-cli.yml \
  --allow-publish \
  --yes
```

The release workflow preflights package existence before installing
dependencies or publishing anything. If a package is missing, it stops with
the bootstrap and trusted-publisher instructions instead of partially
publishing the dependency graph.

## Dispatch a release

From GitHub, open **Actions → Release Cyrus CLI → Run workflow**, select
`main`, enter the exact committed version, and choose the npm distribution tag.
Use **dry run** to exercise every local verification step without publishing,
tagging, or creating a GitHub release.

The equivalent CLI command is:

```sh
gh workflow run release-cli.yml \
  --ref main \
  -f version=0.2.68 \
  -f dist_tag=latest \
  -f dry_run=false
```

The workflow refuses non-`main` refs, duplicate live releases, version drift,
and an existing release tag. If a run stops after publishing only part of the
package graph, rerun the same version and distribution tag: the workflow skips
immutable versions only when the published tarball's complete uncompressed tar
archive matches the artifact packed by the recovery run and already carries
that tag, then resumes publishing the remaining packages. This normalizes gzip
compression differences without accepting a package whose files, metadata, or
archive order differs. It will not resume when an existing version points at a
different distribution tag or has different package contents, which prevents
one release from combining package artifacts from different commits. Dry runs
exercise these recovery comparisons and report which missing packages a live
run would publish. The workflow performs a frozen install and
audit, runs lint, tests, type checks, and the full build, then packs every
package using pnpm so `workspace:*` references become exact published versions.
It inspects each tarball, installs all local release tarballs together so the
CLI smoke test does not depend on unpublished internal versions, verifies
`cyrus --version`, and publishes the same inspected artifacts through npm's
OIDC-capable CLI. npm registry visibility is retried before advancing to the
next package. After all packages are visible on npm with the requested tag, it
creates `v<version>` and the matching GitHub release.

## Post-release

Move each Linear issue referenced in the version's changelog section from
`MergedUnreleased` to `ReleasedMonitoring`. The workflow summary prints the
issue identifiers as a reminder. Then verify the public CLI independently:

```sh
npm view cyrus-ai@0.2.68 version
npx cyrus-ai@0.2.68 --version
```

After the first successful OIDC release, set every package's npm publishing
access to **Require two-factor authentication and disallow tokens**, then
revoke obsolete automation publish tokens. Trusted publishing continues to
work because it uses short-lived, workflow-specific credentials.
