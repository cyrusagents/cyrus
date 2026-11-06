# v0.2.76 release validation attempt

**Date:** 2026-11-05 (America/Vancouver)
**Issue:** [CYPACK-1624](https://linear.app/ceedar/issue/CYPACK-1624)
**Source:** `58ae91cf` plus the coordinated v0.2.76 manifest/changelog changes on `cypack-1624`.
**Previous published release:** `v0.2.75`.
**Result:** BLOCKED. This is an attempted drive, not successful release evidence.

## Full payload and required coverage

`git log v0.2.75..HEAD` contains two product changes:

- [#1581](https://github.com/cyrusagents/cyrus/pull/1581): Plane issue tracking, webhook coordination, routing, activities, and tracker-specific MCP tools. Existing Plane tests cover 29 cases. The feature PR reports live self-hosted Plane Commercial 4.0.1 testing on a branch with unrelated changes, but no Plane Cloud test. Stock F1 uses its CLI tracker and does not exercise Plane's external API. Those limits remain; no new end-to-end Plane validation is claimed here.
- [#1583](https://github.com/cyrusagents/cyrus/pull/1583): Anthropic SDK updates and explicit manual permissions for cold and opt-in warm sessions. This needs relevant authenticated session/activity validation. Existing cold/warm permission tests establish option propagation, not provider acceptance or real tool execution. The prior acceptance record still lists a missing authenticated receipt and separate core prerelease/Hosted follow-up.

This is a runtime-bearing release. It cannot use the non-F1 exemption.

## F1 scenario and assertions

Expected: create an issue, select the test repository, start Claude using the updated SDK, execute `Read(package.json)` followed by foreground `Bash(pwd, timeout=10000)`, emit the final response `SDK_RUNTIME_OK`, and stop cleanly. A successful first turn would permit continuation checks; no continuation was attempted after authentication failed.

```sh
apps/f1/f1 init-test-repo --path /private/tmp/f1-cypack-1624-repo
CYRUS_PORT=3614 CYRUS_REPO_PATH=/private/tmp/f1-cypack-1624-repo bun run apps/f1/server.ts
CYRUS_PORT=3614 apps/f1/f1 ping
CYRUS_PORT=3614 apps/f1/f1 create-issue \
  --title 'Verify Claude SDK 0.3.318 release session' \
  --description 'Read ./package.json with Read, then use Bash to run pwd with timeout 10000 in the foreground. After both succeed reply with exactly SDK_RUNTIME_OK. Do not edit files.'
CYRUS_PORT=3614 apps/f1/f1 start-session --issue-id issue-1
CYRUS_PORT=3614 apps/f1/f1 prompt-session --session-id session-1 \
  --message 'https://github.com/f1-test/primary-repo'
CYRUS_PORT=3614 apps/f1/f1 view-session --session-id session-1
CYRUS_PORT=3614 apps/f1/f1 stop-session --session-id session-1
```

Observed:

- Server health, issue `DEF-1` creation, repository selection, and worktree creation passed.
- Session `session-1` initialized Claude session `cb384a89-838e-4411-bf8f-bad378faec77` with explicit `permissionMode: "default"`.
- Elicitation, prompt, routing, and model-selection activities appeared.
- At `2026-11-06T00:29:33Z`, Claude returned: `Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.`
- The requested Read/Bash execution and successful final response were not reached. Runtime acceptance remains blocked.
- `stop-session` succeeded; the F1 server was stopped. Test state/logs remain under `/private/tmp` for diagnosis and are not committed.

## Other release gates

- `pnpm install --store-dir /private/tmp/cypack-1624-pnpm-store`: passed; no lockfile change.
- `pnpm build`: passed.
- `pnpm typecheck`: passed.
- `pnpm test:packages:run`: passed, including 29 Plane tests and 867 edge-worker tests (one edge-worker skip).
- `pnpm --filter cyrus-ai test:run`: 162 passed.
- `pnpm lint`: passed with 14 existing warnings.
- `pnpm audit --audit-level low`: zero advisories.
- Packed all 18 packages with `pnpm --dir <directory> pack --pack-destination /private/tmp/cypack-1624-artifacts`; inspected every identity/version and required all internal dependencies to resolve to exactly `0.2.76` with no remaining workspace ranges. All passed.
- Installed those 18 tarballs together with `npm install --global --prefix /private/tmp/cypack-1624-cli <tarballs>` using an isolated cache. `/private/tmp/cypack-1624-cli/bin/cyrus --version` returned `0.2.76`. This is local packaging proof, not registry publication proof.
- `node scripts/release-packages.mjs validate 0.2.76`: correctly stops at missing successful release evidence. This attempt intentionally does not use the accepted `-release-v0.2.76.md` suffix.
- npm reports `cyrus-ai@latest` as `0.2.75`, and `cyrus-plane-event-transport` returns E404. The new package needs its one-time approved first publication and trusted-publisher setup before the release workflow can proceed.

Only CYPACK-1623 is named in the original Unreleased changelogs; it was checked at the start and is `MergedUnreleased`. Do not advance it to `ReleasedMonitoring` until publication succeeds. No release workflow, npm publication, or release tag was created by this attempt.
