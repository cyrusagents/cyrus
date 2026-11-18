# Automatic tool approvals release verification

The functional payload since v0.2.80 adds runtime automatic approvals and updates the bundled Codex CLI, SDK, and model default. Approval behavior was first tested at source `d366522ce33d009069e4162978297ba25c32e7c9`. Codex verification was repeated with the updated bundle. Packaging and the version-specific development audit exception add no runtime behavior. Lockfile changes are limited to the Codex CLI, SDK, and native binaries.

Two local F1 servers used separate, empty Git repositories and synthetic issue sessions. A test-only route called the real configuration updater and each server's config watcher applied `auto`, then `allowlist`, without a process restart. Explicit `repo=f1-test-repo` routed both sessions to the fixture repository. The issue prompts requested a distinct response marker without filesystem, network, or shell operations.

| Runner | Automatic | Allowed tools after switching back |
| --- | --- | --- |
| Claude Sonnet | Response `CYRUS_CLAUDE_AUTO_OK`. SDK options reported `permissionMode=auto`, directory read grants and `canUseTool`. | Response `CYRUS_CLAUDE_ALLOWLIST_OK`. SDK options reported `permissionMode=default`. |
| Bundled Codex CLI 0.170.0 | Response `CYRUS_CODEX_AUTO_OK` with default `gpt-6.2-sol`. The backend received the automatic-review configuration without an unsupported-mode warning. The 0.170.0 generated schemas retain `auto_review` on thread start and resume. | Response `CYRUS_CODEX_ALLOWLIST_OK` on the default approval process with explicit `gpt-6.2-astra`. |

The original Codex fixture model gpt-5.5 was rejected by the test account. The successor bundle listed GPT-6.2 Sol as its default and both GPT-6.2 models completed on the test account. Both F1 servers were stopped after the tests. F1 validated mode selection and issue response through real providers without forcing an escalation. Focused tests separately exercised auto and allowlist process isolation, unexpected approval denial before registration, permission grant denial, sandbox configuration, cold-query protections and warm-session cleanup (61 tests passed).

The updated Codex runner suite passed (91 tests), with another 18 routing and configuration tests passed. Production-only pnpm audit passed. The full audit reported only the previously authorized development advisory.
