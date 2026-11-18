# Slack access control

**Date** November 18, 2026  
**Runtime code tested** `128609b4a1b551057c1de2157b7fc40bef209ce4`  
**Previous release** `v0.2.82`

The runtime payload adds a Slack channel allowlist and a Linear-only wildcard for identified users. The remaining release changes are documentation and coordinated package metadata.

An isolated drive used the built EdgeWorker, a disposable local repository, and a watched config file. Synthetic events used the same Slack session handler as the F1 dispatch path. No Slack bot token or external provider account was used.

- A listed user in an unlisted channel and an unlisted user in a listed channel both failed to create a thread.
- A listed user in a listed channel created a thread. After hot reload to an empty channel allowlist, a reply to that thread was denied.
- After switching to Blocklist, the blocked channel and blocked user were denied. A non-blocked channel and user could start a thread.
- All seven synthetic runtime assertions passed. The fixture worker was stopped afterward.

The focused EdgeWorker suites passed 130 tests. They cover the Linear wildcard for identified users, missing identity, block precedence, repository overrides, platform separation, Slack thread follow-ups, and config reload. Linear authorization was checked locally through the runtime access evaluator. Live Linear and Slack delivery were outside this verification.
