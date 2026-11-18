# Slack access controls and custom instructions

Tested runtime source `e3562c967d59d9e5c5d6e998a3793cbaf6fec9f1` in the F1 harness with an isolated Git fixture repository. The previous release tag has the same tree as the base, so these changes are the functional release delta.

After `pnpm build`, started the F1 server on localhost port 3657 with a disposable config file, the normal config watcher, and a local fixture route calling the real config updater. Dispatched synthetic Slack mentions through `POST /cli/dispatch-chat`.

| Step | Observed |
| --- | --- |
| Push `userAccessControl.blockedUsers: [{ slackId: "UHOSTED" }]` | The watcher reloaded the runtime config without restarting. |
| Allowed user in a blocked channel | Denied before a chat thread was created. |
| Blocked user in an allowed channel | Denied by the existing user block list before a chat thread was created. |
| Push `userAccessControl.blockedUsers: []` | The watcher reloaded the cleared list without restarting. |
| Formerly blocked user asks for a verification word in an allowed channel | Claude completed and returned exactly `ORCHID847`, specified only in the custom system instructions. |

The F1 server shut down and the temporary harness copy was removed. The test used synthetic Slack messages without a bot token. The workspace build, CLI config forwarding tests (7), and focused EdgeWorker tests (123) passed.
