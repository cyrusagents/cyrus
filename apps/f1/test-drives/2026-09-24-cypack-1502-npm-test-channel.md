# CYPACK-1502 npm test-channel release preparation

Date: 2026-09-24 UTC. Infrastructure PR: [#1502](https://github.com/cyrusagents/cyrus/pull/1502).

## Tested source and boundary

Infrastructure implementation tested: `11c113478c634a2eac1408620d2276826107617c`.
Candidate: `bd45d03ae855d4148257cfeb93d026f88d886626`, coordinated version
`0.2.73-cypack1502.0`, based on feature revision
`89337bab1c08c616ef58f55ef82bc2f53c52892a`. Dedicated channel: `test-cypack1502`.
This report records preparation, not a successful npm publication. Infrastructure
approval/merge, supported-route dry run, and live registry/install verification
are still required. The rejected artifact-only dispatch route has been removed.

## Verification completed

- 56 focused release/artifact tests passed, including real publisher execution
  against deterministic registry fixtures: full 17-package order, ignore-scripts,
  recovery without rewriting existing versions, manifest tampering, stable tag
  rejection, non-main/wrong workflow rejection, registry integrity mismatch,
  changed latest detection, dry-run no-write and job permission boundaries.
- Full infrastructure suite: 2,035 passed / 2 skipped.
- Required build/typecheck and lint passed. Existing lint warnings remain.
- Actionlint workflow validation passed with shellcheck disabled; full shellcheck
  reports the existing stable workflow's unused loop variables.
- Node22/24 CI passed on the implementation SHA:
  [run35939630436](https://github.com/cyrusagents/cyrus/actions/runs/35939630436).
- Focused security review found no qualifying high/medium finding. Candidate
  build and installed-code execution are in jobs without OIDC. The publisher
  checks out only reviewed main scripts, reads tarballs as data and publishes
  with lifecycle scripts disabled. It never runs candidate installation/build.
- The installed dependency resolver visited all 17 coordinated packages in the
  previously validated local installation. This is resolver testing, not registry
  prerelease-install evidence.

Local evidence: `/private/tmp/cypack1502-artifact-evidence/channel-*.log`.
Existing candidate F1 protocol evidence remains in [the feature report](https://github.com/cyrusagents/cyrus/blob/193b4e3d8b91838d92ebfdf657f932a795b6fd0f/apps/f1/test-drives/2026-09-23-cypack-1502-prerelease-preparation.md).
It uses a real runtime/mock tracker and deterministic mock runner with explicit
strict reject. It does not prove live shared-fallback/default-pin semantics.
No live credential tests were repeated for this infrastructure work.

## npm trust compatibility

Anonymous GET of the npm package trust endpoint returns401, so private settings
are not claimed verified. Public registry provenance for cyrus-ai@0.2.72 records
`https://github.com/cyrusagents/cyrus`, `.github/workflows/release-cli.yml`,
`refs/heads/main`, workflow_dispatch and workflow commit
`5b3e38bdff77f560f2f3d5c47bc17d8d0fe55e08`. The new route preserves that identity
and requests no token, trust/environment change, or added package permission.
Live OIDC publication is the remaining proof of current authorization.

npm's automatic attestation refers to the reviewed main workflow commit; every
package's separate cyrusTestRelease metadata records the exact candidate source.
The publish job verifies that metadata, the complete package list and SHA256
manifest before registry operations; full archive/integrity comparisons remain
mandatory for recovery and final registry acceptance.

## npm12/cloudflared lifecycle proof

A fresh global installation of cloudflared@0.7.1 using **Node24.18.0/npm12.1.0**
completed but explicitly blocked its postinstall script under npm12 defaults.
The documented targeted approval step succeeded:

```bash
npm rebuild -g --allow-scripts=cloudflared cloudflared
```

Afterward the installed binary existed and actually ran:
`cloudflared version 2026.9.1 (built 2026-09-11-13:37 UTC)`.
No tunnel was opened. Private proof/log paths are
`/private/tmp/cypack1502-npm12-tools/cloudflared-binary-proof.json` and
`cloudflared.log`. This tests the lifecycle prerequisite, not the still-unpublished
Cyrus version. npm12 does not support the local Node22.17.1 runtime; npm12 proof
used a separately downloaded Node24.18.0 binary. The release install matrix is
Node22.17.1/npm10.9.2, Node24.18.0/npm11.18.0, Node24.18.0/npm12.1.0.

## Gate and actual endpoint

Coordinator must approve and merge infrastructure PR #1502 through normal
controls, without merging feature #1472. This worker has not merged or dispatched
it. Main-only release-cli.yml can then run the documented dry run and authorized
live test release. All-package registry integrity and unchanged-tag proof plus
fresh registry installation jobs must pass before reporting completion.

Consumer command after that verification:

```bash
npm install -g cyrus-ai@test-cypack1502
# Immutable version: npm install -g cyrus-ai@0.2.73-cypack1502.0
```

Stable/latest, production deployments, customer messages, provider authentication,
review rules/billing and hosted acceptance are outside this test release.
