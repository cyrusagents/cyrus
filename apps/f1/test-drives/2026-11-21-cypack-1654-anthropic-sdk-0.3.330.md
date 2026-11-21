# CYPACK-1654: Anthropic SDK 0.3.330 runtime verification

**Date:** 2026-11-21

**Goal:** Verify that Cyrus runs the Claude Agent SDK 0.3.330 / Claude Code 2.1.330 update through its real worktree, tool, and activity pipeline.

**Test repository:** `/private/tmp/f1-cypack-1654.epVD1R/repo`

**Tested source:** `ea0b74839dcf5463064beefe81bf04e4e739cef5`

**Identity provenance:** Existing intended Claude identity; `claude auth status --json` reported logged in through `claude.ai`, first-party provider, Max subscription. Account identifiers are omitted from committed evidence.

## Scenario

F1 created a disposable repository and routed an inspection-only issue through the real `ClaudeRunner` query path. The prompt required `Read(package.json)`, a foreground `Bash(pwd)` call with timeout `10000`, and the exact final marker `SDK_RUNTIME_OK`, without modifying files.

## Verification results

### Issue tracker

- [x] Health and ready status returned successfully.
- [x] `issue-1` / `DEF-1` was created and exposed through the CLI tracker.
- [x] Repository selection accepted `F1 Test Repository` and resumed the pending session.

### EdgeWorker and Claude runtime

- [x] Installed packages resolved to `@anthropic-ai/claude-agent-sdk` 0.3.330 and `@anthropic-ai/sdk` 1.12.0.
- [x] The bundled native executable reported Claude Code 2.1.330.
- [x] EdgeWorker created the `DEF-1` worktree from local `main`.
- [x] Cyrus supplied its 33-tool engineering catalog, including the three resource-discovery tools.
- [x] Claude read `package.json`, ran foreground `Bash(pwd)`, and returned exactly `SDK_RUNTIME_OK`.
- [x] The session completed successfully without `session_writes_lost` or an unhandled error.

### Activity rendering

- [x] Elicitation, prompt, acknowledgment, routing, model, action, and response activities rendered coherently.
- [x] Pagination returned the requested three-activity window.
- [x] Search returned the Claude model activity.
- [x] The stop request completed the session and the F1 server shut down cleanly.

## Sanitized evidence

- [Successful source-runtime tool/result/stop evidence](evidence/2026-11-21-cypack-1654-source-runtime.json) records the exact Read → foreground Bash (`pwd`, timeout `10000`) → `SDK_RUNTIME_OK` sequence, non-error result, zero observed `session_writes_lost`, stop, and clean shutdown. That run did not enable the SDK sandbox.
- [Configured-sandbox probe](evidence/2026-11-21-cypack-1654-configured-sandbox-probe.json) records `sandbox.enabled`, proxy configuration, the same intended identity class, and clean lifecycle behavior. Read succeeded, but nested macOS `sandbox-exec` rejected Bash with exit 71 (`sandbox_apply: Operation not permitted`). This is explicitly negative evidence, not final acceptance.

## Supporting checks

- `./scripts/extract-claude-tools.sh` completed against Claude Code 2.1.330 with 26 native tools and exactly three resource-capability additions: `ListMcpResourcesTool`, `ReadMcpResourceDirTool`, and `ReadMcpResourceTool`.
- The extracted catalog is unchanged from 2.1.329. Cyrus intentionally retains four context-dependent capabilities beyond the 29-tool fixture: `PushNotification`, `LSP`, `RemoteTrigger`, and `DesignSync`.
- The monorepo build passed.
- Focused Claude runner and EdgeWorker compatibility suites passed: 104 tests across eight files.

## Claude Code 2.1.330 dispositions

| Upstream behavior | Cyrus disposition |
| --- | --- |
| Invalid host, user, project, or local settings now emit `settings_not_in_effect`. | Cyrus logs the warning and posts it as a durable issue-timeline thought so missing settings or policy cannot silently degrade a run. A focused regression test covers this tag. |
| A `SessionStart` hook's `CLAUDE_ENV_FILE` variables now reach Bash after `continue`. | Accepted as an upstream continuation fix. Cyrus preserves the same session environment and hook configuration on resume and adds no competing environment-file layer. |
| `stopTask()` no longer leaves Claude waiting when the background agent finishes concurrently. | Accepted as an upstream background-task lifecycle fix. Cyrus does not add another task-completion state machine around the SDK. |
| `query()` now rejects a `settings` string that is not valid JSON. | Cyrus passes structured settings and managed settings rather than a raw JSON string; its current configuration is unaffected, and malformed future callers now fail visibly. |
| SDK MCP calls avoid lost or swapped results across reconnects by allowing high numeric request IDs. | Accepted as an upstream transport fix. Cyrus treats JSON-RPC request IDs as opaque and does not narrow or rewrite them. |
| Agent Platform fast mode now honors settings and reports the running model's `fast_mode_state`. | Accepted. Cyrus does not override Agent Platform billing or synthesize initialize-state fields; it forwards the runtime-selected model and SDK state. |
| Automatic retry with a lower `max_tokens` value was restored after its removal in 2.1.329. | Accepted as the restored upstream behavior. Cyrus does not add a second retry policy or preserve the superseded 2.1.329 disposition. |
| Newly scheduled `/loop` and recurring tasks can run for up to 30 days; tasks created before 2.1.330 keep their 7-day expiry. | Accepted as an upstream task-lifecycle change. Cyrus does not migrate existing tasks, extend their expiry, or infer any additional authority to act beyond the user's original request. |
| Unattended destructive `rm` commands targeting the filesystem root, home, or top-level working-directory paths are now refused, and interactive runs ask for approval. | Accepted as an upstream safety boundary. Cyrus does not bypass, weaken, or pre-authorize the runtime's destructive-command checks. |
| A `deniedMcpServers` entry by connector name hides only that named claude.ai connector, while an exact URL entry blocks every server at that URL. | Accepted as upstream policy matching. Cyrus passes the configured policy through and does not treat connector names and URLs as interchangeable. |
| The built-in easel/mod chart capability is available only in supported plan, platform, and configuration contexts. | Context-dependent and therefore not added to the static extracted tool fixture. Cyrus must not advertise or assume the capability when the upstream runtime does not expose it. |
| Enterprise Admin Console sign-in can route provider, gateway, and organization settings into the runtime. | Accepted as upstream enterprise routing. Cyrus preserves the selected identity and managed settings; it does not substitute accounts, providers, or gateway configuration. |

## Disposition

The source-worktree 0.3.330 runtime, refreshed tool catalog, worktree creation, repository tools, activity delivery, pagination, search, and shutdown all passed. This is progress beyond the carried-forward CYPACK-1653 drive, but it does **not** close final registry-installed acceptance. That gate still requires an immutable candidate whose source stamp, packed artifacts, consumer lockfile, configured sandbox, and intended authenticated identity all match this update.
