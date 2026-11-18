# Chat automatic tool approval

**Date:** 2026-11-18  
**Runtime code tested:** `9829f155a8a4e65fb2b16d3c47e87d282122b087`

The runtime change since v0.2.81 applies the existing approval mode to Slack and Zulip through their shared runner factory. The remaining release payload is package metadata and the version-scoped development audit exception.

Built the edge worker and ran isolated F1 servers with the automatic and allowlist configurations. A temporary F1 fixture selected the mode and hosted a local stub for the Zulip messaging API. All provider sessions ran on the built runtime using a disposable repository and separate chat workspaces.

- Sent synthetic Slack mentions to `/cli/dispatch-chat` and polled `/cli/chat-thread`. Claude reported `permissionMode: "auto"` and replied on both a new thread and its next turn. The allowlist control reported `permissionMode: "default"` and replied.
- In a separate Automatic Slack thread, Claude created a scratch file with Write, removed it with Bash, and reported success. A direct check found the file absent from the isolated workspace.
- Posted two local mention payloads to the normal `/zulip-webhook` route. Codex returned the expected markers to the local Zulip API stub for both the first turn and the resumed thread. The runner factory regression also verifies that Codex receives Automatic and retains its configured tool list for MCP scope.
- Focused edge-worker suites passed 141 tests. No live Slack or Zulip workspace was contacted. The temporary servers were shut down and the untracked fixture was removed from the worktree.
