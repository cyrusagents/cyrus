# Test Drive CYPACK-1506: Read Linear agent session contents

**Date**: 2026-09-10
**Goal**: Validate the separate `get_agent_session_contents` MCP tool through F1, the EdgeWorker MCP endpoint, and the Linear SDK.
**Test Repo**: `/tmp/f1-cypack-1506-contents`
**Server Port**: `3600`

## Verification results

### Issue tracker
- [x] Created `issue-1` / `DEF-1`, with the `primary` routing label.
- [x] Started `session-1`; issue and session metadata accessible through F1.

### EdgeWorker
- [x] Created an isolated worktree and ran Claude Sonnet.
- [x] Agent discovered `mcp__cyrus-tools__get_agent_session_contents` with ToolSearch.
- [x] Agent called the tool with `first: 2`, then followed the returned cursor.
- [x] Both calls returned actual F1 session activities through the Linear SDK.
- [x] Agent posted a final response confirming successful calls and `F1_GET_AGENT_SESSION_CONTENTS_OK`.
- [x] Session stop and server shutdown completed cleanly.

### Renderer and MCP
- [x] Thought, action, and final response activities visible with timestamps.
- [x] F1 view pagination and search worked.
- [x] MCP tools/list includes both the new contents tool and unchanged metadata tool.
- [x] Direct HTTP MCP calls returned two non-overlapping activity pages.
- [x] Missing session returned an MCP error; a page size of 251 was rejected.

## Reproduction

F1's CLI tracker does not normally expose a Linear client. The committed test-only bridge serves its in-memory session/activity state through a local GraphQL fixture, and supplies a real Linear SDK client to the production `McpConfigService`. The production MCP handler and HTTP transport are unchanged. This validates SDK queries and serialization without contacting production Linear; live Linear authorization is not covered.

```bash
pnpm build
apps/f1/f1 init-test-repo --path /tmp/f1-cypack-1506-contents
CYRUS_PORT=3600 CYRUS_REPO_PATH=/tmp/f1-cypack-1506-contents \
  bun run apps/f1/test-drives/assets/cypack-1506-server.mjs
```

In another terminal:

```bash
apps/f1/f1 ping
apps/f1/f1 status
apps/f1/f1 create-issue --labels primary \
  --title 'CYPACK-1506 read session contents' \
  --description 'Use mcp__cyrus-tools__get_agent_session_contents with sessionId session-1 and first 2. Report its status and returned activity contents. If pageInfo.hasNextPage is true, call again with after set to pageInfo.endCursor and first 2. Do not edit files or use other Linear tools. Finish with F1_GET_AGENT_SESSION_CONTENTS_OK only if both calls succeed.'
apps/f1/f1 start-session --issue-id issue-1
apps/f1/f1 view-session --session-id session-1 --limit 4 --offset 0
apps/f1/f1 view-session --session-id session-1 --search F1_GET_AGENT_SESSION_CONTENTS_OK
bun run apps/f1/test-drives/assets/cypack-1506-verify.mjs
apps/f1/f1 stop-session --session-id session-1
# Ctrl+C in the server terminal.
```

Observed Linear SDK requests during the agent run:

```text
agentSession {"id":"session-1"}
agentSession_activities {"id":"session-1","first":2,"orderBy":"createdAt"}
agentSession {"id":"session-1"}
agentSession_activities {"id":"session-1","first":2,"after":"activity-5","orderBy":"createdAt"}
```

Direct MCP verifier output:

```json
{
  "result": "PASS",
  "firstPage": ["activity-10", "activity-9"],
  "secondPage": ["activity-8", "activity-7"],
  "missingSession": {"success": false, "error": "Agent session not found"},
  "invalidPageSizeRejected": true
}
```

## Retrospective

The first fixture run exposed a case-sensitive GraphQL operation-name mismatch in the test bridge; corrected it and repeated the drive in a fresh repository. The final drive passed. F1 retains an `active` tracker status after a successful runner turn, so completion was verified via the final response and successful runner result, followed by explicit session stop.

The separate MCP/SDK tests additionally exercise all six activity types, action parameters/results, JSON scalar decoding for plans and signal metadata, empty sessions, input bounds, and errors from either API request.

### Rename verification

Repeated the F1 drive after renaming the tool to `get_agent_session_contents`. The agent discovered the renamed tool, successfully retrieved two pages, and posted `F1_GET_AGENT_SESSION_CONTENTS_OK`. The direct MCP verifier passed as well; the existing `linear_get_agent_session` metadata tool remains available.
