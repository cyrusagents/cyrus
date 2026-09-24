# CYPACK-1502: artifact workflow preparation and installed-bundle F1

Date: 2026-09-24 UTC

Draft infrastructure PR: [#1502](https://github.com/cyrusagents/cyrus/pull/1502).
This report covers local preparation. The proposed GitHub artifact workflow has
not been dispatched, merged, or used to publish an artifact. No registry, npm
distribution tag, git release tag, or GitHub release was created.

## Immutable inputs

- Tooling tested: `9345137fb0ac9d3610bc76a9d28c76d08a4e6aaa` (subsequent changes add this report and the changelog entry only).
- Tooling base: main `e9e1e53d629b023545ebfd821bcd16c67f44f217`.
- Candidate: `bd45d03ae855d4148257cfeb93d026f88d886626`.
- Candidate runtime base: `89337bab1c08c616ef58f55ef82bc2f53c52892a`, PR #1472.
- Coordinated version: `0.2.73-cypack1502.0` (all 17 public workspaces).

## Verification

- Frozen install with strict peer dependencies passed.
- Audit passed with no known vulnerabilities.
- Lint passed (12 existing warnings).
- Build and typecheck passed through the required commit hook.
- Full tooling-branch suite: **2,023 passed, 2 skipped**.
- Focused artifact/release regression suite: **44 passed** (included in that total).
- `actionlint .github/workflows/test-cli-artifacts.yml` passed.
- Focused security review: no qualifying high/medium findings; dispatch assumes a reviewed, trusted candidate whose build/install scripts execute on the runner.
- `release-cli.yml`, `publish-release.mjs`, and `release-packages.mjs` are byte-for-byte unchanged from main.
- New validator accepted the actual clean candidate checkout and its canonical 17-package/version/changelog/F1 checks.
- New bundler inspected the 17 existing pnpm tarballs from that candidate. Unit coverage rejects non-SHA refs, stable/invalid versions, wrong checkout SHA, incomplete/extra packages, symlinks, identity mismatch, unresolved/drifting internal dependencies, and reused output directories. A tampered extracted package causes the generated installer to stop at checksum verification.
- Extracted the new bundle, verified outer and inner checksums, installed every tarball together into a fresh prefix, and verified `cyrus --version` equals `0.2.73-cypack1502.0` plus successful `cyrus --help`.

Local evidence directory: `/private/tmp/cypack1502-artifact-evidence`.
Fresh installation: `/private/tmp/cypack1502-artifact-evidence/installed`.
The old independently verified candidate archive was preserved. The new archive
has a different outer hash because this workflow format adds its installer and
tooling provenance; the package tarballs are reused unchanged.

New local archive SHA256:
`04a4b0bb4195d03d78988c5b0984f483c589cc61ce566c5533c0b48405b7494e`.

New local manifest SHA256:
`d1f38e9b8b3565af0e91848f4b138bc05765ce31e710a1c5c85db77e09f0fcff`.

## Installed-runtime F1 protocol

Reused the deterministic installed-runtime fixture harness from the candidate
preparation, redirected to the newly extracted installation and fresh disposable
home/repository under the evidence directory. It uses real EdgeWorker HTTP RPC
on an ephemeral localhost port, the CLI mock tracker, a mocked runner, and fake
offline tokens. It does not use actual Linear delivery or provider authentication.

- [x] Ping and status succeeded.
- [x] Created two tracker users and issues, returning issue/session IDs.
- [x] Started both sessions; runner received the two distinct shared-store owner selections.
- [x] Both sessions rendered completed response activities.
- [x] Explicit `followUpByOtherUser=reject` refused both cross-user prompts visibly; runner starts remained **2 before / 2 after**.
- [x] Activities contained readable content and valid timestamps; two-item pagination returned distinct activity IDs.
- [x] Stopped both sessions and worker cleanly; no fixture errors.

Machine evidence: `evidence/f1-installed.json`; log: `f1.log`, both under the
local evidence directory. This is **strict-reject fixture evidence only**. It
does not establish live shared-fallback or default-pin semantics. Historical
actual Claude PR17/18 evidence is preserved separately; this test does not
replace it or close other provider, hosted UI, or review-enforcement gates.

## Required next action

Coordinator/maintainer review and approval of draft infrastructure PR #1502,
followed by its merge through the normal repository process. This session has
not merged it. After the workflow exists on main, an authorized maintainer can
dispatch exactly:

```bash
gh workflow run test-cli-artifacts.yml --repo cyrusagents/cyrus --ref main \
  -f candidate_sha=bd45d03ae855d4148257cfeb93d026f88d886626 \
  -f version=0.2.73-cypack1502.0
```

Then inspect the successful run's download URL and digests and independently
install its artifact using `apps/cli/RELEASING.md`. No feature-to-main merge,
npm trusted-publisher change, new token, billing change, or provider credential
is required. The artifact job itself has only `contents: read`; its download
expires after 14 days unless preserved. A future workflow run is still required
to prove GitHub-hosted packaging/upload; local success is not that evidence.
