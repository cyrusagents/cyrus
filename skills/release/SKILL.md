---
name: release
description: Prepare, verify, publish, and finish a coordinated Atmiko CLI release. Use when a user asks to release Atmiko, publish atmiko, run a CLI release, or perform the /release workflow.
---

# Release Atmiko

Run Atmiko releases through the trusted-publishing workflow. Do not publish
workspace packages manually.

## Required reference

Read `apps/cli/RELEASING.md` completely before taking release actions. Treat it
as the canonical operator guide and `scripts/release-packages.mjs` as the
canonical package list and dependency order.

## Workflow

1. Fetch `origin/main`, start from current main, and preserve unrelated local
   changes.
2. Prepare the release on a branch:
   - Move both changelogs' Unreleased entries into the new version.
   - Set the same version in every manifest printed by
     `node scripts/release-packages.mjs list`.
   - Run `pnpm install` and commit any lockfile change.
   - Run the F1 release test-drive protocol and save its report with the
     required `-release-v<version>.md` suffix.
   - List every released `package@version` in `CHANGELOG.md`.
3. Run `node scripts/release-packages.mjs validate <version>`, then all checks
   required by `apps/cli/RELEASING.md`. Fix failures before continuing.
4. Commit, push, open the release PR, and merge it to `main` before dispatching
   the workflow. Never publish unmerged source or a non-main ref.
5. Dispatch `.github/workflows/release-cli.yml` from `main` in dry-run mode and
   monitor it through completion.
6. Only when the user has explicitly requested the live release, dispatch the
   same exact version with `dry_run=false`. Monitor it through npm publication,
   git tagging, and GitHub Release creation.
7. Independently verify the version on npm and run the published CLI's
   `--version` command.
8. Use the Linear integration to move every issue referenced by the version's
   changelog section from `MergedUnreleased` to `ReleasedMonitoring`.

## Safety

- Never add an npm token. Publishing must use GitHub Actions OIDC.
- Confirm every npm package trusts `nexmoe/atmiko` and
  `release-cli.yml` before the first live workflow run.
- A dry run does not authenticate to npm and does not prove registry writes.
- Never rerun a partially published version blindly. npm versions are
  immutable; inspect which packages landed and recover deliberately.
- Do not create or move a release tag until every package is published. The
  workflow owns tag and GitHub Release creation.
