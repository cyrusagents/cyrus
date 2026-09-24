---
name: release
description: Prepare, verify, publish, and finish a coordinated Cyrus CLI release. Use when a user asks to release Cyrus, publish cyrus-ai, run a CLI release, or perform the /release workflow.
---

# Release Cyrus

Run Cyrus releases through the trusted-publishing workflow. Do not publish
workspace packages manually.

## Required reference

Read `apps/cli/RELEASING.md` completely before taking release actions. Treat it
as the canonical operator guide and `scripts/release-packages.mjs` as the
canonical package list and dependency order.

Editing release workflows, scripts, installers, or release documentation does
not invoke this release procedure. Validate those changes with targeted checks
and the F1 applicability policy in `skills/f1-test-drive/SKILL.md`.

## Workflow

1. Fetch `origin/main`, start from current main, and preserve unrelated local
   changes.
2. Prepare the release on a branch:
   - Move both changelogs' Unreleased entries into the new version.
   - Set the same version in every manifest printed by
     `node scripts/release-packages.mjs list`.
   - Run `pnpm install` and commit any lockfile change.
   - Assess the entire payload since the previous release using the canonical
     F1 applicability policy, including functional changes merged before the
     version-bump PR. For F1-covered behavior changes, run relevant F1 scenarios
     and save evidence with the required `-release-v<version>.md` suffix.
     Otherwise record the payload assessment and targeted checks as non-F1
     release verification per `apps/cli/RELEASING.md`; do not invent an F1 report.
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
- Confirm every npm package trusts `cyrusagents/cyrus` and
  `release-cli.yml` before the first live workflow run.
- A dry run does not authenticate to npm and does not prove registry writes.
- Never rerun a partially published version blindly. npm versions are
  immutable; inspect which packages landed and recover deliberately.
- Do not create or move a release tag until every package is published. The
  workflow owns tag and GitHub Release creation.
