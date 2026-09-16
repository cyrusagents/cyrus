# Managed GitHub credential removal — CYPACK-1522

This is the runtime follow-up to [CYHOST-913](https://linear.app/ceedar/issue/CYHOST-913), tracked in [CYPACK-1522](https://linear.app/ceedar/issue/CYPACK-1522). The published 0.2.72 runtime does **not** satisfy authentication-removal acceptance. The earlier dedicated TEST 599133565 empty-set exercise established delivery, retry and a zero-entry store only. It did not prove the Git/gh authentication result. No fixture logout repairs that acceptance gap.

## Contract

A present `github-tokens.json` is authoritative, including `tokens: []`. Malformed, unreadable, unsupported-version and expired snapshots cannot restore ambient authentication. Installing the managed helpers creates `github-auth-managed` alongside the store so accidental store deletion also refuses. An entirely unmanaged machine with neither file retains its own environment, hosts/keyring and Git helper behavior. Merely installing the package does not enroll that machine.

Both credential scripts use the bundled `managed-github-auth.cjs` policy and read it per invocation. An explicit repository owner must match a live installation; the last remaining installation cannot stand in for a removed organization. Repo-less gh commands may select a single live token or an exact still-live `CYRUS_GH_TOKEN` hint. A stale hint refuses; repository context selects the refreshed credential without relying on that snapshot.

Managed gh refuses before spawning native gh if resolution fails, so neither `hosts.yml` nor OS keyring is consulted. Git returns `quit=true`, which stops subsequent helpers and prompts per the [Git credential protocol](https://git-scm.com/docs/gitcredentials). Native gh caches are not deleted or overwritten. The token-push handler no longer logs installation tokens into native gh; successful auth always comes from the managed resolver. Missing resolver/policy errors fail closed. Resolver/wrapper installation exceptions return failed delivery for retry.

Known droplet wrappers, including the first-generation resolver wrapper, are upgraded with the missing-resolver fence. Unrecognized wrappers or machines without a wrapper are not overwritten: those installations must arrange invocation of the supported resolver before claiming gh removal acceptance. `ghResolverInstalled` attests script installation, not PATH adoption. `ghAuthConfigured` remains false because the handler no longer creates native cached login state.

## Boundary and rollout

This is credential selection by the Cyrus Git helper/gh wrapper, not provider revocation or isolation from the machine's owner. Absolute native gh invocations, an overwritten helper configuration, URL-embedded credentials, SSH keys, explicit HTTP headers, arbitrary SDK consumers and already-running processes that captured credentials are outside this fence. Do not describe store removal as revoking a token at GitHub. Immediate provider-wide revocation requires provider action and separately coordinated session handling.

The old image's root refresh timer can run `gh auth setup-git` and overwrite helper configuration. That separate transition remains unproven: preserve backups, stop the legacy mechanism through an authorized canary, and check both Git and gh across its former timer interval and token expiry. The new-image 913 canary cannot prove that transition.

No runtime has been changed and no new version has been published for this fix. Release/host mutation is not authorized here. After an authorized release, verify tarball integrity and packaged policy/scripts, pin the exact published version, then repeat authentication checks on the authorized canary. Do not pin 0.2.72 as sufficient or silently log out cached fixture credentials.

Personal identities and shared-store schema work remain owned by [CYPACK-1502 / PR1472](https://github.com/cyrusagents/cyrus/pull/1472). Reconcile the managed installation policy when merging those changes; this follow-up does not implement personal identity selection.

## Reproduction and validation

`packages/config-updater/test/managed-github-auth.test.ts` uses fresh isolated HOME/config paths, synthetic tokens, a fake native gh, and actual Git credential-fill subprocesses. A later synthetic keyring helper records any invocation. Cached hosts credentials deliberately remain present throughout the tests. No real credentials, network requests, OS keyring modification, or model requests are used.

The original code fails nine of the initial ten regression cases. The matrix covers empty/expired/corrupt/unreadable/invalid-version/invalid-shape/deleted managed stores, stale session snapshots, partial removal with a retained org, rotation and unmanaged authentication. The real handler integration installs the helper and legacy wrapper, pushes tokens then an empty set, verifies both consumers refuse, deletes the store and resolver, and verifies refusal remains. This tests the affected authentication path directly; no model F1, live provider revocation or fleet proof is claimed.

Local verification: 1,896 package tests passed, 2 existing skips; 73 config-updater tests included. Monorepo build and typecheck passed. Lint passed with 12 existing warnings. A local npm pack contains all three credential scripts byte-for-byte identical to the tested source; this is packaging evidence, not a registry publication or supported release pin.

## Placeholder and acknowledgement compatibility review

`gh api repos/{owner}/{repo}` is supported using the same repository context precedence as other managed invocations (explicit repository, `GH_REPO`, cwd origin). The owner placeholder is resolved for credential selection; original arguments stay unchanged for native gh to expand `{owner}`, `{repo}` and `{branch}`. Missing context stays unresolved and refuses; explicit removed owners still override valid context and cannot borrow a token. See [gh api placeholder documentation](https://cli.github.com/manual/gh_api).

Caller audit of hosted PR960 at `d7d2447a6bdf35f7a4d74994214a111901d35640`:

- `updateInfrastructureGitHubTokens` → `requestInfrastructure` checks HTTP status, not `ghAuthConfigured` or `ghResolverInstalled`. Its callers cover callback persistence, installation removal, repository/config sync, webhook freshness, and scheduled/manual reconciliation. `reconcileTeamGitHubTokens` classifies `refreshed`/`cleared` from push success and count; those outcomes attest delivery, not grant or PATH proof.
- The modern embedded `ConfigUpdater.registerRoute` maps handler `success:false` to HTTP 400 and exceptions to 500. A synthetic authenticated Fastify integration checks 401 without credentials, HTTP 200 and the exact empty-store acknowledgement, and HTTP 400 for resolver installation failure. Thus installation failures still propagate to hosted refresh retry. This does not establish compatibility with legacy Go endpoints that acknowledge failures with HTTP 200.
- Droplet provisioning health (`/health/update-server`) checks HTTP success only. It neither consumes these fields nor proves resolver adoption or GitHub access. Runtime route/version/service identity must be checked separately; old Go updater health is not embedded runtime attestation.
- Hosted `checkGitHubCLI` is used by onboarding and reauthentication for **self-host** only; cloud returns an explicit `skipped:true`. It consumes `/api/check-gh`'s `isInstalled`/`isAuthenticated`, not the token-push acknowledgement. No-store unmanaged auth behavior remains intact.
- Runtime `handleCheckGh` executes `gh --version` then `gh auth status`. The resolver permits **only exact `--version`** without credentials, stripping token variables for that probe, so empty managed auth reports installed=true/authenticated=false rather than misclassifying gh as missing. A real installed-wrapper/health-handler regression verifies this. Every authentication command still passes through the managed policy. A repo-less multi-installation auth check can be ambiguous and is not per-installation grant proof.

For a newly published fixed version, positive-delivery acceptance must bind to the actual running runtime and endpoint contract, then prove the installed resolver/helper is on the executed path and perform per-repository Git/gh grant checks. `ghAuthConfigured:false` means no native cached login was written; `ghResolverInstalled:true` means scripts installed, not PATH adoption. Empty-set acceptance requires refusal with stale session and cached credentials left present. No published fixed version or live canary is claimed by this review.
