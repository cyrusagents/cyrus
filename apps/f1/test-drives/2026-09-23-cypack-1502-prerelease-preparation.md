# CYPACK-1502 test prerelease: validated local candidate, publication blocked

September 23, 2026. **Local preparation passed; nothing was published.**
This report does not claim a usable published CLI, stable readiness, or closure
of the remaining provider/review/hosted acceptance gates.

## Exact candidate and locations

| Item | Value |
| --- | --- |
| Candidate version | `0.2.73-cypack1502.0` (all 17 canonical release packages) |
| Feature source | [`89337bab1c08c616ef58f55ef82bc2f53c52892a`](https://github.com/cyrusagents/cyrus/commit/89337bab1c08c616ef58f55ef82bc2f53c52892a) |
| Candidate source | [`bd45d03ae855d4148257cfeb93d026f88d886626`](https://github.com/cyrusagents/cyrus/commit/bd45d03ae855d4148257cfeb93d026f88d886626) |
| Reviewable preparation | [`cypack-1502-prerelease-prep`](https://github.com/cyrusagents/cyrus/compare/89337bab1c08c616ef58f55ef82bc2f53c52892a...bd45d03ae855d4148257cfeb93d026f88d886626) |
| Candidate CI | [GitHub Actions run 35935709448](https://github.com/cyrusagents/cyrus/actions/runs/35935709448) |
| Local bundle | `/Users/agentops/.cyrus/CYPACK-1502/attachments/cyrus-0.2.73-cypack1502.0-local-candidate.tar.gz` |
| Bundle SHA-256 | `7ec9abe850cb33254036c358b8c0d4fd61b2b8e6b946ba300310af23a72f24f5` |
| npm dist-tag / release tag | None created or moved |
| Published registry / release artifact URL | **None: candidate is not published** |

The preparation commit changes only coordinated package versions, candidate
changelog sections, and F1 preparation evidence. Runtime source is unchanged
from the feature SHA. The original feature checkout's package versions remain
unchanged. The candidate is not merged into main or the feature branch.

[Per-package SHA-256 manifest](artifacts/2026-09-23-cypack-1502-candidate-manifest.json)
records each of the 17 tarballs. The outer bundle contains those tarballs,
`manifest.json`, `SHA256SUMS`, `INSTALL.md`, and a guarded local installer; no
secrets or test homes are bundled. Tar manifests were inspected for expected
package/version, absence of `workspace:` ranges, exact candidate versions for
every internal dependency, and absence of `.env`/`github-tokens.json` files.

## Why publication is blocked

Freshly fetched main is `e9e1e53d629b023545ebfd821bcd16c67f44f217`; PR1472 was
confirmed open at the requested feature SHA. Inspected both revisions' canonical
`apps/cli/RELEASING.md`, all available Actions workflows, and existing artifacts.

- [`release-cli.yml`](https://github.com/cyrusagents/cyrus/blob/e9e1e53d629b023545ebfd821bcd16c67f44f217/.github/workflows/release-cli.yml)
  refuses any ref except `refs/heads/main` **before** packing/upload. Its dry-run
  option and `next`/`beta` tags do not relax that guard.
- `scripts/publish-release.mjs` independently rejects non-main refs. A local
  dry-run invocation with the actual feature ref stopped at that guard before
  any registry activity: `Cyrus releases must run from main.` No ref spoofing.
- Ordinary CI has no installable-artifact upload. Available package artifacts
  belong to older main releases, not this feature candidate.
- The current release skill forbids manual workspace publishing. The older
  core-test skill's manual `pnpm publish` instructions conflict with this current
  process and only cover core/Claude, not the complete CLI dependency graph.
- Existing npm `test` points to `0.2.72-test.2`; that is not this candidate and was
  not substituted for it. Before/after `cyrus-ai` reads show `latest=0.2.72` and
  `test=0.2.72-test.2`, unchanged.

No release workflow was dispatched; no npm token was added/requested; no npm
publish, tag/release creation, trust-policy alteration, merge, or deployment ran.

The concrete missing mechanism is an **approved feature artifact route**. A
maintainer-reviewed artifact-only workflow could accept a full immutable candidate
SHA, use read-only repository permissions with no OIDC/publish credentials, run
the canonical checks/pack/install validation, and upload the complete graph plus
hash manifest without npm writes or release tags. That route does not currently
exist. Adopting it needs a separate reviewed workflow change; this task did not
modify the main-only publishing safeguards or authorize an infrastructure merge.

## Fresh checks and independent installation

- Frozen install with strict peer checks passed; lockfile unchanged. pnpm
  `10.33.1`, Node `22.17.1`, npm `10.9.2` locally.
- Canonical `release-packages.mjs validate 0.2.73-cypack1502.0` passed for all 17
  packages, with candidate changelogs/package list and F1 evidence.
- Full `pnpm -r test:run`: **2,134 passed, 2 skipped**, including CLI/release tests.
- Candidate source CI passed on **Node 22 and 24** in run 35935709448.
- Build and typecheck passed. Lint passed with 12 existing warnings. Audit: zero
  vulnerabilities. No dependency or runtime changes were made to obtain a pass.
- Packed every canonical package using pnpm; inspected all manifests and edges.
- Installed all 17 tarballs together into a fresh private npm prefix, using a
  separate HOME/cache and empty user npm config. The installed binary, not the
  source entrypoint, reports **`0.2.73-cypack1502.0`**. Help and add-user help pass.
- Installed `add-user --github-only` and `list-users` passed with an explicit
  synthetic GitHub fixture and skipped live check. Verified canonical
  `{store:"github-tokens"}` config reference, personal store entry, and 0600 mode.
  Initial invocation correctly rejected a missing config; seeding an empty
  disposable config completed the fixture. This is not live authentication proof.

## Fresh F1 protocol and its limits

Ran the protocol twice: first against the built candidate, then against the
independently installed tarballs. Each drive used a fresh home/repo and an
ephemeral loopback port. The real EdgeWorker, HTTP RPC, CLI mock tracker,
worktree creation, credential resolution and renderer were exercised. Only the
model runner was replaced with a deterministic fixture; personal GitHub values
were synthetic. No customer or provider calls were made.

- Health/status passed; created two mock users, issues DEF-1/DEF-2 and sessions
  session-1/session-2. Fresh worktrees and completed responses observed.
- Both actual runner configurations selected their respective personal entries
  in the shared store. Both directions of cross-user follow-up visibly refused
  under **explicit reject**, with runner starts unchanged at two.
- Coherent thought/response timestamps; pagination returned disjoint two-item
  windows from an eight-activity view. No actual tool actions were synthesized.
- Both sessions stopped; awaited `worker.stop()` closed each test server.

These are **offline strict-reject fixtures**, not actual Linear/live-provider
tests. They do not establish live shared-fallback or default-pin semantics.
Earlier actual Linear Claude PR17/18 and bidirectional refusals remain valid
separate historical evidence, using two tokens from one Claude account. Required
human review/no-bypass, Cursor/Codex live gates and genuine hosted UI-to-runtime
acceptance remain open. No stable-readiness claim.

## Local install only

Verify the outer archive hash, extract it, then from its extracted directory run:

```sh
./install-local.sh /absolute/empty/test-prefix
/absolute/empty/test-prefix/bin/cyrus --version
```

The script verifies package hashes and refuses an existing prefix. It installs
all 17 tarballs together; external dependencies still require registry access.
It does not register a service, start a worker or modify existing authentication.
Do **not** use `npm install cyrus-ai@0.2.73-cypack1502.0`: it is not published.

Prepared source, package files and logs are retained under
`/private/tmp/cypack1502-prerelease-0923-lkz6pc1z`. Existing internal Cyrus, prior
test homes, authentication, review rules, billing, and visibility were untouched.
