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

## Scope of release validation

Editing release tooling, CI, installers, build metadata, or this guide is not a
release. Apply the [canonical F1 applicability policy](../../skills/f1-test-drive/SKILL.md#applicability-required-before-setup)
to the actual changed behavior. Use targeted script/unit/integration tests,
package inspection, and isolated install/CLI smoke checks as appropriate. When
no F1-covered behavior changes, a brief PR validation note is enough; do not
run an unrelated F1 fixture or create an F1 report.

## Prepare a release

Release preparation remains a reviewed pull request. Start from current
`main`, create a release branch, and complete the existing release checklist:

1. Move both changelogs' Unreleased content into the new version section.
2. Set the same exact version in every package printed by
   `node scripts/release-packages.mjs list`.
3. Run `pnpm install` and commit `pnpm-lock.yaml` if it changes.
4. Assess the **entire released payload since the previous release**, including
   changes merged before this version-bump PR. For F1-covered runtime or harness
   behavior changes, run the F1 release test-drive protocol with scenarios that
   assert those changes and commit evidence under `apps/f1/test-drives/` with a
   filename ending in `-release-v<version>.md`. For payloads with no relevant
   workflow behavior change, use non-F1 release verification below instead.
5. Add every `package@version` entry to the release section in `CHANGELOG.md`.
6. Run `node scripts/release-packages.mjs validate <version>`.
7. Run `pnpm test:packages:run`, `pnpm typecheck`, and `pnpm build`.
8. Commit, push, open the release PR, and merge it to `main`.

The validator rejects version drift, missing packages, incorrect dependency
order, stale repository metadata, incomplete changelogs, and missing release
verification. Relevant F1 evidence remains required for runtime-bearing releases;
a version-only PR is not evidence of a nonfunctional payload.

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

## Non-F1 release verification

Use this only when review of the full payload finds no changed F1-covered
behavior. File categories alone do not establish applicability: dependency,
build, packaging, or prompt changes can alter installed runtime behavior.
A blocked F1 scenario is not a nonapplicable scenario.

1. Commit the prepared release payload, including versions and changelogs.
2. Fetch release tags and inspect the full diff from the previous release tag
   on the first-parent history to `HEAD`. Run all relevant targeted checks,
   including installer/build/release tests and install smoke checks where
   affected. The normal release workflow's audit, tests, types, build, tarball
   inspection, and install smoke gates still run.
3. Run `node scripts/release-evidence.mjs <version>` from the repository root.
   It prints `previousRelease`, `previousReleaseCommit`, and `payloadSha256`.
   This command binds evidence to the committed payload; it does **not** decide
   whether that payload is functional. If no previous release tag is available,
   restore the history before assessing applicability.
4. Create `docs/release-verification/v<version>.json` using those exact fields
   plus the fields below (replace the illustrative values with actual results):

   ```json
   {
     "version": "0.2.73",
     "previousRelease": "v0.2.72",
     "previousReleaseCommit": "<commit from command>",
     "payloadSha256": "<hash from command>",
     "f1Applicability": "not-applicable",
     "rationale": "Describe the complete payload and why it changes no F1-covered workflow behavior.",
     "checks": [
       {
         "command": "<actual targeted validation command>",
         "status": "passed",
         "result": "<observed result and scope or limitations>"
       }
     ]
   }
   ```

5. Have the release reviewer verify the behavior assessment and results against
   the full diff. Commit the evidence and run the release validator. It requires
   the previous release and payload hash to match, a nonempty rationale, and
   successful checks. Any subsequent payload change requires reassessment and
   fresh checks/hash. Only this evidence file is excluded from the hash.

This is release verification, not an F1 drive; no file belongs in
`apps/f1/test-drives/` for this case. Historical F1 evidence remains valid and
must not be deleted or relabeled. A functional release keeps the relevant F1
report route; no filename-based exemption or automatic skip is provided.

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
OIDC-capable CLI in dependency order, using `scripts/publish-release.mjs`.

### Ordered uploads and the final registry gate

The publishing script first reads every exact version. Only an explicit npm
`E404` counts as missing; transient errors are retried and never authorize a
publish. Any existing artifacts are checked together before new uploads:
requested tag, exact package/version, registry `dist.integrity`, and the full
uncompressed tar stream must match. An existing wrong tag or different artifact
stops recovery. Gzip compression differences remain allowed.

It then submits all missing artifacts sequentially in dependency order, without
waiting for each upload to propagate. A failed or timed-out publish is never
retried blindly: npm may already have accepted it. The final gate must establish
that the artifact exists and matches; otherwise the run fails.

After uploads, **every artifact, including recovered versions**, must pass the
final gate before any git tag or GitHub release. A single 10-minute deadline
covers the entire final phase. Each pass checks packages concurrently and
rechecks earlier successes, so changing a recovered package's tag cannot escape
verification. Checks include exact identity and tag, a SHA-512 check of the
download against registry integrity, and the gzip-normalized comparison with
the inspected local artifact. A content/integrity mismatch fails immediately;
missing versions, lagging tags, and transient read/download failures are retried
with up to 10 seconds between passes. Registry commands are time-limited and
share the phase deadline.

Preflight and recovery each also have one shared 10-minute deadline. Uploads
are limited to two minutes per npm command; the job's existing 45-minute limit
still bounds the entire run. Phase durations are printed in the workflow log.
These are failure bounds, not expected durations or speedup guarantees.

If the final gate fails, more packages may need recovery than with per-package
polling. Rerun the same reviewed source/version/tag only after inspecting the
failure. Dry runs perform preflight and recovery comparisons and list intended
uploads; they do not publish, require missing versions to appear, tag, or create
a release. A dry run cannot prove npm writes or real propagation timing.

Behavioral fixtures execute the workflow's publish/tag/release steps with fake
npm, registry downloads, git, and GitHub commands:

```sh
pnpm --filter cyrus-ai test:run release-publish.test.ts release-workflow.test.ts
```

The baseline and synthetic-delay evidence are recorded in
[`2026-09-15-cypack-1521-release-verification.md`](../f1/test-drives/2026-09-15-cypack-1521-release-verification.md).

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
