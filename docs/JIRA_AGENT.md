# Jira agent runners

Jira agent assignments use the same repository and runner selection as Cyrus issues, including `[repo=...]`, `[agent=codex]` and `[model=...]`. Claude and Codex are supported. The selected runner and session remain pinned for follow-ups in that conversation. Other runners are refused before execution.

## Codex authentication

Jira uses a dedicated Codex home at `<cyrusHome>/jira-agent/codex`. Authenticate that home once with the Codex CLI's normal browser login (or its supported API-key stdin login). For a default Cyrus home:

```sh
mkdir -p ~/.cyrus/jira-agent/codex
CODEX_HOME=~/.cyrus/jira-agent/codex codex login
CODEX_HOME=~/.cyrus/jira-agent/codex codex login status
```

Substitute the actual Cyrus home for a custom runtime. This login is separate from a personal Codex installation; do not copy personal configuration or credentials into a repository. Cyrus manages this home's `config.toml`, while Codex manages its authentication and conversation storage.

## Execution boundaries

Each Jira Codex invocation owns a separate app-server process, with no shared process to interrupt. Jira does not report cancellation settled until that process group has exited. A failure to confirm termination retains the execution fence; a runtime restart closes the conversation and reports recorded process identities for operator reconciliation, without automatically signalling them.

Jira Codex disables repository MCP discovery, native apps, plugins, hooks and automatic skill MCP installation. Before starting or resuming a thread, it rejects inherited native MCP servers or an enabled project configuration layer, and explicitly marks the task path untrusted so Codex cannot automatically enable repository configuration. A native filesystem profile limits tools to the worktree, necessary Git metadata and platform temporary paths; it does not grant access to the Codex authentication home or other conversations. Cyrus integration secrets are blanked in the child environment.

Confirmed process-group teardown currently requires macOS or Linux. Isolated Jira Codex execution is refused on Windows before a process is started. Existing non-Jira runner selection and shared process pooling are preserved.
