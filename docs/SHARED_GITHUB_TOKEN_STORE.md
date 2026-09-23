# Shared GitHub credentials

`cyrus add-user` and hosted GitHub App refreshes use the same
`<cyrusHome>/github-tokens.json`. Claude credentials remain separate. `config.json`
contains user identity and credential references, never personal PAT values.

## File and configuration contracts

The file keeps `version: 1`, `updatedAt`, and the existing `tokens` installation
array unchanged. It adds an optional `personalTokens` object keyed by Linear user
UUID. Each value is one of:

- `{ token: string }`: a locally provisioned PAT, stored only in this protected file.
- `{ env: string }`: the name of a rotating environment variable; no PAT value is copied.
- `null`: a revocation marker, retained to prevent stale legacy mappings from importing it again.

Installation entries retain `installationId`, `organization`, `accountType`,
`token`, and `expiresAt`. Installation consumers read only `tokens`; personal PATs
are never installation candidates or single-installation fallbacks. Hosted
`POST /api/update/github-tokens` still accepts only its installation-token contract.
It cannot supply or replace personal entries.

New `add-user` configuration uses this reference within `linearUsers[UUID]`:

```json
{
  "github": {
    "token": { "store": "github-tokens" },
    "login": "engineer",
    "gitAuthorName": "Engineer",
    "gitAuthorEmail": "engineer@example.com"
  }
}
```

The enclosing mapping's UUID selects the entry; configuration cannot reference a
different user's entry. Use the verified GitHub account's email or noreply address.
Author and committer are both set. Provisioning verifies the PAT's `/user` actor
unless explicitly skipped; custom Git names/emails are operator supplied.

## Migration and rotation

Existing v1 installation-only files require no migration. Existing `github.token`
`{file}` and `{env}` references remain accepted. On first resolution (including
`list-users`, `check-users`, and session preflight), Cyrus imports that user's
credential under the store lock if the UUID has never had an entry:

- File references are read once and copied into the shared store. The source is
  left untouched, whether managed by old Cyrus or supplied externally. Afterwards
  the shared entry is authoritative; editing the old file no longer rotates it.
- Environment references move into the shared entry and retain their variable
  name. Cyrus reads the current process environment at runner start. Already
  running children keep their environment snapshot.
- Existing entries and revocation markers win over legacy references. A missing
  new-style store entry refuses execution instead of importing or falling back.
- Claude references/files are not migrated or repurposed.

Rotate a PAT with `cyrus add-user --force --github-only` and the same Linear user
ID plus a protected `--github-token-file` (or hidden input). To retain personal
Claude authentication when replacing the complete mapping, also provide the
Claude options and omit `--github-only`. Re-provisioning writes the new store
reference to config. Do not delete the whole shared file to remove a user:
`cyrus remove-user UUID` writes a personal revocation marker, removes the mapping
and managed user-secret directory, and preserves installation tokens. External
source files and environment values remain the operator's responsibility.

A malformed or unreadable store does not prevent worker startup or configuration
reload. Installation-only instances retain the legacy shared-credential behavior.
When personal credentials are configured, or personal environment references have
been observed since startup, an unreadable store blocks session starts and personal-session input
validation with an explicit repair message. This includes shared-policy sessions:
they cannot safely inherit an environment without a complete personal-secret
omission list. Removing the last mapping does not clear this protection. Repairing
the store restores resolution without a restart; previously observed environment
names remain filtered. Existing personal session assignments always fail closed,
even if personal credentials are now disabled. Store mutations remain strict and
never overwrite an unreadable or malformed file.

## Selection and failure behavior

Mapped sessions receive `CYRUS_HOME` and `CYRUS_GITHUB_USER_ID` for the assigned
credential owner. The shared `gh-cyrus.cjs` and `git-credential-cyrus.cjs` look up
that UUID on **each invocation**, ahead of organization selection and all host
credentials. Missing, empty, locally revoked or unreadable selections refuse;
Git receives `quit=true` to prevent later helpers or prompting. Provider-revoked
PATs fail at GitHub without retrying another identity.

The runtime prepends a session-only `scripts/bin/gh` shim and selects the shared
Git helper through process-local Git configuration. It does not change global
Git configuration or run `gh auth login` for personal users. This also cooperates
with the installation-token `gh` wrapper. The shim skips older Cyrus wrappers
on PATH and resolves directory aliases, preventing those wrappers from replacing
a personal PAT or recursively invoking the shim. With no personal selection, existing
owner/org matching, explicit repository overrides, single-installation fallback,
and shared `gh` authentication retain their previous behavior.

`GH_TOKEN` and `GITHUB_TOKEN` also carry the selected user's PAT for SDKs and tools
that consume them directly. Removing a mapping cannot erase credentials already
copied into a running process or stop an in-flight request. Stop its sessions and
revoke provider tokens for immediate revocation. This is identity selection, not
an OS boundary: agents sharing an OS user can read that user's credential files.

## Persistence and recovery

All new-runtime writers share an exclusive `github-tokens.json.lock` created
with `wx`, then read the current file, modify only their namespace, write a unique
0600 temporary file, fsync it, and atomically rename it. Updates preserve unrelated
fields. Concurrent CLI processes and hosted refreshes cannot overwrite each
other's namespace or collide on a fixed temporary filename.

A writer waits up to five seconds for the lock and then reports a safe error.
It never guesses that a lock is stale: a suspended writer may still own it. After
an interrupted writer, **stop all writers** before removing the stale `.lock`
file, then retry. A leftover uniquely named `.tmp` file may contain secrets;
protect/remove it as a credential file. Malformed/unsupported stores are not
reset or overwritten. Restore a protected backup and retry; errors never include
the stored data. Readers see a complete old or new file during atomic replacement.

All credential-store writers must run the updated runtime. Old v1 installation
readers can ignore the extension, but an old whole-file writer cannot preserve
fields it does not understand. Do not run that writer alongside personal entries
or downgrade without backing up and stopping the instance.

See [verification](PROMPTER_CREDENTIAL_VERIFICATION.md) for provider and review
proof, which is separate from offline credential-routing regressions.
