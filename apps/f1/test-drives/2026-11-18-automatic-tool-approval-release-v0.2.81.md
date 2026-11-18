# Automatic tool approvals release verification

The functional payload since v0.2.80 is the runtime automatic approval setting in source `d366522ce33d009069e4162978297ba25c32e7c9`. Packaging and the version-specific development audit exception add no runtime behavior. The package dependency lockfile is identical to v0.2.80.

Two local F1 servers used separate, empty Git repositories and synthetic issue sessions. A test-only route called the real configuration updater and each server's config watcher applied `auto`, then `allowlist`, without a process restart. Explicit `repo=f1-test-repo` routed both sessions to the fixture repository. The issue prompts requested a distinct response marker without filesystem, network, or shell operations.

| Runner | Automatic | Allowed tools after switching back |
| --- | --- | --- |
| Claude Sonnet | Response `CYRUS_CLAUDE_AUTO_OK`. SDK options reported `permissionMode=auto`, directory read grants and `canUseTool`. | Response `CYRUS_CLAUDE_ALLOWLIST_OK`. SDK options reported `permissionMode=default`. |
| Codex CLI 0.163.0 / gpt-6-sol | Response `CYRUS_CODEX_AUTO_OK`. The backend received the automatic-review configuration without an unsupported-mode warning. An independent probe against the same app-server binary confirmed `on-request`, `auto_review` and `workspaceWrite`. | Response `CYRUS_CODEX_ALLOWLIST_OK` on the default approval process. |

The original Codex fixture model gpt-5.5 was rejected by the test account. The successful rerun used its supported gpt-6-sol model. Both F1 servers were stopped after the tests. F1 validated mode selection and issue response through real providers without forcing an escalation. Focused tests separately exercised auto and allowlist process isolation, unexpected approval denial before registration, permission grant denial, sandbox configuration, cold-query protections and warm-session cleanup (61 tests passed).
