# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed
- If you run the Azure router, `enableFleetRecovery = true` now actually enables guarded recovery. It only ever did half the job: it added `fleet.recover` to the operator grants, so a principal was authorized to ask — but it never told the router to accept, so the router built no recovery service, advertised no recovery capability, and refused every request. The result was a deployment that looked configured for recovery from the parameter file and, from the operator's side, was indistinguishable from one where recovery had been left off. Both halves now come from that one parameter. It remains `false` by default and stripping the role while it is false is unchanged. ([CYR-89](https://linear.app/northrop-digital/issue/CYR-89/verify-the-operator-surface-post-deployment-and-decide-the-recovery), [#80](https://github.com/nick-boey/cyrus/pull/80))
- If you run the Azure router, a parameter file that breaks one of the template's cross-parameter rules is now caught when you preview it, not when you apply it. Fifteen rules are enforced this way — "`enableSetupUi` requires `enableSetupAuth`", "traces require logs", and so on — and every one of them was invisible to `what-if`, which reported a perfectly ordinary change list and then let the deployment fail partway in. The preview now validates the parameters first, so a broken combination stops before anything is described as changing, and names the rule it broke. ([CYR-89](https://linear.app/northrop-digital/issue/CYR-89/verify-the-operator-surface-post-deployment-and-decide-the-recovery), [#80](https://github.com/nick-boey/cyrus/pull/80))
- An agent in a cloud sandbox can now run a repository's Bicep, PowerShell, pnpm and .NET 8 checks. All four used to fail the same way: the tool was not installed and the sandbox could not reach the host it would have been fetched from, so each failed at bootstrap rather than failing a check — which meant an agent could open a pull request whose infrastructure changes had been validated by nothing, and could only say so in prose. It was also worse than one failure each: a `check-all.sh`-style script aborts at the first missing tool, so every step after it silently never ran, and an agent seeing no failure output could reasonably conclude the tree was clean. The worker image now carries the Bicep CLI (with Azure CLI configured to use it rather than downloading its own on every invocation), the .NET 8 ASP.NET Core runtime alongside the .NET 10 SDK so `dotnet test -f net8.0` can actually run, Pester for PowerShell suites, `dotnet-affected` on `PATH` so no manual `PATH` edit is needed, and activated `pnpm`/`yarn` — `corepack enable` could never have worked from a session, because it writes next to `node` in a directory the agent cannot write to. Which pnpm runs is still the repository's choice: its `packageManager` pin is honoured and fetched on demand. Bicep templates that pull in a shared public module now work too — those are fetched from a Microsoft registry the sandbox previously could not reach, which failed the compile before it started. ([CYR-88](https://linear.app/northrop-digital/issue/CYR-88/sandbox-cannot-run-the-bicep-powershell-pnpm-or-net-8-repository-gates), [#78](https://github.com/nick-boey/cyrus/pull/78))
- `az monitor app-insights query` now works in a cloud sandbox. The extension that provides it was not installed, and while the command itself does fail loudly, it is usually run inside a script that keeps only its output — so the answer that came back was an empty result, which is precisely what authorises deleting a component believed to emit no telemetry. The extension is now in the worker image and the Application Insights data plane is reachable, as are the hosts `az extension add` and PowerShell's `Install-Module` need, so a repository can also install extensions and modules Cyrus does not ship. Existing sandboxes keep the network policy they were created with — destroy an issue's sandbox and re-prompt to pick this up. ([CYR-88](https://linear.app/northrop-digital/issue/CYR-88/sandbox-cannot-run-the-bicep-powershell-pnpm-or-net-8-repository-gates), [#78](https://github.com/nick-boey/cyrus/pull/78))
- Agents can run Playwright suites in a cloud sandbox again. The worker image bakes a browser, but Playwright only launches the exact browser revision its own version asks for — so a repository pinning a different Playwright than the image saw the baked browser ignored, and the download that would have fixed it was blocked, leaving no way to run a visual-regression suite locally at all. The Playwright browser CDN is now reachable from a sandbox, so a repository whose pin differs downloads the revision it needs once and then runs — including repositories on an older Playwright, which uses a different set of download hosts. The image's own browser is matched to the pinned Playwright as well, so the common case needs no download. Existing sandboxes keep the network policy they were created with — destroy an issue's sandbox and re-prompt to pick this up. ([CYR-87](https://linear.app/northrop-digital/issue/CYR-87/playwright-cannot-launch-in-the-sandbox-the-image-bakes-chromium-1234), [#76](https://github.com/nick-boey/cyrus/pull/76))
- If you run the Azure router, a cloud sandbox resumed from a saved snapshot now gets the same network policy as a freshly created one. It was only ever set when a sandbox was built from the image, and restoring does not carry the previous one over — so a sandbox that came back from a snapshot was left on whatever the platform defaults to, rather than the deny-by-default allowlist Cyrus intends, and never picked up hosts added by an upgrade. The auto-suspend setting was already being re-applied on both paths for the same reason. ([CYR-87](https://linear.app/northrop-digital/issue/CYR-87/playwright-cannot-launch-in-the-sandbox-the-image-bakes-chromium-1234), [#76](https://github.com/nick-boey/cyrus/pull/76))
- If you run the Azure router, an abandoned cloud sandbox is now cleaned up in three days rather than fourteen. The old rule waited a fortnight because it only looked at whether anything had been sent to the sandbox and whether the sandbox had checked in — too little to be confident sooner. It now also looks at what the agent itself did, at the runs on that sandbox, and at when a session last picked it up, and a sandbox quiet on all of those for three days is shut down and removed along with its snapshots. Whatever it was holding is released, so an issue that had become unreachable can be worked on again. A sandbox whose worker is still connected is never removed this way, however quiet it looks. Set `containers.reclaimStrandedMs` to change the three days, or to `0` to keep the old fourteen-day behaviour. ([CYR-84](https://linear.app/northrop-digital/issue/CYR-84/sweep-stale-aca-sandboxes-and-obsolete-disk-images-automatically), [#75](https://github.com/nick-boey/cyrus/pull/75))
- If you run the Azure router, old worker images no longer pile up. Every deployment registers a new image, and nothing ever removed the old ones — one audited deployment had built up 14 images taking 68 GB, more than half of which nothing was using. Images with nothing running on them, nothing restoring from them, and no issue pinned to them are now removed once they are a week old, except for the three newest, which are always kept. Those two floors are both there on purpose: the image you are about to deploy and the one you would roll back to are, at that moment, used by nothing — and keeping them by age alone would leave you with nothing to roll back to if you deploy less often than once a week. The current deployment image is never removed, whatever its age. Set `containers.aca.imageRetentionMs` and `containers.aca.imageRetentionCount` to change the two floors, `containers.aca.imageGcIntervalMs` to change how often the check runs, `containers.aca.imageGcDryRun` to watch a round decide without removing anything, or `containers.aca.imageGcEnabled: false` to turn it off. ([CYR-84](https://linear.app/northrop-digital/issue/CYR-84/sweep-stale-aca-sandboxes-and-obsolete-disk-images-automatically), [#75](https://github.com/nick-boey/cyrus/pull/75))
- `cyrus runs`, `cyrus logs`, `cyrus connection`, and `cyrus recover` now exit `2` when you mistype an option or pass a stray argument, instead of `1`. Their documented exit codes always said `2` for an invalid invocation, but the argument parser rejected the command before any of that applied, so a script branching on `2` never fired for the most common mistake. Other commands are unchanged. ([CYR-76](https://linear.app/northrop-digital/issue/CYR-76/ship-the-guarded-cyrus-recover-workflow), [#72](https://github.com/nick-boey/cyrus/pull/72))
- Prompting an issue whose cloud sandbox has been parked for a couple of days no longer starts a session that runs invisibly. The router reclaims the locks of machines that have gone dark, and a parked sandbox looks dark by definition — so once one had been idle longer than the event lifetime, the very next sweep tore the lock off a session that had been routed to it seconds earlier, while its sandbox was still booting. The session then started anyway and ran disowned: everything it did was refused on the way to Linear, and the idle sweep suspended its sandbox mid-work because the issue no longer looked claimed. On one issue that meant three and a half hours of implementation work with no visible output, followed by a second session starting alongside the first in the same worktree, each editing the other's uncommitted files. A cloud sandbox now keeps its claim on the issue while work it was just handed is still on its way to it. A sandbox that genuinely died mid-session is still reclaimed exactly as before, and nothing changes for sessions running on your own machine. ([CYR-81](https://linear.app/northrop-digital/issue/CYR-81/dont-reclaim-a-devices-locks-while-a-boot-it-was-just-routed-to-is-in), [#69](https://github.com/nick-boey/cyrus/pull/69))
- `cyrus runs list` now shows one row per agent session rather than one per turn. Stopping a session in Linear and restarting it with Continue ends one run and opens another under the same session, so the listing showed a `stopped` row beside an `active` one and read as two agents working the same issue — the state you would escalate. The listing keeps each session's current turn; `--all-runs` shows every turn when you want the history. Runs are still recorded per turn, because a run's team and project are the ones it was routed under and rewriting them across a stop would falsify what already happened. ([#65](https://github.com/nick-boey/cyrus/pull/65))
- A running session now reports which agent is running it. `runner` was only ever sent when a run paused for a question, ended a turn holding background work, or finished, so an ordinary run showed as `unknown` for its whole life and the column was blank exactly while the work was in flight. The runner is now reported as soon as it is attached. The model still appears only once the agent has started — it is left absent rather than guessed, and fills in on the next report. ([#65](https://github.com/nick-boey/cyrus/pull/65))

### Added
- If you run the Azure router, you can now advertise which `cyrus-fleet-operator` release your operators should install, with the new `fleetOperatorSkill` parameter. There was no way to do it before, so `cyrus skills list` reported nothing advertised on every Azure deployment and there was nothing for `cyrus skills install` to resolve against. Advertising is not trust: the CLI still resolves the download from its own built-in registry and verifies the published checksum, so naming a release cannot make a client install anything it would not otherwise accept. That is also the current limit of the feature — the CLI builds its download URL from the official `cyrusagents/cyrus` releases, so advertising a release published anywhere else will resolve to a URL that does not exist. ([CYR-89](https://linear.app/northrop-digital/issue/CYR-89/verify-the-operator-surface-post-deployment-and-decide-the-recovery), [#80](https://github.com/nick-boey/cyrus/pull/80))
- Cyrus now publishes one versioned `cyrus-fleet-operator` skill with every release and installs it through `cyrus skills install cyrus-fleet-operator --target <claude|codex>`. The CLI derives the archive and checksum URLs from its built-in official-release registry, checks authenticated router compatibility without trusting the router's advertised URL, verifies both SHA-256 values, rejects unsafe archive paths and links, and swaps the verified skill into place atomically. `cyrus skills list` reports compatible versions from live authenticated connection context. The skill composes the existing connection, run, log, and guarded-recovery commands, stays within the remote profile, and stops at stale evidence, refusal, elicitation, missing capability, or any break-glass boundary. ([CYR-77](https://linear.app/northrop-digital/issue/CYR-77/publish-and-install-the-trusted-fleet-operator-skill), [#73](https://github.com/nick-boey/cyrus/pull/73))
- `cyrus recover <runId>` asks a router to reconcile one stuck agent run from the terminal — the case where Linear still shows a live agent session that nothing is working on, and every comment you post on the issue is rejected. It reads the run's current state, asks the router to reconcile it, and then prints each step as it happens until the run is recovered, needs your input, is refused, or fails. `cyrus recover --issue NOR-402` does the same when you only know the issue, and acts only when exactly one unfinished run matches — zero or several stops and lists the candidates without touching anything. Recovery is safe by design and never asks you to confirm. ([CYR-76](https://linear.app/northrop-digital/issue/CYR-76/ship-the-guarded-cyrus-recover-workflow), [#72](https://github.com/nick-boey/cyrus/pull/72))
- The command cannot do anything except ask for a run to be reconciled. There is no `--force`, no unlock, no way to destroy a sandbox, and no way to pick which internal step runs — the router decides that, and the command only reports which one it is on. It also never posts to Linear. Unlock, forced termination, and sandbox destruction stay where they were, as separate commands on the router host. ([CYR-76](https://linear.app/northrop-digital/issue/CYR-76/ship-the-guarded-cyrus-recover-workflow), [#72](https://github.com/nick-boey/cyrus/pull/72))
- A recovery can never act on evidence that has gone stale. Unless you pass `--expected-revision`, the run is re-read immediately before the request, and the router refuses if the run moved in between. Every request also carries an idempotency key: retrying with the same key joins the attempt already running instead of starting a second one, and the generated key is printed so you can retry with it later. Pass `--idempotency-key` yourself when the retry has to survive a restart. ([CYR-76](https://linear.app/northrop-digital/issue/CYR-76/ship-the-guarded-cyrus-recover-workflow), [#72](https://github.com/nick-boey/cyrus/pull/72))
- `cyrus recover --no-wait` returns as soon as the router accepts, and `cyrus recover status <operationId>` reads that operation back — with `--wait` to resume following it. Whatever happens, including a timeout, the output always carries the operation id, because a recovery keeps running on the router after this command stops watching. Waiting stops after 10 minutes by default, which is generous on purpose: a recovery starts a cloud sandbox and waits for it to come back. ([CYR-76](https://linear.app/northrop-digital/issue/CYR-76/ship-the-guarded-cyrus-recover-workflow), [#72](https://github.com/nick-boey/cyrus/pull/72))
- Recovery reports the same exit codes as the other fleet commands: `0` recovered, `3` for a run needing input or a refusal, `4` when this command stopped watching, `5` for a credential problem, `6` for a transient router failure, and `2` for a bad invocation, an ambiguous issue, or a router that does not offer recovery. `3` and `4` are deliberately different: a refusal is the router's answer, while a timeout only means we stopped looking. Output is one line per phase by default, one JSON document with `--json`, or one event per line with `--ndjson`. Anything a router wrote into a failure message or a phase detail has credentials stripped out of it before printing, whichever mode you chose. ([CYR-76](https://linear.app/northrop-digital/issue/CYR-76/ship-the-guarded-cyrus-recover-workflow), [#72](https://github.com/nick-boey/cyrus/pull/72))
- The default worker image now includes Azure CLI and the GA Log Analytics query command. Operators can optionally store `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, and `AZURE_TENANT_ID` for a user; a complete set signs the worker into Azure before setup starts, while absent credentials leave Azure disabled and a partial or rejected set stops boot with redacted diagnostics. The credentials are removed before the agent starts, Azure CLI telemetry is disabled, and the default ACA and `trusted` network policies permit Azure public-cloud authentication, Resource Manager reads, and both current Log Analytics query hosts. Repository-owned devcontainers remain unchanged. ([CYR-82](https://linear.app/northrop-digital/issue/CYR-82/set-up-az-cli-with-read-only-service-principal), [#71](https://github.com/nick-boey/cyrus/pull/71))
- Asking a router to recover a stuck run now actually recovers it. The router starts the run's stopped cloud sandbox, waits for its worker to come back and prove who it is, asks that worker which sessions it is running, and gives the worker's own buffered messages a moment to arrive. Only if the worker that came back does not claim the run does the router release every claim the run was holding — its claim on the sandbox, the issue lock, and the grace period a paused session keeps — and record its outcome as unobserved, all in one step, so a run can never be left half-released. That is the fix for the failure this whole feature exists for: an issue whose sandbox stopped while it still held the lock, which Linear keeps showing as a live agent session and which rejects every new comment you post on it. If the run's own finish message lands while the router is waiting, the router keeps the outcome the worker reported rather than overwriting it, and still clears anything that finish left behind. ([CYR-75](https://linear.app/northrop-digital/issue/CYR-75/reconcile-stranded-run-ownership-safely-on-the-router), [#70](https://github.com/nick-boey/cyrus/pull/70))
- Recovery will not act on a worker that has not caught up yet. If the sandbox still has messages queued for it, or the session was claimed within the last few minutes, the attempt stops rather than reading "I'm running nothing" from a worker that simply has not been handed the work yet. Releasing there would leave the session running with no claim on its own issue: everything it posts refused, and its sandbox suspended mid-work. ([CYR-75](https://linear.app/northrop-digital/issue/CYR-75/reconcile-stranded-run-ownership-safely-on-the-router), [#70](https://github.com/nick-boey/cyrus/pull/70))
- Recovery stops if the session starts a new run while it is working. That is the likely case rather than a rare one: replying in the thread is how you get past a rejected comment, and doing so the moment recovery frees the issue starts fresh work on the same sandbox. The new run keeps its claim and its lock, and the recovery reports that the session moved on. ([CYR-75](https://linear.app/northrop-digital/issue/CYR-75/reconcile-stranded-run-ownership-safely-on-the-router), [#70](https://github.com/nick-boey/cyrus/pull/70))
- Recovery declines rather than guesses. A run whose worker is currently connected is left alone — a connected worker owns its own run, whether it is busy or merely quiet. A run waiting on a question comes back as needing input, because the router cannot answer it for you. A run on a teammate's own machine that is switched off is declined outright, since the router has no way to start it and will not conclude anything from that machine's silence. A run that has moved on since you read it, or that moves on while the recovery is in flight, is refused so a stale decision can never overwrite a newer one. In every one of those cases nothing is started, nothing is released, and nothing is written. ([CYR-75](https://linear.app/northrop-digital/issue/CYR-75/reconcile-stranded-run-ownership-safely-on-the-router), [#70](https://github.com/nick-boey/cyrus/pull/70))
- A recovery that cannot finish its job fails without touching anything. A sandbox that will not start, a worker that never reconnects, and a worker that reconnects but will not say what it is running all end the attempt with the reason recorded and the run's ownership exactly as it was — "the worker did not answer" is never read as "the worker is running nothing". Recovery has no way to stop a session, destroy a sandbox, or post to Linear, and every release it does perform is recorded so you can tell an attempt that freed a live claim from one that found nothing to do. ([CYR-75](https://linear.app/northrop-digital/issue/CYR-75/reconcile-stranded-run-ownership-safely-on-the-router), [#70](https://github.com/nick-boey/cyrus/pull/70))
- Two new optional router settings tune recovery: `containers.recoveryReconnectTimeoutMs` (default 3 minutes) is how long it waits for a restarted sandbox's worker to reconnect, sized for a cold start that has to pull an image, and `containers.recoveryReplayMs` (default 5 seconds) is how long it lets that worker's buffered messages arrive before judging a claim stale. Omit both and nothing changes. ([CYR-75](https://linear.app/northrop-digital/issue/CYR-75/reconcile-stranded-run-ownership-safely-on-the-router), [#70](https://github.com/nick-boey/cyrus/pull/70))
- You can now ask a router to reconcile one stuck agent run, and it keeps a durable record of the attempt. A request names the run, the observation version you actually read, and a key of your own choosing; the router refuses if the run has moved on since you looked, so a recovery can never act on evidence that has gone stale, and refuses a run that has already ended. Retrying with the same key joins the attempt you already started rather than beginning a competing one, and reusing that key for a different run is refused outright. The attempt is recorded as an operation you can read back — who asked, what it targeted, every step it passed through, and what ownership looked like before and after — so progress survives a router restart and never depends on anything having been posted to Linear. ([CYR-74](https://linear.app/northrop-digital/issue/CYR-74/persist-authorize-and-audit-recovery-operations), [#68](https://github.com/nick-boey/cyrus/pull/68))
- Recovery is off unless a router is explicitly configured for it, and turning it on is the only switch there is — the router builds the reconciliation itself, so it can never advertise recovery with nothing behind it. While it is off, the capability is not advertised and every request is refused, which is the state every router ships in. A router with no cloud sandboxes says so at startup: it can still accept a recovery, but every run it has is on somebody's own machine and will be declined. ([CYR-74](https://linear.app/northrop-digital/issue/CYR-74/persist-authorize-and-audit-recovery-operations), [#68](https://github.com/nick-boey/cyrus/pull/68), [CYR-75](https://linear.app/northrop-digital/issue/CYR-75/reconcile-stranded-run-ownership-safely-on-the-router), [#70](https://github.com/nick-boey/cyrus/pull/70))
- Asking to recover a run you may not see answers exactly as asking to recover a run that does not exist, so no one can probe another workspace for which runs and which operations are there. Reading a run is not permission to recover one: an operator with read access alone, a machine running your own sessions, and a cloud sandbox are all refused. ([CYR-74](https://linear.app/northrop-digital/issue/CYR-74/persist-authorize-and-audit-recovery-operations), [#68](https://github.com/nick-boey/cyrus/pull/68))
- Every recovery — accepted, joined, each step, refused, or failed — also emits a structured audit record carrying the workspace, the run, who asked, and the ownership evidence on both sides of the attempt, so an attempt is queryable long after the operation itself ages out. Nothing an operator or a coordinator writes is stored or logged before credentials are stripped from it, and no prompt text or agent-activity content is recorded at any point. ([CYR-74](https://linear.app/northrop-digital/issue/CYR-74/persist-authorize-and-audit-recovery-operations), [#68](https://github.com/nick-boey/cyrus/pull/68))
- `cyrus logs query` and `cyrus logs follow` read a remote fleet's logs from the terminal, using the same stored connection as `cyrus runs` and available in both command profiles. Filters are the facts you already think in — issue, run, session, owner, team, project, component, level, message text, trace id, and a time window — and they are spelled the same as the matching `cyrus runs` filters, so a run you found with `cyrus runs list --issue NOR-402` reads with `cyrus logs query --issue NOR-402`. There is no way to write a backend query by hand; `--show-query` prints the generated one to stderr if you want to reproduce it elsewhere. Router lines and cloud-sandbox lines both come back, each saying which it was. ([CYR-73](https://linear.app/northrop-digital/issue/CYR-73/query-and-follow-log-analytics-directly-from-the-cli), [#67](https://github.com/nick-boey/cyrus/pull/67))
- Log queries go from your machine straight to the log backend, never through the router. The router only says *where* the logs are; your own local credentials read them, so your own grant on that workspace decides what you can see, and log data never crosses a hop that would have to buffer it. ([CYR-73](https://linear.app/northrop-digital/issue/CYR-73/query-and-follow-log-analytics-directly-from-the-cli), [#67](https://github.com/nick-boey/cyrus/pull/67))
- A log query that would exceed a budget now fails and prints nothing, rather than returning part of the answer. Too many matching records, a record over 256 KiB, a result over 10 MiB, a range wider than the source allows, or a partial result from the backend are all refused with a message naming what to narrow. A truncated log window reads exactly like a complete one, and reading one is how you conclude an error never happened. ([CYR-73](https://linear.app/northrop-digital/issue/CYR-73/query-and-follow-log-analytics-directly-from-the-cli), [#67](https://github.com/nick-boey/cyrus/pull/67))
- `cyrus logs follow` re-reads an overlap of its previous window on every poll and suppresses the duplicates, because a record is only queryable once the backend has ingested it — some time after it was written. It reports the ingestion lag it observes and widens the overlap when that lag grows, and it says plainly that it is polling a historical store rather than following a live stream, so a quiet screen is not read as a quiet fleet. ([CYR-73](https://linear.app/northrop-digital/issue/CYR-73/query-and-follow-log-analytics-directly-from-the-cli), [#67](https://github.com/nick-boey/cyrus/pull/67))
- Known secrets are removed from log output before it is printed: values under credential-named keys, recognizable credential shapes such as bearer headers and tokens, and the exact values of any credentials in your own environment. A record that was altered says so. ([CYR-73](https://linear.app/northrop-digital/issue/CYR-73/query-and-follow-log-analytics-directly-from-the-cli), [#67](https://github.com/nick-boey/cyrus/pull/67))
- Router logs now carry the workspace, owner, team, project, issue, run, session, device, agent, and model a line belongs to — the same set on every line, whether the router wrote it or a cloud sandbox did. Answering "what happened on this run?" was previously a matter of joining three differently-named partial views, and you could only start if you already knew the session id; it is now one filter on the run id. A fact that was not known when the line was written is recorded as empty rather than omitted, so you can search for the lines that are missing one; nothing is ever guessed or filled in with a default. No prompt text and no agent-activity content is logged. ([CYR-72](https://linear.app/northrop-digital/issue/CYR-72/emit-canonical-run-and-routing-attributes-in-console-logs), [#66](https://github.com/nick-boey/cyrus/pull/66))
- A cloud sandbox cannot label its own logs with someone else's workspace, owner, run, issue, or device. Every one of those is stamped by the router from the device it authenticated and the run it recorded, and a sandbox that claims a different issue or session has the disagreement recorded beside the router's answer rather than silently resolved. ([CYR-72](https://linear.app/northrop-digital/issue/CYR-72/emit-canonical-run-and-routing-attributes-in-console-logs), [#66](https://github.com/nick-boey/cyrus/pull/66))
- Runs the router ended *itself* — because a reconnecting machine no longer tracked the session, because an event expired before any machine took it, or because a run's machine had been replaced — are now distinguishable from runs that reported finishing normally. Both end a run, but only the first kind means nobody ever saw the outcome, and they used to be indistinguishable in the logs. A run that had already finished normally is never reported this way, and a machine replaying a message the router already handled does not report its run as ending twice. Three new saved queries on Azure show one run end to end, list the runs that ended unobserved by reason, and break run volume and outcome down by workspace, team, project, agent, and model. ([CYR-72](https://linear.app/northrop-digital/issue/CYR-72/emit-canonical-run-and-routing-attributes-in-console-logs), [#66](https://github.com/nick-boey/cyrus/pull/66))
- A refused prompt or a dropped agent post is now findable by workspace, team, or issue rather than only by session id. These are the events that mean a comment never reached an agent, or that something an agent said never reached Linear — the ones you go looking for without knowing which session to look in. Existing log queries are unaffected: columns were added beside the old ones, never renamed. ([CYR-72](https://linear.app/northrop-digital/issue/CYR-72/emit-canonical-run-and-routing-attributes-in-console-logs), [#66](https://github.com/nick-boey/cyrus/pull/66))
- A self-hosted router can now say where its historical logs live, in the units you think in, with a new `observability.logSource` block in `router-config.json`: the Log Analytics workspace ID, optionally its ARM resource id and cloud, and optionally how far back a query reaches by default, how wide a range it may ask for, how many records it may return, and how fast a follow may re-poll. Budgets default to 15 minutes, 24 hours, 5000 records, and 15 seconds. Omit the block and nothing changes — the router advertises no log capability and hands out no descriptor. An Azure deployment does not need it: `main.bicep` still renders the same thing from the workspace it created. Declaring it in both places is refused at startup rather than one quietly winning. ([CYR-71](https://linear.app/northrop-digital/issue/CYR-71/advertise-the-configured-historical-log-source), [#64](https://github.com/nick-boey/cyrus/pull/64))
- What the router hands over is a way to *find* the logs and nothing more: there is no router endpoint that accepts a query, runs one, or returns a log record, and the router holds no credential for the log backend — your own client authenticates to it directly. The descriptor is disclosed only on the authenticated operator context route, and only to a caller who may query it: an anonymous caller, an unauthorized one, and a device token all receive nothing, since a device token is scoped to your own work and the router cannot narrow a query it never sees. ([CYR-71](https://linear.app/northrop-digital/issue/CYR-71/advertise-the-configured-historical-log-source), [#64](https://github.com/nick-boey/cyrus/pull/64))
- A mistyped log source is now refused when the router starts, naming the field, instead of becoming a `404` from Azure hours later that reads as a permissions problem. A workspace ID that is not a workspace ID, a resource id that is a URL or points at another kind of resource, a cloud that is not one of the three, a budget that is zero, negative, or fractional, a default lookback longer than the maximum range, and any unrecognized key beside them — including anything shaped like an endpoint or a credential — are all rejected. The two Azure identifiers are checked wherever a log source comes from, including the block an Azure or Docker deployment renders for you, not only the hand-written form. There is deliberately no way to name a log table or write a query in configuration. ([CYR-71](https://linear.app/northrop-digital/issue/CYR-71/advertise-the-configured-historical-log-source), [#64](https://github.com/nick-boey/cyrus/pull/64))
- `cyrus runs` is now three commands with three different jobs, instead of one command whose meaning changed with its flags. `cyrus runs list` prints every current run for one workspace and succeeds whatever states it reports — an unhealthy fleet is a successful read, not a failed command. `cyrus runs watch` follows material changes as they land and stops on `--timeout` or Ctrl-C; no run outcome inside it can fail it. `cyrus runs wait <runId>` blocks on one run and is the only one of the three whose exit code describes work rather than the read. `list` and `watch` share one filter vocabulary — `--run`, `--session`, `--issue`, `--state`, `--runner`, `--model`, `--comment`, `--routed-after`, `--owner`, `--team`, and `--project` — and `wait` takes a run id and nothing else, because a filter over a fact that moves would make the run vanish the instant it changed. The four nameable filters, plus `--workspace`, accept a canonical id or the display name captured when the run was routed, and a name shared by two of them is refused with the ids to choose between rather than resolved to one; every line of output carries the id beside the name. There is no `--stalled`, and never will be: nothing here decides a run is stuck from elapsed time or silence, and `waiting` appears only because a worker reported it. ([CYR-70](https://linear.app/northrop-digital/issue/CYR-70/ship-deterministic-runs-list-watch-and-wait-workflows), [#63](https://github.com/nick-boey/cyrus/pull/63))
- `cyrus runs wait` distinguishes a run that is asking you a question from a wait that ran out of time. A worker-reported `waiting` state exits `3` and says what the run is waiting on; the command's own timeout exits `4` and prints the last state it saw. Previously both were the same generic failure, so a script could not tell "answer this" from "look again later". A run that ends in `error`, `stopped`, or `unknown` also exits `3`, and `complete` exits `0`. ([CYR-70](https://linear.app/northrop-digital/issue/CYR-70/ship-deterministic-runs-list-watch-and-wait-workflows), [#63](https://github.com/nick-boey/cyrus/pull/63))
- `cyrus runs watch` reads the router's durable change feed instead of comparing repeated snapshots, so a run that starts and finishes between two polls still appears. If the router restarts mid-watch, the stream says so — a `resync` event — then takes a fresh snapshot and resumes from the new position, rather than quietly presenting the gap as though it had been watched. ([CYR-70](https://linear.app/northrop-digital/issue/CYR-70/ship-deterministic-runs-list-watch-and-wait-workflows), [#63](https://github.com/nick-boey/cyrus/pull/63))
- These commands emit machine-readable output you can pipe: `--json` gives one `{"schemaVersion": 1, …}` document for `list` and `wait`, and newline-delimited JSON events for `watch`. Data goes to stdout and diagnostics, warnings, and deprecations go to stderr, so a parser on stdout never has to skip a line meant for a person. Without `--json` you get a human table. ([CYR-70](https://linear.app/northrop-digital/issue/CYR-70/ship-deterministic-runs-list-watch-and-wait-workflows), [#63](https://github.com/nick-boey/cyrus/pull/63))
- `cyrus runs` now works from a machine that runs no sessions of its own. It reads a stored connection from `cyrus connection add` rather than this device's own enrollment, so it is available under `cyrus --profile remote` — where device enrollment does not exist — as well as in the full CLI. ([CYR-70](https://linear.app/northrop-digital/issue/CYR-70/ship-deterministic-runs-list-watch-and-wait-workflows), [#63](https://github.com/nick-boey/cyrus/pull/63))
- Routers now serve two read-only fleet routes to an authorized operator: `GET /api/v1/runs`, a paginated snapshot of current runs, and `GET /api/v1/run-changes`, an ordered feed of the changes between snapshots. Both apply your workspace authorization before anything else, so counts, filters, and error messages describe only work you may already see. Runs can be filtered by run, session, issue, workspace, owner, team, project, state, agent, and model; workspaces, owners, teams, and projects accept either their id or an exact captured name, and a name shared by two of them is refused with the ids to choose between rather than silently resolved to one. A filter these routes do not implement — a typo, or one from a newer client — is refused rather than ignored, because an unapplied filter answers successfully with more runs than were asked for, which is the worst possible outcome on a surface used to decide whether to intervene. Nothing surfaces these yet — the commands that read them arrive with the fleet-operations CLI. ([CYR-69](https://linear.app/northrop-digital/issue/CYR-69/serve-paginated-run-snapshots-and-durable-material-changes), [#62](https://github.com/nick-boey/cyrus/pull/62))
- A run that starts and finishes between two polls is no longer invisible. Routers now durably record each material change to a run — it being routed, its lifecycle moving, what it is waiting on, its worker connecting or dropping, its container's state changing, and its latest published activity — so an operator who reconnects can replay what happened while they were away instead of seeing only where things ended up. Repeated heartbeats and unchanged container samples still refresh how current a fact is without adding to the feed, so watching a quiet fleet stays quiet. No prompt text and no agent-activity content is ever recorded — only timestamps and normalized facts. Finished runs and their history are kept for 24 hours; a run that is still going is kept until it finishes, however long that takes. ([CYR-69](https://linear.app/northrop-digital/issue/CYR-69/serve-paginated-run-snapshots-and-durable-material-changes), [#62](https://github.com/nick-boey/cyrus/pull/62))
- A client resuming the change feed with a position from before a router restart now gets an explicit "this stream is gone" rather than an empty, successful-looking answer it would read as "nothing happened". It can re-list and resume from a fresh position, and can ask for a position at the present rather than replaying the whole retained window to get there. A position presented against a different query, presented by a different operator, or not issued by that router at all is refused as a bad request instead — distinct from a lost stream, so an automated caller can tell "fix the request" from "start again". ([CYR-69](https://linear.app/northrop-digital/issue/CYR-69/serve-paginated-run-snapshots-and-durable-material-changes), [#62](https://github.com/nick-boey/cyrus/pull/62))
- A run whose container is destroyed, or whose machine goes dark long enough for the router to reclaim it, now reports that it ended. Previously only one of the several ways a container can go away recorded it, so a run could keep describing a sandbox destroyed hours earlier as running — the fleet view calling an unreachable issue healthy. ([CYR-69](https://linear.app/northrop-digital/issue/CYR-69/serve-paginated-run-snapshots-and-durable-material-changes), [#62](https://github.com/nick-boey/cyrus/pull/62))
- The existing `GET /runs` is unchanged: same shape, same owner-scoped device-token authentication, same fields. It now reads from the same place the new routes do, so the two can no longer disagree about a run. ([CYR-69](https://linear.app/northrop-digital/issue/CYR-69/serve-paginated-run-snapshots-and-durable-material-changes), [#62](https://github.com/nick-boey/cyrus/pull/62))
- A session that asks you a question while a background build is still running no longer leaves its container up by going silent about it. Previously "I am waiting on you" and "my container can be suspended" were a single signal, so a session that could not safely be suspended reported nothing at all — from the outside, indistinguishable from a worker that had stopped. The two are now separate: the session always reports that it is waiting, and simply declines to let its container be suspended while the build runs, because suspending it would freeze that build and its completion is what would have woken the session. ([CYR-68](https://linear.app/northrop-digital/issue/CYR-68/capture-routing-and-worker-reported-run-facts), [#61](https://github.com/nick-boey/cyrus/pull/61))
- Routers now record, for each run, the workspace, owner, Linear team, and Linear project it was routed under, which agent and model ran it, and what it was waiting on or held open by. These are captured when work is routed and never rewritten, so moving an issue to another team or project does not change the history of runs that already happened. Nothing surfaces them yet — the commands that read them arrive with the fleet-operations CLI — so today this changes what a router remembers, not what you can see. ([CYR-68](https://linear.app/northrop-digital/issue/CYR-68/capture-routing-and-worker-reported-run-facts), [#61](https://github.com/nick-boey/cyrus/pull/61))
- If you deploy Cyrus on Azure, fleet-operator access is now something you configure rather than assemble by hand. Three new deployment parameters — `fleetOperatorGrants`, `enableFleetRecovery`, and `fleetOperatorLogReaderPrincipalIds` — render the router's Entra grant table and its log-source metadata, and assign `Log Analytics Reader` at the workspace scope. Omit all three and your deployment is exactly what it is today: no operator role assignments, and no workspace metadata published to anyone. The two authorizations stay independent on purpose — what the router will answer, and what an operator's own client can read from Log Analytics — so granting one never grants the other. The router-side grants are credential-free by construction and are exported as a deployment output you can read back and check. Matching Entra app roles are optional and still created by hand with `az ad app update`, because app registrations are not Azure resources — they control who can obtain a token at all, not what that token can do; `infra/azure/README.md` § 12 has the commands, including the read-back-first step that stops you deleting the roles `/setup` sign-in depends on. ([CYR-66](https://linear.app/northrop-digital/issue/CYR-66/provision-fleet-operator-roles-and-log-analytics-access), [#60](https://github.com/nick-boey/cyrus/pull/60))
- Recovery is off by default and stays off until you turn it on. While `enableFleetRecovery` is false the deployment strips `fleet.recover` from every grant it renders, so someone who holds both roles keeps working read-only and a recovery-only grant disappears entirely — without touching their Entra assignment. Turning recovery on, or back off, is a parameter change and a redeploy. ([CYR-66](https://linear.app/northrop-digital/issue/CYR-66/provision-fleet-operator-roles-and-log-analytics-access), [#60](https://github.com/nick-boey/cyrus/pull/60))
- New `cyrus connection add <name> <url> --auth entra`, `cyrus connection list`, `cyrus connection show [name]`, and `cyrus connection remove <name>` store named connections to remote Cyrus routers, so a person or an agent can observe more than one fleet without re-typing a URL or a tenant. `add` reads the router's own discovery document for its Entra tenant and audience, so you never copy those out of a deployment by hand, and it then actually signs in before saving — a connection that would fail on first use is refused at the point you create it rather than looking like a fleet outage later. For routers that do not use Entra, `--auth local --token-env <ENV_NAME>` records the NAME of an environment variable holding a token from `cyrus router operators create-token`; the token itself is read fresh on every request and never written to disk, so rotating it needs no config change. `cyrus connection show` reports what the router says you may do right now — roles, capabilities, authorized workspaces, log source, and the operator skill it expects — rather than what was true when you added it, so a revoked grant shows up as a revoked grant. ([CYR-67](https://linear.app/northrop-digital/issue/CYR-67/add-the-remote-command-profile-and-named-router-connections), [#59](https://github.com/nick-boey/cyrus/pull/59))
- `cyrus connection show` accepts `--connection <name>` to choose between stored routers and `--workspace <id>` to choose between the workspaces a connection covers; the remaining fleet commands gain the same pair as they land. Both are optional when there is only one of the thing in question and required when there is more than one: Cyrus will not guess which fleet or which workspace you meant. A workspace can be named by its id or by an exact, unique name; a name shared by two workspaces is refused rather than resolved. ([CYR-67](https://linear.app/northrop-digital/issue/CYR-67/add-the-remote-command-profile-and-named-router-connections), [#59](https://github.com/nick-boey/cyrus/pull/59))
- `cyrus --profile remote` — or `CYRUS_COMMAND_PROFILE=remote` for an installation that should default to it — narrows the CLI to the commands for working with a remote router, hiding router administration, the worker, device enrollment, secrets, containers, and unlock. This is a discoverability boundary, not a security one: it keeps an orchestrating agent from reaching for a command that makes no sense where it is running, and it grants nothing — the router still authorizes every read and every change, exactly as before. The full command surface remains the default, and `--profile full` restores it for a single command. Today this profile carries `cyrus connection` and `cyrus runs`; `logs`, `recover`, and `skills` join as they are built. ([CYR-67](https://linear.app/northrop-digital/issue/CYR-67/add-the-remote-command-profile-and-named-router-connections), [#59](https://github.com/nick-boey/cyrus/pull/59))
- On Azure, a machine that holds more than one usable identity no longer dead-ends on whichever one it happens to find first. Cyrus tries workload identity, then managed identity, then a service principal from the environment, then your `az login`, and if the router *refuses* one it moves on to the next rather than stopping — so an unattended host carrying an ungranted managed identity beside a granted service principal now works. If everything is refused, the error names each credential it presented. It also names the case no grant can fix: a router will not accept an app-only token — a workload identity, a managed identity, or a service principal — whatever permissions it has been given, so for those the answer is to sign in as a person with `az login`. No credential can prompt you interactively, and each one is given a bounded time to answer, so a machine whose metadata endpoint silently swallows the request fails in seconds instead of hanging. ([CYR-67](https://linear.app/northrop-digital/issue/CYR-67/add-the-remote-command-profile-and-named-router-connections), [#59](https://github.com/nick-boey/cyrus/pull/59))
- Remote commands now exit with a category an automated caller can branch on rather than a single generic failure: `2` for a bad invocation, bad configuration, or something this router cannot do; `5` for an authentication or authorization failure; and `6` for a router that was unreachable or failed in a way worth retrying. Failing to reach a router and being refused by one are no longer the same exit code, so a script no longer retries a request that will never be allowed. ([CYR-67](https://linear.app/northrop-digital/issue/CYR-67/add-the-remote-command-profile-and-named-router-connections), [#59](https://github.com/nick-boey/cyrus/pull/59))
- `cyrus connect`, which enrolls this machine to receive its own work, is unchanged and unaffected. It and `cyrus connection` are deliberately separate: the device token from `cyrus connect` keeps exactly the scope it has today and is never widened into fleet-wide access. ([CYR-67](https://linear.app/northrop-digital/issue/CYR-67/add-the-remote-command-profile-and-named-router-connections), [#59](https://github.com/nick-boey/cyrus/pull/59))
- Routers now answer `GET /.well-known/cyrus`, an unauthenticated document naming the router, the operator API versions it speaks, and how to authenticate to it — and nothing else. No workspace, log source, run, user, or skill detail appears there, so pointing a tool at a router no longer requires being told out of band what it is or how to sign in to it. ([CYR-65](https://linear.app/northrop-digital/issue/CYR-65/authenticate-scoped-fleet-operators-and-expose-discovery), [#58](https://github.com/nick-boey/cyrus/pull/58))
- An authenticated operator can now ask a router what it is allowed to do, at `GET /api/v1/operator/context`. The answer describes only the caller: the roles they hold, the workspaces those roles cover, the operations this router will actually serve them, and — only if they may query it — where its logs live. There are two roles, `fleet.read` and `fleet.recover`, and holding read authority never implies the ability to recover a run. ([CYR-65](https://linear.app/northrop-digital/issue/CYR-65/authenticate-scoped-fleet-operators-and-expose-discovery), [#58](https://github.com/nick-boey/cyrus/pull/58))
- If you run a router on Microsoft Entra, you can now grant fleet-operations access to named people and groups under `fleetOperations` in `router-config.json`. Grants are keyed on immutable Entra object ids rather than on email addresses, so a renamed or recycled account cannot inherit somebody else's authority, and every request is re-checked for tenant, audience, and role before any workspace is mapped. ([CYR-65](https://linear.app/northrop-digital/issue/CYR-65/authenticate-scoped-fleet-operators-and-expose-discovery), [#58](https://github.com/nick-boey/cyrus/pull/58))
- New `cyrus router operators create-token --label <label> --role <role> --workspace <id>`, `cyrus router operators list`, and `cyrus router operators revoke <tokenId>` mint and manage operator credentials on a router that does not use Entra. `create-token` prints the token once and stores only its hash — `list` shows the grant and never the credential — and revocation takes effect on the very next request. Pass `--role` and `--workspace` more than once to grant several. ([CYR-65](https://linear.app/northrop-digital/issue/CYR-65/authenticate-scoped-fleet-operators-and-expose-discovery), [#58](https://github.com/nick-boey/cyrus/pull/58))
- The device token `cyrus connect` already gave you now also authenticates against the operator context route, at exactly the authority it already had: read-only, and scoped to your own work. It is deliberately not offered log queries, because those run against the log backend directly where the router cannot narrow them to you — that needs an operator credential. Tokens held inside cloud sandboxes are refused outright: a credential issued for one issue gains no fleet-wide reach. ([CYR-65](https://linear.app/northrop-digital/issue/CYR-65/authenticate-scoped-fleet-operators-and-expose-discovery), [#58](https://github.com/nick-boey/cyrus/pull/58))
- A router now refuses to start on a `fleetOperations.logSource` or `skill` block that the operator API would reject — an Azure log source naming no workspace, a non-Azure one carrying Azure details, a default lookback beyond the maximum range. Previously such a router started cleanly, served everything else normally, and failed only the authenticated operator route, for as long as it ran. ([CYR-65](https://linear.app/northrop-digital/issue/CYR-65/authenticate-scoped-fleet-operators-and-expose-discovery), [#58](https://github.com/nick-boey/cyrus/pull/58))
- You can now ask Claude sessions to run their tool invocations under the Claude Code sandbox that keeps your Anthropic credentials out of the environment of the shell commands the agent spawns. Set `CYRUS_SUBPROCESS_ENV_SCRUB=1` on the machine running Cyrus. It is off unless you ask for it, and when you do ask for it on a machine that cannot provide it, the session now fails to start and says on the issue what is missing and how to install it — rather than starting anyway without the protection, which is what the previous behaviour amounted to. **Please treat this as unverified and check it on your own machine before relying on it:** we have confirmed the prerequisites are in place, but we have not yet watched a shell command actually start without those credentials, and the underlying switch is undocumented by the Claude Code SDK. Requirements, all three of which must hold: `socat` and `bubblewrap` installed, and a kernel that lets an unprivileged process create a user namespace — the last is a property of the machine and cannot be installed, which is why this is opt-in per machine rather than on by default. Linux only; on macOS and Windows the request is refused rather than silently reported as active, because we cannot confirm it does anything there. Setting the underlying `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` variable by hand no longer has any effect — Cyrus now sets it per session from the setting above — and Cyrus will warn you once if it sees you doing so. Cloud sandboxes will carry the two packages once a new worker image and a new worker feature version are built and deployed; until then, leave the setting off there. ([NOR-412](https://linear.app/northrop-digital/issue/NOR-412/subprocess-env-scrubbing-is-off-in-every-sandbox-socat-and-bubblewrap), [#46](https://github.com/nick-boey/cyrus/pull/46))
- A session that fails before the agent starts now reports the failure on the issue and ends, instead of sitting at "Working…" forever. Startup failures were logged where only an operator would see them, so from the issue the session looked alive indefinitely and the issue stayed locked against further work. ([NOR-412](https://linear.app/northrop-digital/issue/NOR-412/subprocess-env-scrubbing-is-off-in-every-sandbox-socat-and-bubblewrap), [#46](https://github.com/nick-boey/cyrus/pull/46))
- You can now pick your own default coding agent and model, under **Session defaults** on the `/setup` page. Previously every issue ran Claude unless you remembered to put a label on it, which made a label mandatory rather than optional — so the label was carrying a preference that never changes instead of an exception. Your choice is per-person and applies across the workspace. Labels and `[agent=…]`/`[model=…]` tags keep working exactly as before and still win for the issue they are on. The list offers Claude and Codex; Gemini and Cursor are not offered because neither runs in a cloud container yet, and they remain available as a per-issue label on your own machine. Changing your default applies to issues that start a container after you save — an issue that already has one keeps the agent it started with until you run `cyrus router containers destroy <issueKey>` and re-prompt it, which the page now tells you. ([NOR-364](https://linear.app/northrop-digital/issue/NOR-364/allow-users-to-select-default-runners), [#41](https://github.com/nick-boey/cyrus/pull/41))
- Codex sessions can now run on your own ChatGPT subscription instead of a separately-billed API key. Connect it once under **Codex account** on `/setup`: run `codex login --device-auth` on your own machine and paste the file it writes. Cyrus keeps it signed in for you and hands each session a fresh short-lived copy, so you never have to sign in from inside a session and your concurrent issues do not fight over the credential. Your paste is checked when you submit it, so a wrong file is rejected there and then with a message saying what is wrong, rather than becoming a session that dies hours later. If the credential stops working — a lapsed subscription, or a `codex logout` on your laptop, which revokes every copy — the session fails with a message naming the fix rather than quietly running a different agent than you chose. `OPENAI_API_KEY` still works if you would rather use metered billing. ([NOR-364](https://linear.app/northrop-digital/issue/NOR-364/allow-users-to-select-default-runners), [#41](https://github.com/nick-boey/cyrus/pull/41))
- Cyrus can now read the contents of Linear agent sessions with the separate `get_agent_session_contents` tool, including user prompts, tool results, and responses, with pagination for longer conversations. ([CYPACK-1506](https://linear.app/ceedar/issue/CYPACK-1506), [#1473](https://github.com/cyrusagents/cyrus/pull/1473))
- New optional `maxConcurrentSessions` setting in `~/.cyrus/config.json` caps how many agent sessions run at once across all repositories and platforms. Extra session starts wait in order for a free slot and begin automatically as running sessions finish. Omit it for the previous unlimited behavior. The value hot-reloads with the config file: raising it admits queued sessions immediately, and lowering it takes effect as running sessions finish. ([#1445](https://github.com/cyrusagents/cyrus/pull/1445), [#1469](https://github.com/cyrusagents/cyrus/pull/1469))
- Zulip is now a supported chat platform. @mention the bot in a Zulip topic (or DM it) and Cyrus answers in that topic, with 👀/✅ reactions marking receipt and completion. Set `ZULIP_SITE`, `ZULIP_BOT_EMAIL`, `ZULIP_API_KEY` and `ZULIP_WEBHOOK_TOKEN` to enable it; see [docs/ZULIP.md](./docs/ZULIP.md). ([#1468](https://github.com/cyrusagents/cyrus/pull/1468))

### Changed
- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.261` to [`0.3.268`](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03268), bringing Claude sessions to parity with Claude Code 2.1.268. The accumulated update adds browser SSE delivery/catch-up helpers, preserves shell working-directory changes across multi-turn sessions, improves message correlation for synthetic and agent-initiated turns, records custom system prompts by default, and expands host control over permission prompts, plugin reloads, context usage, and interrupted-turn recovery. Updated `@anthropic-ai/sdk` from `^0.124.0` to [`^0.125.0`](https://github.com/anthropics/anthropic-sdk-typescript/releases/tag/sdk-v0.125.0), adding Managed Agents auto-mode permissions, public GitHub repository mounts, and new API types. The refreshed 31-tool Claude allowance lists remove the three MCP resource-discovery tools no longer exposed by Claude Code 2.1.268. ([CYPACK-1498](https://linear.app/ceedar/issue/CYPACK-1498/update-anthropic-aiclaude-agent-sdk-and-anthropic-aisdk-to-the-latest), [CYPACK-1505](https://linear.app/ceedar/issue/CYPACK-1505/update-anthropic-aiclaude-agent-sdk-and-anthropic-aisdk-to-the-latest), [CYPACK-1510](https://linear.app/ceedar/issue/CYPACK-1510/update-anthropic-aiclaude-agent-sdk-and-anthropic-aisdk-to-the-latest), [#1463](https://github.com/cyrusagents/cyrus/pull/1463), [#1471](https://github.com/cyrusagents/cyrus/pull/1471), [#1474](https://github.com/cyrusagents/cyrus/pull/1474), [cyrus-hosted#1063](https://github.com/cyrusagents/cyrus-hosted/pull/1063), [cyrus-hosted#1073](https://github.com/cyrusagents/cyrus-hosted/pull/1073), [cyrus-hosted#1077](https://github.com/cyrusagents/cyrus-hosted/pull/1077))
- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.260` to [`0.3.261`](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03261), adding initialization-time plugin delivery to avoid Windows launch failures with many plugins, fixing `query()` in runtimes without native `Symbol.dispose`, and bringing Claude sessions to parity with Claude Code 2.1.261. Updated `@anthropic-ai/sdk` from `^0.123.0` to [`^0.124.0`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md#01240-2026-09-04), adding expanded usage-report breakdowns, organization compliance-setting types, broader workspace-ID support, and safer agent-toolset filesystem permissions. The refreshed 31-tool Claude allowance lists are unchanged. ([CYPACK-1497](https://linear.app/ceedar/issue/CYPACK-1497/update-anthropic-aiclaude-agent-sdk-and-anthropic-aisdk-to-the-latest), [#1462](https://github.com/cyrusagents/cyrus/pull/1462), [cyrus-hosted#1062](https://github.com/cyrusagents/cyrus-hosted/pull/1062))

### Security
- Patched five newly reported Cyrus CLI dependency advisories by updating the Vitest toolchain and enforcing a safe Hono release, so `pnpm audit` again reports no known vulnerabilities. ([CYPACK-1503](https://linear.app/ceedar/issue/CYPACK-1503/address-open-security-patches-for-cyrus-cli), [#1466](https://github.com/cyrusagents/cyrus/pull/1466))

## [0.2.71] - 2026-09-04

### Added
- Every agent session now explains how to attach local images and videos to GitHub issues, pull requests, and comments with GitHub CLI v2.99.0 or newer, independently of optional browser tooling. ([CYPACK-1490](https://linear.app/ceedar/issue/CYPACK-1490/add-this-to-the-system-prompt), [#1453](https://github.com/cyrusagents/cyrus/pull/1453))

### Changed
- The fleet-operator skill no longer treats an empty `cyrus runs list` as proof there is nothing wrong. Runs are kept for 24 hours after they finish, but a cloud sandbox can hold an issue far longer than that — one was found still pinned six days after its last run — so the issue with the worst problem on a fleet is exactly the one the listing can show nothing for. The skill now sends you to the logs in that case, and says there is no run to recover in that state, only something to report. ([CYR-89](https://linear.app/northrop-digital/issue/CYR-89/verify-the-operator-surface-post-deployment-and-decide-the-recovery), [#80](https://github.com/nick-boey/cyrus/pull/80))
- The old `cyrus runs [issue] [--watch]` syntax still works for one more release and now prints a deprecation notice on stderr naming its replacement, rather than failing to parse on upgrade. Without `--watch` it runs `cyrus runs list`; with `--watch` it finds the single non-terminal run matching your filters and waits on it, and if more than one matches it stops and lists the run ids instead of picking one. `--after` maps to `--routed-after`. One behaviour does change: where the old `--watch` exited `1` for any non-`complete` outcome and for a timeout, it now uses the categories above — `3` for a non-success outcome, `4` for a timeout, `2` when more than one run matches — so a script testing for exit code `1` will no longer fire. ([CYR-70](https://linear.app/northrop-digital/issue/CYR-70/ship-deterministic-runs-list-watch-and-wait-workflows), [#63](https://github.com/nick-boey/cyrus/pull/63))
- The Codex model list on `/setup` now offers **GPT-5.6 Sol**, OpenAI's current flagship Codex model. GPT-5.5 stays the default and stays on the list, so nothing changes for you unless you pick the new one — and picking it is how you find out it works, because unlike every other name on that list it has not yet been run against a live ChatGPT subscription. That matters here: OpenAI serves a narrower set of models to a subscription than to a paid API key, and a name it refuses is a session that dies rather than one that falls back, which is why the list is short and why the unverified name is not the default. ([CYR-79](https://linear.app/northrop-digital/issue/CYR-79/make-codex-subscription-auth-independent-of-the-default-runner-and), [#55](https://github.com/nick-boey/cyrus/pull/55))
- A Codex session that names no model now runs the model shown on `/setup`, rather than one fixed when your Cyrus version was built. If you run cloud sandboxes this also means a wrong Codex model can be corrected by changing the setting, instead of needing a new sandbox image. ([CYR-79](https://linear.app/northrop-digital/issue/CYR-79/make-codex-subscription-auth-independent-of-the-default-runner-and), [#55](https://github.com/nick-boey/cyrus/pull/55))
- Cursor sessions no longer take an OpenAI model as their fallback. When a Cursor session needed to fall back it was handed a Codex model name, which Cursor cannot use; it now falls back to the Cursor model it is configured with. ([CYR-79](https://linear.app/northrop-digital/issue/CYR-79/make-codex-subscription-auth-independent-of-the-default-runner-and), [#55](https://github.com/nick-boey/cyrus/pull/55))
- Skills you install into `~/.claude/skills` now also work in Codex sessions, not just Claude ones. Codex has no user-level skill discovery of its own, so Cyrus stages those directories alongside your repository's and Cyrus's own before each run — previously a Codex session was told it had such a skill and then could not find it. ([NOR-365](https://linear.app/northrop-digital/issue/NOR-365/install-the-mattpocock-plugin-for-claude-code-in-the-sandboxes), [#39](https://github.com/nick-boey/cyrus/pull/39))
- If you keep only `summarize` and `verify-and-ship` and replace the rest of Cyrus's skills with your own, the agent is still told to run them — to open the pull request after a code change, and to post the session's final message. Previously that instruction was dropped along with the routing advice it was attached to, so in the configuration most likely to be used for a custom workflow, sessions could quietly stop opening PRs and posting summaries. ([NOR-365](https://linear.app/northrop-digital/issue/NOR-365/install-the-mattpocock-plugin-for-claude-code-in-the-sandboxes), [#39](https://github.com/nick-boey/cyrus/pull/39))
- The skill list Cyrus puts in front of the agent no longer advertises skills the agent cannot actually run. Skills that declare themselves user-invocable only (`disable-model-invocation`) are left out of that listing — you can still invoke them yourself as slash commands — and the accompanying routing advice is now built from the skills that are actually present, so trimming Cyrus's own skills no longer leaves instructions referring to skills you no longer have. ([NOR-365](https://linear.app/northrop-digital/issue/NOR-365/install-the-mattpocock-plugin-for-claude-code-in-the-sandboxes), [#39](https://github.com/nick-boey/cyrus/pull/39))
- Choosing Codex as your default no longer requires an Anthropic subscription. The credential check that runs before a cloud session starts demanded a Claude token from everyone, so someone who only uses Codex could not start a session at all — the readiness banner on `/setup` asked them for a credential they had no reason to hold. Both the banner and the check now ask for what your chosen agent actually needs. ([NOR-364](https://linear.app/northrop-digital/issue/NOR-364/allow-users-to-select-default-runners), [#41](https://github.com/nick-boey/cyrus/pull/41))
- On a router configured for Azure cloud sandboxes, everyone's sessions now run in one. Cloud sandboxes are the only thing that works on such a deployment, and the per-person executor setting could previously be left — or fall back to — "your own machine", where the issue would be silently dropped if you had not enrolled that machine. Nothing is rewritten: removing the Azure configuration restores the previous behaviour exactly. Relatedly, the router now refuses to start if it is configured to default everyone to a sandbox type it does not actually have, instead of accepting it and failing per-issue afterwards. ([NOR-364](https://linear.app/northrop-digital/issue/NOR-364/allow-users-to-select-default-runners), [#41](https://github.com/nick-boey/cyrus/pull/41))
- Errors in the log stream now carry the error's type, message, and full stack trace as separate fields, so a log backend can group failures by type and show you the stack without you having to read it out of a message. The stack includes the underlying cause when one error wraps another — previously an outer error's stack often pointed only at Cyrus's own retry code and said nothing about what actually failed. This applies to warnings too, not just errors, and to failures inside cloud sandbox workers: a sandbox error now reaches the router with the worker's own stack intact instead of a one-line summary. ([NOR-282](https://linear.app/northrop-digital/issue/NOR-282/telemetry-phase-4-semantic-conventions-where-they-pay), [#31](https://github.com/nick-boey/cyrus/pull/31))
- Named lifecycle events in the log stream have been renamed to a consistent scheme: `session_completed` is now `session.completed`, `sandbox_gauge` is now `sandbox.gauge`, and so on, with each event's own details grouped under a `cyrus.` prefix. If you have written your own log queries or dashboards against these names you will need to update them; the Azure saved queries and alerts that ship with Cyrus were updated in the same change and need no action. Note that a dotted field name needs bracket syntax in KQL — write `p["cyrus.issue_key"]`, not `p.cyrus.issue_key`, which silently returns nothing rather than erroring. Ordinary log lines are unaffected. ([NOR-282](https://linear.app/northrop-digital/issue/NOR-282/telemetry-phase-4-semantic-conventions-where-they-pay), [#31](https://github.com/nick-boey/cyrus/pull/31))
- Cloud container startup output and a handful of remaining log lines now go through the same logging path as everything else, so they respect `CYRUS_LOG_LEVEL` and `CYRUS_LOG_FORMAT` and reach any configured log backend instead of only the terminal. Startup output is still also written to `~/cyrus-boot.log`. Interactive command output — setup prompts, the OAuth walkthrough, status tables — is unchanged and stays plain text. ([NOR-282](https://linear.app/northrop-digital/issue/NOR-282/telemetry-phase-4-semantic-conventions-where-they-pay), [#31](https://github.com/nick-boey/cyrus/pull/31))
- Azure runtime role assignments can now be bootstrapped separately from routine deployments. Run `./scripts/bootstrap-azure-role-assignments.sh` with an authorized operator, then set `manageRoleAssignments = false`; subsequent Bicep deployments need Contributor rather than permission to grant roles. Existing Bicep environments keep their current deterministic assignments under Incremental mode, so this is a reconciliation step rather than a migration. ([NOR-299](https://linear.app/northrop-digital/issue/NOR-299/establish-private-northrop-bicep-cd-and-retire-terraform), [#30](https://github.com/nick-boey/cyrus/pull/30))
- Deploying the Azure-hosted router no longer keeps a state file. The deployment is now described in Bicep and applied with `./scripts/deploy-azure.sh`, which previews every change before you accept it; Azure itself is the record of what is deployed. For operators this removes the whole state apparatus — no storage account to create before the first deploy, nothing to initialise, no lock to break, and no second copy of your Linear credentials sitting in a state file on disk. Routine deployments are secretless and cannot overwrite credentials rotated directly in Key Vault; a bootstrap or deliberate rotation now requires both an opt-in Bicep flag and `--allow-secret-writes`. Existing early-Bicep deployments should set both write flags false and clear the eight value fields before their next run; Incremental mode keeps the already-created Key Vault secrets. Two long-standing annoyances go with it: getting the router's public URL into its own configuration no longer takes a second deploy, and turning the per-user secret store's feature flag back off no longer fails with an error about a protected resource — the stored secrets and their encryption key simply stay where they are. Private deployment automation can pass an external environment parameter file and override the immutable router image without rewriting the public checkout. If you were deploying with Terraform, copy `infra/azure/bicep/main.bicepparam.example`, transfer your values into it, and follow the runbook in `infra/azure/README.md`; your existing resources are adopted as they are, with no import step. ([#29](https://github.com/nick-boey/cyrus/pull/29))
- Pull requests Cyrus opens now contain only the commits the agent actually wrote, with the messages it wrote. Cyrus used to protect in-progress work by committing it to the issue branch every five minutes as `wip: auto-saved by cyrus`, which meant every PR carried a run of those commits — and on any session longer than five minutes the timer beat the agent to its own commit, so the PR's entire history became auto-generated `wip:` commits with no real message and no meaningful authorship. Work is now saved to a hidden ref instead: it never touches your branches, never triggers CI, and is not fetched by an ordinary `git clone`. The ref is deleted from your remote when the issue is marked Done or Canceled, so these don't accumulate — hidden refs are still advertised on every clone and fetch and count against a repository's size limit, so one left behind per issue would be a cost every contributor pays. Durability is unchanged — an issue's work still survives losing the machine it was running on, with the same five-minute worst case. Two knock-on effects you will notice: the agent's workspace now stays dirty until it commits, so the guardrail that stops a session ending with uncommitted or unpushed work starts doing its job again; and if saving that work ever fails, Cyrus now says so on the issue instead of only in its logs, because the branch is no longer a fallback copy. No configuration needed, and existing `wip:` commits on open PRs are left exactly as they are. ([#26](https://github.com/nick-boey/cyrus/pull/26))

### Fixed
- You can now run Codex on a single issue without making it your default agent. If your default was Claude and you asked for Codex on one issue — with an `[agent=codex]` or `[model=…]` tag, or a label — that session started with no access to your connected ChatGPT subscription and died on `401 Unauthorized: Missing bearer or basic authentication in header`. The only way around it was to make Codex the default for everything. Your subscription is now available to every session you run, so an issue-level choice works, and choosing Codex per-issue no longer costs anything if you have not connected one. ([CYR-79](https://linear.app/northrop-digital/issue/CYR-79/make-codex-subscription-auth-independent-of-the-default-runner-and), [#55](https://github.com/nick-boey/cyrus/pull/55))
- A Codex session that fails before it starts no longer breaks the rest of that agent session. It recorded a conversation id the agent had never actually opened, so every later message on the same issue tried to resume a conversation that does not exist and failed with `no rollout found for thread id` — including the message you send after fixing the original problem, which left the session unusable for good. ([CYR-79](https://linear.app/northrop-digital/issue/CYR-79/make-codex-subscription-auth-independent-of-the-default-runner-and), [#55](https://github.com/nick-boey/cyrus/pull/55))
- A Codex session that has nothing to authenticate with now says so, on the issue, before it starts. Previously your only signal was OpenAI's own rejection of the first request, which named neither the cause nor a fix. The message now tells you to connect a ChatGPT subscription under **Codex account** on `/setup`, or to set `OPENAI_API_KEY` for metered billing. A session that fails to start for any other reason — a bad configuration, an unreadable credential file — is now reported on the issue too, instead of only in the logs. ([CYR-79](https://linear.app/northrop-digital/issue/CYR-79/make-codex-subscription-auth-independent-of-the-default-runner-and), [#55](https://github.com/nick-boey/cyrus/pull/55))
- Sessions no longer open with a warning that Linux sandbox requirements are not met. Every session logged it, and it was misleading twice over: it said a security setting was being skipped because packages were missing, when in fact nothing would have switched that setting on regardless, and it kept saying so on machines where the setting was never wanted. Cyrus now checks for those packages only when you have actually asked for the protection they support — see `CYRUS_SUBPROCESS_ENV_SCRUB` above — and otherwise notes once, at info level, that the setting is off. ([NOR-412](https://linear.app/northrop-digital/issue/NOR-412/subprocess-env-scrubbing-is-off-in-every-sandbox-socat-and-bubblewrap), [#46](https://github.com/nick-boey/cyrus/pull/46))
- When a new comment on an issue is rejected because another agent session is already running there, the message now depends on whose session it is. If it is your own, you are told to reply inside the running session's thread, which works. If it is someone else's, you are told that, and told that replying in their thread will not work either — previously everyone got the same advice, and for anybody who did not start the running session it sent them in a circle: reply in the thread, get told to start your own session, and be rejected by the same lock again. Neither message now suggests `cyrus router unlock`: whether a quiet session is stuck or simply waiting on scheduled work cannot be determined from the issue, and unlocking one that is about to resume makes things worse rather than better. ([CYR-1](https://linear.app/northrop-digital/issue/CYR-1/a-never-terminating-agent-session-makes-an-issue-permanently))
- Every comment Cyrus declines to deliver is now visible to an operator, not just some of them. Previously only refusals on a brand-new session were recorded; refusals on a reply to an existing session were not — including the one you hit by following the advice in the rejection message itself. A comment that never reached an agent could still disappear without trace. ([CYR-1](https://linear.app/northrop-digital/issue/CYR-1/a-never-terminating-agent-session-makes-an-issue-permanently))
- The saved query the stranded-sandbox alert directs operators to now works. It missed the most common case: a session that finished normally at least once before it got stuck. Since replying in an existing session's thread is the recommended way to work around a locked issue, the workaround itself produced the shape the query could not see — and an empty result was the operator's signal to unlock the issue, which is the one action that makes a waiting session worse. ([CYR-1](https://linear.app/northrop-digital/issue/CYR-1/a-never-terminating-agent-session-makes-an-issue-permanently))
- If you run the Azure router, the threshold for reporting a sandbox as making no progress is now configurable as `containers.sessionNoProgressMs` (default 4 hours). A scheduled task with a period longer than the threshold is reported even though nothing is wrong, and previously the only way to stop that alert was to disable it entirely — which also disabled the alert for genuinely stranded sandboxes. ([CYR-1](https://linear.app/northrop-digital/issue/CYR-1/a-never-terminating-agent-session-makes-an-issue-permanently))
- A malformed background-task entry can no longer stop a session from finishing. A task reported with neither a command nor a description caused an error inside the very step that releases the issue for the next session, which would have left the issue locked. ([CYR-1](https://linear.app/northrop-digital/issue/CYR-1/a-never-terminating-agent-session-makes-an-issue-permanently))
- Agent output no longer vanishes from an issue when a session pauses to ask you something or finishes its work. A session that stops to wait for your answer, and a session posting the summary it writes as it wraps up, were both treated as no longer owning the issue they were working on — so every comment they posted from that moment on was rejected and thrown away, with nothing on the issue to say anything had gone missing. The closing summary was the most common casualty, which is the part of a run most worth reading. On one day this silently discarded 161 posts across seventeen issues. A session that genuinely does not belong to the machine posting for it is still refused, and that refusal is now recorded in the router's own logs with the session, machine and operation involved, so a recurrence is visible rather than invisible. If you deploy the Azure router, this comes with a new saved query ("Refused session claims") and an alert that fires when activities are being dropped against a single session, so the failure this fixes cannot recur unnoticed. ([NOR-405](https://linear.app/northrop-digital/issue/NOR-405/a-parked-or-completed-session-keeps-emitting-and-every-linear-activity), [#47](https://github.com/nick-boey/cyrus/pull/47))
- One machine can no longer claim another machine's agent session. A machine enrolled on your router could report that it had paused, resumed, or finished a session belonging to someone else, and on resuming take that session over — letting it post comments as that agent and stop the real one's work, on an issue it was never given. The router now checks that a machine actually holds a session before acting on anything it says about it, and refuses and records the attempt otherwise. A machine reporting the end of its *own* session after a restart is recognised as the ordinary repeat it is, rather than being reported as an intrusion. ([NOR-405](https://linear.app/northrop-digital/issue/NOR-405/a-parked-or-completed-session-keeps-emitting-and-every-linear-activity), [#47](https://github.com/nick-boey/cyrus/pull/47))
- A cloud sandbox is no longer shut down because of what it looked like several minutes ago. The routine sweep that parks idle sandboxes read the clock and each sandbox's record once when it started, then worked through them one at a time — and because each one can involve a slow call to Azure, the sweep could still be running six minutes later, deciding from figures that old. In one case it shut down a sandbox four seconds after a new session had started on it, having never seen the session arrive; the session's completion message never reached the router, so the issue stayed locked and Linear went on showing a live agent for 37 minutes. Each sandbox is now judged on its state at the moment of the decision, and re-checked once more immediately before anything is shut down. As a second line of defence for when the sweep itself is running slowly — the only situation in which the first is not enough — a sandbox is also left alone for a couple of minutes after a session on it ends, so its worker can finish reporting in. Sandboxes that are genuinely idle are still parked on the same schedule. Every sandbox the sweep decides *not* to park now says so in the log stream with a reason, and the per-sweep summary counts them — previously the only evidence that any of this was working was an absence of shutdowns, which looks exactly like a sweep that has stopped running. If you deploy the Azure router, this comes with a new saved query ("Idle-stops the sweep abandoned, by reason") and an alert for a sandbox that has been spared on nearly every sweep for an hour, which is a sandbox billing indefinitely. The settle window is configurable as `terminalSettleMs` and is now stated explicitly in the Bicep template alongside `idleStopMs`; the router rejects a value that is not a positive whole number of milliseconds at startup, and warns if you set one shorter than a sweep interval or longer than `idleStopMs`. ([NOR-406](https://linear.app/northrop-digital/issue/NOR-406/the-lifecycle-sweep-decides-idle-stop-from-a-snapshot-minutes-stale), [#45](https://github.com/nick-boey/cyrus/pull/45))
- A cloud sandbox booted while a slow sweep was still in progress no longer has its uptime clock reset. The sweep asks each provider once per pass how its sandboxes are doing — the cost of asking per sandbox would be prohibitive — but then used that answer to decide whether a sandbox was still running, even minutes later. A sandbox that started up after the question was asked looked stopped, and the clock behind the "running for six hours" alert was cleared out from under it, under-reporting exactly the sandboxes that had been busy throughout. That reading is now ignored when it predates the sandbox's own start, and each sandbox's status line records how old the reading was. ([NOR-406](https://linear.app/northrop-digital/issue/NOR-406/the-lifecycle-sweep-decides-idle-stop-from-a-snapshot-minutes-stale), [#45](https://github.com/nick-boey/cyrus/pull/45))
- A workspace on your own machine is no longer left on disk when an issue is closed, if you had pointed Cyrus's worktrees somewhere other than its default directory. Cleanup looked for the workspace under that default rather than where it had actually created it, found nothing, and said so in a way that read like success. When Cyrus now finds nothing to clean up it names the directory it looked in and where that came from, so "already tidy" and "looked in the wrong place" stop being indistinguishable. ([NOR-411](https://linear.app/northrop-digital/issue/NOR-411/wip-snapshot-refs-leak-permanently-teardown-looks-for-the-worktree), [#48](https://github.com/nick-boey/cyrus/pull/48))
- An issue whose agent session stopped working is no longer silently unreachable. When a session never reaches a terminal state — most often because the agent left a background task running, which withholds the completion signal indefinitely — it keeps holding the issue, and a new top-level `@cyrus1` comment on that issue is rejected rather than delivered. That rejection now says so plainly on the issue: it tells you the comment did not reach the running session and that replying **inside the running session's thread** will, instead of the previous message claiming the session belonged to another user, which was usually the same person. Operators also get a warning in the logs naming the session that holds the issue, so a dropped comment is distinguishable from a webhook that never arrived. ([NOR-402](https://linear.app/northrop-digital/issue/NOR-402/a-never-terminating-agent-session-makes-an-issue-permanently), [#49](https://github.com/nick-boey/cyrus/pull/49))
- A cloud sandbox that is running and connected but has had nothing routed to it and has posted nothing for several hours is now reported as stranded, so the stranded-session alert can cover it. Previously that alert could only fire for a sandbox that was stopped and disconnected — so the failure that actually blocks work, where everything looks healthy while an issue is locked to a session that quietly stopped, was excluded by definition. One such sandbox held an issue for five hours and seventeen minutes and ran the whole time doing nothing. The report names both possibilities rather than guessing: a session waiting on a scheduled wakeup looks the same from outside the sandbox, and the alert tells an operator how to tell them apart before acting. ([NOR-402](https://linear.app/northrop-digital/issue/NOR-402/a-never-terminating-agent-session-makes-an-issue-permanently), [#49](https://github.com/nick-boey/cyrus/pull/49))
- A slash command at the start of a comment now actually invokes the skill. Writing `@cyrus1 /tdd add a failing test` on an issue used to reach the agent as ordinary prose, and it would reply that no such skill was available, quietly pick a different one, or go hunting through the filesystem for the skill's definition. This mattered most for skills that declare themselves user-invocable only, which are reachable *only* this way — over half of a typical installed skill set — so they could not be used from Linear at all. Cyrus now repeats the command on the first line of what it sends the agent, which is the only form the agent recognises; your comment is passed along unchanged underneath it, so nothing is lost and the words after the command still reach the skill. A slash further into a sentence is still treated as prose, and so is a command that does not name a skill you actually have — Cyrus checks before acting on it, because an unrecognised command is rejected outright rather than read as text, which would have discarded the rest of your comment. Each such invocation is recorded in the log stream as `skill.slash_invoked` with the skill's name, which is the only trace these leave — a slash-invoked skill bypasses the ordinary tool machinery and so produces no tool activity to watch. ([NOR-368](https://linear.app/northrop-digital/issue/NOR-368/make-skill-in-a-linear-comment-actually-invoke-the-skill), [#42](https://github.com/nick-boey/cyrus/pull/42))
- Connecting a ChatGPT subscription for Codex now works on an Azure-hosted router. The credential store was never switched on there, so the **Codex account** section never appeared on `/setup` — while the runner picker still offered Codex, leaving anyone who chose it with a session that refused to start and a message pointing at a page section that did not exist. Selecting Codex on a router that cannot store subscription credentials now says so and names `OPENAI_API_KEY` as the way to run it, instead of sending you looking for a control you do not have. ([NOR-364](https://linear.app/northrop-digital/issue/NOR-364/allow-users-to-select-default-runners), [#41](https://github.com/nick-boey/cyrus/pull/41))
- A connected Codex account can no longer quietly stop working after a router restart. The key that encrypts stored subscription credentials could be written to disk that does not survive a restart, and it was never included in the router's backups — so the credential came back unreadable while the page kept showing the account as connected, and the only clue was a session failing days later. Credentials are now encrypted with a durable key wherever one is available, and a router that has to fall back to a local key says so at startup. ([NOR-364](https://linear.app/northrop-digital/issue/NOR-364/allow-users-to-select-default-runners), [#41](https://github.com/nick-boey/cyrus/pull/41))
- Codex sessions in a cloud container can now run shell commands at all. Codex enforces its own sandbox by running every command under bubblewrap, and bubblewrap cannot start inside a worker container — so each command exited before it began, and the session spent its whole run discovering it could not read a file, then finished reporting success having changed nothing. The container is already the boundary, so the nested sandbox is now switched off inside one; a Codex session on your own machine keeps it, where it is the only boundary there is. ([NOR-364](https://linear.app/northrop-digital/issue/NOR-364/allow-users-to-select-default-runners), [#41](https://github.com/nick-boey/cyrus/pull/41))
- Retiring a model from the picker no longer stops your sessions from starting. When a model you had selected was dropped from the list, your whole choice was discarded — including which agent you had picked — so a Codex user was silently treated as a Claude user, asked for an Anthropic token they never needed, and every cloud session refused to start. Your agent is now kept and only the model moves. ([NOR-364](https://linear.app/northrop-digital/issue/NOR-364/allow-users-to-select-default-runners), [#41](https://github.com/nick-boey/cyrus/pull/41))
- The **Codex account** picker no longer offers models a ChatGPT subscription cannot run. Four were listed and only `GPT-5.5` works: choosing any of the others authenticated fine and then failed every request with *"model is not supported when using Codex with a ChatGPT account"* — a dead session from a control whose whole purpose is to make an unusable value impossible to pick. ([NOR-364](https://linear.app/northrop-digital/issue/NOR-364/allow-users-to-select-default-runners), [#41](https://github.com/nick-boey/cyrus/pull/41))
- Your Codex credential is no longer left in the environment of every command a session runs. It was handed to the container as an environment variable and stayed set after being written to disk, so any command that prints its environment would have printed a live token into the session transcript. It also broke the shell for the rest of the session, because Codex snapshots the environment into a script and the credential's line breaks made that script unparseable. ([NOR-364](https://linear.app/northrop-digital/issue/NOR-364/allow-users-to-select-default-runners), [#41](https://github.com/nick-boey/cyrus/pull/41))
- A follow-up agent session on a cloud issue is no longer killed seconds after it starts. Asking for a review right after an implementation session finished — the most common thing you do with Cyrus — reliably stopped the sandbox out from under the new session, which then sat there doing nothing while Linear went on showing a live, thinking agent. The cause was an idle timer that only ever reset when the *router* did something, so a sandbox that had been working hard for half an hour still counted as idle and was eligible to be shut down the instant one session ended and before the next was registered. The timer now resets while an agent is working, a session that starts while the shutdown is being decided cancels it, and if the impossible state does somehow occur it is reported instead of sitting silent — on Azure it raises an alert naming the issue. Sandboxes that genuinely finish are still shut down on the same schedule as before. If it ever happens again, posting into the thread still restarts the sandbox reliably. ([NOR-366](https://linear.app/northrop-digital/issue/NOR-366/sandbox-idle-stop-races-the-session-affinity-pin-and-silently-kills), [#40](https://github.com/nick-boey/cyrus/pull/40))
- Setting `"model"` or `"fallbackModel"` on a repository now does something. It was accepted, documented as sitting between issue labels and the global default, and silently ignored — every session got the global default regardless. A repository's model is used only when nothing on the issue names one, and only when it belongs to the agent the issue actually resolved to, so a Claude model set on a repository no longer breaks an issue routed to Codex. ([NOR-364](https://linear.app/northrop-digital/issue/NOR-364/allow-users-to-select-default-runners), [#41](https://github.com/nick-boey/cyrus/pull/41))
- `cyrus router users set-executor` no longer accepts `fly` or `codespaces`. Both were listed in the help and accepted without complaint, and neither has ever existed: choosing one appeared to work, then left every issue for that person queued against something that could never start. ([NOR-364](https://linear.app/northrop-digital/issue/NOR-364/allow-users-to-select-default-runners), [#41](https://github.com/nick-boey/cyrus/pull/41))
- The `/setup` page no longer tells you a saved change "applies to the next session that starts". For an issue that already has a cloud container that was wrong — the container keeps its values for the life of the issue, and there may be no next session to pick them up. The message now says so, and names `cyrus router containers destroy <issueKey>` as the way to apply a change to a live issue. ([NOR-364](https://linear.app/northrop-digital/issue/NOR-364/allow-users-to-select-default-runners), [#41](https://github.com/nick-boey/cyrus/pull/41))
- A cloud session can no longer go permanently deaf, silently discarding every prompt you send it. If the router's record of how many events it had sent a worker ever fell behind the worker's own record — which a restart restoring slightly stale state could cause — the worker judged everything that followed to be a message it had already handled and dropped it. There was no error, nothing in the logs, and nothing on the issue: the session simply sat there, apparently working, having never been told anything. The router now checks the two records against each other every time a worker connects, corrects itself when they disagree, and reports it as an error naming the worker and both values. Prompts that were already queued when the mismatch appeared are delivered rather than mistaken for duplicates, so a message caught mid-fault still arrives. Previously the only remedy was `cyrus router containers destroy <ISSUE-KEY>` and re-prompting, which lost the worktree. ([NOR-263](https://linear.app/northrop-digital/issue/NOR-263/router-event-sequence-regression-silently-drops-every-prompt-to-an), [#32](https://github.com/nick-boey/cyrus/pull/32))
- Work published for an issue is no longer discarded when its workspace is rebuilt. If a repository's base branch was set with the `[repo=name#branch]` syntax, recreating the workspace — after a container was replaced, or a worktree removed by hand — silently rebranched from that base and threw away everything already pushed to the issue branch. Published work now wins; the base branch selector still decides where the issue branch starts. ([#26](https://github.com/nick-boey/cyrus/pull/26))
- An agent that comes back to an issue with restored uncommitted work but no memory of doing it is now told so in its first message, instead of finding unexplained changes and potentially reverting them as stray edits.
- A cloud session that failed to start now says why. When an issue's container could not boot, Linear showed only "Cyrus failed to start" and there was no record anywhere of what went wrong — the container writes its startup output before it connects to the router, so nothing was collecting it. Startup output is now also written to `~/cyrus-boot.log` inside the container, so the failure and its cause survive for an operator to read. ([#27](https://github.com/nick-boey/cyrus/pull/27))
- An expired GitHub token is now reported as an expired GitHub token. Cloud containers check the credential before they use it and fail with a message naming the token and how to rotate it, instead of failing later with a `git clone` authentication error that reads like a repository access problem.

### Added
- A repository can now describe its own environment with a `devcontainer.json`, and Cyrus builds that repository its own workspace image from it. Adding a toolchain — a different Node, a language Cyrus has never seen, a version your build pins — becomes a commit to your repository instead of a change to Cyrus plus a full image redeploy. Cyrus's own agent is added on top of whatever base you declare, so you do not have to build your devcontainer around it. `image`, `build`, `features` and `containerEnv` are honoured, and `postCreateCommand` runs at the start of each session after the clone, alongside `cyrus-setup.sh` — in the cloud sandbox only, since a `devcontainer.json` is written for your editor rather than for Cyrus and is not treated as permission to run shell on your own machine. A Compose-based devcontainer is refused when you register the repository, with a message saying why: a sandbox is one container, with no Docker daemon inside it. The first issue on a repository waits a few minutes while the image builds, says so on the issue, and starts as soon as it is ready; every issue afterwards is cached. If a build fails, Cyrus falls back to the standard environment and tells you on the issue rather than stalling. Editing your devcontainer never disturbs work already in flight — it applies to sessions that start after it. Off unless you turn it on, and it needs the Azure sandbox host; see `docs/ROUTER.md`. ([NOR-309](https://linear.app/northrop-digital/issue/NOR-309/support-devcontainers), [#43](https://github.com/nick-boey/cyrus/pull/43))
- You can now bring your own agent skills into your sessions, and turn Cyrus's own off. Skills copied into `~/.claude/skills` — typically by the `install.sh` of the dotfiles repo you already point `DOTFILES_REPO` at — are now offered to the agent. Previously they were not: the files landed on disk, `install.sh` exited cleanly, and the agent saw none of them, with no error anywhere. Alongside this, `CYRUS_DEFAULT_SKILLS` controls which of the five skills Cyrus ships are kept — unset or `all` for all of them, `none` for none, or a comma-separated list. It applies only to Cyrus's own skills; your skills, your repository's, and the ones managed in the web UI are never filtered by it. Both are ordinary per-user variables, set the same way as any other, and they work on your own machine too. Two of the five are worth keeping unless you are replacing them: `summarize` is what posts a session's final message to Linear, and `verify-and-ship` is what opens the pull request — turn them off without a replacement and sessions silently stop doing those things. ([NOR-365](https://linear.app/northrop-digital/issue/NOR-365/install-the-mattpocock-plugin-for-claude-code-in-the-sandboxes), [#39](https://github.com/nick-boey/cyrus/pull/39))
- Cyrus can now trace a piece of work end to end, so you can see *where the time went* rather than only that it took a while. One trace follows a Linear webhook through the routing decision, the container boot, the handover to the worker, and the agent session itself — across the two separate machines that work happens on — and renders as a single timeline with a duration on every step. This is the thing that answers "why did this issue take four minutes to get started": a cold container boot and a stalled call to a cloud API look identical in a log, and are obvious in a trace. Outbound calls get their own entries too, so a request that sat on its two-minute timeout is visible as exactly that instead of as an unexplained gap. Set `CYRUS_OTEL_TRACES_ENABLED=true` alongside the existing OpenTelemetry log export; `CYRUS_OTEL_TRACES_SAMPLE_RATIO` lowers the volume if you ever need to. Off unless you turn it on. Cloud sandboxes need no new network access or credentials — their traces travel over the connection they already hold to the router. On Azure the Bicep stack wires it up and ships saved queries for a single issue's trace, boot-time percentiles, and stalled outbound calls. ([NOR-283](https://linear.app/northrop-digital/issue/NOR-283/telemetry-phase-5-distributed-tracing-across-router-and-sandbox), [#33](https://github.com/nick-boey/cyrus/pull/33))
- The router now logs every HTTP request it serves, with a status code and a duration. It previously logged none of them and timed nothing, so a slow or failing webhook delivery left no trace at all. Failures are logged as failures, rejected requests as warnings, and successful ones at debug level so normal traffic stays quiet. Query strings are omitted from the logs, since some of the router's URLs carry tokens. ([NOR-283](https://linear.app/northrop-digital/issue/NOR-283/telemetry-phase-5-distributed-tracing-across-router-and-sandbox), [#33](https://github.com/nick-boey/cyrus/pull/33))
- Router logs can now be exported over OpenTelemetry, so they land in a log backend as structured records with queryable fields instead of prose to be pattern-matched. Set `CYRUS_OTEL_LOGS_ENABLED=true` and point `APPLICATIONINSIGHTS_CONNECTION_STRING` at your endpoint; `CYRUS_OTEL_LOGS_LEVEL` controls how much is sent (default `INFO`), independently of what the router prints locally. Every record carries the service name, version, instance, deployment environment and cloud region, so you can tell one replica or one environment from another. Off unless you turn it on, and the existing console output is unchanged either way — this is an additional destination, not a replacement. On Azure the Bicep stack wires it up for you, into the same Log Analytics workspace the router's stdout already goes to. ([NOR-281](https://linear.app/northrop-digital/issue/NOR-281/telemetry-phase-3-vendor-neutral-opentelemetry-logging-foundation), [#28](https://github.com/nick-boey/cyrus/pull/28))
- Logs from cloud sandbox workers now reach the router's log stream instead of disappearing with the sandbox. Previously nothing collected a worker's output, so when a session went wrong in a cloud container the only record was whatever it managed to post to Linear. Warnings and errors are forwarded by default, tagged with the issue and device they came from; `CYRUS_LOG_FORWARD_LEVEL`, `CYRUS_LOG_FORWARD_RATE` and `CYRUS_LOG_FORWARD_BURST` adjust how much is sent, and anything the rate guard skips is reported as a count rather than silently dropped. Nothing is sent until the router confirms it can accept it, so a worker running against an older router simply keeps its logs to itself. ([#21](https://github.com/nick-boey/cyrus/pull/21))
- `cyrus router containers list` now shows `AGE`, `UPTIME`, and `PARKED` for each container. `AGE` is how long the issue has had a container, `UPTIME` is how long the current run has been going (it resets whenever a container is stopped and resumed), and `PARKED` is how long a session has been waiting on an answer. Previously these were recorded but never displayed, so answering "how long has that been running?" meant querying the database by hand. ([#18](https://github.com/nick-boey/cyrus/pull/18))
- Router hosts on Azure get saved log queries and alerts for their cloud sandboxes out of the box: how many are open right now and for which issues, how many sessions each is holding, and alerts for a sandbox that has been running more than six hours, a container that failed to boot, and a router that has stopped reclaiming idle containers. The long-running alert distinguishes a genuinely busy agent from a sandbox whose worker died but whose infrastructure is still billing. ([#18](https://github.com/nick-boey/cyrus/pull/18))
- Container sessions can now build and test Rust projects: `cargo`, `rustc`, `rustfmt`, and `clippy` are preinstalled, along with the C toolchain crates need to link. Cloud workers can also reach Cargo's crate index and rustup's toolchain downloads, so a repo that pins a Rust version in `rust-toolchain.toml` still works under deny-by-default network egress. ([#16](https://github.com/nick-boey/cyrus/pull/16))
- Logs can now be emitted as one JSON object per line by setting `CYRUS_LOG_FORMAT=json`, so a log aggregator can filter on level, component, and issue rather than pattern-matching prose. The default output is unchanged. ([#15](https://github.com/nick-boey/cyrus/pull/15))
- The router now logs when a device connects and disconnects, and why a handshake was rejected. For cloud workers this is the first sign the worker process actually started — the infrastructure can report a sandbox as "running" while nothing is listening inside it. ([#15](https://github.com/nick-boey/cyrus/pull/15))
- Router hosts can now turn on a `/setup` page so teammates manage their own container credentials (Claude token, GitHub token, and so on) from a browser, instead of asking an admin to run `cyrus router secrets set` for them. It is off by default and an operator has to choose how sign-in is verified before it will start.
- `cyrus router secrets migrate --from keyvault --to table [--dry-run]` moves a router's per-user secrets onto the new Table-backed storage option without ever printing a value, for operators who want its "someone else changed this while you were editing" protection.
- Startup now reports the health of each MCP server — connected, degraded and retrying, or skipped — so a Linear or `cyrus-tools` server that fails to come up is visible instead of only showing up as tools mysteriously missing mid-session.
- `cyrus router secrets list <email> --check-scopes` reports which GitHub scopes a stored token actually has. It only warns: a token missing `read:org` still works for everything except organization-level queries, and is never rejected. Token values are never printed.
- `cyrus router containers list` now shows a `TEARDOWN` column, so you can see when a closed issue's worker is still waiting on its cleanup callback rather than guessing why it hasn't gone away yet.
- Container sessions can now lint GitHub Actions workflows with `actionlint`, drive a browser with Playwright (Chromium is preinstalled, so it works even under deny-by-default network egress), run PowerShell scripts with `pwsh`, invoke the `opencode` agent CLI, and use the Fleece CLI. These are available in both container executors — the same worker image backs local Docker and Azure Container Apps. The `codex` CLI is also installed, but is not authenticated yet — credentials for it inside a container are still being worked out. ([#12](https://github.com/nick-boey/cyrus/pull/12))
- Azure Container Apps Sandboxes executor: selected router users can run each issue in an isolated cloud worker that suspends when idle, resumes from memory, and uses deny-by-default network egress.
- The router can now run as a single-replica Azure Container App with managed identity, Key Vault-backed per-user secrets, Blob-backed router state, optional Entra-gated enrollment, and Terraform deployment assets.
- Router mode: run `cyrus router start` on an always-on host and `cyrus connect` on each team member's machine — sessions run on the creator's own device with its native credentials (az, gh, SSH, Claude subscription). Includes offline queueing, per-issue locks, and creator-only prompting. See `docs/ROUTER.md`.
- Guided setup (`/cyrus-setup`) now starts by asking which deployment mode you want — **standalone** (single-host), **router host**, or **client device** — and walks you through only the steps that mode needs. Router-host and client-device setup are first-class guided flows instead of a manual appendix.
- Worktrees now resume from the issue's pushed branch when one exists, and uncommitted work is auto-pushed as WIP before a worktree is removed.
- The router now exposes a `GET /healthz` liveness endpoint for container health checks and uptime monitors.
- `cyrus connect` now asks the router which Linear workspace it serves and records the answer, so you no longer have to copy the workspace id off the router host by hand when adding repositories on a client device. Getting that id wrong used to fail silently — the device would connect, receive events, and quietly drop them. Connecting against an older router still works; the id is simply left for you to fill in.
- The router host can now run as a Docker container: configuration via environment variables, one persistent volume for all state, a compose file with an optional Cloudflare tunnel sidecar, and prebuilt images on GHCR. A guided `cyrus-setup-router-docker` skill walks through the whole setup. See "Running the router in Docker" in `docs/ROUTER.md`.
- Sessions can now run in ephemeral Docker containers managed by the router: assign a user to the `docker` executor and their issues each get an isolated, auto-stopping container, with work persisted across restarts. See `docker/worker/README.md` for the setup runbook.
- Router operators can store arbitrary per-user environment variables for containers with `cyrus router secrets set <email> <ENV_VAR> <value>`, so any tool that authenticates via env vars works without code changes.
- `cyrus router secrets list <email>` shows a user's stored secret keys (values masked) and which required credentials are still missing.
- New router status commands: `cyrus router devices list` shows every enrolled device and its owner, and `cyrus router sessions list` shows all running and locked sessions with both their Linear issue id and session GUID — so you can find which issue a stuck session holds. `cyrus router users list` now also shows each user's running and locked session counts.
- `cyrus router unlock` now accepts a Linear issue identifier (e.g. `cyrus router unlock PAR-169`) in addition to the raw issue GUID — no more hunting for the GUID to release a stuck lock. The identifier is resolved through Linear; passing the GUID still works with no Linear token needed.
- Containers run the full hosted Linear MCP in their Claude session when a `LINEAR_API_TOKEN` secret is set for the user.
- Operators can require extra credentials before a user's containers boot via `containers.requiredSecretKeys` in the router config (the Claude OAuth token is always required).
- Router deployments can now register multiple repositories and manage them from the setup UI at `/setup/repositories`, including a default repository and associations to Linear project and team names (`p=Platform,t=NOR`). ([#13](https://github.com/nick-boey/cyrus/pull/13))
- When an issue's project or team matches a registered repository, Cyrus now clones only that repository — no more tagging every issue with `[repo=…]`. ([#13](https://github.com/nick-boey/cyrus/pull/13))
- When two repositories match equally, or nothing matches and no default is set, Cyrus asks in Linear which one to use. Nothing runs while it waits. ([#13](https://github.com/nick-boey/cyrus/pull/13))

### Changed
- Router deployments with more than one repository previously always used the first one and cloned all of them into every workspace. They are now routed by project, team, or the configured default, and only the chosen repository is cloned. Single-repository deployments are unaffected. ([#13](https://github.com/nick-boey/cyrus/pull/13))
- Project and team routing now match names case-insensitively. ([#13](https://github.com/nick-boey/cyrus/pull/13))
- `containers.repositories` entries now have their `baseBranch` validated before the repository registry is seeded (letters, digits, dots, dashes, underscores, and slashes only — no leading dash, no `..`). `main`, `master`, and version-style branches like `release/1.2.x` are unaffected. If any entry's `baseBranch` fails validation, the whole seed is skipped and the router reports "No repositories are registered" for every issue until it's fixed — the router logs exactly which repository and branch failed and why. Operators upgrading with an unusual branch name (containing `+`, `~`, `%`, `@`, `#`, or similar) in `containers.repositories` should check their logs after upgrading. ([#13](https://github.com/nick-boey/cyrus/pull/13))

### Fixed
- Cloudflare tunnel startup now waits up to 120 seconds (previously 30) before giving up, so Cyrus starts reliably on hosts with slow DNS or slow first-time tunnel establishment. ([#1458](https://github.com/cyrusagents/cyrus/pull/1458))
- Stopping Cyrus no longer stalls when a sandbox egress-proxy tunnel is still open or hung: open proxy connections are force-closed on shutdown, and tunnel sockets are torn down when either side closes instead of only on error. ([#1458](https://github.com/cyrusagents/cyrus/pull/1458))
- Orchestrator sessions are resumed again as soon as a delegated sub-issue's session completes. Since v0.2.69 the parent-to-child link was never created for sub-issues started through Linear delegation, so orchestrators only advanced when their own scheduled wake-up fired, paying the full timer interval on every hand-off. Cyrus now links a new session to the most recent session on its parent issue, whether or not that parent session is still running, so parent-child issue relationships carry child completion results in general. ([#1454](https://github.com/cyrusagents/cyrus/pull/1454))
- A child session that ends a turn with a scheduled wake-up or a background task still pending no longer resumes its parent early. Previously the parent received a non-final result and was resumed a second time when the child actually finished; the callback now waits for the result that ends the child session. ([#1454](https://github.com/cyrusagents/cyrus/pull/1454))

### Changed
- Updated the bundled Codex CLI and SDK from `0.144.4` to [`0.153.3`](https://github.com/openai/codex/releases/tag/rust-v0.153.3), enabling Codex sessions to use GPT-6 Astra via the `gpt-6-astra` model selector. ([CYPACK-1494](https://linear.app/ceedar/issue/CYPACK-1494/update-codex-to-latest-specifically-so-that-we-support-gpt-6), [#1460](https://github.com/cyrusagents/cyrus/pull/1460))
- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.259` to [`0.3.260`](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03260), bringing Claude sessions to parity with Claude Code 2.1.260 plus improved remote-session latency and rate-limit reporting, stricter rewind failure handling, and clearer structured-output validation errors. `@anthropic-ai/sdk` remains current at [`^0.123.0`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md#01230-2026-09-01), and the refreshed 31-tool Claude allowance lists are unchanged. ([CYPACK-1493](https://linear.app/ceedar/issue/CYPACK-1493/update-anthropic-aiclaude-agent-sdk-and-anthropic-aisdk-to-the-latest), [#1459](https://github.com/cyrusagents/cyrus/pull/1459), [cyrus-hosted#1060](https://github.com/cyrusagents/cyrus-hosted/pull/1060))
- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.258` to [`0.3.259`](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03259), adding multi-message reply correlation, unattended permission-prompt denial, and parity with Claude Code 2.1.259. `@anthropic-ai/sdk` remains current at [`^0.123.0`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md#01230-2026-09-01), and the refreshed 31-tool Claude allowance lists are unchanged. ([CYPACK-1491](https://linear.app/ceedar/issue/CYPACK-1491/update-anthropic-aiclaude-agent-sdk-and-anthropic-aisdk-to-the-latest), [#1455](https://github.com/cyrusagents/cyrus/pull/1455), [cyrus-hosted#1057](https://github.com/cyrusagents/cyrus-hosted/pull/1057))
- The `orchestrator` and `graphite-orchestrator` prompts now instruct Cyrus to delegate each sub-issue to itself when creating it. The previous guidance said the inherited assignee was enough to start the child session, which stopped being true once the explicit session-creation tools were removed in v0.2.69. ([#1454](https://github.com/cyrusagents/cyrus/pull/1454))
- EdgeWorker state saves are now atomic, preventing a process interrupted during a save from leaving a truncated state file that strands in-flight sessions; empty and legacy-truncated state files also recover cleanly. Thanks @connor-tembo for the contribution. ([CYPACK-1486](https://linear.app/ceedar/issue/CYPACK-1486/can-you-add-a-changelog-entry-for-this), [#1444](https://github.com/cyrusagents/cyrus/pull/1444))

### Changed
- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.252` to [`0.3.258`](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03258), bringing Claude sessions to parity with Claude Code 2.1.258 plus MCP resource-link and reconnection fixes. Updated `@anthropic-ai/sdk` from `^0.122.0` to [`^0.123.0`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md#01230-2026-09-01); the refreshed 31-tool Claude allowance lists are unchanged. ([CYPACK-1489](https://linear.app/ceedar/issue/CYPACK-1489/update-anthropic-aiclaude-agent-sdk-and-anthropic-aisdk-to-the-latest), [#1451](https://github.com/cyrusagents/cyrus/pull/1451), [cyrus-hosted#1056](https://github.com/cyrusagents/cyrus-hosted/pull/1056))
- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.251` to [`0.3.252`](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03252), bringing Claude sessions to parity with Claude Code 2.1.252. `@anthropic-ai/sdk` remains current at [`^0.122.0`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md#01220-2026-08-27), and the refreshed Claude tool allowance lists are unchanged. ([CYPACK-1488](https://linear.app/ceedar/issue/CYPACK-1488/update-anthropic-aiclaude-agent-sdk-and-anthropic-aisdk-to-the-latest), [#1449](https://github.com/cyrusagents/cyrus/pull/1449))
- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.250` to [`0.3.251`](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03251), bringing Claude sessions to parity with Claude Code 2.1.251. `@anthropic-ai/sdk` remains current at [`^0.122.0`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md#01220-2026-08-27), and the refreshed Claude tool allowances remove the retired MCP resource-discovery tools. ([CYPACK-1482](https://linear.app/ceedar/issue/CYPACK-1482/update-anthropic-aiclaude-agent-sdk-and-anthropic-aisdk-to-the-latest), [#1446](https://github.com/cyrusagents/cyrus/pull/1446))
- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.247` to [`0.3.250`](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03250), adding per-server SDK-hosted MCP timeouts and parity with Claude Code 2.1.250. Updated `@anthropic-ai/sdk` from `^0.121.0` to [`^0.122.0`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md#01220-2026-08-27), and refreshed the Claude tool allowances to add agent/resource discovery tools and remove the retired onboarding-guide tool. ([CYPACK-1481](https://linear.app/ceedar/issue/CYPACK-1481/update-anthropic-aiclaude-agent-sdk-and-anthropic-aisdk-to-the-latest), [#1443](https://github.com/cyrusagents/cyrus/pull/1443))

### Security
- Patched eight newly reported Cyrus CLI dependency advisories so `pnpm audit` reports no known vulnerabilities, while replacing the redundant `fast-uri` override with upstream-compatible direct dependency updates. ([CYPACK-1492](https://linear.app/ceedar/issue/CYPACK-1492/address-open-security-patches-for-cyrus-cli), [#1456](https://github.com/cyrusagents/cyrus/pull/1456))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.71

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.71

#### cyrus-core
- cyrus-core@0.2.71

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.71

#### cyrus-config-updater
- cyrus-config-updater@0.2.71

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.71

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.71

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.71

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.71

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.71

#### cyrus-opencode-runner
- cyrus-opencode-runner@0.2.71

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.71

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.71

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.71

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.71

#### cyrus-ai
- cyrus-ai@0.2.71 ([CYPACK-1495](https://linear.app/ceedar/issue/CYPACK-1495/run-a-release), [#1461](https://github.com/cyrusagents/cyrus/pull/1461))

## [0.2.70] - 2026-08-27

### Fixed
- `strictMcpConfig: false` in `~/.cyrus/config.json` now actually takes effect at startup. Previously the CLI dropped the setting when assembling the worker configuration, so sessions were still launched in strict MCP mode and ambient MCP sources (claude.ai connectors, settings-file servers, plugins) never loaded despite the opt-out. ([CYPACK-1478](https://linear.app/ceedar/issue/CYPACK-1478/if-a-mcp-server-has-no-enabled-tools-will-it-not-be-allowed-as-an-mcp), [#1440](https://github.com/cyrusagents/cyrus/pull/1440))
- An audit prompted by the same bug found and fixed other silently dropped settings: `cursorDefaultModel` / `cursorDefaultFallbackModel` were ignored at startup, and edits to `userAccessControl`, `global_setup_script`, and Cursor model defaults in `~/.cyrus/config.json` were not picked up by live config reloads. ([CYPACK-1478](https://linear.app/ceedar/issue/CYPACK-1478/if-a-mcp-server-has-no-enabled-tools-will-it-not-be-allowed-as-an-mcp), [#1440](https://github.com/cyrusagents/cyrus/pull/1440))

### Changed
- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.245` to [`0.3.247`](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03247), adding per-turn message correlation, managed model pricing, per-task stop control, ambient task metadata, and live permission-mode reporting fixes. Updated `@anthropic-ai/sdk` from `^0.120.0` to [`^0.121.0`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md#01210-2026-08-26); the Claude tool allowance lists are unchanged. ([CYPACK-1476](https://linear.app/ceedar/issue/CYPACK-1476/update-anthropic-aiclaude-agent-sdk-and-anthropic-aisdk-to-the-latest), [#1438](https://github.com/cyrusagents/cyrus/pull/1438))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.70

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.70

#### cyrus-core
- cyrus-core@0.2.70

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.70

#### cyrus-config-updater
- cyrus-config-updater@0.2.70

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.70

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.70

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.70

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.70

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.70

#### cyrus-opencode-runner
- cyrus-opencode-runner@0.2.70

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.70

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.70

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.70

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.70

#### cyrus-ai
- cyrus-ai@0.2.70

## [0.2.69] - 2026-08-26

### Added
- Added an enabled-by-default `strictMcpConfig` setting for Claude sessions. Set it to `false` to make ambient MCP sources—including authenticated claude.ai connectors, project and user settings, and plugins—available alongside Cyrus-configured servers; config reloads and pre-warmed sessions honor changes. ([CYHOST-1245](https://linear.app/ceedar/issue/CYHOST-1245/can-u-add-a-bevahiours-settings-page-setting-for-strict-mcp-config), [#1434](https://github.com/cyrusagents/cyrus/pull/1434))
- OpenCode is now a supported Cyrus runner for self-hosted sessions, including `opencode` labels and `[agent=opencode]` selectors, provider/model defaults, runtime config overrides, MCP and tool permission translation, CLI-managed auth/state handling, readable Linear activity, session resume/follow-up handling, and stalled-runner recovery. Thanks @JappyMondo and @jappyjan for the original contribution. ([CYPACK-1466](https://linear.app/ceedar/issue/CYPACK-1466/create-clean-opencode-support-pr-from-pr-1263-tip), [#1426](https://github.com/cyrusagents/cyrus/pull/1426))

### Changed
- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.241` to [`0.3.245`](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03245), bringing Claude sessions to parity with Claude Code 2.1.245 and incorporating the 0.3.243 queued-turn, MCP reconnect, managed-hook, and PDF result fixes. `@anthropic-ai/sdk` remains current at [`^0.120.0`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md#01200-2026-08-19), and the Claude tool allowance lists are unchanged. ([CYPACK-1467](https://linear.app/ceedar/issue/CYPACK-1467/update-anthropic-aiclaude-agent-sdk-and-anthropic-aisdk-to-the-latest), [#1427](https://github.com/cyrusagents/cyrus/pull/1427))

### Fixed
- **OpenCode sessions no longer terminate during quiet work** — The inactivity watchdog is disabled by default so provider requests and context compaction can complete; deployments may still configure an explicit timeout. ([#1428](https://github.com/cyrusagents/cyrus/pull/1428))
- The self-hosted GitHub App setup flow (`cyrus-setup-github` skill, "enable @mentions") no longer fails with "Default events are not supported by permissions: organization". The generated App manifest subscribed to an event with no matching permission, so GitHub rejected the submission and no App was ever created. ([#1406](https://github.com/cyrusagents/cyrus/issues/1406), [#1407](https://github.com/cyrusagents/cyrus/pull/1407))

### Security
- Patched newly reported Cyrus CLI dependency advisories so `pnpm audit` reports no known vulnerabilities. ([CYPACK-1431](https://linear.app/ceedar/issue/CYPACK-1431/address-open-security-patches-for-cyrus-cli), [#1404](https://github.com/cyrusagents/cyrus/pull/1404))
- Removed an unused Gemini runner reference dependency so `pnpm audit` no longer reports the `extract-zip` advisory. ([CYPACK-1443](https://linear.app/ceedar/issue/CYPACK-1443/address-open-security-patches-for-cyrus-cli), [#1409](https://github.com/cyrusagents/cyrus/pull/1409))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.69

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.69

#### cyrus-core
- cyrus-core@0.2.69

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.69

#### cyrus-config-updater
- cyrus-config-updater@0.2.69

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.69

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.69

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.69

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.69

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.69

#### cyrus-opencode-runner
- cyrus-opencode-runner@0.2.69

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.69

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.69

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.69

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.69

#### cyrus-ai (CLI)
- cyrus-ai@0.2.69

## [0.2.68] - 2026-08-05

### Added
- `ClaudeRunnerConfig` accepts a `spawnClaudeCodeProcess` override, forwarded to the Claude Agent SDK option of the same name. Lets the Claude Code process run somewhere other than a local child process — a container, a Kubernetes pod, a remote host — without forking the runner. ([#1391](https://github.com/cyrusagents/cyrus/pull/1391))

### Fixed
- Linear webhooks sent from Linear's three newly added delivery IPs are no longer rejected. Instances validating webhook source IPs were intermittently dropping agent mentions (the agent appeared to randomly not respond) after Linear expanded its documented egress IP list on 2026-08-04. ([#1395](https://github.com/cyrusagents/cyrus/pull/1395))
- Cyrus now catches up on what was said in a Slack thread between mentions. Previously, @mentioning Cyrus again in a thread it had already replied to passed along only your new message, so anything the team discussed since the last mention was invisible to it — most noticeably with automatic thread listening turned off, where untagged messages are never delivered. Cyrus now back-reads the messages posted since it last had context and reads them before responding. ([#1388](https://github.com/cyrusagents/cyrus/pull/1388)) Thanks @rairulyle for the contribution!

### Security
- Patched newly reported Cyrus CLI dependency advisories so `pnpm audit` reports no known vulnerabilities. ([CYPACK-1423](https://linear.app/ceedar/issue/CYPACK-1423/address-open-security-patches-for-cyrus-cli), [#1392](https://github.com/cyrusagents/cyrus/pull/1392))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.68

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.68

#### cyrus-core
- cyrus-core@0.2.68

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.68

#### cyrus-config-updater
- cyrus-config-updater@0.2.68

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.68

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.68

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.68

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.68

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.68

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.68

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.68

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.68

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.68

#### cyrus-ai (CLI)
- cyrus-ai@0.2.68


### Fixed
- The "Set up your account" button on `/setup` now works. On Azure deployments it failed with a bare 403 and no explanation: the sign-in sidecar rejected the click before it ever reached Cyrus, because a plain form submission carries none of the headers the sidecar requires to tell a real click apart from a forged one. Nobody could create their own account through the browser at all. ([#17](https://github.com/nick-boey/cyrus/pull/17))
- Opening a `/setup` page other than the main one — `/setup/repositories`, say, from a bookmark or a shared link — before your account exists now takes you to `/setup`, where you can set it up yourself. It previously refused with "you are not a registered Cyrus user, ask an administrator to run `cyrus router users add`", which was a dead end and the wrong advice on any deployment that has self-service sign-up turned on. Signing in on any page works the same way now. Where an operator has deliberately turned self-service sign-up off, the message is unchanged, because there an administrator genuinely does have to act. ([#17](https://github.com/nick-boey/cyrus/pull/17))
- Cloud workers no longer keep running — and billing — after their issue is finished. A worker that had accumulated a large amount of state took longer to park than the router was willing to wait, so parking failed, was retried every minute, and each retry queued up behind the last. Cleanup for a closed issue never got a turn, and the sweep that parks *every other* idle worker stalled behind it too. Workers now park reliably regardless of how much state they hold, and one slow worker can no longer hold up the rest. ([#19](https://github.com/nick-boey/cyrus/pull/19))
- Router failures that previously appeared as warnings — a failed container boot, a lost delegation, a state-backup failure, a sweep that could not run — are now reported as errors and carry the underlying stack trace instead of a one-line flattened message. ([#15](https://github.com/nick-boey/cyrus/pull/15))
- The `/setup` page can now save a credential it has never held before. Any required variable missing from your stored record showed an editable row that silently threw away whatever you typed, answering "No changes to save" — so a newly required credential could never be entered through the browser at all.
- Saving from `/setup` no longer fails with a bare 403 before reaching the router. The sign-in sidecar's cross-site request protection rejected the save outright because the app's own address was not on its approved list, which no deployment configured.
- Containers waiting on a question are now suspended reliably. Previously a finished session could leave a stale claim on its container, which kept the container running (and billing) indefinitely even after the agent had parked.
- Errors on the `/setup` page are now visible instead of failing silently. An expired page, a rejected sign-in, or a clash with another tab left the page completely unchanged, with the explanation discarded before it could be shown — the save button simply appeared to do nothing. The router now also records why it refused a request, so these are diagnosable from the logs rather than only from a browser console.
- Saving on the `/setup` page now works. The page's Content Security Policy set `default-src 'none'` without a `connect-src`, so the browser blocked the request that saves your credentials — the page loaded and displayed correctly, but every save silently failed with a console error and nothing was ever written.
- `cyrus router secrets migrate` now actually runs. The command was documented and its logic shipped, but it was never registered with the CLI, so every invocation failed with `unknown command 'migrate'` — leaving no supported way to move per-user secrets onto the Table backend.
- `cyrus router` inspection commands no longer invent an empty database when pointed at the wrong home. Run without the right `--cyrus-home`, `containers list`, `devices list`, `sessions list` and `users list` used to create a fresh database wherever they were looking and confidently report that nothing existed — while the real router state sat untouched somewhere else. They now stop and tell you which path they expected. Only `cyrus router users add` still creates the database, on a new install.
- When the lifecycle sweep parks or destroys a container, the log line now records what it decided from — how long the container had been idle, the threshold it was measured against, whether any session was still attached, and its last-routed time. Previously a container that was stopped while still working left no evidence of why, and the state needed to explain it was gone by the time anyone looked.
- Delegating an issue to a cloud worker no longer hangs forever with no explanation. Workers built on Windows shipped a startup script with Windows line endings, which the container could not execute — so the worker never started, nothing ever connected back, and the Linear session sat waiting indefinitely. Nothing reported an error, because from the outside the sandbox looked perfectly healthy.
- Linear webhooks that are rejected are now logged. A webhook turned away for a missing or mismatched signature previously produced no output at all, so a signing-secret mismatch was indistinguishable from Linear simply not sending the event — the only clue was work silently never starting.
- A failure inside Cyrus's own webhook handling is no longer reported to Linear as a bad signature. It used to answer with "invalid signature", which both pointed at the wrong cause and asked Linear to redeliver an event that had in fact already been accepted.
- The router now says when it accepts a session and when it starts a cloud worker for it. Previously only ignored and rejected events were logged, so a successfully routed session produced complete silence — making a worker that started but never connected look identical to an event that never arrived.
- Cloud workers now reconnect on their own after being suspended and resumed. A resumed worker used to keep a dead connection and sit there doing nothing — the message you sent was safely queued, but no work happened until a second message eventually forced a slow cold restart of the whole worker.
- Restarting or upgrading the router no longer runs the same Linear event twice. During the brief window where the outgoing and incoming router overlap, both could pick up the same webhook, producing duplicated comments and doubled activity on the issue.
- A session that finished cleanly no longer reports a spurious error afterwards. When a worker was replaced, or a completed issue was reopened, the session reported an error before completing and dropped its final summary — the work itself was fine, but the report on it was wrong. Sessions that finish are now recorded as finished, and their final response is saved before the session is handed off.
- Closing an issue now cleans up its cloud worker promptly. If the worker had gone idle, the cleanup request could be lost entirely, and the worker and its snapshots survived until a 10-minute grace period expired — billed the whole time. Cleanup is now remembered across a worker restart and retried until it is acknowledged.
- Waking a parked container in order to clean it up now actually wakes it. If a boot for that container happened to already be in progress, the wake assumed the container was running and did nothing, so the close was never delivered and only the grace deadline reclaimed it.
- MCP servers that drop mid-session are now retried with bounded backoff instead of silently staying down, and servers that require an interactive browser login are skipped in cloud containers rather than waiting on a login nobody can complete.
- Ephemeral containers are now destroyed automatically when their Linear issue is completed, canceled, or deleted, after saving in-progress work and running worktree teardown. Deleted issues also remove their saved bundle; stale cleanup remains the fallback for missed Linear notifications.
- Ephemeral containers: resuming a session after its container was destroyed and recreated no longer drops the repository. The session's git worktree is now re-created from the issue's branch (including any in-progress work already pushed) before work resumes, instead of silently continuing in an empty folder with no code and no history. A session moved from a teammate's device onto a container now also keeps its Claude conversation history where possible, instead of always starting a fresh one.
- Ephemeral containers: revoking a teammate's physical device (for example after they get a new laptop, via `cyrus router devices revoke`) no longer destroys their running per-issue containers along with it. Only the physical device is detached now; in-progress container sessions, and the work inside them, are left alone.
- Ephemeral containers: the automatic backup of in-progress work (WIP commits pushed to the issue branch) now only happens inside containers, where it's required so work survives a restart. Router setups where everyone works from their own device are unaffected — nobody's laptop starts auto-committing to their issue branches, including open pull requests, as a side effect of this feature.
- Ephemeral containers: an idle container being stopped now gets enough time to finish saving its work first, instead of risking being force-killed mid-save.
- Ephemeral containers: a session on an issue with no readable identifier now fails with a clear message instead of silently starting a container whose work could never be saved.
- Ephemeral containers: a session resumed in a fresh container now reports to Linear again. After a container was destroyed and recreated, the restored session ran to completion but its activities and final summary silently stopped reaching Linear — the timeline froze right after "Getting started on that…" — and the issue could stay locked afterward. Restored sessions now stream their activities and final response as normal, and release their issue lock when they finish.
- Ephemeral containers: the worker image now ships the .NET SDK, so sessions working on .NET repositories can build, test, and restore tools out of the box instead of failing with `dotnet: command not found`.
- Ephemeral containers: set a `GH_TOKEN` secret (`cyrus router secrets set <email> GH_TOKEN <pat>`) and it authenticates both the `gh` CLI and `git` from one token — `git` rides on `gh`'s credential helper, so `gh pr create` and private-repo clone/push all work. Previously the `gh` CLI was signed out inside sessions. The older `GIT_TOKEN` secret still works for git-only authentication.
- Router mode: an issue no longer stays locked forever after the machine running it restarts. If a device lost track of a session — because it ran out of disk and its saved session file was truncated mid-write, or because a session finished scheduling follow-up work and the machine restarted before that work ran — the router kept the issue locked on that session and rejected every re-delegation with "an agent is already working on this issue," with no way out short of an admin running `cyrus router unlock`. Two things change: a device now writes its session file atomically, so a full disk can no longer corrupt it and silently wipe every session on the next restart; and when a device reconnects it tells the router which sessions it is still running, so the router releases any lock whose session the device no longer has. ([#3](https://github.com/nick-boey/cyrus/pull/3))
- Router mode: worktrees are now removed when an issue is closed. The router received the "issue completed / canceled / deleted" notification from Linear and dropped it, because it only ever forwarded agent-session events — so your device was never told the issue had closed and kept every worktree it had ever created, along with each one's `node_modules` and build output. One node had accumulated 55 GB across twenty finished issues. Closing an issue now reclaims its worktree (and runs `cyrus-teardown.sh`) on the device that owns it, as it already did in single-user mode. To reclaim worktrees already stranded by this bug, run `scripts/reclaim-stale-worktrees.sh` — it skips anything still in use or holding uncommitted or unpushed work, and prints what it would delete before you commit to it with `--apply`. ([#3](https://github.com/nick-boey/cyrus/pull/3))
- The systemd service recipe in guided setup and the self-hosting guide now works when Cyrus runs as a user whose home directory isn't `/home/<user>` — notably `root`, whose home is `/root`. The unit pointed at a path that didn't exist, so the service started without any of your credentials. The environment file is also optional now, so the service starts before you've written one, and the unit names the `start` command explicitly rather than relying on it staying the default. The command that writes the unit file was also malformed in a way that could append the rest of the setup script into the service file instead of ending it.
- Sessions killed by a machine restart, a crash, or the system running out of memory no longer sit at "Working…" forever. Cyrus now reports them as errored when it comes back up, so you can tell at a glance which sessions died and which finished. Send a new message to resume one.
- A session that fails no longer goes silent. Some failures ended the run without telling Linear anything, leaving the session looking like it was still working. The failure is now always reported.
- Stopping a session now says so in Linear instead of leaving it stuck on "Working…".
- Pressing Stop on a session that had already died no longer swallows your next message. The stop was remembered indefinitely and consumed the next thing you sent, which was silently discarded.
- Router mode: images and files attached to a comment are no longer skipped when you reply to a running session. Fetching the comment's attachments crashed on every follow-up, so anything you attached was silently ignored — the session carried on without it.
- Router mode: the router now refreshes its Linear access token instead of dying roughly a day after setup. Linear expires the token about 24 hours after it is minted, and the router held on to the expired one forever — so every delegated issue hung on "Waiting for Cyrus" and then reported "Agent didn't start. The request may not have reached the agent." Restarting the router did not help, because it re-read the same expired token from disk. The router now re-mints the token automatically and saves the new one, the same way single-user mode already did. Add `linearRefreshToken` to each workspace in `router-config.json` (alongside `linearToken`, copied from `config.json`) and make sure `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET` are set in `~/.cyrus/.env`; the router warns at startup if either is missing and refresh stays off.
- Router mode: a session that has finished can be messaged again. Once a session completed, every follow-up message you sent it was discarded without a word — the issue simply sat in "Waiting for Cyrus" indefinitely, and starting a brand-new session was the only way out. Follow-ups now reach your machine as they always should have. If a message genuinely can't be routed anywhere, the session now says so instead of going quiet.
- A session's final summary now reaches Linear. Cyrus told the router it had finished *before* posting that summary, and the router treats "finished" as the moment a device gives up ownership of the session — so the last message was refused and the timeline simply stopped mid-work, with the session left looking stale. This affected every normally-completing session in router mode.
- A session that schedules follow-up work (a wakeup, a cron, a backgrounded task) no longer goes silent for the rest of its run. Cyrus treated the end of a turn as the end of the session, gave up ownership, and then had every subsequent message refused — in one observed case losing sixteen minutes of work from the timeline. It now keeps ownership until the work is genuinely done.
- Router mode: delegated issues are now moved to "In Progress". The router does this itself when it accepts a delegation, before handing the work to your device — an issue that is already started, one whose creator has no enrolled device, and one already locked by another session are all left alone. A previous release claimed to have fixed this by rebuilding the issue's team and state on the device, but the ids those depend on never survived the trip from the router, so the promotion silently did nothing.
- Router mode: an issue's assignee, parent, team, and state are now readable on your device. These were rebuilt in a previous release, but from identifiers that never actually survived the trip from the router, so each one still silently resolved to nothing — a session saw every issue as having no team and no parent. The parent is what a sub-issue branches from, so sub-issue worktrees were silently cut from the repository's default branch instead of the parent's branch.
- Router mode: issues delivered to your device are now complete. Previously an issue arrived as plain data with its related records stripped, so a session could not read the issue's labels, attachments, assignee, parent, or team. The visible symptoms were that label-based prompts never applied, attachments never reached the session, blocked-by issues were ignored, and delegated issues were never moved to "In Progress". Sessions still ran, which made this easy to miss. Reading an issue's blocking issues additionally requires an up-to-date router.
- Router mode: stopping a session no longer leaves its issue locked. When you sent a stop signal, the session was terminated without ever telling the router, so the issue kept rejecting new sessions — indefinitely — until an admin ran `cyrus router unlock`. Stopping now releases the issue immediately.
- Router mode: the signal that releases an issue is now delivered reliably. It used to be sent once and silently dropped if the connection was down at that instant, stranding the issue. It is now stored on the device and re-sent until the router confirms it. **Router hosts and client devices must be updated together** — a device running the older version will be refused at connect with a protocol version mismatch.
- `cyrus auth`, `cyrus check-tokens`, and `cyrus refresh-token` no longer hang after finishing their work. Each command completed successfully but never exited, leaving you to press Ctrl-C — which made them unusable in scripts and CI.
- Forwarded and shared Slack messages are now included when you @mention Cyrus. Previously, forwarding a message (for example a Sentry alert) into a channel and @mentioning Cyrus passed along only your typed comment — the forwarded message's contents were dropped, so a forward with no comment gave Cyrus nothing to work with. The forwarded content is now part of the prompt. ([#1326](https://github.com/cyrusagents/cyrus/pull/1326))
- Router mode: Linear authentication no longer breaks after a router restart. Previously the
  rotated Linear token was stored only on disk that is wiped on each deploy, so
  Cyrus would stop being able to read or post to Linear — silently — within a
  day of restarting.
- A Linear credential Cyrus can no longer refresh is now reported once, clearly,
  and with instructions to fix it, instead of failing quietly and repeating the
  same stack trace on every request. Re-authorizing also takes effect
  immediately now — previously Cyrus kept refusing to use the new credential
  until it was restarted.

### Changed
- Per-user container secrets are now keyed by the real environment-variable name (e.g. `CLAUDE_CODE_OAUTH_TOKEN`, `GIT_TOKEN`). Existing stored secrets are migrated automatically.
- Commenting on an issue whose workspace was already cleaned up (for example, after the issue was completed, or by a repository's `cyrus-teardown.sh` script) now rebuilds the workspace from the issue's branch before resuming, instead of silently continuing in an empty folder with no code or history. This can take a little longer than a normal reply — the same repository setup that runs for a brand-new session (including any `cyrus-setup.sh` script) runs again first.
- Refreshed dependencies across the project, clearing every outstanding security advisory (`pnpm audit` now reports zero, down from 17). This covers the remaining `body-parser`, `find-my-way`, `js-yaml`, `postcss`, `shell-quote`, `@hono/node-server`, and `@opentelemetry/propagator-jaeger` reports.
- Resolved four dependency security advisories (two high severity) affecting `brace-expansion`, `fast-uri`, `hono`, and `protobufjs`. The version floors meant to keep these patched had drifted a release or two behind the fix, so the vulnerable versions were still being installed.
- Claude sessions now run on Claude Opus 5 by default. The default model is the `opus` alias, which the updated Claude Code resolves to Claude Opus 5 (the `sonnet` fallback likewise resolves to Claude Sonnet 5). Set `claudeDefaultModel` in your config, or use a `[model=...]` tag or a model label on an issue, to pin a different model.
- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.202` to `0.3.220`, bringing in the latest Claude Code capabilities and bug fixes ([SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)).
## [0.2.67] - 2026-07-25

### Changed
- Updated the bundled Codex CLI and SDK to `0.144.4`, the minimum Codex release required for GPT-5.6 models such as `gpt-5.6-sol`.
- Cyrus setup now creates Linear OAuth applications from a manifest-backed setup URL, so callback, webhook, and event type settings are pre-populated consistently instead of configured field by field. ([CYPACK-1403](https://linear.app/ceedar/issue/CYPACK-1403/convert-cyrus-setup-linear-app-creation-to-use-manifest), [#1385](https://github.com/cyrusagents/cyrus/pull/1385))
- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.204` to `0.3.205`, bringing in enhanced interrupt handling with typed receipts from `Query.interrupt()`, a `still_queued` field for pending async message UUIDs, interrupt capability detection in the init block, and structured `name`/`body` fields on peer-message session events ([SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)). ([CYPACK-1376](https://linear.app/ceedar/issue/CYPACK-1376), [#1368](https://github.com/cyrusagents/cyrus/pull/1368))
- Refreshed Claude Code tool list: removed deprecated `LSP` tool. ([CYPACK-1376](https://linear.app/ceedar/issue/CYPACK-1376), [#1368](https://github.com/cyrusagents/cyrus/pull/1368))
- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.202` to `0.3.204`, bringing in `background_tasks_changed` system messages for level-based background task tracking (instead of pairing start/end events), a fix for `sdk.d.ts` unresolved type references breaking consumer typechecking with `skipLibCheck` disabled, and parity with Claude Code v2.1.204 ([SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)). ([CYPACK-1375](https://linear.app/ceedar/issue/CYPACK-1375), [#1367](https://github.com/cyrusagents/cyrus/pull/1367))
- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.201` to `0.3.202`, bringing in `parent_agent_id` on subagent session messages for multi-level agent hierarchy tracking and a fix for crashes when `apply_flag_settings` receives a non-object value ([SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)). ([CYPACK-1373](https://linear.app/ceedar/issue/CYPACK-1373), [#1364](https://github.com/cyrusagents/cyrus/pull/1364))
- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.199` to `0.3.201`, bringing in `'manual'` as an alias for the `'default'` permission mode, a fix for `onSetPermissionMode` not firing on SDK-hosted Remote Control sessions, stricter validation for `set_model` control requests, and parity with Claude Code v2.1.201 ([SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)). ([CYPACK-1368](https://linear.app/ceedar/issue/CYPACK-1368), [#1363](https://github.com/cyrusagents/cyrus/pull/1363))
- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.198` to `0.3.199` and `@anthropic-ai/sdk` from `^0.109.1` to `^0.110.0`, bringing in the latest Claude Code capabilities including `requestId` support in `canUseTool` callbacks, `blocked` field on workflow agent progress events, and the `agent-memory-2026-07-22` beta header ([SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)). ([CYPACK-1365](https://linear.app/ceedar/issue/CYPACK-1365), [#1361](https://github.com/cyrusagents/cyrus/pull/1361))
- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.185` to `0.3.198` and `@anthropic-ai/sdk` from `^0.105.0` to `^0.109.1`, bringing in the latest Claude Code capabilities and bug fixes ([SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)). ([CYPACK-1364](https://linear.app/ceedar/issue/CYPACK-1364), [#1359](https://github.com/cyrusagents/cyrus/pull/1359))
- Refreshed Claude Code tool list: added `ReportFindings`; removed deprecated `AskUserQuestion`, `EnterPlanMode`, and `ExitPlanMode` tools. ([CYPACK-1364](https://linear.app/ceedar/issue/CYPACK-1364), [#1359](https://github.com/cyrusagents/cyrus/pull/1359))
- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.173` to `0.3.185` and `@anthropic-ai/sdk` from `^0.104.1` to `^0.105.0`, bringing in the latest Claude Code capabilities and bug fixes. ([CYPACK-1346](https://linear.app/ceedar/issue/CYPACK-1346), [#1342](https://github.com/cyrusagents/cyrus/pull/1342))
- Refreshed Claude Code tool list: added `DesignSync`, removed deprecated `TeamCreate` and `TeamDelete` tools. ([CYPACK-1346](https://linear.app/ceedar/issue/CYPACK-1346), [#1342](https://github.com/cyrusagents/cyrus/pull/1342))

### Fixed
- Forwarded and shared Slack messages are now included when you @mention Cyrus. Previously, forwarding a message (for example a Sentry alert) into a channel and @mentioning Cyrus passed along only your typed comment — the forwarded message's contents were dropped, so a forward with no comment gave Cyrus nothing to work with. The forwarded content is now part of the prompt. ([#1326](https://github.com/cyrusagents/cyrus/pull/1326))

### Security
- Patched newly reported Cyrus CLI dependency advisories so `pnpm audit` reports no known vulnerabilities. ([CYPACK-1404](https://linear.app/ceedar/issue/CYPACK-1404/run-a-release), [#1386](https://github.com/cyrusagents/cyrus/pull/1386))
- Patched newly reported Cyrus CLI dependency advisories so `pnpm audit` reports no known vulnerabilities. ([CYPACK-1400](https://linear.app/ceedar/issue/CYPACK-1400), [#1383](https://github.com/cyrusagents/cyrus/pull/1383))
- Patched newly reported Cyrus CLI dependency advisories so `pnpm audit` reports no known vulnerabilities. ([CYPACK-1396](https://linear.app/ceedar/issue/CYPACK-1396), [#1380](https://github.com/cyrusagents/cyrus/pull/1380))
- Patched newly reported Cyrus CLI dependency advisories so `pnpm audit` reports no known vulnerabilities, while replacing redundant broad overrides with direct dependency updates where available. ([CYPACK-1379](https://linear.app/ceedar/issue/CYPACK-1379), [#1370](https://github.com/cyrusagents/cyrus/pull/1370))
- Patched the tracked Cyrus CLI Bun lockfile so both `pnpm audit` and `bun audit` report no known vulnerabilities. ([CYPACK-1356](https://linear.app/ceedar/issue/CYPACK-1356), [#1353](https://github.com/cyrusagents/cyrus/pull/1353))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.67

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.67

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.67

#### cyrus-core
- cyrus-core@0.2.67

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.67

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.67

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.67

#### cyrus-config-updater
- cyrus-config-updater@0.2.67

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.67

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.67

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.67

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.67

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.67

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.67

#### cyrus-ai (CLI)
- cyrus-ai@0.2.67

## [0.2.66] - 2026-06-19

### Security
- Patched the Cyrus CLI dependency graph so `pnpm audit` reports no known vulnerabilities, including updated Sentry, Cursor SDK, Axios, Vite/esbuild, Hono, form-data, ws, protobufjs, and OpenTelemetry resolutions. ([CYPACK-1334](https://linear.app/ceedar/issue/CYPACK-1334), [#1330](https://github.com/cyrusagents/cyrus/pull/1330))
- Patched newly reported Cyrus CLI dependency advisories so `pnpm audit` continues to report no known vulnerabilities. ([CYPACK-1340](https://linear.app/ceedar/issue/CYPACK-1340), [#1335](https://github.com/cyrusagents/cyrus/pull/1335))

### Changed
- Tightened the self-reported failure-mode instructions so agents keep reporting true user-visible failures and repeated stuck loops, but avoid filing failure-mode tickets for normal review iteration, brainstorming, first-pass clarification, or probe/no-op messages. ([PRO-116](https://linear.app/ceedar/issue/PRO-116), [#1329](https://github.com/cyrusagents/cyrus/pull/1329))

### Fixed
- Repository setup and teardown hooks are now discovered from the issue worktree instead of the persistent checkout Cyrus uses to create worktrees. If a branch adds or updates `cyrus-setup.sh`, Cyrus now runs that exact version for the task, so dependency installs, environment bootstrap, generated config, and other repo-specific preparation no longer get skipped or run from an older checkout. Teardown cleanup likewise uses the `cyrus-teardown.sh` committed with the worktree being removed. ([CYPACK-1337](https://linear.app/ceedar/issue/CYPACK-1337), [#1332](https://github.com/cyrusagents/cyrus/pull/1332))
- Linear agent sessions now show when a repository `cyrus-setup.sh` starts, succeeds, or fails before Cyrus begins working. Failures include duration, exit status, and a short redacted stdout/stderr tail so users can diagnose setup issues without exposing local paths, environment values, or secrets. ([CYPACK-1338](https://linear.app/ceedar/issue/CYPACK-1338), [#1333](https://github.com/cyrusagents/cyrus/pull/1333))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.66

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.66

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.66

#### cyrus-core
- cyrus-core@0.2.66

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.66

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.66

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.66

#### cyrus-config-updater
- cyrus-config-updater@0.2.66

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.66

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.66

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.66

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.66

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.66

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.66

#### cyrus-ai (CLI)
- cyrus-ai@0.2.66

## [0.2.65] - 2026-06-11

### Fixed
- Sessions that schedule a wakeup or background task no longer falsely report "Finished" with raw tool JSON, and the scheduled work actually runs. Previously, ending a turn on a `ScheduleWakeup` (or background `Bash`) call shut the Claude subprocess down — silently dropping the timer so the session never resumed — and posted a "Finished" Linear activity whose body was the raw tool-input JSON. Now Cyrus keeps the session alive while a wakeup, session cron, or background task is in flight (so it fires), posts a readable "⏰ Wakeup scheduled" response instead of JSON, and adds a "⏳ Standing by" thought listing what the session is waiting on — returning the Linear agent panel to its working state. Sessions with nothing pending still shut down at turn end to free memory. ([CYPACK-1310](https://linear.app/ceedar/issue/CYPACK-1310), [CYPACK-1177](https://linear.app/ceedar/issue/CYPACK-1177), [CYHOST-905](https://linear.app/ceedar/issue/CYHOST-905), [#1313](https://github.com/cyrusagents/cyrus/pull/1313))
- The final "response" activity is never raw tool-input JSON. When a turn ends on a tool call with no trailing assistant text, Cyrus now uses the model's result text or skips the response entirely rather than dumping the last tool's input JSON into the Linear timeline. ([CYPACK-1177](https://linear.app/ceedar/issue/CYPACK-1177), [#1313](https://github.com/cyrusagents/cyrus/pull/1313))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.65

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.65

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.65

#### cyrus-core
- cyrus-core@0.2.65

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.65

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.65

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.65

#### cyrus-config-updater
- cyrus-config-updater@0.2.65

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.65

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.65

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.65

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.65

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.65

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.65

#### cyrus-ai (CLI)
- cyrus-ai@0.2.65

## [0.2.64] - 2026-06-11

### Fixed
- Slack/chat follow-up messages sent while the agent is mid-task are no longer dropped. Previously a quick second message got "I'm still working on the previous request… I'll pick up your new message once I'm done" and was then silently ignored; it's now queued and delivered as a new turn once the current one finishes (and, with the Codex app-server backend, woven into the active turn). Codex chat threads also now correctly continue the same session on follow-ups instead of starting fresh each time. ([CYPACK-1288](https://linear.app/ceedar/issue/CYPACK-1288), [#1293](https://github.com/cyrusagents/cyrus/pull/1293))
- Codex sessions now translate Cyrus MCP allow-list entries into Codex MCP tool filters and approvals, so `mcp__server__tool` permissions restrict Codex sessions to the configured tools without requiring interactive approval. ([CYPACK-1288](https://linear.app/ceedar/issue/CYPACK-1288), [#1293](https://github.com/cyrusagents/cyrus/pull/1293))
- Codex sessions now load Cyrus-hosted custom MCP configs with Codex-specific MCP options preserved, so configured MCP servers are available when using the Codex runner. ([CYPACK-1286](https://linear.app/ceedar/issue/CYPACK-1286), [#1293](https://github.com/cyrusagents/cyrus/pull/1293))
- Codex issue and chat sessions can now use Cyrus-managed custom skills synced from the hosted app. Scoped managed skills are symlinked into Codex's native repository skill discovery path for each session and cleaned up afterward. ([CYPACK-1287](https://linear.app/ceedar/issue/CYPACK-1287/make-our-managed-skills-available-to-the-codex-runner), [#1293](https://github.com/cyrusagents/cyrus/pull/1293))

### Added
- Codex sessions now honor the configured filesystem sandbox when the egress sandbox is enabled: each session runs under a per-thread Codex permission profile that confines writes to the worktree and restricts reads to the worktree plus allowed directories (home and the rest of the filesystem are denied), matching the Claude runner's posture. Without sandbox enabled, behavior is unchanged. ([CYPACK-1288](https://linear.app/ceedar/issue/CYPACK-1288), [#1293](https://github.com/cyrusagents/cyrus/pull/1293))
- Codex now runs on the `codex app-server` backend, so it can respond to comments added while it's mid-task without throwing away its in-progress work: a follow-up comment is woven into Codex's current turn (rather than aborting and restarting it), matching how the Claude runner handles mid-task comments. This applies to Linear issues and Slack/chat threads alike. ([CYPACK-1288](https://linear.app/ceedar/issue/CYPACK-1288), [#1293](https://github.com/cyrusagents/cyrus/pull/1293))

### Changed
- Updated `@anthropic-ai/claude-agent-sdk` to `0.3.173` (parity with Claude Code v2.1.173; includes `skipMcpDiscovery` plugin option and fix for slash-followed-by-whitespace prompts). ([CYPACK-1306](https://linear.app/ceedar/issue/CYPACK-1306), [#1312](https://github.com/cyrusagents/cyrus/pull/1312))
- Updated `@anthropic-ai/sdk` to `0.104.1` (latest), keeping Claude sessions on current Anthropic API capabilities. ([CYPACK-1303](https://linear.app/ceedar/issue/CYPACK-1303), [#1308](https://github.com/cyrusagents/cyrus/pull/1308))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.64

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.64

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.64

#### cyrus-core
- cyrus-core@0.2.64

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.64

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.64

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.64

#### cyrus-config-updater
- cyrus-config-updater@0.2.64

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.64

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.64

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.64

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.64

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.64

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.64

#### cyrus-ai (CLI)
- cyrus-ai@0.2.64

## [0.2.63] - 2026-06-09

### Added
- Cyrus now recognizes Anthropic's new Fable model class: apply the `fable` model label or selector to run Claude sessions on `claude-fable-5`, with automatic fallback to Opus and then Sonnet when needed. ([CYPACK-1298](https://linear.app/ceedar/issue/CYPACK-1298), [#1302](https://github.com/cyrusagents/cyrus/pull/1302))

### Security
- Patched Hono dependency advisories reported by Dependabot so `pnpm audit` is clean for the Cyrus CLI workspace. ([CYPACK-1290](https://linear.app/ceedar/issue/CYPACK-1290), [#1295](https://github.com/cyrusagents/cyrus/pull/1295))

### Changed
- Codex sessions now default to `gpt-5.5`, and Linear model labels such as `gpt-5.5` are recognized as Codex model overrides alongside the existing `*-codex` labels. ([CYPACK-1282](https://linear.app/ceedar/issue/CYPACK-1282), [#1288](https://github.com/cyrusagents/cyrus/pull/1288))

### Fixed
- Git commands (`add`, `commit`, `merge`, etc.) no longer fail with "Operation not permitted" in multi-repo workspaces when running under a sandboxed agent (e.g. the Codex runner). Each repository's git metadata directory is now granted write access, not just the workspace container. ([#1287](https://github.com/cyrusagents/cyrus/pull/1287))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.63

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.63

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.63

#### cyrus-core
- cyrus-core@0.2.63

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.63

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.63

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.63

#### cyrus-config-updater
- cyrus-config-updater@0.2.63

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.63

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.63

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.63

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.63

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.63

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.63

#### cyrus-ai (CLI)
- cyrus-ai@0.2.63


## [0.2.62] - 2026-06-02

### Added
- On Cyrus-managed cloud runtimes, the agent now knows that missing system packages should be added via the dashboard: when the `CYRUS_CLOUD_RUNTIME` environment variable is set to `true`, a system-prompt addendum tells the agent to direct users to https://app.atcyrus.com/settings/packages to install missing `apt`/`npm` packages rather than installing them ad-hoc (off by default for self-host). ([CYPACK-1266](https://linear.app/ceedar/issue/CYPACK-1266), [#1272](https://github.com/cyrusagents/cyrus/pull/1272))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.62

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.62

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.62

#### cyrus-core
- cyrus-core@0.2.62

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.62

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.62

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.62

#### cyrus-config-updater
- cyrus-config-updater@0.2.62

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.62

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.62

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.62

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.62

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.62

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.62

#### cyrus-ai (CLI)
- cyrus-ai@0.2.62

## [0.2.61] - 2026-06-01

### Security
- Bumped `qs` to >=6.15.2 to address a remotely triggerable DoS (`qs.stringify` crash on null/undefined entries in comma-format arrays when `encodeValuesOnly` is set), pulled in transitively via `express`. ([CYPACK-1269](https://linear.app/ceedar/issue/CYPACK-1269), [#1274](https://github.com/ceedaragents/cyrus/pull/1274))

### Changed
- Updated `@anthropic-ai/claude-agent-sdk` from 0.3.158 to 0.3.159. Tool list is unchanged (33 tools). See the [SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) for details. ([CYPACK-1271](https://linear.app/ceedar/issue/CYPACK-1271), [#1277](https://github.com/cyrusagents/cyrus/pull/1277))
- Updated `@anthropic-ai/claude-agent-sdk` from 0.3.156 to 0.3.158. Tool list is unchanged (33 tools). See the [SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) for details. ([CYPACK-1268](https://linear.app/ceedar/issue/CYPACK-1268), [#1275](https://github.com/cyrusagents/cyrus/pull/1275))
- Updated `@anthropic-ai/claude-agent-sdk` from 0.3.154 to 0.3.156 and `@anthropic-ai/sdk` from 0.100.0 to 0.100.1. See the [SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) for details. ([CYPACK-1265](https://linear.app/ceedar/issue/CYPACK-1265), [#1270](https://github.com/cyrusagents/cyrus/pull/1270))

### Added
- Slack thread-following can now be turned off. It's on by default; disable it per-team from the Behaviours settings page, or force it off on a self-hosted instance by setting the `CYRUS_SLACK_THREAD_FOLLOWING_DISABLED` environment variable (the env variable always wins). When off, Cyrus only responds to explicit @mentions. On managed teams, asking Cyrus in a thread to stop listening now gets a link to the Behaviours page, and Cyrus goes quiet in that thread until someone asks it a direct question. ([CYPACK-1267](https://linear.app/ceedar/issue/CYPACK-1267), [#1273](https://github.com/cyrusagents/cyrus/pull/1273))
- Slack messages now show when Cyrus has finished processing them: the 👀 reaction added on receipt is swapped for ✅ once the turn completes — including when Cyrus decided the message didn't need a reply, so you can tell "seen but skipped" apart from "still working". ([CYPACK-1267](https://linear.app/ceedar/issue/CYPACK-1267), [#1273](https://github.com/cyrusagents/cyrus/pull/1273))
- Cyrus now follows along in Slack threads it's been pulled into: once you @mention it in a thread, every later reply in that thread is fed to the same session automatically — no need to re-mention it each time. To avoid chiming in on every message, Cyrus only replies when a message is a question it can genuinely help with or is addressed to it by name; it stays quiet on side conversation, acknowledgements, and chatter not aimed at it. Replies that do @mention it still work as before, and Cyrus ignores its own messages, edits, and plain channel chatter outside threads it's part of. Thread follow-ups keep working even after Cyrus restarts — it no longer goes silent on plain replies until you re-@mention it. **Existing Slack apps must add the `message.channels`, `message.groups`, `message.mpim`, and `message.im` bot events in their Slack app's Event Subscriptions for this to take effect.** ([CYPACK-1267](https://linear.app/ceedar/issue/CYPACK-1267), [#1273](https://github.com/cyrusagents/cyrus/pull/1273))
- New "PR review trigger" control: when disabled, a pull request review that requests changes on a Cyrus-opened PR no longer auto-starts a Cyrus session or posts an acknowledgement comment. Enabled by default, so existing behaviour is unchanged unless you turn it off. ([CYPACK-1273](https://linear.app/ceedar/issue/CYPACK-1273), [#1278](https://github.com/cyrusagents/cyrus/pull/1278))
- A repository can now ship its own skills: any skill directories under `<repo>/.claude/skills/` are automatically discovered and made available to the agent whenever Cyrus works in that repo — for single-repo issues, multi-repo issues (skills from every participating repo are combined), and GitHub/GitLab mentions alike. ([CYPACK-1261](https://linear.app/ceedar/issue/CYPACK-1261), [#1268](https://github.com/cyrusagents/cyrus/pull/1268))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.61

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.61

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.61

#### cyrus-core
- cyrus-core@0.2.61

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.61

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.61

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.61

#### cyrus-config-updater
- cyrus-config-updater@0.2.61

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.61

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.61

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.61

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.61

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.61

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.61

#### cyrus-ai (CLI)
- cyrus-ai@0.2.61

## [0.2.60] - 2026-05-28

### Added
- Optional browser-use system prompt addendum that tells the agent it has access to the `agent-browser` CLI and a local Chromium for screenshots and browser automation. Enabled by setting the `CYRUS_BROWSER_USE_ENABLED` environment variable to `true` (off by default for self-host). ([CYHOST-991](https://linear.app/ceedar/issue/CYHOST-991), [#1257](https://github.com/cyrusagents/cyrus/pull/1257))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.60

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.60

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.60

#### cyrus-core
- cyrus-core@0.2.60

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.60

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.60

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.60

#### cyrus-config-updater
- cyrus-config-updater@0.2.60

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.60

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.60

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.60

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.60

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.60

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.60

#### cyrus-ai (CLI)
- cyrus-ai@0.2.60

## [0.2.59] - 2026-05-28

### Added
- When a GitHub webhook arrives from a repo Cyrus has no configuration for, and the event is an @-mention or a `pull_request_review` requesting changes, Cyrus now posts a one-time reply on the pull request explaining the failure and citing likely causes (org rename/transfer, typo in the configured GitHub URL, or App installed on an unconfigured repo). Previously the webhook was silently dropped with only a server-side warning log. ([#1265](https://github.com/cyrusagents/cyrus/pull/1265))
- GitHub App manifest in the `cyrus-setup-github` skill now subscribes to `repository` and `organization` webhook events so future renames, transfers, and org renames can be reconciled automatically. ([#1265](https://github.com/cyrusagents/cyrus/pull/1265))

### Changed
- OPUS 4.8 SUPPORT. Updated `@anthropic-ai/claude-agent-sdk` from `0.2.123` to `0.3.154` and `@anthropic-ai/sdk` from `^0.91.x` to `^0.100.0`. See [claude-agent-sdk CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) for details. ([CYPACK-1257](https://linear.app/ceedar/issue/CYPACK-1257), [#1264](https://github.com/cyrusagents/cyrus/pull/1264))
- Refreshed mandatory tool allowance list per SDK v0.3.154: removed deprecated `RemoteTrigger` tool, added new `Workflow` tool to `availableTools` in `config.ts` and all platform default lists in `allowed-tools-defaults.ts`. ([CYPACK-1257](https://linear.app/ceedar/issue/CYPACK-1257), [#1264](https://github.com/cyrusagents/cyrus/pull/1264))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.59

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.59

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.59

#### cyrus-core
- cyrus-core@0.2.59

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.59

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.59

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.59

#### cyrus-config-updater
- cyrus-config-updater@0.2.59

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.59

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.59

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.59

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.59

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.59

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.59

#### cyrus-ai (CLI)
- cyrus-ai@0.2.59

## [0.2.58] - 2026-05-26

### Added
- **Per-repo `cyrus-teardown.sh` auto-detection** — Place a `cyrus-teardown.sh` (or `.ps1` / `.cmd` / `.bat`) script in your repository root and Cyrus runs it inside the issue's worktree directory immediately before the worktree is removed when the Linear issue is **completed**, **canceled**, or **deleted**. Symmetric to the existing `cyrus-setup.sh` mechanism — no configuration needed, just commit the script. In multi-repo issues each repo's teardown runs independently with `cwd` set to that repo's worktree subdirectory; failures in one repo do not block other repos' teardowns or worktree removal. The script gets `LINEAR_ISSUE_IDENTIFIER` in env, a 2-minute timeout, and is non-blocking on failure. Closes upstream [cyrusagents/cyrus#1065](https://github.com/cyrusagents/cyrus/issues/1065); credit to @matthewbjones for the original direction in [#1111](https://github.com/cyrusagents/cyrus/pull/1111). ([CYPACK-1219](https://linear.app/ceedar/issue/CYPACK-1219), [#1233](https://github.com/cyrusagents/cyrus/pull/1233))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.58

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.58

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.58

#### cyrus-core
- cyrus-core@0.2.58

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.58

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.58

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.58

#### cyrus-config-updater
- cyrus-config-updater@0.2.58

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.58

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.58

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.58

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.58

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.58

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.58

#### cyrus-ai (CLI)
- cyrus-ai@0.2.58

## [0.2.57] - 2026-05-22

### Fixed
- **Pinned the Slack MCP server to v1.2.3.** v1.3.0 of `slack-mcp-server` requires additional Slack OAuth scopes; pinning avoids breaking existing Slack installations that haven't re-authorized. ([CYPACK-1239](https://linear.app/ceedar/issue/CYPACK-1239), [#1247](https://github.com/cyrusagents/cyrus/pull/1247))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.57

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.57

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.57

#### cyrus-core
- cyrus-core@0.2.57

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.57

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.57

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.57

#### cyrus-config-updater
- cyrus-config-updater@0.2.57

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.57

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.57

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.57

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.57

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.57

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.57

#### cyrus-ai (CLI)
- cyrus-ai@0.2.57

## [0.2.56] - 2026-05-22

### Fixed
- **`slackAllowedTools`, `githubAllowedTools`, `linearAllowedTools`, and the `*McpConfigs` arrays from `~/.cyrus/config.json` are now applied at cold start.** Previously these fields were only picked up after a post-start config-file change, so the very first session after restart silently fell back to the built-in defaults. ([CYPACK-1236](https://linear.app/ceedar/issue/CYPACK-1236), [#1245](https://github.com/cyrusagents/cyrus/pull/1245))

### Changed
- **The `ALLOWED_TOOLS` environment variable has been renamed to `LINEAR_ALLOWED_TOOLS`** to match the per-channel naming used elsewhere (`slackAllowedTools`, `githubAllowedTools`). If you were setting `ALLOWED_TOOLS` to override Linear's tool allowlist, rename it to `LINEAR_ALLOWED_TOOLS`. ([CYPACK-1236](https://linear.app/ceedar/issue/CYPACK-1236), [#1245](https://github.com/cyrusagents/cyrus/pull/1245))

### Removed
- **Claude-in-Chrome browser integration is no longer enabled for agent sessions.** Cyrus previously passed `--chrome` to every Claude runner session, which registered the `mcp__claude-in-chrome__*` MCP tools. In cloud-runtime sessions there is no path from the worker to the user's local Chrome extension, so those tools always failed with "Browser extension is not connected" — leading agents to loop on a misdiagnosis instead of falling back. The flag and the associated screenshot/GIF upload-guidance hooks have been removed. ([PRO-9](https://linear.app/ceedar/issue/PRO-9/failed-chrome-extension-not-connecting-oswaldo-okeefe), [#1244](https://github.com/cyrusagents/cyrus/pull/1244))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.56

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.56

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.56

#### cyrus-core
- cyrus-core@0.2.56

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.56

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.56

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.56

#### cyrus-config-updater
- cyrus-config-updater@0.2.56

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.56

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.56

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.56

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.56

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.56

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.56

#### cyrus-ai (CLI)
- cyrus-ai@0.2.56

## [0.2.55] - 2026-05-22

### Fixed
- **`~/`-prefixed paths in `slackMcpConfigs`, `linearMcpConfigs`, and `githubMcpConfigs` are now expanded.** When cyrus-hosted writes platform MCP config paths for a self-host runtime, it emits `~/.cyrus/mcp-configs/...` strings that were passed verbatim to `fs.readFileSync`, which does not expand tildes — Claude sessions would crash with `ENOENT: ~/.cyrus/mcp-configs/mcp-supabase.json`. EdgeWorker now runs the three platform MCP config arrays through `resolvePath` at construction and on config hot-reload, mirroring how repository-scoped paths have always been normalized. ([#1242](https://github.com/cyrusagents/cyrus/pull/1242))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.55

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.55

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.55

#### cyrus-core
- cyrus-core@0.2.55

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.55

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.55

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.55

#### cyrus-config-updater
- cyrus-config-updater@0.2.55

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.55

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.55

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.55

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.55

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.55

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.55

#### cyrus-ai (CLI)
- cyrus-ai@0.2.55

## [0.2.54] - 2026-05-22

### Fixed
- **`log_failure_mode` MCP tool now registers when only `CYRUS_API_KEY` is set.** EdgeWorker previously required both `CYRUS_API_KEY` and `CYRUS_APP_URL` env vars to wire up the self-reported-failure-mode tool, so workspaces that hadn't overridden `CYRUS_APP_URL` silently shipped the failure-mode prompt addendum without a corresponding tool. The URL now falls back to the canonical default (`https://app.atcyrus.com`) via the shared `getCyrusAppUrl()` helper, matching the remote session store. ([CYPACK-1232](https://linear.app/ceedar/issue/CYPACK-1232), [#1240](https://github.com/cyrusagents/cyrus/pull/1240))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.54

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.54

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.54

#### cyrus-core
- cyrus-core@0.2.54

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.54

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.54

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.54

#### cyrus-config-updater
- cyrus-config-updater@0.2.54

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.54

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.54

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.54

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.54

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.54

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.54

#### cyrus-ai (CLI)
- cyrus-ai@0.2.54

## [0.2.53] - 2026-05-22

### Added
- **Per-platform allowed tools — explicit defaults exported from `cyrus-core`** — `cyrus-core` now exports three canonical lists (`LINEAR_DEFAULT_ALLOWED_TOOLS`, `SLACK_DEFAULT_ALLOWED_TOOLS`, `GITHUB_DEFAULT_ALLOWED_TOOLS`) plus a `getDefaultAllowedTools(platform)` resolver. Each list is **completely explicit** — workspace MCP prefixes (`mcp__linear`, `mcp__cyrus-tools`, `mcp__cyrus-docs`, and for Slack `mcp__slack`) are members of the list, not implicitly appended at runtime. cyrus-hosted imports the same constants so the source of truth lives in one place. ([CYHOST-967](https://linear.app/ceedar/issue/CYHOST-967))
- **`EdgeConfig` accepts `slackAllowedTools` and `githubAllowedTools`** — two optional top-level keys for team-level platform overrides. When unset, the resolver falls back to the matching cyrus-core default. ([CYHOST-967](https://linear.app/ceedar/issue/CYHOST-967))
- **`EdgeConfig` accepts `slackMcpConfigs`, `linearMcpConfigs`, `githubMcpConfigs`** — three optional arrays of filesystem paths to custom-integration `.mcp.json` files, one per surface. Slack chat sessions load the files in `slackMcpConfigs` directly (chat is repo-agnostic, no `repository.mcpConfigPath` lookup). Linear- and GitHub/GitLab-triggered issue sessions use the per-platform list only when the routed repo does NOT have its own `allowedTools` override; if the repo has its own allow-list, the agent uses `repository.mcpConfigPath` instead so the repo's permission rules and its server set always come from the same scope. Native MCP servers (Linear, Cyrus tools, Cyrus docs, and Slack when `SLACK_BOT_TOKEN` is set) are still spun up inline by the runtime — these lists govern custom integrations only. ([CYHOST-967](https://linear.app/ceedar/issue/CYHOST-967))

### Changed
- **Claude sessions now run with `strictMcpConfig: true`.** Per Claude Code's `--strict-mcp-config` semantics, the SDK now only uses MCP servers explicitly passed via `mcpConfig` / `mcpServers` — it will not silently pick up servers from the user's `~/.claude.json`, project `.mcp.json`, or any other ambient configuration. Closes a gap where unrelated MCP servers on the host could bleed into a session and grant tools the agent shouldn't have. ([CYHOST-967](https://linear.app/ceedar/issue/CYHOST-967))
- **`ToolPermissionResolver` is now additive-only — no implicit MCP appending, no `SLACK_BOT_TOKEN`-conditional injection.** Previously `buildAllowedTools` and `buildChatAllowedTools` appended `mcp__linear`, `mcp__cyrus-tools`, `mcp__cyrus-docs` (and conditionally `mcp__slack` when `SLACK_BOT_TOKEN` was set in the process env) to every returned list. Now the explicit per-platform defaults include those prefixes verbatim, the resolver returns lists as-is, and `getWorkspaceMcpTools()` is removed. The `"readOnly"` preset now resolves to `SLACK_DEFAULT_ALLOWED_TOOLS` (the curated read-only set) instead of the bare `getReadOnlyTools()` list. ([CYHOST-967](https://linear.app/ceedar/issue/CYHOST-967))
- **GitHub- and GitLab-triggered sessions now go through `buildGithubAllowedTools`.** EdgeWorker previously called `buildAllowedTools(repository).filter(t => t !== "mcp__slack")` — a subtractive hack to strip the auto-appended Slack MCP prefix. With explicit defaults the filter is unnecessary, and routing through `buildGithubAllowedTools` means the team's `githubAllowedTools` override actually takes effect. ([CYHOST-967](https://linear.app/ceedar/issue/CYHOST-967))
- **Slack chat sessions no longer pull the "first repo's" `mcpConfigPath`.** Chat sessions are repo-agnostic at the session level, so the prior fallback that loaded whichever repo happened to be configured first into the chat session's MCP set is gone. Slack now loads exactly the files in `slackMcpConfigs` (which cyrus-hosted derives from the team's Slack allowed-tools array); native MCP servers continue to run inline. ([CYHOST-967](https://linear.app/ceedar/issue/CYHOST-967))
- **`EdgeConfig.defaultAllowedTools` renamed to `linearAllowedTools`.** Reflects what it actually controls (Linear-triggered sessions specifically, not a global default). The legacy field is still accepted on parse and migrated forward so older self-host configs keep working. ([CYHOST-967](https://linear.app/ceedar/issue/CYHOST-967))
- **Self-reported failure modes.** Every customer-facing agent session now has access to a new `mcp__cyrus-tools__log_failure_mode` MCP tool and is instructed (via a shared system-prompt addendum appended to all Linear prompt flavors, the Slack entrypoint, and the GitHub entrypoint) to call it when the user expresses dissatisfaction or when it recognizes it has made 3+ unsuccessful attempts at the same problem. The tool POSTs to cyrus-hosted, which opens (or comments on) a Linear ticket in the internal failure-modes project so the Cyrus team can intervene before churn. Self-reporting is internal — users are not told about it. ([CYPACK-1226](https://linear.app/ceedar/issue/CYPACK-1226))

### Fixed
- **`slackAllowedTools`, `githubAllowedTools`, and the per-platform MCP config keys (`slackMcpConfigs`, `linearMcpConfigs`, `githubMcpConfigs`) are now honored after config hot-reload.** `ConfigManager.loadConfigSafely()` previously merged a hardcoded whitelist of fields from the parsed `config.json` and silently dropped every per-platform allow-list / MCP config key, so Slack and GitHub sessions kept resolving to the cyrus-core defaults even when the workspace had a tighter override on disk. The merge and the change-detection list now include all six platform keys. ([CYHOST-967](https://linear.app/ceedar/issue/CYHOST-967))
- **Self-Managed GitLab MR replies** — `EdgeWorker` was instantiating `GitLabCommentService` with no `apiBaseUrl`, so every MR-reply request on a Self-Managed instance hit `gitlab.com` and 404'd. The base URL is now derived from the URL origin of the first configured repo with a `gitlabUrl`, so MR replies post against the correct host. Thanks [@tenforty](https://github.com/tenfourty) ([#1191](https://github.com/cyrusagents/cyrus/pull/1191))
- **Stop hook no longer blocks sessions for pre-existing untracked files** — Replaces the previous unconditional first-stop block (CYPACK-1204) with a more targeted git-aware guardrail. Cyrus now scopes the end-of-session check to tracked changes and unpushed commits, ignoring stray untracked files (local scratch files, env files, IDE artifacts) outside `.gitignore`. New files Cyrus creates via Write/Edit are still flagged via `git add --intent-to-add` if left uncommitted, so the "forgot to ship new work" check is preserved. ([CYPACK-1196](https://linear.app/ceedar/issue/CYPACK-1196), [#1204](https://github.com/cyrusagents/cyrus/pull/1204))

### Security
- **Patched 4 transitive dependency advisories** — Bumped `pnpm.overrides` for `brace-expansion` (≥5.0.6, DoS via large numeric ranges defeating `max` protection), `ws` (≥8.20.1, uninitialized memory disclosure on `close()` with `TypedArray` reason), `protobufjs` (≥7.5.8, DoS via unbounded recursive JSON descriptor expansion), and `uuid` (≥11.1.1, missing buffer bounds check in `v3`/`v5`/`v6`). `pnpm audit` now reports zero advisories. ([CYPACK-1230](https://linear.app/ceedar/issue/CYPACK-1230), [#1238](https://github.com/cyrusagents/cyrus/pull/1238))
- **Patched 9 transitive dependency advisories** — Bumped `pnpm.overrides` for `hono` (≥4.12.18, fixes CSS injection / JWT validation / Cache Middleware cross-user leakage), `fast-uri` (≥3.1.2, path traversal + host confusion), `ip-address` (≥10.1.1, `Address6` XSS), `@anthropic-ai/sdk` (≥0.91.1, insecure default file permissions in local filesystem memory tool), and `@opentelemetry/sdk-node` / `@opentelemetry/exporter-prometheus` (≥0.217.0, Prometheus exporter process crash via malformed HTTP request). `pnpm audit` now reports zero advisories. ([CYPACK-1206](https://linear.app/ceedar/issue/CYPACK-1206))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.53

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.53

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.53

#### cyrus-core
- cyrus-core@0.2.53

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.53

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.53

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.53

#### cyrus-config-updater
- cyrus-config-updater@0.2.53

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.53

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.53

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.53

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.53

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.53

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.53

#### cyrus-ai (CLI)
- cyrus-ai@0.2.53

## [0.2.52] - 2026-05-13

### Added
- **User skills can now be scoped to specific repositories, Linear teams, or Linear labels** — Skills synced from cyrus-hosted with `repositoryIds`, `linearTeamIds`, or `linearLabelIds` are only loaded into sessions whose context matches every populated dimension (AND across dimensions, OR within each list). Unscoped skills continue to load for every session, and old payloads without scope fields keep working as global. Scope is persisted as a `scope.json` sidecar alongside `SKILL.md` and enforced at runtime via the Claude Agent SDK's `skills` option so the model can't see or invoke out-of-scope skills. ([CYPACK-1156](https://linear.app/ceedar/issue/CYPACK-1156), [#1205](https://github.com/cyrusagents/cyrus/pull/1205))
- **Shared auto-memory across Slack chat sessions** — Slack-triggered chat sessions now share a persistent Claude auto-memory directory at `<cyrusHome>/slack-memory/`, so memory built up in one Slack thread carries over to every other Slack thread. ([CYPACK-1190](https://linear.app/ceedar/issue/CYPACK-1190), [#1199](https://github.com/cyrusagents/cyrus/pull/1199))

### Fixed
- **Session Stop hook now actually reminds the agent to ship before stopping** — Replaced the broken Stop-hook return shape (`additionalContext` + `continue: true`, which the Claude Agent SDK silently drops) with the SDK's documented `decision: "block"` + `reason` form. The first stop attempt now blocks and feeds the commit/push/PR reminder back into the next turn; a second stop (with `stop_hook_active === true`) proceeds, preventing infinite loops. ([CYPACK-1204](https://linear.app/ceedar/issue/CYPACK-1204), [#1210](https://github.com/cyrusagents/cyrus/pull/1210))
- **Slack chat sessions can now read and edit their shared auto-memory** — The shared auto-memory directory (`<cyrusHome>/slack-memory/`) is now included in `allowedDirectories` for chat sessions. Previously, sessions could create new memory files via shell redirects, but `Read`/`Edit`/`Glob` against existing memory files (including `MEMORY.md`) were denied by the home-directory restriction rules, leaving the auto-memory feature half-working. ([CYPACK-1197](https://linear.app/ceedar/issue/CYPACK-1197), [#1206](https://github.com/cyrusagents/cyrus/pull/1206))

### Changed
- **Slack mention prompt nudges agents toward `linear_agent_give_feedback` for live child sessions** — When responding in Slack, Cyrus is now told to send mid-flight corrections to a running child agent session via `mcp__cyrus-tools__linear_agent_give_feedback` instead of falling back to `mcp__linear__save_comment`. Produces a stronger signal when correcting work that is already in progress. ([CYPACK-1189](https://linear.app/ceedar/issue/CYPACK-1189), [#1198](https://github.com/cyrusagents/cyrus/pull/1198))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.52

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.52

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.52

#### cyrus-core
- cyrus-core@0.2.52

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.52

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.52

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.52

#### cyrus-config-updater
- cyrus-config-updater@0.2.52

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.52

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.52

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.52

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.52

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.52

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.52

#### cyrus-ai (CLI)
- cyrus-ai@0.2.52

## [0.2.51] - 2026-04-30

### Changed
- **Updated `@anthropic-ai/claude-agent-sdk` to v0.2.123 and `@anthropic-ai/sdk` to `^0.91.0`** — Bumps the bundled Claude Code binary to v2.1.123 and the Anthropic TypeScript SDK to `^0.91.0`. This resolves a session-breaking bug where, after a parallel `Bash` tool call was cancelled following a non-zero exit on a sibling call, every subsequent `Bash` invocation in the same session would fail with `/bin/bash: line 4: /proc/self/fd/3: Permission denied` (exit 126) until the session was restarted. Other tools (`Read`, `Edit`, `Glob`, `Grep`, MCP) were unaffected. Also removes `LSP` from the `availableTools` list in `config.ts` — `LSP` is no longer shipped in Claude Code SDK v0.2.123. See [SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) for details. ([CYPACK-1152](https://linear.app/ceedar/issue/CYPACK-1152), [#1172](https://github.com/cyrusagents/cyrus/pull/1172))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.51

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.51

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.51

#### cyrus-core
- cyrus-core@0.2.51

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.51

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.51

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.51

#### cyrus-config-updater
- cyrus-config-updater@0.2.51

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.51

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.51

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.51

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.51

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.51

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.51

#### cyrus-ai (CLI)
- cyrus-ai@0.2.51

## [0.2.50] - 2026-04-30

### Added
- **Cyrus-authored PRs and MRs are now reliably tagged** — After every `gh pr create`/`gh pr edit`, `glab mr create`/`glab mr update`/`glab mr edit`, or `gt submit` command, Cyrus automatically appends a hidden `<!-- generated-by-cyrus -->` marker to the live PR/MR description if it isn't already there. This ensures the GitHub/GitLab webhook handlers can recognize Cyrus-authored PRs (so "Changes requested" events get forwarded back) even when the agent forgets to include the marker in the body it submits. ([CYPACK-1141](https://linear.app/ceedar/issue/CYPACK-1141), [#1162](https://github.com/cyrusagents/cyrus/pull/1162))
- **PR guardrail when sessions try to stop with unshipped work** — When the agent attempts to end a session, Cyrus now inspects the worktree and blocks the first stop attempt if there are uncommitted changes or commits ahead of the upstream branch, prompting the agent to commit, push, and open a pull request. Sessions with no code changes (e.g. questions, research) stop normally. ([CYPACK-1140](https://linear.app/ceedar/issue/CYPACK-1140), [#1161](https://github.com/cyrusagents/cyrus/pull/1161))
- **Remote Claude session transcripts** — When `CYRUS_APP_URL`, `CYRUS_API_KEY`, and `CYRUS_TEAM_ID` are all set, Cyrus now mirrors every Claude session transcript to the hosted Cyrus control plane (in addition to the local JSONL on disk). This lets sessions be inspected or resumed from any host, even after the ephemeral worktree is torn down. The transport speaks the Claude Agent SDK's `SessionStore` contract and passes the full 13-check behavioral conformance suite from the upstream SDK. Set `CYRUS_DISABLE_REMOTE_SESSION_STORE=1` to opt out and keep transcripts local-only. ([CYPACK-1121](https://linear.app/ceedar/issue/CYPACK-1121))
- **Optional Sentry error tracking** — When both `CYRUS_SENTRY_DSN` and `CYRUS_TEAM_ID` are set (and `CYRUS_SENTRY_DISABLED` is not), all `logger.error(...)` calls across the codebase (Claude Code/runner errors, edge-worker failures, webhook transport errors, persistence errors, uncaught exceptions, unhandled rejections) are reported to Sentry as Issues, and `WARN`/`ERROR` logs plus major lifecycle events (session started/resumed/completed/stopped, Claude session ID assigned, message emitted, webhook received, Claude query options) are forwarded to [Sentry Logs](https://docs.sentry.io/product/explore/logs/) tagged with `team_id`, `component`, and active session/issue/Claude-session identifiers — debug/info logs stay local to keep volume bounded. `CYRUS_TEAM_ID` is the single gate for both Issues and Logs: installs without a tenant tag stay silent. Set `CYRUS_SENTRY_DISABLED=1` to opt out entirely (also disables the bundled default DSN once it ships). Override the environment tag with `CYRUS_SENTRY_ENVIRONMENT`, sample errors with `CYRUS_SENTRY_SAMPLE_RATE` (0.0–1.0). Every event is enriched with a structured `cyrus` context block alongside `linear_workspace`/`deployment_id` if those env vars are set. The Sentry SDK's own internal debug output is gated separately on `CYRUS_SENTRY_DEBUG` to avoid flooding the terminal. Outgoing events **and** logs are scrubbed for token-shaped strings and sensitive keys before transmission (including breadcrumbs from console output), and grouped by a stable fingerprint so log messages with embedded IDs/paths don't fragment into one issue per occurrence. No telemetry is sent unless both env vars are present. ([CYPACK-1142](https://linear.app/ceedar/issue/CYPACK-1142))
- **New `/linear-webhook` endpoint for Linear webhooks** — The Linear webhook URL in your OAuth application can now be set to `<CYRUS_BASE_URL>/linear-webhook`. The legacy `/webhook` path continues to work for backward compatibility but is deprecated and will log a warning on first use. ([CYPACK-1119](https://linear.app/ceedar/issue/CYPACK-1119), [#1142](https://github.com/ceedaragents/cyrus/pull/1142))
- **Base branch update notifications** - When your base branch receives new commits while Cyrus is working, the active session is automatically notified to rebase, helping avoid merge conflicts. ([CYPACK-978](https://linear.app/ceedar/issue/CYPACK-978), [#1004](https://github.com/ceedaragents/cyrus/pull/1004))
- **Blocked-by dependency deferral** - Issues with unresolved `blocked_by` relationships are now automatically deferred instead of starting immediately. Cyrus posts an acknowledgment and starts work automatically when all blocking issues are resolved. User re-prompts also re-check blocking status. ([CYPACK-978](https://linear.app/ceedar/issue/CYPACK-978), [#1004](https://github.com/ceedaragents/cyrus/pull/1004))

### Changed
- **Bump OpenAI Codex SDK (`@openai/codex-sdk`) to v0.125.x** — Updates the pinned Codex integration to match the current `@openai/codex` release line bundled by that SDK (`codex` CLI **0.125.0**, including richer `codex exec`/`turn.completed` usage fields such as reasoning output tokens observed in streamed JSON sessions). Hosts relying on Cyrus’s pinned CLI via this dependency should behave the same aside from additive telemetry from Codex itself. ([CYPACK-1151](https://linear.app/ceedar/issue/CYPACK-1151), [#1171](https://github.com/cyrusagents/cyrus/pull/1171))
- Cursor sessions now run via the `@cursor/sdk` TypeScript SDK instead of spawning the `cursor-agent` CLI; permission allow/deny is now enforced via `.cursor/hooks.json` rather than `.cursor/cli.json` ([CYPACK-1149](https://linear.app/ceedar/issue/CYPACK-1149)).
- **Warm Claude sessions are now opt-in** — On startup, Cyrus no longer pre-spawns Claude Code subprocesses for the 30 most recent sessions by default. To restore the previous near-zero cold-start latency on the first message after a restart, set `CYRUS_ENABLE_WARM_SESSIONS=1` in the environment. ([CYPACK-1116](https://linear.app/ceedar/issue/CYPACK-1116))
- **Claude SDK subprocesses now exit at turn end unless warm mode is enabled** — When `CYRUS_ENABLE_WARM_SESSIONS` is unset, the streaming prompt is completed when the SDK emits a `result` message, which lets the underlying Claude Code subprocess actually exit and free its memory at the end of a turn (restores the pre-warm-sessions behavior). When `CYRUS_ENABLE_WARM_SESSIONS=1`, the streaming prompt stays open and the subprocess is kept alive so follow-up messages reuse the warm session.

### Fixed
- **Patched 6 high-severity `tar` advisories pulled in by the new `@cursor/sdk` integration** — The `@cursor/sdk` → `sqlite3` → `tar@6.2.1` chain introduced in CYPACK-1149 was flagged by Dependabot for six path-traversal/hardlink/symlink advisories (CVE-2026-24842, CVE-2026-23745, CVE-2026-26960, CVE-2026-29786, CVE-2026-31802, and a related race condition). A root `pnpm.overrides` entry now pins `tar` to `>=7.5.11` for all transitive consumers; `sqlite3`'s install script and the rest of the dep graph still resolve cleanly. ([CYPACK-1159](https://linear.app/ceedar/issue/CYPACK-1159))
- **Cursor sessions no longer crash with "Could not locate the bindings file" for `sqlite3`** — The `@cursor/sdk` switch in CYPACK-1149 introduced a transitive dependency on `sqlite3@5.1.7`, whose native `node_sqlite3.node` binding is fetched/built by an `install` lifecycle script. pnpm 10 blocks dependency lifecycle scripts by default, so fresh installs ended up with sqlite3 present but no native binding, and the first Cursor session on a clean `pnpm install` crashed at runtime. `sqlite3` is now in `pnpm.onlyBuiltDependencies` so its install script runs and the prebuilt binary lands on disk. ([CYPACK-1158](https://linear.app/ceedar/issue/CYPACK-1158), [#1174](https://github.com/cyrusagents/cyrus/pull/1174))
- **Stop signals no longer trigger "Request was aborted" errors on non-warm sessions** — Previously, every stop signal called the SDK's `query.interrupt()` regardless of whether the session was warm, which surfaced an `Error: Request was aborted` from non-warm sessions. Stop signals now branch on session state: non-warm sessions are stopped immediately on the first signal, while warm sessions retain the existing two-step interrupt-then-stop UX (interrupt on first stop, full terminate on a second stop within 10s). ([CYPACK-1145](https://linear.app/ceedar/issue/CYPACK-1145), [#1165](https://github.com/ceedaragents/cyrus/pull/1165))
- **Chat-platform replies (Slack/GitHub) are now posted when warm sessions are enabled** — Previously, `ChatSessionHandler` waited for `runner.startStreaming()` to resolve before calling the adapter's `postReply`. With `CYRUS_ENABLE_WARM_SESSIONS=1` the streaming prompt stays open across turns, so `startStreaming` never resolved and no reply was ever posted. Reply posting is now driven by `result` messages on the runner's message stream, decoupled from session termination. A FIFO queue of pending events per session ensures each turn (initial prompt, resume, or injected follow-up) is paired with its corresponding reply.
- **Improved `ToolSearch` presentation in Linear activities** — `ToolSearch` calls now post as a regular action entry (with an expandable result) instead of a bare thought. The parameter reads like "Loading tool schemas: `TaskCreate`, `TaskUpdate`" or "Searching tools for: `+linear get_issue`", and the expanded result shows the tools that were loaded (e.g. "Loaded tools: `TaskCreate`, `TaskUpdate`"). ([CYPACK-1112](https://linear.app/ceedar/issue/CYPACK-1112), [#1134](https://github.com/ceedaragents/cyrus/pull/1134))

### Fixed
- **Fixed garbled activity labels for parallel deferred-tool calls** — When Claude issued multiple `ToolSearch` (or other local deferred-tool) calls in quick succession, Linear sometimes displayed the result under a generic "Tool" label with a raw list of tool names (e.g. `Tool / mcp__digitalocean-droplets__droplet-create / ...`) instead of the proper `ToolSearch` action with a formatted result. Internal message processing is now serialized per session so the tool-use handler always registers before its matching tool-result is formatted. ([CYPACK-1112](https://linear.app/ceedar/issue/CYPACK-1112), [#1134](https://github.com/ceedaragents/cyrus/pull/1134))
- **Eliminated spurious blank lines in the Linear activity log** — Empty/whitespace-only assistant turns no longer produce blank "thought" activities, which previously appeared as an extra empty line between the "Using model: ..." notification and the first real tool call. ([CYPACK-1112](https://linear.app/ceedar/issue/CYPACK-1112), [#1134](https://github.com/ceedaragents/cyrus/pull/1134))

### Security
- **Tightened sandbox and tool permission defaults** — Claude sessions now run with stricter out-of-the-box restrictions: the OS-level sandbox enforces `denyRead: ["~/"]` + `allowRead: ["."]` (home directory blocked, worktree allowed) and `allowWrite` scoped to the session worktree only. On the tool permission side, `Read`, `Edit`, and `Write` are now narrowed to `Read(**)`, `Edit(**)`, and `Write(**)` to prevent unintended matches. Home directory files (SSH keys, credentials, etc.) are explicitly enumerated and added to `disallowedTools` at session start, working around the fact that `Read(~/**)` does not match in Claude Code's permission layer. ([#1123](https://github.com/ceedaragents/cyrus/pull/1123))
- **Addressed open security advisories** — Refreshed `pnpm-lock.yaml` so vulnerable transitive dependencies resolve to their patched versions (`protobufjs`, `path-to-regexp`, `picomatch`, `flatted`, `brace-expansion`, `yaml`, `follow-redirects`, `vite`, `hono`, `@hono/node-server`) through their existing direct-dep paths, without introducing new `pnpm.overrides` entries. ([CYPACK-1101](https://linear.app/ceedar/issue/CYPACK-1101), [#1128](https://github.com/ceedaragents/cyrus/pull/1128))

### Changed
- **Updated `@anthropic-ai/claude-agent-sdk` to v0.2.117** — Bumps the bundled Claude Code binary from v2.1.116 to v2.1.117 (parity release with no tool-list changes). Also fixes `scripts/extract-claude-tools.sh` to work with the new native binary structure introduced in SDK v0.2.113 (now resolves the platform-specific optional dependency instead of the removed `cli.js`). See [SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) for details. ([CYPACK-1120](https://linear.app/ceedar/issue/CYPACK-1120), [#1143](https://github.com/ceedaragents/cyrus/pull/1143))
- **Update `@anthropic-ai/claude-agent-sdk` to v0.2.116** — Bumps the bundled Claude Code binary from v2.1.114 to v2.1.116 (parity releases with no tool-list changes). See [SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) for details. ([CYPACK-1111](https://linear.app/ceedar/issue/CYPACK-1111), [#1133](https://github.com/ceedaragents/cyrus/pull/1133))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.50

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.50

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.50

#### cyrus-core
- cyrus-core@0.2.50

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.50

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.50

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.50

#### cyrus-config-updater
- cyrus-config-updater@0.2.50

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.50

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.50

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.50

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.50

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.50

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.50

#### cyrus-ai (CLI)
- cyrus-ai@0.2.50

## [0.2.49] - 2026-04-22

Hotfix released from the `cypack-1123` branch and forward-ported to `main`.

### Fixed
- **Claude sessions inherit the parent process environment again** — `@anthropic-ai/claude-agent-sdk` v0.2.113 reverted to no longer overlaying `process.env` onto the env passed to spawned sessions, which left Cyrus-launched Claude processes without `HOME` (and other inherited vars). That broke GPG-signed commits, `gh` CLI authentication, and any other tool that relies on a real home directory or the user's shell environment. Cyrus now spreads `process.env` explicitly when invoking the SDK so these tools work as expected. ([#1150](https://github.com/cyrusagents/cyrus/pull/1150))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.49

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.49

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.49

#### cyrus-core
- cyrus-core@0.2.49

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.49

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.49

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.49

#### cyrus-config-updater
- cyrus-config-updater@0.2.49

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.49

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.49

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.49

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.49

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.49

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.49

#### cyrus-ai (CLI)
- cyrus-ai@0.2.49

## [0.2.48] - 2026-04-20

### Changed
- **Claude Code subprocess env scrubbing is disabled** — `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is no longer set on Claude sessions while undesirable side effects from the Linux bubblewrap sandbox are investigated. The Linux sandbox requirements precheck (added in 0.2.46) still runs and logs guidance so it can be re-enabled quickly once the side effects are resolved. ([CYPACK-1108](https://linear.app/ceedar/issue/CYPACK-1108), [#1131](https://github.com/ceedaragents/cyrus/pull/1131))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.48

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.48

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.48

#### cyrus-core
- cyrus-core@0.2.48

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.48

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.48

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.48

#### cyrus-config-updater
- cyrus-config-updater@0.2.48

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.48

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.48

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.48

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.48

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.48

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.48

#### cyrus-ai (CLI)
- cyrus-ai@0.2.48

## [0.2.47] - 2026-04-20

### Fixed
- **Runtime switches no longer require restarting Cyrus** — When `cyrus auth` rotates credentials (for example, after switching between cloud and self-host runtimes), incoming config updates from the Cyrus web app now succeed immediately instead of failing with `401 Unauthorized` until the next process restart. ([CYHOST-798](https://linear.app/ceedar/issue/CYHOST-798), [#1127](https://github.com/ceedaragents/cyrus/pull/1127))

### Changed
- **Updated `@anthropic-ai/claude-agent-sdk` to v0.2.114** — Bumps the Claude Agent SDK to the latest version. See the [claude-agent-sdk changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) for full details. ([CYPACK-1096](https://linear.app/ceedar/issue/CYPACK-1096), [#1124](https://github.com/ceedaragents/cyrus/pull/1124))
- **Updated `@anthropic-ai/claude-agent-sdk` to v0.2.112** — Bumps the Claude Agent SDK to the latest version. See the [claude-agent-sdk changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) for full details. ([CYPACK-1093](https://linear.app/ceedar/issue/CYPACK-1093), [#1121](https://github.com/ceedaragents/cyrus/pull/1121))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.47

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.47

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.47

#### cyrus-core
- cyrus-core@0.2.47

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.47

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.47

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.47

#### cyrus-config-updater
- cyrus-config-updater@0.2.47

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.47

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.47

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.47

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.47

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.47

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.47

#### cyrus-ai (CLI)
- cyrus-ai@0.2.47

## [0.2.46] - 2026-04-16

### Added
- **Linux sandbox requirements precheck** — On Linux hosts, Cyrus now verifies that `socat`, `bubblewrap`, and the kernel/AppArmor configuration needed to create an unprivileged user namespace are all in place before enabling Claude Code's subprocess credential scrubbing. When a requirement is missing, the session continues but sandbox mode (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`) is left unset and resolution guidance is printed to stdout. These requirements are documented by Anthropic [here](https://code.claude.com/docs/en/sandboxing#prerequisites). The source-code of Antrhopic's sandbox runtime can be found [here](https://github.com/anthropic-experimental/sandbox-runtime). ([CYPACK-1091](https://linear.app/ceedar/issue/CYPACK-1091), [#1115](https://github.com/ceedaragents/cyrus/pull/1115))

### Changed
- **Claude Opus 4.7 is now the default model** — The `opus` model alias now resolves to `claude-opus-4-7`. No configuration change needed — existing setups using `"opus"` (the default) automatically use Opus 4.7. ([CYPACK-1090](https://linear.app/ceedar/issue/CYPACK-1090), [#1113](https://github.com/ceedaragents/cyrus/pull/1113))
- **Updated `@anthropic-ai/claude-agent-sdk` to v0.2.111 and `@anthropic-ai/sdk` to v0.90.0** — Refreshed both Anthropic SDK dependencies to their latest versions. Also updated tool allowance lists to match the new SDK: adds `LSP`, `ToolSearch`, and `PushNotification`. See the [claude-agent-sdk changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) for full details. ([CYPACK-1090](https://linear.app/ceedar/issue/CYPACK-1090), [#1113](https://github.com/ceedaragents/cyrus/pull/1113))

### Fixed
- **Cloud runtime provisioning no longer fails on first repository** — Fixed a race condition where the edge worker tried to initialize a new repository before Linear workspace tokens were available, causing "No Linear workspace config found" errors during cloud runtime provisioning. ([CYPACK-1089](https://linear.app/ceedar/issue/CYPACK-1089), [#1112](https://github.com/ceedaragents/cyrus/pull/1112))
- **Working directory context now shows actual path** — The `<working_directory>` in agent session prompts previously showed "Will be created based on issue" instead of the actual worktree path. It now correctly displays the real workspace directory. ([CYPACK-1088](https://linear.app/ceedar/issue/CYPACK-1088), [#1110](https://github.com/ceedaragents/cyrus/pull/1110))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.46

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.46

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.46

#### cyrus-core
- cyrus-core@0.2.46

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.46

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.46

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.46

#### cyrus-config-updater
- cyrus-config-updater@0.2.46

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.46

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.46

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.46

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.46

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.46

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.46

#### cyrus-ai (CLI)
- cyrus-ai@0.2.46

## [0.2.45] - 2026-04-15

### Added
- **Customizable repos directory** — Set `CYRUS_REPOS_DIR` to control where Cyrus clones repositories, similar to the existing `CYRUS_WORKTREES_DIR` for worktrees. Defaults to `~/.cyrus/repos` when unset. ([CYPACK-1081](https://linear.app/ceedar/issue/CYPACK-1081), [#1104](https://github.com/ceedaragents/cyrus/pull/1104))
- **Network egress sandboxing** — Agent sessions can now route all network traffic through a local egress proxy for domain filtering, request logging, and per-domain header injection (credentials brokering). Enable with `sandbox.enabled: true` in `~/.cyrus/config.json`. When enabled, Bash commands are restricted to writing only within the session worktree directory — no writes to any other path on disk. Supports TLS termination for domains with transform rules, following the Vercel Sandbox Firewall interface. Sandbox network ports are passed to each Claude Agent SDK session automatically. ([CYPACK-1066](https://linear.app/ceedar/issue/CYPACK-1066), [#1095](https://github.com/ceedaragents/cyrus/pull/1095))
- **`"trusted"` network policy preset** — Set `networkPolicy.preset: "trusted"` to pre-populate the sandbox allow list with ~200 domains matching Claude Code on the web's default allowlist (package registries, version control, container registries, cloud platforms, dev tools, monitoring). Custom `allow` rules merge on top. ([CYPACK-1066](https://linear.app/ceedar/issue/CYPACK-1066))

### Changed
- **Refreshed Claude Code tool allowance lists** — Updated all tool permission presets (`availableTools`, `readOnlyTools`, `writeTools`, `getSafeTools`, `getCoordinatorTools`) to match the latest Claude Code SDK tool set (30 tools). Adds new tools like `Glob`, `Grep`, `Write`, `SendMessage`, `EnterPlanMode`, `EnterWorktree`, cron/scheduling tools, MCP resource tools, and team management tools. Removes deprecated `TodoRead`, `NotebookRead`, and `Batch`. Tool names no longer use glob patterns (`Read` instead of `Read(**)`). ([CYPACK-1067](https://linear.app/ceedar/issue/CYPACK-1067), [#1096](https://github.com/ceedaragents/cyrus/pull/1096))
- **Agent subprocess credential scrubbing** — Agent sessions set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` so the SDK automatically strips authentication credentials (API keys, OAuth tokens) from Bash subprocess environments. Auth tokens are forwarded to the SDK process for API calls but cannot be accessed by tool-spawned commands. The parent process environment (`process.env`) is no longer inherited by agent sessions — only `PATH` and auth credentials are forwarded, alongside the repository's own `.env` variables and per-session env vars (CA certs, Cyrus flags). ([CYPACK-1066](https://linear.app/ceedar/issue/CYPACK-1066))
- **Webhook IP provenance validation** — Incoming webhooks from Linear, GitHub, and GitLab are now validated against each provider's known source IP ranges. Enabled automatically in self-hosted mode (`CYRUS_HOST_EXTERNAL=true`); can be toggled with the `WEBHOOK_IP_VALIDATION` environment variable. GitHub CIDRs are refreshed from the `/meta` API on startup. ([CYPACK-1056](https://linear.app/ceedar/issue/CYPACK-1056), [#1094](https://github.com/ceedaragents/cyrus/pull/1094))

### Fixed
- **Changelog updates no longer create duplicate entries** — The PR/MR and changelog-update skills now diff entries against the base branch instead of only the last commit, correctly detecting entries already added by the current branch and updating them in-place. ([CYPACK-1063](https://linear.app/ceedar/issue/CYPACK-1063), [#1091](https://github.com/ceedaragents/cyrus/pull/1091))
- **Agent sessions no longer fail with "executable not found" in pnpm monorepos** — The Claude Agent SDK's internal path resolution fails in pnpm's symlinked `node_modules`. Cyrus now explicitly resolves the SDK executable path using Node's module resolution, and passes `PATH` to the child process so the `node` binary can be found. ([CYPACK-1066](https://linear.app/ceedar/issue/CYPACK-1066))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.45

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.45

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.45

#### cyrus-core
- cyrus-core@0.2.45

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.45

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.45

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.45

#### cyrus-config-updater
- cyrus-config-updater@0.2.45

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.45

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.45

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.45

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.45

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.45

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.45

#### cyrus-ai (CLI)
- cyrus-ai@0.2.45

## [0.2.44] - 2026-04-10

### Fixed
- **Repository `.env` variables are now scoped per-session** — Previously, `.env` files were loaded into the EdgeWorker's `process.env`, causing environment poisoning across sessions and repositories. Variables are now parsed into an isolated object and merged only into the child subprocess env, so updated or removed values take effect immediately and one repo's `.env` cannot leak into another. ([CYPACK-1059](https://linear.app/ceedar/issue/CYPACK-1059), [#1086](https://github.com/ceedaragents/cyrus/pull/1086))
- **PR/MR interaction tips now correctly reference `@cyrusagent`** — Previously, when `GITHUB_BOT_USERNAME` or `GITLAB_BOT_USERNAME` environment variables were not set, PR/MR descriptions could show an incorrect bot username. The system now defaults to `cyrusagent`. ([CYPACK-1054](https://linear.app/ceedar/issue/CYPACK-1054), [#1082](https://github.com/ceedaragents/cyrus/pull/1082))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.44

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.44

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.44

#### cyrus-core
- cyrus-core@0.2.44

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.44

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.44

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.44

#### cyrus-config-updater
- cyrus-config-updater@0.2.44

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.44

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.44

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.44

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.44

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.44

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.44

#### cyrus-ai (CLI)
- cyrus-ai@0.2.44

## [0.2.43] - 2026-04-08

### Fixed
- **Slack chat sessions now see repositories added or removed at runtime** — Previously, Slack sessions used a stale snapshot of configured repositories from boot time, causing Cyrus to report missing access to repos that were actually configured. New sessions now always reflect the current repository configuration. ([CYPACK-1051](https://linear.app/ceedar/issue/CYPACK-1051), [#1078](https://github.com/ceedaragents/cyrus/pull/1078))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.43

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.43

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.43

#### cyrus-core
- cyrus-core@0.2.43

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.43

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.43

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.43

#### cyrus-config-updater
- cyrus-config-updater@0.2.43

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.43

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.43

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.43

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.43

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.43

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.43

#### cyrus-ai (CLI)
- cyrus-ai@0.2.43

## [0.2.42] - 2026-04-06

### Fixed
- **Bundled skills now resolve correctly for npm installs** - Skills shipped with the CLI were not found when installed via npm because symlinks were stripped during publishing. Skills are now resolved from the correct compiled path. ([CYPACK-1046](https://linear.app/ceedar/issue/CYPACK-1046), [#1073](https://github.com/ceedaragents/cyrus/pull/1073))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.42

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.42

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.42

#### cyrus-core
- cyrus-core@0.2.42

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.42

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.42

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.42

#### cyrus-config-updater
- cyrus-config-updater@0.2.42

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.42

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.42

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.42

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.42

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.42

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.42

#### cyrus-ai (CLI)
- cyrus-ai@0.2.42

## [0.2.41] - 2026-04-06

### Changed
- **Skills replace rigid procedure workflows** - Agent sessions now use flexible, customizable skills instead of fixed procedure sequences. Skills are discoverable at runtime, giving the agent more natural control over its workflow. A Stop hook ensures PRs and summaries are always created before sessions end. Users can add custom skills to `~/.cyrus/skills/`. ([CYPACK-996](https://linear.app/ceedar/issue/CYPACK-996), [#1018](https://github.com/ceedaragents/cyrus/pull/1018))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.41

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.41

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.41

#### cyrus-core
- cyrus-core@0.2.41

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.41

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.41

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.41

#### cyrus-config-updater
- cyrus-config-updater@0.2.41

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.41

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.41

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.41

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.41

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.41

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.41

#### cyrus-ai (CLI)
- cyrus-ai@0.2.41

## [0.2.40] - 2026-04-02

### Fixed
- **Slack chat sessions now use fresh Linear tokens** - The Linear MCP connection in Slack chat sessions was using a token captured once at startup, so after a daily OAuth refresh new sessions would fail to reach Linear. Chat sessions now build fresh MCP config per session, matching how issue sessions already work. ([CYPACK-1029](https://linear.app/ceedar/issue/CYPACK-1029), [#1063](https://github.com/ceedaragents/cyrus/pull/1063))
- **Logger tests updated for ISO timestamp output** - Fixed test failures caused by the ISO timestamp addition to log output in v0.2.39. Tests in `core` and `claude-runner` now correctly match the timestamped log format. ([CYPACK-1027](https://linear.app/ceedar/issue/CYPACK-1027), [#1060](https://github.com/ceedaragents/cyrus/pull/1060))

### Changed
- **Updated `@anthropic-ai/claude-agent-sdk` to v0.2.90 and `@anthropic-ai/sdk` to v0.82.0** - Upgrades from v0.2.89 / v0.81.0. v0.2.90 syncs with Claude Code v2.1.90. v0.82.0 adds structured `stop_details` to message responses and AWS Bedrock SDK API key support. See changelogs: [claude-agent-sdk](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md), [anthropic-sdk](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md). ([CYPACK-1028](https://linear.app/ceedar/issue/CYPACK-1028), [#1062](https://github.com/ceedaragents/cyrus/pull/1062))
- **Updated `@anthropic-ai/claude-agent-sdk` to v0.2.89 and `@anthropic-ai/sdk` to v0.81.0** - Upgrades from v0.2.87 / v0.80.0. v0.2.89 adds `startup()` for ~20x faster first queries, `listSubagents()` / `getSubagentMessages()` for subagent conversation history, fixes Zod v4 schema metadata being dropped, and fixes `side_question` returning null on resume. v0.81.0 adds `.type` field to `APIError` for error kind identification. See changelogs: [claude-agent-sdk](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md), [anthropic-sdk](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md). ([CYPACK-1026](https://linear.app/ceedar/issue/CYPACK-1026), [#1058](https://github.com/ceedaragents/cyrus/pull/1058))

### Added
- **GitHub App webhook setup for self-hosted users** - Self-hosted users can now configure GitHub App webhooks during setup. ([#1054](https://github.com/ceedaragents/cyrus/pull/1054))
- **ISO timestamps in log output** - Log lines now include ISO timestamps for easier debugging and correlation. ([#1055](https://github.com/ceedaragents/cyrus/pull/1055))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.40

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.40

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.40

#### cyrus-core
- cyrus-core@0.2.40

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.40

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.40

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.40

#### cyrus-config-updater
- cyrus-config-updater@0.2.40

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.40

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.40

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.40

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.40

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.40

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.40

#### cyrus-ai (CLI)
- cyrus-ai@0.2.40

## [0.2.39] - 2026-03-31

### Fixed
- **Linear OAuth tokens now stay fresh across long sessions** - When Linear access tokens are refreshed (at least once daily with OAuth 2.0), running sessions and services now automatically pick up the new token instead of continuing with a stale one. ([CYPACK-1024](https://linear.app/ceedar/issue/CYPACK-1024), [#1056](https://github.com/ceedaragents/cyrus/pull/1056))
- **Self-auth now works with reverse proxies on other machines** - The self-auth OAuth callback server now respects `CYRUS_HOST_EXTERNAL=true` and listens on `0.0.0.0` instead of `localhost`, matching the main server's behavior. ([#1046](https://github.com/ceedaragents/cyrus/issues/1046), [CYPACK-1017](https://linear.app/ceedar/issue/CYPACK-1017), [#1047](https://github.com/ceedaragents/cyrus/pull/1047))

### Added
- **Auto-detect base branch when adding repositories** - `cyrus self-add-repo` now automatically detects the remote's default branch instead of always using `main`. Also adds a `--base-branch` flag for manual override. ([CYPACK-1015](https://linear.app/ceedar/issue/CYPACK-1015), [#1051](https://github.com/ceedaragents/cyrus/pull/1051))

### Changed
- **Skills replace rigid procedure workflows** - Agent sessions now use flexible, customizable skills instead of fixed procedure sequences. Skills are discoverable at runtime, giving the agent more natural control over its workflow. A Stop hook ensures PRs and summaries are always created before sessions end. Users can add custom skills to `~/.cyrus/skills/`. ([CYPACK-996](https://linear.app/ceedar/issue/CYPACK-996), [#1018](https://github.com/ceedaragents/cyrus/pull/1018))
- **Renamed `cyrus self-auth` to `cyrus self-auth-linear`** - Clarifies that this command authenticates specifically with Linear OAuth. ([CYPACK-1017](https://linear.app/ceedar/issue/CYPACK-1017), [#1047](https://github.com/ceedaragents/cyrus/pull/1047))
- **Updated `@anthropic-ai/claude-agent-sdk` to v0.2.88** - Syncs with Claude Code v2.1.88. Fixes error result messages now correctly setting `is_error: true`, MCP servers no longer getting permanently stuck after a connection race, ~50% failure rate bug in `StructuredOutput` schema cache, and `ERR_STREAM_WRITE_AFTER_END` errors with single-turn queries. Also adds `includeSystemMessages` option to `getSessionMessages()` and `includeHookEvents` option for hook lifecycle messages. See SDK changelog: [claude-agent-sdk](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md). ([CYPACK-1023](https://linear.app/ceedar/issue/CYPACK-1023), [#1053](https://github.com/ceedaragents/cyrus/pull/1053))
- **Updated `@anthropic-ai/claude-agent-sdk` to v0.2.87** - Syncs with Claude Code v2.1.87 (maintenance release). See SDK changelog: [claude-agent-sdk](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md). ([CYPACK-1020](https://linear.app/ceedar/issue/CYPACK-1020), [#1050](https://github.com/ceedaragents/cyrus/pull/1050))
- **Updated `@anthropic-ai/claude-agent-sdk` to v0.2.86** - Keeps AI SDK dependency up to date. v0.2.86 adds `getContextUsage()` for token distribution visibility, makes `session_id` optional in `SDKUserMessage`, and fixes TypeScript type resolution. v0.2.85 adds `reloadPlugins()` for dynamic plugin refresh and fixes PreToolUse hooks with `"ask"` permission decisions. See SDK changelog: [claude-agent-sdk](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md). ([CYPACK-1016](https://linear.app/ceedar/issue/CYPACK-1016), [#1045](https://github.com/ceedaragents/cyrus/pull/1045))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.39

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.39

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.39

#### cyrus-core
- cyrus-core@0.2.39

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.39

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.39

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.39

#### cyrus-config-updater
- cyrus-config-updater@0.2.39

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.39

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.39

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.39

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.39

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.39

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.39

#### cyrus-ai (CLI)
- cyrus-ai@0.2.39

## [0.2.38] - 2026-03-25

### Added
- **GitLab integration with `glab` CLI support** - Cyrus now supports GitLab repositories alongside GitHub. Create merge requests, respond to MR comments, and handle review feedback using the `glab` CLI. Includes webhook support for receiving GitLab events, a dedicated setup skill (`/cyrus-setup-gitlab`), and platform-aware subroutines that automatically use `glab` commands for GitLab-hosted repos. ([#857](https://github.com/ceedaragents/cyrus/issues/857), [#1029](https://github.com/ceedaragents/cyrus/pull/1029))
- **Cyrus docs MCP available in all sessions** - Cyrus now has access to its own documentation via the Mintlify docs MCP server, enabling better self-reference and user guidance. ([CYPACK-995](https://linear.app/ceedar/issue/CYPACK-995), [#1016](https://github.com/ceedaragents/cyrus/pull/1016))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.38

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.38

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.38

#### cyrus-core
- cyrus-core@0.2.38

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.38

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.38

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.38

#### cyrus-config-updater
- cyrus-config-updater@0.2.38

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.38

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.38

#### cyrus-gitlab-event-transport
- cyrus-gitlab-event-transport@0.2.38

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.38

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.38

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.38

#### cyrus-ai (CLI)
- cyrus-ai@0.2.38

## [0.2.37] - 2026-03-18

### Added
- **Slack sessions now support user-configured MCP tools** - Slack chat sessions can now access MCP tools from user-configured `.mcp.json` files (e.g., Supabase, Stripe, Trigger.dev), not just the built-in Linear/cyrus-tools/Slack MCPs. ([CYPACK-982](https://linear.app/ceedar/issue/CYPACK-982), [#1006](https://github.com/ceedaragents/cyrus/pull/1006))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.37

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.37

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.37

#### cyrus-core
- cyrus-core@0.2.37

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.37

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.37

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.37

#### cyrus-config-updater
- cyrus-config-updater@0.2.37

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.37

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.37

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.37

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.37

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.37

#### cyrus-ai (CLI)
- cyrus-ai@0.2.37

## [0.2.36] - 2026-03-17

### Added
- **Automatic worktree cleanup on issue completion or deletion** - When a Linear issue moves to Done, Cancelled, or is deleted, worktrees are automatically deleted and any active sessions are stopped. Handles both single-repo and multi-repo layouts. ([CYPACK-961](https://linear.app/ceedar/issue/CYPACK-961), [#982](https://github.com/ceedaragents/cyrus/pull/982))

### Fixed
- **Worktree recreation after issue reopened** - Fixed a bug where worktrees were not recreated when an issue was re-prompted after being moved to Done/Cancelled. Stale git worktree entries from a previous cleanup could prevent fresh worktree creation. ([CYPACK-961](https://linear.app/ceedar/issue/CYPACK-961), [#982](https://github.com/ceedaragents/cyrus/pull/982))
- **Self-hosted onboarding improvements** - Fixed `-l` routing labels flag not working with `cyrus self-add-repo`, idle mode now shows `cyrus self-add-repo` guidance instead of cloud URL for self-hosted users, and `cyrus self-auth` error messages now correctly point to `~/.cyrus/.env` instead of `.zshrc`. ([CYPACK-967](https://linear.app/ceedar/issue/CYPACK-967), [#991](https://github.com/ceedaragents/cyrus/pull/991))
- **Security vulnerabilities resolved** - Fixed all Dependabot security alerts (1 critical, 20 high, 11 moderate, 4 low) by updating transitive dependency versions for packages including simple-git, undici, hono, minimatch, rollup, and others. ([CYPACK-973](https://linear.app/ceedar/issue/CYPACK-973), [#1000](https://github.com/ceedaragents/cyrus/pull/1000))

### Changed
- **PR descriptions now include interaction tips** - Pull requests created by Cyrus now include a tip explaining how to @ mention the bot (configurable via `GITHUB_BOT_USERNAME`) for inline responses and how to submit "changes requested" reviews for batch feedback. ([CYPACK-974](https://linear.app/ceedar/issue/CYPACK-974), [#1001](https://github.com/ceedaragents/cyrus/pull/1001))
- **Co-authored-by attribution disabled** - Git commits no longer include the "Co-Authored-By: Claude" trailer. ([CYPACK-974](https://linear.app/ceedar/issue/CYPACK-974), [#1001](https://github.com/ceedaragents/cyrus/pull/1001))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.36

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.36

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.36

#### cyrus-core
- cyrus-core@0.2.36

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.36

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.36

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.36

#### cyrus-config-updater
- cyrus-config-updater@0.2.36

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.36

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.36

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.36

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.36

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.36

#### cyrus-ai (CLI)
- cyrus-ai@0.2.36

## [0.2.35] - 2026-03-16

### Fixed
- **OAuth token refresh no longer stops working after first expiry** - Fixed a bug where the OAuth token refresh mechanism would permanently stop refreshing after the first successful refresh, causing all Linear API calls to fail ~24 hours later. Subsequent token expirations now correctly trigger fresh refreshes. ([CYPACK-963](https://linear.app/ceedar/issue/CYPACK-963), [#986](https://github.com/ceedaragents/cyrus/pull/986))
- **Self-auth no longer modifies repositories or shows confusing messages** - `cyrus self-auth` now only saves workspace credentials and no longer auto-links repositories. Shows "Saved credentials for workspace: \<name\>" and guides users to run `cyrus self-add-repo` when no repos exist. Resolves [#716](https://github.com/ceedaragents/cyrus/issues/716). ([CYPACK-964](https://linear.app/ceedar/issue/CYPACK-964), [#988](https://github.com/ceedaragents/cyrus/pull/988))
- **Linear webhook signature verification more reliable** - Webhook signature verification now uses the raw request body bytes instead of re-serializing JSON, preventing intermittent HMAC failures caused by key ordering or whitespace differences.

### Added
- **Routing labels default when adding repos** - `cyrus self-add-repo` now automatically sets routing labels to the repository name. Use `-l custom,labels` to override with custom comma-separated labels. ([CYPACK-963](https://linear.app/ceedar/issue/CYPACK-963), [#986](https://github.com/ceedaragents/cyrus/pull/986))
- **Cloudflare tunnel auto-starts during self-auth** - Running `cyrus self-auth` now automatically starts a Cloudflare tunnel, so webhooks can reach the local agent immediately after authentication. ([#952](https://github.com/ceedaragents/cyrus/pull/952))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.35

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.35

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.35

#### cyrus-core
- cyrus-core@0.2.35

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.35

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.35

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.35

#### cyrus-config-updater
- cyrus-config-updater@0.2.35

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.35

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.35

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.35

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.35

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.35

#### cyrus-ai (CLI)
- cyrus-ai@0.2.35

## [0.2.34] - 2026-03-13

### Fixed
- **Slack-created issues no longer land in Triage** - Issues created from Slack conversations now default to "Backlog" status instead of potentially being set to "Triage". ([CYPACK-957](https://linear.app/ceedar/issue/CYPACK-957), [#978](https://github.com/ceedaragents/cyrus/pull/978))
- **Issue updates no longer trigger duplicate runs** - When a Linear issue title or description was updated, all idle sessions for that issue were resumed, causing multiple concurrent runs. Issue updates are now only delivered to currently running sessions via streaming input; idle sessions are no longer resumed. Duplicate webhooks are also deduplicated. ([CYPACK-954](https://linear.app/ceedar/issue/CYPACK-954), [#977](https://github.com/ceedaragents/cyrus/pull/977))

### Added
- **Multi-repo routing** - A single Linear issue can now be routed to multiple repositories. Supported syntax: `[repo=frontend]` and `[repo=backend]` as separate tags, `repo=frontend,backend` or `repos=frontend,backend` as comma-separated lists, `repo=frontend#develop` or `[repo=frontend#release/v2]` for base branch overrides, and label-based routing that matches multiple repos when their routing labels overlap. Each matched repository gets its own worktree subfolder and git context within the same session, with per-repository branch names, MCP configs, and tool permissions. ([CYPACK-911](https://linear.app/ceedar/issue/CYPACK-911), [#955](https://github.com/ceedaragents/cyrus/pull/955), [#959](https://github.com/ceedaragents/cyrus/pull/959), [#960](https://github.com/ceedaragents/cyrus/pull/960), [#961](https://github.com/ceedaragents/cyrus/pull/961), [#962](https://github.com/ceedaragents/cyrus/pull/962), [#963](https://github.com/ceedaragents/cyrus/pull/963), [#964](https://github.com/ceedaragents/cyrus/pull/964), [#965](https://github.com/ceedaragents/cyrus/pull/965))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.34

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.34

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.34

#### cyrus-core
- cyrus-core@0.2.34

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.34

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.34

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.34

#### cyrus-config-updater
- cyrus-config-updater@0.2.34

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.34

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.34

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.34

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.34

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.34

#### cyrus-ai (CLI)
- cyrus-ai@0.2.34

## [0.2.33] - 2026-03-10

### Fixed
- **MCP config files crashing ClaudeRunner sessions** - File-loaded MCP server configs (`.mcp.json`, `mcp-*.json`) that omit the `type` field for URL-based servers no longer crash sessions with 0 messages. ClaudeRunner now infers `type: "http"` when a `url` is present. ([#966](https://github.com/ceedaragents/cyrus/pull/966))

### Added
- **Real MCP connection testing** - The MCP test endpoint now performs actual SDK connections (stdio process spawn or HTTP/SSE) and returns discovered tools, replacing the previous placeholder response. ([#966](https://github.com/ceedaragents/cyrus/pull/966))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.33

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.33

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.33

#### cyrus-core
- cyrus-core@0.2.33

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.33

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.33

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.33

#### cyrus-config-updater
- cyrus-config-updater@0.2.33

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.33

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.33

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.33

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.33

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.33

#### cyrus-ai (CLI)
- cyrus-ai@0.2.33

## [0.2.32] - 2026-03-10

### Fixed
- **Orchestrator sub-issue results not reaching parent** - Sub-issue completion results are now correctly written back to the parent orchestrator issue. This regression was introduced in v0.2.22 by the GlobalSessionRegistry refactor (CYPACK-724), which changed the parent session lookup to read from `globalSessionRegistry` without updating the write path to match. ([CYPACK-922](https://linear.app/ceedar/issue/CYPACK-922), [#957](https://github.com/ceedaragents/cyrus/pull/957))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.32

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.32

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.32

#### cyrus-core
- cyrus-core@0.2.32

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.32

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.32

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.32

#### cyrus-config-updater
- cyrus-config-updater@0.2.32

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.32

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.32

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.32

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.32

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.32

#### cyrus-ai (CLI)
- cyrus-ai@0.2.32

## [0.2.31] - 2026-03-09

### Fixed
- **Rate limit event handling** - Rate limit events from Claude are now properly handled instead of producing "Unknown message type" warnings in logs. ([CYPACK-895](https://linear.app/ceedar/issue/CYPACK-895), [#946](https://github.com/ceedaragents/cyrus/pull/946))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.31

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.31

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.31

#### cyrus-core
- cyrus-core@0.2.31

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.31

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.31

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.31

#### cyrus-config-updater
- cyrus-config-updater@0.2.31

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.31

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.31

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.31

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.31

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.31

#### cyrus-ai (CLI)
- cyrus-ai@0.2.31

## [0.2.30] - 2026-03-05

### Fixed
- **Chat session repository context and git pull guidance** - Chat sessions now receive read-only access to all configured repository paths and include explicit `git pull` instructions in their system prompt when inspecting repository source code. ([CYPACK-891](https://linear.app/ceedar/issue/CYPACK-891), [#942](https://github.com/ceedaragents/cyrus/pull/942))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.30

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.30

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.30

#### cyrus-core
- cyrus-core@0.2.30

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.30

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.30

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.30

#### cyrus-config-updater
- cyrus-config-updater@0.2.30

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.30

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.30

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.30

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.30

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.30

#### cyrus-ai (CLI)
- cyrus-ai@0.2.30

## [0.2.29] - 2026-03-05

### Fixed
- **Slack thread context now includes the agent's own messages** - Follow-up sessions (especially after switching runner types) no longer lose conversation history. The agent's previous replies are now included in thread context and labeled as "assistant (you)" so the new runner understands conversation roles.

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.29

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.29

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.29

#### cyrus-core
- cyrus-core@0.2.29

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.29

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.29

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.29

#### cyrus-config-updater
- cyrus-config-updater@0.2.29

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.29

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.29

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.29

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.29

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.29

#### cyrus-ai (CLI)
- cyrus-ai@0.2.29

## [0.2.28] - 2026-03-04

### Fixed
- **Webhook verification mode now updates at runtime** - When `SLACK_SIGNING_SECRET` or `GITHUB_WEBHOOK_SECRET` environment variables are added after the process starts (along with `CYRUS_HOST_EXTERNAL=true`), Cyrus now automatically switches from proxied to direct webhook verification without requiring a restart. ([CYPACK-884](https://linear.app/ceedar/issue/CYPACK-884), [#934](https://github.com/ceedaragents/cyrus/pull/934))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.28

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.28

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.28

#### cyrus-core
- cyrus-core@0.2.28

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.28

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.28

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.28

#### cyrus-config-updater
- cyrus-config-updater@0.2.28

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.28

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.28

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.28

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.28

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.28

#### cyrus-ai (CLI)
- cyrus-ai@0.2.28

## [0.2.27] - 2026-03-04 ([#933](https://github.com/ceedaragents/cyrus/pull/933))

### Added
- **PR change request handling** - When a reviewer requests changes on a PR created by Cyrus, the agent now automatically acknowledges the review and starts working on the requested changes. Supports both summary-level and line-level review comments. ([CYPACK-842](https://linear.app/ceedar/issue/CYPACK-842), [#896](https://github.com/ceedaragents/cyrus/pull/896))
- **Direct Slack webhook verification for self-hosted deployments** - Cyrus can now verify Slack webhooks directly using HMAC-SHA256 signature verification when `SLACK_SIGNING_SECRET` is set, removing the need for the CYHOST proxy in self-hosted environments. Thanks to [@aniravi24](https://github.com/aniravi24) ([#829](https://github.com/ceedaragents/cyrus/pull/829))
- **GitHub bot mention filtering** - GitHub webhook handler now respects `GITHUB_BOT_USERNAME` to only trigger on `@bot` mentions and ignore its own comments, preventing infinite loops in self-hosted setups. Thanks to [@aniravi24](https://github.com/aniravi24) ([#829](https://github.com/ceedaragents/cyrus/pull/829))
- **Smarter Slack thread context** - Other bots' messages (Sentry, CI, GitHub notifications) are now preserved in Slack thread context instead of being filtered out. Only the bot's own messages are excluded. Thanks to [@aniravi24](https://github.com/aniravi24) ([#829](https://github.com/ceedaragents/cyrus/pull/829))

### Fixed
- **Slack bot token availability after runtime switch** - Fixed Slack bot token not being available when switching from cloud to self-host runtime. The token is now resolved at usage time with a fallback to `process.env`, handling cases where the env update arrives after the first webhook. ([CYPACK-842](https://linear.app/ceedar/issue/CYPACK-842), [#896](https://github.com/ceedaragents/cyrus/pull/896))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.27

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.27

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.27

#### cyrus-core
- cyrus-core@0.2.27

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.27

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.27

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.27

#### cyrus-config-updater
- cyrus-config-updater@0.2.27

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.27

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.27

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.27

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.27

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.27

#### cyrus-ai (CLI)
- cyrus-ai@0.2.27

## [0.2.26] - 2026-02-28 ([#918](https://github.com/ceedaragents/cyrus/pull/918))

### Changed
- **Updated Claude SDK dependencies** - project configs & auto memory are now shared across git worktrees of the same repository, so Claude's persistent memory works consistently across all Cyrus worktrees. Updated `@anthropic-ai/claude-agent-sdk` to v0.2.63 and `@anthropic-ai/sdk` to v0.78.0. See [claude-agent-sdk changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) for details. ([CYPACK-859](https://linear.app/ceedar/issue/CYPACK-859), [#917](https://github.com/ceedaragents/cyrus/pull/917))

### Fixed
- **Cursor runs no longer fail on version mismatches** - Cyrus no longer blocks Cursor sessions when the installed `cursor-agent` version differs from a previously tested version, and the `CYRUS_CURSOR_AGENT_VERSION` override is no longer needed. ([CYPACK-857](https://linear.app/ceedar/issue/CYPACK-857/remove-the-requirement-that-throws-this-error), [#915](https://github.com/ceedaragents/cyrus/pull/915))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.26

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.26

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.26

#### cyrus-core
- cyrus-core@0.2.26

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.26

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.26

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.26

#### cyrus-config-updater
- cyrus-config-updater@0.2.26

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.26

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.26

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.26

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.26

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.26

#### cyrus-ai (CLI)
- cyrus-ai@0.2.26

## [0.2.25] - 2026-02-27

### Fixed
- **Default runner config now applies on hot-reload** - Changing `defaultRunner`, model defaults, or other global settings in `~/.cyrus/config.json` while Cyrus is running now takes effect immediately, instead of being ignored until restart. ([CYPACK-856](https://linear.app/ceedar/issue/CYPACK-856), [#907](https://github.com/ceedaragents/cyrus/pull/907))
- **Codex runner no longer fails during issue classification** - When `defaultRunner` is set to `codex`, the ProcedureAnalyzer classification step no longer crashes with a reasoning effort error. Also uses structured outputs for more reliable classification responses. ([CYPACK-856](https://linear.app/ceedar/issue/CYPACK-856), [#907](https://github.com/ceedaragents/cyrus/pull/907))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.25

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.25

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.25

#### cyrus-core
- cyrus-core@0.2.25

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.25

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.25

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.25

#### cyrus-config-updater
- cyrus-config-updater@0.2.25

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.25

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.25

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.25

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.25

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.25

#### cyrus-ai (CLI)
- cyrus-ai@0.2.25

## [0.2.24] - 2026-02-26

### Fixed
- **Sessions no longer appear stuck after restart** - When the system restarts or migrates, user prompts, stop signals, and other interactions that target older sessions are now recovered instead of silently dropped. Users will see clear feedback instead of a hanging state. ([CYPACK-852](https://linear.app/ceedar/issue/CYPACK-852), [#905](https://github.com/ceedaragents/cyrus/pull/905))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.24

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.24

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.24

#### cyrus-core
- cyrus-core@0.2.24

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.24

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.24

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.24

#### cyrus-config-updater
- cyrus-config-updater@0.2.24

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.24

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.24

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.24

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.24

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.24

#### cyrus-ai (CLI)
- cyrus-ai@0.2.24

## [0.2.23] - 2026-02-25

### Fixed
- **`defaultRunner` config setting now works correctly** - Setting `"defaultRunner": "codex"` (or `"gemini"` / `"cursor"`) in `~/.cyrus/config.json` now properly routes issues without runner-specific labels to the configured default runner, instead of always falling back to Claude. ([CYPACK-838](https://linear.app/ceedar/issue/CYPACK-838), [#892](https://github.com/ceedaragents/cyrus/pull/892))

### Added
- **Assignee attribution on PRs** - PR descriptions now include assignee attribution at the top. When the assignee has a linked GitHub account, they are @mentioned for a GitHub notification. When no GitHub account is linked, the assignee's Linear profile is linked instead, ensuring an audit trail for all PRs. ([CYPACK-843](https://linear.app/ceedar/issue/CYPACK-843), [#895](https://github.com/ceedaragents/cyrus/pull/895))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.23

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.23

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.23

#### cyrus-core
- cyrus-core@0.2.23

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.23

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.23

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.23

#### cyrus-config-updater
- cyrus-config-updater@0.2.23

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.23

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.23

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.23

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.23

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.23

#### cyrus-ai (CLI)
- cyrus-ai@0.2.23

## [0.2.22] - 2026-02-20

### Added
- **Slack MCP tools available in agent sessions** - When the `SLACK_BOT_TOKEN` environment variable is set, Slack MCP tools (`mcp__slack`) are now automatically available in Linear and Slack sessions, enabling agents to read channels, search messages, and interact with Slack workspaces. ([CYPACK-832](https://linear.app/ceedar/issue/CYPACK-832), [#884](https://github.com/ceedaragents/cyrus/pull/884))
- **Subroutine transition status messages** - Cyrus now posts a status update to the Linear timeline when transitioning between sub-procedures (e.g., "Running tests, linting, and type checking...", "Creating summary..."), so users can see what Cyrus is doing instead of the session appearing to hang. ([CYPACK-835](https://linear.app/ceedar/issue/CYPACK-835), [#887](https://github.com/ceedaragents/cyrus/pull/887))
- **Configurable default runner** - The default agent harness is now configurable via `defaultRunner` in `config.json` (values: `"claude"`, `"gemini"`, `"codex"`, `"cursor"`) instead of always defaulting to Claude. When only one API key is set (Claude, Gemini, Codex, or Cursor), that runner is auto-detected as the default. When multiple keys are present, set `defaultRunner` to choose which one is used for new sessions. The setting is also updateable via the config update endpoint. ([CYPACK-826](https://linear.app/ceedar/issue/CYPACK-826), [#878](https://github.com/ceedaragents/cyrus/pull/878))
- GitHub PR comment support: Cyrus can now be triggered by `@cyrusagent` mentions on GitHub pull request comments, creating sessions and posting replies directly on PRs. ([CYPACK-772](https://linear.app/ceedar/issue/CYPACK-772), [#820](https://github.com/ceedaragents/cyrus/pull/820))
- Slack integration: Cyrus can now receive `@mention` webhooks from Slack channels and threads, enabling Slack as a new platform for triggering agent sessions. ([CYPACK-807](https://linear.app/ceedar/issue/CYPACK-807), [#861](https://github.com/ceedaragents/cyrus/pull/861))

### Changed
- **Slack responses now use proper mrkdwn formatting** - Slack sessions now instruct the agent to use Slack's native mrkdwn syntax instead of standard Markdown, ensuring bold, italic, links, and code blocks render correctly in Slack messages. ([CYPACK-834](https://linear.app/ceedar/issue/CYPACK-834), [#886](https://github.com/ceedaragents/cyrus/pull/886))
- **OpenAI tools now auto-detected from environment** - GPT Image and Sora video generation tools are now automatically available when the `OPENAI_API_KEY` environment variable is set, instead of requiring `openaiApiKey` in repository config. The `openaiApiKey` and `openaiOutputDirectory` config fields have been removed. ([CYPACK-831](https://linear.app/ceedar/issue/CYPACK-831), [#883](https://github.com/ceedaragents/cyrus/pull/883))
- **Updated Claude SDK dependencies** - Updated `@anthropic-ai/claude-agent-sdk` to v0.2.47 and `@anthropic-ai/sdk` to v0.77.0, adding Claude Sonnet 4.6 support, new `promptSuggestion()` method, and improved memory usage for large shell outputs. See [claude-agent-sdk changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) for details. ([CYPACK-827](https://linear.app/ceedar/issue/CYPACK-827), [#880](https://github.com/ceedaragents/cyrus/pull/880))
- Slack bot token is now read exclusively from the `SLACK_BOT_TOKEN` environment variable. The `X-Slack-Bot-Token` HTTP header is no longer supported. ([CYPACK-824](https://linear.app/ceedar/issue/CYPACK-824), [#876](https://github.com/ceedaragents/cyrus/pull/876))
- Slack agent sessions now run in transient empty directories instead of git worktrees, and subsequent @mentions in the same thread share the same session context. ([CYPACK-815](https://linear.app/ceedar/issue/CYPACK-815), [#868](https://github.com/ceedaragents/cyrus/pull/868))
- **Agent and model selectors now work across Claude, Gemini, and Codex** - You can now set runner and model directly in issue descriptions using `[agent=claude|gemini|codex]` and `[model=<model-name>]`. This is not Codex-only: selectors apply to all supported runners. `[agent=...]` explicitly selects the runner, `[model=...]` selects the model and can infer runner family, and description tags take precedence over labels. ([#850](https://github.com/ceedaragents/cyrus/pull/850))
- **Codex tool activity is now visible in Linear sessions** - Codex runs now emit tool lifecycle activity (including command execution, file edits, web fetch/search, MCP tool calls, and todo updates) so activity streams show execution details instead of only final output. ([#850](https://github.com/ceedaragents/cyrus/pull/850))
- **Codex todo output now renders as proper checklists** - Todo items are now formatted as markdown task lists (`- [ ]` and `- [x]`) for correct checklist rendering in Linear. ([#850](https://github.com/ceedaragents/cyrus/pull/850))
- **Major new feature: Cursor agent harness support** - Cyrus now supports Cursor as a first-class agent option. To use it, set `[agent=cursor]` in the issue description or apply a `cursor` issue label; either selector runs end-to-end with the Cursor runner and posts the final response back to the issue thread. Cursor runs now map Cyrus tool permissions into project-level Cursor CLI permissions, pre-enable configured MCP servers before run, and refresh permissions between subroutines so permission changes take effect without restarting the issue flow. Cursor sandbox is enabled by default for tool execution isolation; set `CYRUS_SANDBOX=disabled` to disable. Before each run, Cyrus validates that the installed `cursor-agent` version matches the tested version; a mismatch posts an error to Linear. Set `CYRUS_CURSOR_AGENT_VERSION` to your installed version to override. Assembled cursor-agent CLI args are now logged to console and session log files for debugging. Codex default runner model is now `gpt-5.3-codex` (configurable via `codexDefaultModel`). ([CYPACK-804](https://linear.app/ceedar/issue/CYPACK-804), [#858](https://github.com/ceedaragents/cyrus/pull/858))
- **Cyrus MCP tools now run on the built-in server endpoint with authenticated Codex access** - Cyrus tools are now served via Fastify MCP on the same configured server port, cyrus-tools MCP requests require `Authorization: Bearer <CYRUS_API_KEY>`, and Codex now forwards configured MCP HTTP auth headers correctly so authenticated MCP servers initialize successfully. ([CYPACK-817](https://linear.app/ceedar/issue/CYPACK-817), [#870](https://github.com/ceedaragents/cyrus/pull/870))

### Fixed
- Summary subroutines now properly disable all tools including MCP tools like Linear's create_comment ([#808](https://github.com/ceedaragents/cyrus/pull/808))
- Procedures no longer fail when a subroutine exits with an error (e.g., hitting the max turns limit). Cyrus now recovers by using the last successful subroutine's result, allowing the workflow to continue to completion instead of stopping mid-procedure ([#818](https://github.com/ceedaragents/cyrus/pull/818))
- **Codex usage limit errors now display full message in Linear** - When Codex hits usage limits or other turn.failed errors, the actual error message is now posted to Linear agent activity instead of a generic message. ([CYPACK-804](https://linear.app/ceedar/issue/CYPACK-804), [#858](https://github.com/ceedaragents/cyrus/pull/858))
- **Cursor project .cursor/cli.json is now backed up and restored** - CursorRunner no longer overwrites the project's `.cursor/cli.json`. It temporarily renames the existing file before writing Cyrus permissions, then restores the original when the session ends. ([CYPACK-804](https://linear.app/ceedar/issue/CYPACK-804), [#858](https://github.com/ceedaragents/cyrus/pull/858))
- **Cursor API key no longer in CLI args or logs** - The Cursor API key is now passed only via the `CURSOR_API_KEY` environment variable, so it never appears in spawn logs or terminal output. The `--force` option has also been removed from cursor-agent invocations. ([CYPACK-804](https://linear.app/ceedar/issue/CYPACK-804), [#858](https://github.com/ceedaragents/cyrus/pull/858))
- **Cursor completed todos now display as checked in Linear** - Cursor API uses `TODO_STATUS_COMPLETED` for completed todo items; the formatter now recognizes this so completed items render as `- [x]` instead of `- [ ]` in Linear activity. ([CYPACK-804](https://linear.app/ceedar/issue/CYPACK-804), [#858](https://github.com/ceedaragents/cyrus/pull/858))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.22

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.2.22

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.22

#### cyrus-core
- cyrus-core@0.2.22

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.22

#### cyrus-codex-runner
- cyrus-codex-runner@0.2.22

#### cyrus-cursor-runner
- cyrus-cursor-runner@0.2.22

#### cyrus-config-updater
- cyrus-config-updater@0.2.22

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.22

#### cyrus-github-event-transport
- cyrus-github-event-transport@0.2.22

#### cyrus-slack-event-transport
- cyrus-slack-event-transport@0.2.22

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.22

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.22

#### cyrus-ai (CLI)
- cyrus-ai@0.2.22

## [0.2.21] - 2026-02-09

### Changed
- **Updated Claude SDK dependencies** - Updated `@anthropic-ai/claude-agent-sdk` to v0.2.34 and `@anthropic-ai/sdk` to v0.73.0. See [claude-agent-sdk changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#v0234) for details. ([CYPACK-788](https://linear.app/ceedar/issue/CYPACK-788), [#837](https://github.com/ceedaragents/cyrus/pull/837))
- **Improved task and tool activity display** - Task creation now shows as concise checklist items instead of verbose multi-line entries, task status updates display the task name with status emoji, and tool search/background task output activities are now cleanly formatted. ([CYPACK-795](https://linear.app/ceedar/issue/CYPACK-795), [#846](https://github.com/ceedaragents/cyrus/pull/846))
- **Task status updates now show task descriptions** - Task update and task detail activities now display the task subject alongside the task number (e.g., "Task #3 — Fix login bug") instead of just the number. ([CYPACK-797](https://linear.app/ceedar/issue/CYPACK-797), [#847](https://github.com/ceedaragents/cyrus/pull/847))

### Fixed
- **Procedures no longer fail when a subroutine exits with an error** - When a single-turn subroutine hits the max turns limit, Cyrus now recovers by using the last successful subroutine's result, allowing the workflow to continue to completion instead of stopping mid-procedure. ([CYPACK-792](https://linear.app/ceedar/issue/CYPACK-792), [#843](https://github.com/ceedaragents/cyrus/pull/843))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.21

#### cyrus-config-updater
- cyrus-config-updater@0.2.21

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.21

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.21

#### cyrus-core
- cyrus-core@0.2.21

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.21

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.21

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.21

#### cyrus-ai (CLI)
- cyrus-ai@0.2.21

## [0.2.20] - 2026-02-05

### Fixed
- **Agent guidance for draft PRs now respected** - When your Linear workspace guidance specifies `--draft` or requests PRs remain as drafts, Cyrus will no longer automatically convert them to ready for review. PRs also now correctly target the configured base branch instead of defaulting to main. ([CYPACK-784](https://linear.app/ceedar/issue/CYPACK-784), [#834](https://github.com/ceedaragents/cyrus/pull/834))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.20

#### cyrus-config-updater
- cyrus-config-updater@0.2.20

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.20

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.20

#### cyrus-core
- cyrus-core@0.2.20

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.20

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.20

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.20

#### cyrus-ai (CLI)
- cyrus-ai@0.2.20

## [0.2.19] - 2026-01-24

### Fixed
- Fixed configuration schema compatibility issue between cyrus-hosted and local installations. ([#802](https://github.com/ceedaragents/cyrus/pull/802))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.19

#### cyrus-config-updater
- cyrus-config-updater@0.2.19

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.19

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.19

#### cyrus-core
- cyrus-core@0.2.19

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.19

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.19

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.19

#### cyrus-ai (CLI)
- cyrus-ai@0.2.19

## [0.2.18] - 2026-01-23

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.18

#### cyrus-config-updater
- cyrus-config-updater@0.2.18

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.18

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.18

#### cyrus-core
- cyrus-core@0.2.18

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.18

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.18

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.18

#### cyrus-ai (CLI)
- cyrus-ai@0.2.18

## [0.2.17] - 2026-01-23

### Added
- **Issue update awareness** - Cyrus now detects when you edit an issue's title, description, or attachments while it's actively working on that issue. The agent receives context showing what changed (old vs new values) along with guidance to evaluate whether the update affects its implementation or action plan. TIP: instead of re-prompting Cyrus in a comment or chat window, just update the issue description with additional acceptance criteria! It will auto-start or adjust course and apply changes. ([CYPACK-736](https://linear.app/ceedar/issue/CYPACK-736), [#782](https://github.com/ceedaragents/cyrus/pull/782))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.17

#### cyrus-config-updater
- cyrus-config-updater@0.2.17

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.17

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.17

#### cyrus-core
- cyrus-core@0.2.17

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.17

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.17

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.17

#### cyrus-ai (CLI)
- cyrus-ai@0.2.17

## [0.2.16] - 2026-01-23

### Added
- **User access control** - Added the ability to whitelist or blacklist Linear users from delegating issues to Cyrus. Supports blocking specific users by Linear ID or email address, allowing only specific users (allowlist mode blocks everyone not explicitly listed), configurable block behavior (silent ignore or post comment), and template variables in block messages. Blocklist is additive (global + repo), while allowlist overrides (repo replaces global). Thanks to [@tjorri](https://github.com/tjorri) for the contribution! ([#779](https://github.com/ceedaragents/cyrus/pull/779))

### Improved
- **Better Cloudflare tunnel error messages** - When the Cloudflare tunnel fails to connect, Cyrus now provides detailed troubleshooting guidance including common causes (firewall, VPN, proxy issues) and links to connectivity prechecks documentation. This helps users quickly identify and resolve network configuration issues preventing tunnel establishment. ([CYPACK-743](https://linear.app/ceedar/issue/CYPACK-743), [#788](https://github.com/ceedaragents/cyrus/pull/788))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.16

#### cyrus-config-updater
- cyrus-config-updater@0.2.16

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.16

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.16

#### cyrus-core
- cyrus-core@0.2.16

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.16

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.16

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.16

#### cyrus-ai (CLI)
- cyrus-ai@0.2.16

## [0.2.15] - 2026-01-16

### Added
- **Version endpoint** - Added a `/version` endpoint that returns the Cyrus CLI version, enabling the dashboard to display version information. The endpoint returns `{ "cyrus_cli_version": "x.y.z" }` or `null` if unavailable. ([CYPACK-731](https://linear.app/ceedar/issue/CYPACK-731), [#775](https://github.com/ceedaragents/cyrus/pull/775))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.15

#### cyrus-config-updater
- cyrus-config-updater@0.2.15

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.15

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.15

#### cyrus-core
- cyrus-core@0.2.15

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.15

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.15

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.15

#### cyrus-ai (CLI)
- cyrus-ai@0.2.15

## [0.2.14] - 2026-01-16

### Fixed
- **Cross-repository orchestration** - Fixed an issue where parent sessions could not be resumed when orchestrating sub-issues across different repositories. Child sessions now correctly locate and resume their parent sessions regardless of which repository they belong to. ([CYPACK-722](https://linear.app/ceedar/issue/CYPACK-722), [#768](https://github.com/ceedaragents/cyrus/pull/768))
- **Summary subroutines no longer show extended "Working" status** - During summarization phases (concise-summary, verbose-summary, question-answer, plan-summary, user-testing-summary, release-summary), the agent no longer makes tool calls that caused users to see an extended "Working" status in Linear. The agent now produces only text output during these phases. ([CYPACK-723](https://linear.app/ceedar/issue/CYPACK-723), [#764](https://github.com/ceedaragents/cyrus/pull/764))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.14

#### cyrus-config-updater
- cyrus-config-updater@0.2.14

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.14

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.14

#### cyrus-core
- cyrus-core@0.2.14

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.14

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.14

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.14

#### cyrus-ai (CLI)
- cyrus-ai@0.2.14

## [0.2.13] - 2026-01-15

### Added
- **Multi-repository orchestration routing context** - Orchestrator prompts now receive routing context when multiple repositories are configured in the same workspace. This enables orchestrators to intelligently route sub-issues to different repositories using description tags (`[repo=org/repo-name]`), routing labels, team keys, or project keys. ([CYPACK-711](https://linear.app/ceedar/issue/CYPACK-711), [#756](https://github.com/ceedaragents/cyrus/pull/756))

### Fixed
- **Usage limit errors now display as errors** - When hitting usage limits (rate_limit) or other SDK errors, the agent now creates an "error" type activity instead of a "thought" type, making error messages more visible to users in the Linear UI. ([CYPACK-719](https://linear.app/ceedar/issue/CYPACK-719), [#760](https://github.com/ceedaragents/cyrus/pull/760))

### Changed
- **Orchestrator label routing is now hardcoded** - Issues with 'orchestrator' or 'Orchestrator' labels now always route to the orchestrator procedure, regardless of EdgeConfig settings. This ensures consistent orchestrator behavior without requiring explicit configuration. ([CYPACK-715](https://linear.app/ceedar/issue/CYPACK-715), [#757](https://github.com/ceedaragents/cyrus/pull/757))
- **Updated dependencies** - Updated `@anthropic-ai/claude-agent-sdk` from 0.2.2 to 0.2.7 ([changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#027-2026-01-14)). This brings compatibility with Claude Code v2.1.7, which enables MCP tool search auto mode by default. When MCP tool descriptions exceed 10% of the context window, they are automatically deferred and discovered via the MCPSearch tool instead of being loaded upfront, reducing context usage for sessions with many MCP tools configured. ([CYPACK-716](https://linear.app/ceedar/issue/CYPACK-716), [#758](https://github.com/ceedaragents/cyrus/pull/758))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.13

#### cyrus-config-updater
- cyrus-config-updater@0.2.13

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.13

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.13

#### cyrus-core
- cyrus-core@0.2.13

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.13

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.13

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.13

#### cyrus-ai (CLI)
- cyrus-ai@0.2.13

## [0.2.12] - 2026-01-09

### Fixed
- **Case-insensitive label matching for orchestrator/debugger modes** - Label matching for orchestrator, debugger, builder, and scoper modes is now case-insensitive, matching the existing behavior of model selection. Labels like "Orchestrator" in Linear now correctly match config entries like `["orchestrator"]`. ([CYPACK-701](https://linear.app/ceedar/issue/CYPACK-701), [#746](https://github.com/ceedaragents/cyrus/pull/746))
- **Haiku model label support** - Fixed "haiku" as a supported model label for label-based model selection. Uses sonnet as fallback model for retry scenarios. ([CYPACK-701](https://linear.app/ceedar/issue/CYPACK-701), [#746](https://github.com/ceedaragents/cyrus/pull/746))

### Changed
- **Improved changelog handling** - Changelog updates now run as a separate subroutine before git operations, ensuring PR links can be included via amend. The `git-gh` subroutine has been split into `changelog-update`, `git-commit`, and `gh-pr` for better modularity. Non-changelog subroutines now explicitly avoid touching the changelog to prevent conflicts. ([CYPACK-670](https://linear.app/ceedar/issue/CYPACK-670), [#708](https://github.com/ceedaragents/cyrus/pull/708))
- **Updated dependencies** - Updated `@anthropic-ai/claude-agent-sdk` from 0.1.72 to 0.2.2 ([changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#020-2026-01-07)). Updated `zod` from 3.x to 4.3.5 to satisfy peer dependencies. Migrated from `zod-to-json-schema` to Zod v4's native `toJSONSchema()` method. ([CYPACK-700](https://linear.app/ceedar/issue/CYPACK-700), [#745](https://github.com/ceedaragents/cyrus/pull/745))

### Added
- **Worktree include support** - Add `.worktreeinclude` file support to automatically copy gitignored files (like `.env`, local configs) from the main repository to new worktrees. Files must be listed in both `.worktreeinclude` AND `.gitignore` to be copied. Supports glob patterns like `.env.*` and `**/.claude/settings.local.json`. ([CYPACK-690](https://linear.app/ceedar/issue/CYPACK-690), [#734](https://github.com/ceedaragents/cyrus/pull/734))
- **Screenshot upload guidance hooks** - Agents are now guided to use `linear_upload_file` when taking screenshots, ensuring screenshots are viewable in Linear comments instead of remaining as local files. Hooks added for `playwright_screenshot`, `mcp__claude-in-chrome__computer`, `mcp__claude-in-chrome__gif_creator`, and `mcp__chrome-devtools__take_screenshot`. ([CYPACK-699](https://linear.app/ceedar/issue/CYPACK-699), [#744](https://github.com/ceedaragents/cyrus/pull/744))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.12

#### cyrus-config-updater
- cyrus-config-updater@0.2.12

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.12

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.12

#### cyrus-core
- cyrus-core@0.2.12

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.12

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.12

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.12

#### cyrus-ai (CLI)
- cyrus-ai@0.2.12

## [0.2.11] - 2026-01-07

### Fixed
- **Repository tag routing now works with Linear's escaped brackets** - Fixed a bug where `[repo=...]` tags weren't recognized because Linear escapes square brackets in descriptions (e.g., `\[repo=cyrus\]`). The parser now handles both escaped and unescaped formats. ([CYPACK-688](https://linear.app/ceedar/issue/CYPACK-688), [#738](https://github.com/ceedaragents/cyrus/pull/738))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.11

#### cyrus-config-updater
- cyrus-config-updater@0.2.11

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.11

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.11

#### cyrus-core
- cyrus-core@0.2.11

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.11

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.11

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.11

#### cyrus-ai (CLI)
- cyrus-ai@0.2.11

## [0.2.10] - 2026-01-06

### Added
- **Repository tag routing** - You can now specify which repository an issue should be routed to by adding a `[repo=...]` tag in the issue description. Supports `[repo=org/repo-name]` to match GitHub URLs, `[repo=repo-name]` to match by name, or `[repo=repo-id]` to match by ID. This takes precedence over label, project, and team-based routing. ([CYPACK-688](https://linear.app/ceedar/issue/CYPACK-688), [#732](https://github.com/ceedaragents/cyrus/pull/732))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.10

#### cyrus-config-updater
- cyrus-config-updater@0.2.10

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.10

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.10

#### cyrus-core
- cyrus-core@0.2.10

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.10

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.10

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.10

#### cyrus-ai (CLI)
- cyrus-ai@0.2.10

## [0.2.9] - 2025-12-30

### Added
- **Repository tag routing** - You can now specify which repository an issue should be routed to by adding a `[repo=...]` tag in the issue description. Supports `[repo=org/repo-name]` to match GitHub URLs, `[repo=repo-name]` to match by name, or `[repo=repo-id]` to match by ID. This takes precedence over label, project, and team-based routing. ([CYPACK-688](https://linear.app/ceedar/issue/CYPACK-688), [#732](https://github.com/ceedaragents/cyrus/pull/732))
- **GPT Image 1.5 support** - The image-tools MCP server now supports `gpt-image-1.5`, OpenAI's latest and highest quality image generation model. You can choose between `gpt-image-1.5` (default, best quality), `gpt-image-1`, or `gpt-image-1-mini` (faster, lower cost). ([CYPACK-675](https://linear.app/ceedar/issue/CYPACK-675), [#717](https://github.com/ceedaragents/cyrus/pull/717))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.9

#### cyrus-config-updater
- cyrus-config-updater@0.2.9

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.9

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.9

#### cyrus-core
- cyrus-core@0.2.9

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.9

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.9

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.9

#### cyrus-ai (CLI)
- cyrus-ai@0.2.9

## [0.2.8] - 2025-12-28

### Added
- **Release procedure** - Added a new `release` procedure with two subroutines for executing software releases. When an issue is classified as a release request, Cyrus will: (1) check for a release skill in the project, (2) check CLAUDE.md or README.md for release instructions, or (3) ask the user via AskUserQuestion how to perform the release. This enables Cyrus to handle release workflows for any project type. ([CYPACK-668](https://linear.app/ceedar/issue/CYPACK-668), [#706](https://github.com/ceedaragents/cyrus/pull/706))
- **Self-hosting OAuth commands** - New CLI commands for self-hosted deployments: `cyrus self-auth` performs direct Linear OAuth authorization without a proxy, and `cyrus self-add-repo` clones repositories and adds them to config with inherited workspace credentials. Both commands support the `--cyrus-home` flag for custom configuration directories. See the [Self-Hosting Guide](./docs/SELF_HOSTING.md) for setup instructions. Based on the [original OAuth implementation](https://github.com/grandmore/cyrus-self-hosting/pull/1) contributed by Stuart and the Grandmore team. ([CYPACK-669](https://linear.app/ceedar/issue/CYPACK-669), [#707](https://github.com/ceedaragents/cyrus/pull/707))

### Changed
- **Documentation restructured** - Moved self-hosting documentation from `selfhosting/` folder to `docs/` with separate files: `SELF_HOSTING.md` (main guide), `CONFIG_FILE.md` (configuration reference), and `CLOUDFLARE_TUNNEL.md` (optional tunnel setup). Main README now links to these docs. ([CYPACK-669](https://linear.app/ceedar/issue/CYPACK-669), [#707](https://github.com/ceedaragents/cyrus/pull/707))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.8

#### cyrus-config-updater
- cyrus-config-updater@0.2.8

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.8

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.8

#### cyrus-core
- cyrus-core@0.2.8

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.8

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.8

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.8

#### cyrus-ai (CLI)
- cyrus-ai@0.2.8

## [0.2.7] - 2025-12-28

### Fixed
- **AskUserQuestion UI cleanup** - The AskUserQuestion tool no longer appears as raw JSON in Linear's activity stream. Since the tool is custom-handled via Linear's select signal elicitation, the tool call and result are now suppressed from the activity UI for a cleaner experience. ([CYPACK-654](https://linear.app/ceedar/issue/CYPACK-654), [#698](https://github.com/ceedaragents/cyrus/pull/698))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.7

#### cyrus-config-updater
- cyrus-config-updater@0.2.7

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.7

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.7

#### cyrus-core
- cyrus-core@0.2.7

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.7

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.7

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.7

#### cyrus-ai (CLI)
- cyrus-ai@0.2.7

## [0.2.6] - 2025-12-22

### Changed
- **Default model upgraded to Opus** - Cyrus now uses Claude Opus as the default model with Sonnet as fallback (previously Sonnet with Haiku fallback). This provides higher quality responses for all tasks. ([CYPACK-613](https://linear.app/ceedar/issue/CYPACK-613))
- Updated `@anthropic-ai/claude-agent-sdk` from v0.1.69 to v0.1.72 to maintain parity with Claude Code v2.0.72. This update includes fixed `/context` command behavior to respect custom system prompts, improved non-streaming performance for single-turn queries, and renamed V2 session API method from `receive()` to `stream()`. See the [Claude Agent SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#0172) for full details. ([CYPACK-618](https://linear.app/ceedar/issue/CYPACK-618))

### Added
- **Interactive clarification via AskUserQuestion** - Cyrus can now ask you clarifying questions during task execution using Linear's select signal. When Claude needs to make a decision with multiple valid options (e.g., which sorting algorithm, which library to use), it will present the options in Linear and wait for your selection before proceeding. This enables more interactive and accurate task completion. ([CYPACK-654](https://linear.app/ceedar/issue/CYPACK-654), [#691](https://github.com/ceedaragents/cyrus/pull/691))
- **Custom Skills support** - Cyrus now supports Claude Skills, allowing you to extend Cyrus with your own packaged capabilities. Create `SKILL.md` files in your project's `.claude/skills/` directory or personal `~/.claude/skills/` directory, and Cyrus will automatically discover and use them when relevant. See the [Skills documentation](https://code.claude.com/docs/en/skills) for details on creating Skills. ([CYPACK-655](https://linear.app/ceedar/issue/CYPACK-655), [#690](https://github.com/ceedaragents/cyrus/pull/690))
- **Acceptance criteria validation** - The verifications subroutine now fetches the Linear issue and validates the implementation against all acceptance criteria. Failing to meet acceptance criteria counts as a failed verification, ensuring requirements are fully satisfied before proceeding to commit and PR creation. ([CYPACK-649](https://linear.app/ceedar/issue/CYPACK-649), [#687](https://github.com/ceedaragents/cyrus/pull/687))
- **Validation loop with retry logic** - When verifications fail during the full-development procedure, Cyrus now automatically runs a fixer subroutine to address issues, then re-runs verification up to 4 times. Uses structured outputs with Zod schema validation for reliable pass/fail detection, with fallback parsing for Gemini compatibility. ([CYPACK-620](https://linear.app/ceedar/issue/CYPACK-620), [#666](https://github.com/ceedaragents/cyrus/pull/666))
- **Claude in Chrome integration** - EdgeWorker now enables Chrome browser automation via the Claude Agent SDK's `--chrome` flag, providing access to browser automation tools (screenshot recording, console reading, JavaScript execution, tab management) for main Cyrus sessions. Simple agent runners explicitly disable this integration to keep lightweight queries fast. ([CYPACK-618](https://linear.app/ceedar/issue/CYPACK-618))
- **Process status endpoint** - Added `GET /status` endpoint that returns `{"status": "idle"}` or `{"status": "busy"}` to safely determine when Cyrus can be restarted without interrupting active work. ([CYPACK-576](https://linear.app/ceedar/issue/CYPACK-576), [#632](https://github.com/ceedaragents/cyrus/pull/632))
- **Version logging on startup** - Cyrus now displays the running version when the edge worker starts, making it easier to verify which version is deployed. ([CYPACK-585](https://linear.app/ceedar/issue/CYPACK-585))
- Added CLI platform mode support to enable in-memory issue tracking for testing and development ([CYPACK-509](https://linear.app/ceedar/issue/CYPACK-509))
- **User testing procedure** - New "user-testing" procedure for interactive, user-driven testing sessions. When you explicitly request manual testing (e.g., "test this for me", "run user testing"), Cyrus will execute tests based on your instructions and provide a comprehensive summary of results and findings. ([CYPACK-542](https://linear.app/ceedar/issue/CYPACK-542))
- **Graphite workflow support** - Cyrus now integrates with Graphite CLI for stacked PR workflows. Apply a "graphite" label to any issue to enable Graphite-aware behavior: sub-issues automatically branch from their blocking issue's branch (based on Linear's "blocked by" relationships) instead of main, and PRs are created using `gt submit`. For orchestrating complex multi-part features, apply both "graphite" and "orchestrator" labels - the orchestrator will create dependent sub-issues with proper blocking relationships that automatically stack in Graphite's dashboard. ([CYPACK-466](https://linear.app/ceedar/issue/CYPACK-466), [#577](https://github.com/ceedaragents/cyrus/pull/577))
- **Linear agent sessions MCP tools** - Added `linear_get_agent_sessions` and `linear_get_agent_session` tools to cyrus-tools MCP server for retrieving agent session information from Linear. The tools support pagination, filtering, and provide comprehensive session details including timestamps, associated issues, and related entities. ([CYPACK-549](https://linear.app/ceedar/issue/CYPACK-549), [#625](https://github.com/ceedaragents/cyrus/pull/625))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.6

#### cyrus-config-updater
- cyrus-config-updater@0.2.6

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.6

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.6

#### cyrus-core
- cyrus-core@0.2.6

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.6

#### cyrus-gemini-runner
- cyrus-gemini-runner@0.2.6

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.6

#### cyrus-ai (CLI)
- cyrus-ai@0.2.6

## [0.2.5] - 2025-12-03

### Fixed
- Fixed Zod peer dependency mismatch in claude-runner that caused `mcp__cyrus-tools__linear_agent_session_create` MCP tools to fail with `keyValidator._parse is not a function` error. Downgraded claude-runner's Zod dependency from v4.1.12 to v3.24.1 to match the Claude Agent SDK's peer dependency requirement ([CYPACK-478](https://linear.app/ceedar/issue/CYPACK-478), [#581](https://github.com/ceedaragents/cyrus/pull/581))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.5

#### cyrus-config-updater
- cyrus-config-updater@0.2.5

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.5

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.5

#### cyrus-core
- cyrus-core@0.2.5

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.5

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.5

#### cyrus-ai (CLI)
- cyrus-ai@0.2.5

## [0.2.4] - 2025-11-25

### Added
- **Google Gemini AI support** - Cyrus now supports Google's Gemini models alongside Claude. Choose which AI processes your issues by adding labels to Linear issues: use `gemini`, `gemini-2.5-pro`, `gemini-2.5-flash`, or `gemini-3-pro` for Gemini models, or `claude`, `sonnet`, or `opus` for Claude models. If no AI label is present, Cyrus defaults to Claude. This gives you flexibility to select the best AI for each task.

### Fixed
- Fixed race condition in subroutine transitions where new subroutines could start before the previous runner fully cleaned up, which could cause issues with session state management

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.4

#### cyrus-config-updater
- cyrus-config-updater@0.2.4

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.4

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.4

#### cyrus-core
- cyrus-core@0.2.4

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.4

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.4

#### cyrus-ai (CLI)
- cyrus-ai@0.2.4

## [0.2.3] - 2025-11-24

### Added
- **Claude Opus 4.5 support** - Cyrus now has access to [Claude Opus 4.5](https://www.anthropic.com/claude/opus), Anthropic's most intelligent model with breakthrough capabilities in complex reasoning, advanced coding, and nuanced content creation. Experience significantly improved code generation, deeper analysis, and more sophisticated problem-solving across all Cyrus workflows.

### Changed
- Updated @anthropic-ai/claude-agent-sdk from v0.1.42 to v0.1.52 - includes support for Claude Opus 4.5 and latest agent capabilities. See [@anthropic-ai/claude-agent-sdk v0.1.52 changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#0152) ([CYPACK-427](https://linear.app/ceedar/issue/CYPACK-427), [#558](https://github.com/ceedaragents/cyrus/pull/558))
- Updated @anthropic-ai/sdk from v0.69.0 to v0.71.0 - adds Claude Opus 4.5 model support with enhanced performance and capabilities. See [@anthropic-ai/sdk v0.71.0 changelog](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md#0710-2025-11-22) ([CYPACK-427](https://linear.app/ceedar/issue/CYPACK-427), [#558](https://github.com/ceedaragents/cyrus/pull/558))

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.3

#### cyrus-config-updater
- cyrus-config-updater@0.2.3

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.3

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.3

#### cyrus-core
- cyrus-core@0.2.3

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.3

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.3

#### cyrus-ai (CLI)
- cyrus-ai@0.2.3

## [0.2.2] - 2025-11-19

### Changed
- Improved Linear agent-session tool formatting with custom formatters for better readability: Bash tool descriptions now appear in the action field with round brackets, Edit tool results display as unified diffs, and specialized parameter/result formatters for common tools (Read, Write, Grep, Glob, etc.) extract meaningful information instead of showing raw JSON (CYPACK-395, https://github.com/ceedaragents/cyrus/pull/512)

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.2

#### cyrus-config-updater
- cyrus-config-updater@0.2.2

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.2

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.2

#### cyrus-core
- cyrus-core@0.2.2

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.2

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.2

#### cyrus-ai (CLI)
- cyrus-ai@0.2.2

## [0.2.1] - 2025-11-15

### Added
- When no routing option matches, it will prompt the user to select which repo they'd like to run Cyrus on for the Linear Issue. Repository selection now displays GitHub repository icons and formatted names when configured with a GitHub URL in the config file. The selected repository will be shown to the user, including what method was used to select it (label-based, team key based, project based, user-selected, etc)
- Restored `--env-file` option to specify custom environment variables file location (uses Commander library for CLI parsing)

### Changed
- Updated @anthropic-ai/claude-agent-sdk from v0.1.31 to v0.1.42 - see [@anthropic-ai/claude-agent-sdk v0.1.42 changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#0142)
- Updated @anthropic-ai/sdk from v0.68.0 to v0.69.0 - adds support for structured outputs beta - see [@anthropic-ai/sdk v0.69.0 changelog](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md#0690-2025-11-14)

### Fixed
- Fixed Linear profile URLs in summary subroutines to use correct workspace slug instead of hardcoded "linear" workspace

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.1

#### cyrus-config-updater
- cyrus-config-updater@0.2.1

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.1

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.1

#### cyrus-core
- cyrus-core@0.2.1

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.1

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.1

#### cyrus-ai (CLI)
- cyrus-ai@0.2.1

## [0.2.0] - 2025-11-07

### Added
- **Cloudflare Tunnel Transport Client**: New `cyrus-cloudflare-tunnel-client` package for receiving configuration updates and webhooks from cyrus-hosted
  - Uses Cloudflare tunnels via `cloudflared` npm package for secure communication
  - Validates customer subscriptions with cyrus-hosted API
  - Handles configuration updates (repositories, environment variables, MCP servers)
  - Receives Linear webhook payloads forwarded through cyrus-hosted
  - Repository management (automatically clones/verifies repositories to `~/.cyrus/repos/<repo-name>`)
  - All file operations restricted to `~/.cyrus` directory for security
  - Will replace `ndjson-client` for customers using cyrus-hosted service
- **Setup Waiting Mode**: After running `cyrus auth`, the client now enters a waiting state to receive configuration from the server
  - Automatically starts server infrastructure (SharedApplicationServer, ConfigUpdater) without repositories
  - Displays clear waiting status and instructions to complete setup
  - Auto-transitions to normal operation when server pushes repository configuration
  - Watches config.json for changes and starts EdgeWorker when repositories are added

### Fixed
- Cyrus client now stays running when all repositories are removed after onboarding, allowing it to receive new configuration from app.atcyrus.com
- Orchestrator label now enforces orchestrator procedure consistently - issues with the Orchestrator label always use the orchestrator-full procedure, even when receiving results from child sub-agents or processing new messages
- Suppressed unnecessary error logs when stopping Claude sessions
- Repository deletion now works correctly when triggered from the web UI
- Added missing `routingLabels` and `projectKeys` fields to `CyrusConfigPayload` type in config-updater package
- Config handler now properly processes and saves label routing and project routing parameters when received from cyrus-hosted
- Fixed missing `dist/` directory in published packages by adding `"files": ["dist"]` to `cloudflare-tunnel-client` and `config-updater` package.json files
- All packages now include their compiled TypeScript output when installed from npm

### Changed
- **Linear Event Transport**: Refactored `cyrus-linear-webhook-client` to `cyrus-linear-event-transport` for simplified webhook handling
  - Package now directly registers /webhook endpoint with Fastify server
  - Supports dual verification modes: direct Linear webhooks (LINEAR_DIRECT_WEBHOOKS) and proxy authentication
  - Removed complex transport abstractions (WebhookTransport, BaseTransport) in favor of direct route registration
  - Routes registered after server startup for improved initialization flow
- **Simplified CLI startup**: Removed legacy onboarding flows and subscription validation
  - Cloudflare tunnel now starts automatically when CLOUDFLARE_TOKEN is present
  - Removed Pro plan prompts and customer validation code
  - Removed `billing` and `set-customer-id` commands
  - Streamlined `auth` command to focus on authentication only
  - All tunnel management now handled by SharedApplicationServer
- Updated @anthropic-ai/claude-agent-sdk from v0.1.28 to v0.1.31 - see [@anthropic-ai/claude-agent-sdk v0.1.31 changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#0131)
- Updated @anthropic-ai/sdk from v0.67.0 to v0.68.0 - see [@anthropic-ai/sdk v0.68.0 changelog](https://github.com/anthropics/anthropic-sdk-typescript/compare/sdk-v0.67.0...sdk-v0.68.0)

### Removed
- **Subscription service**: Removed customer validation and subscription checking code
- **Billing commands**: Removed `billing` and `set-customer-id` CLI commands
- **Deprecated config parameter**: Removed `isLegacy` from EdgeConfig (replaced by setup waiting mode)

### Packages

#### cyrus-cloudflare-tunnel-client
- cyrus-cloudflare-tunnel-client@0.2.0

#### cyrus-config-updater
- cyrus-config-updater@0.2.0

#### cyrus-linear-event-transport
- cyrus-linear-event-transport@0.2.0

#### cyrus-claude-runner
- cyrus-claude-runner@0.2.0

#### cyrus-core
- cyrus-core@0.2.0

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.2.0

#### cyrus-edge-worker
- cyrus-edge-worker@0.2.0

#### cyrus-ai (CLI)
- cyrus-ai@0.2.0

## [0.1.60] - 2025-11-03

### Fixed
- Orchestrator label now enforces orchestrator procedure consistently - issues with the Orchestrator label always use the orchestrator-full procedure, even when receiving results from child sub-agents or processing new messages
- Suppressed unnecessary error logs when stopping Claude sessions

### Changed
- Updated @anthropic-ai/claude-agent-sdk from v0.1.28 to v0.1.31
- Updated @anthropic-ai/sdk from v0.67.0 to v0.68.0 - see [@anthropic-ai/sdk v0.68.0 changelog](https://github.com/anthropics/anthropic-sdk-typescript/compare/sdk-v0.67.0...sdk-v0.68.0)

### Packages

#### cyrus-core
- cyrus-core@0.0.21

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.32

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.41

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.25

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.0.4

#### cyrus-ai (CLI)
- cyrus-ai@0.1.60

## [0.1.59] - 2025-10-31

### Fixed
- Skip loading 'primary' subroutine prompt to eliminate ENOENT error in logs - the "primary" promptPath is a placeholder with no corresponding file

### Packages

#### cyrus-core
- cyrus-core@0.0.20

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.40

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.0.3

#### cyrus-ai (CLI)
- cyrus-ai@0.1.59

## [0.1.58] - 2025-10-29

### Added
- Orchestrator and sub-issue communication is now visible in Linear activity: feedback from orchestrator to sub-issues and results from sub-issues to orchestrator are posted as thoughts with clear context

### Fixed
- Procedure routing is now reset when resuming parent sessions from child completion, preventing excessive thought and action suppression logs
- Fixed bug where initial subroutine prompts were not applied to comment-triggered new sessions (only worked for assignment-based sessions)
- Improved routing classification to correctly identify test-related requests (e.g., "add unit tests", "fix failing tests") as code work instead of planning tasks

### Changed
- Debugger workflow now proceeds directly from bug reproduction to fix implementation without requiring manual approval
- All workflows (full-development, debugger-full, orchestrator-full) now end with concise summary instead of verbose summary
- Non-summary subroutines (debugger-fix, debugger-reproduction, verifications, git-gh) now explicitly avoid posting Linear comments and end with brief 1-sentence completion messages
- Orchestrator agents are now strongly discouraged from posting Linear comments to current issues; comments only used when triggering sub-agent sessions on child issues
- Orchestrator agents are explicitly instructed not to assign themselves (Cyrus) as a delegate when creating sub-issues
- Tool call result outputs are no longer wrapped in collapsible sections in Linear comments
- Concise summary format now uses collapsible sections for "Changes Made" and "Files Modified" to keep summaries brief
- Simple-question workflow now has two phases: investigation (gather information without answering) and answer formatting (provide markdown-formatted response)
- Initial subroutine prompts are now consistently loaded for all new sessions (assignment-based and comment-based), ensuring agents receive proper workflow guidance from the start
- Full-development workflow now starts with dedicated coding-activity subroutine (implementation and testing only, no git/gh operations)

### Packages

#### cyrus-core
- cyrus-core@0.0.20

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.40

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.0.3

#### cyrus-ai (CLI)
- cyrus-ai@0.1.58

## [0.1.57] - 2025-10-12

### Fixed
- Fixed missing `cyrus-simple-agent-runner` package publication that broke installation of cyrus-ai@0.1.56

### Packages

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.0.2

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.39

#### cyrus-ai (CLI)
- cyrus-ai@0.1.57

## [0.1.56] - 2025-10-12

### Added
- **Intelligent procedure routing**: Cyrus now automatically selects the best workflow for each task by analyzing the request content. Simple questions get quick answers, documentation edits proceed directly to implementation, and code changes get the full workflow with verifications and git operations. Uses fast "haiku" model for 10-second classification.
- **Modular subroutine system**: Workflows are composed of reusable subroutines (verifications, git-gh, concise-summary, verbose-summary) that can be mixed and matched based on the procedure selected.
- **Environment variable support in MCP configs**: MCP configuration files can now reference environment variables from repository `.env` files using `${VAR}` and `${VAR:-default}` syntax, making it easier to manage API tokens and other sensitive configuration values
- **Sora 2 video generation support**: Added custom MCP tools for OpenAI Sora 2 video generation with three tools: `mcp__sora-tools__sora_generate_video` to start video generation (supports text-to-video and image-to-video via `input_reference` parameter; reference images must match target video resolution and be in JPEG, PNG, or WebP format only), `mcp__sora-tools__sora_check_status` to poll job status, and `mcp__sora-tools__sora_get_video` to download completed videos
- **Simple agent runner package**: Added new `cyrus-simple-agent-runner` package for constrained agent queries that return one of a predefined set of responses (e.g., "yes", "no"). Features type-safe enumerated responses, comprehensive error handling, and progress tracking.
- **Image generation support**: Added GPT Image tools using OpenAI's Responses API with background mode. Two tools provide async image generation: `mcp__image-tools__gpt_image_generate` starts async image generation and returns a job ID, and `mcp__image-tools__gpt_image_get` checks status and downloads the image if ready (returns "not ready" if incomplete - agents can call again). Supports customizable size (1024x1024, 1536x1024, 1024x1536, auto), quality (low/medium/high/auto), background transparency, and output formats (PNG/JPEG/WebP). Uses gpt-5 model for tool invocation.

### Changed
- Updated @anthropic-ai/claude-agent-sdk from v0.1.13 to v0.1.14 - includes parity updates with Claude Code v2.0.14. See [@anthropic-ai/claude-agent-sdk v0.1.14 changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#0114)
- **Breaking: OpenAI configuration naming**: Renamed repository config fields from `soraApiKey`/`soraOutputDirectory` to `openaiApiKey`/`openaiOutputDirectory` to reflect support for multiple OpenAI services (Sora and GPT Image). Update your repository config to use the new field names.

### Packages

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.31

#### cyrus-core
- cyrus-core@0.0.19

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.38

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.24

#### cyrus-simple-agent-runner
- cyrus-simple-agent-runner@0.0.2

#### cyrus-ai (CLI)
- cyrus-ai@0.1.56

## [0.1.55] - 2025-10-09

### Added
- **Dynamic configuration updates**: Cyrus now automatically detects and applies changes to `~/.cyrus/config.json` without requiring a restart
  - Add or remove repositories on the fly while Cyrus continues running
  - Removed repositories stop all active sessions and post notification messages to Linear
  - Webhook connections automatically reconnect when tokens are updated
  - File watcher uses debouncing to handle rapid configuration changes smoothly

### Changed
- **Upgraded to official Linear MCP server**: Replaced the unofficial `@tacticlaunch/mcp-linear` stdio-based server with Linear's official HTTP-based MCP server (`https://mcp.linear.app/mcp`). This provides better stability and access to the latest Linear API features.
- Updated @anthropic-ai/claude-agent-sdk from v0.1.10 to v0.1.11 - includes parity updates with Claude Code v2.0.11. See [@anthropic-ai/claude-agent-sdk v0.1.11 changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#0111---2025-01-09)

### Packages

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.30

#### cyrus-core
- cyrus-core@0.0.18

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.37

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.23

#### cyrus-ai (CLI)
- cyrus-ai@0.1.55

## [0.1.54] - 2025-10-04

### Added
- **Automatic MCP config detection**: Cyrus now automatically detects and loads `.mcp.json` files in the repository root. The `.mcp.json` serves as a base configuration that can be extended by explicit `mcpConfigPath` settings, allowing for composable MCP server configurations.

### Fixed
- **Custom instructions now work correctly**: Fixed critical bug where `appendSystemPrompt` was being silently ignored, causing Cyrus to not follow custom instructions or agent guidance. The feature has been fixed to use the correct SDK API (`systemPrompt.append`), making custom prompts and Linear agent guidance work as intended.

### Packages

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.29

#### cyrus-core
- cyrus-core@0.0.17

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.36

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.22

#### cyrus-ai (CLI)
- cyrus-ai@0.1.54

## [0.1.53] - 2025-10-04

### Added
- **Agent guidance injection**: Cyrus now automatically receives and includes both workspace-level and team-specific agent guidance from Linear in all prompts. When both types of guidance are configured, both are included in the prompt, with team-specific guidance taking precedence as specified by Linear's guidance system.

### Changed
- Updated @linear/sdk from v58.1.0 to v60.0.0 to support agent guidance feature

### Packages

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.28

#### cyrus-core
- cyrus-core@0.0.16

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.35

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.21

#### cyrus-ai (CLI)
- cyrus-ai@0.1.53

## [0.1.52] - 2025-10-04

### Changed
- Version bump for all packages to ensure proper dependency resolution

### Packages

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.27

#### cyrus-core
- cyrus-core@0.0.15

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.34

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.20

#### cyrus-ai (CLI)
- cyrus-ai@0.1.52

## [0.1.51] - 2025-10-04

### Fixed
- **Restored file-based settings loading**: Fixed regression from claude-agent-sdk update where CLAUDE.md files, settings files, and custom slash commands were not being loaded
  - Added explicit `settingSources: ["user", "project", "local"]` configuration to ClaudeRunner
  - This restores backwards compatibility with existing user configurations
  - See [Claude Code SDK Migration Guide](https://docs.claude.com/en/docs/claude-code/sdk/migration-guide#settings-sources-no-longer-loaded-by-default)

### Changed
- **Default model changed from opus to sonnet 4.5**: The default Claude model is now `sonnet` instead of `opus`
  - Fallback model changed from `sonnet` to `haiku`
  - Label-based model selection still available - users can add `opus`, `sonnet`, or `haiku` labels to issues to override the default
  - Affects all new sessions that don't explicitly specify a model in config
- Updated @anthropic-ai/claude-agent-sdk from v0.1.0 to v0.1.5 for latest Claude Agent SDK improvements
- Updated @anthropic-ai/sdk from v0.64.0 to v0.65.0 for latest Anthropic SDK improvements
  - Added support for Claude Sonnet 4.5 and context management features
  - See [@anthropic-ai/sdk v0.65.0 changelog](https://github.com/anthropics/anthropic-sdk-typescript/compare/sdk-v0.64.0...sdk-v0.65.0)

### Packages

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.26

#### cyrus-core
- cyrus-core@0.0.14

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.33

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.19

#### cyrus-ai (CLI)
- cyrus-ai@0.1.51

## [0.1.50] - 2025-09-30

### Added
- **Global setup script support**: Added `global_setup_script` optional field in config.json
  - Runs before repository-specific `cyrus-setup.sh` when creating git worktrees
  - Supports ~ expansion for home directory paths
  - Same environment variables passed to both global and repository scripts (LINEAR_ISSUE_ID, LINEAR_ISSUE_IDENTIFIER, LINEAR_ISSUE_TITLE)
  - 5-minute timeout to prevent hanging scripts
  - Comprehensive error handling and logging for both global and repository scripts
  - Script failures don't prevent worktree creation
  - Cross-platform support (bash, PowerShell, cmd, bat)

- **Ephemeral agent activities for tool calls**: Standard tool calls now post ephemeral activities to Linear
  - Tool calls (except Task and TodoWrite) create ephemeral activities that disappear when replaced
  - Tool responses create non-ephemeral activities showing original tool name and input
  - Tool outputs are wrapped in `+++Tool Output` collapsible blocks (collapsed by default)
  - Tool errors display as "{ToolName} (Error)" for better clarity
  - Subtasks maintain arrow emoji (↪) prefix for visual hierarchy
  - TodoWrite tool results are skipped to prevent duplicate activities
  - Reduces visual clutter in Linear while preserving important information

### Changed
- **Linear SDK upgraded to v58.1.0**: Updated across all packages to support ephemeral agent activity field
  - Added `ephemeral: boolean` support for agent activities
  - Maintained backward compatibility with existing non-ephemeral activities

### Packages

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.26

#### cyrus-core
- cyrus-core@0.0.14

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.33

#### cyrus-linear-webhook-client
- cyrus-linear-webhook-client@0.0.3

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.19

## [0.1.49] - 2025-09-29

### Changed
- **Migrated from Claude Code SDK to Claude Agent SDK**: Replaced `@anthropic-ai/claude-code` v1.0.128 with `@anthropic-ai/claude-agent-sdk` v0.1.0
  - Updated all imports and type references to use the new package name
  - Handled breaking change: SDK no longer uses Claude Code's system prompt by default - now explicitly requests Claude Code preset to maintain backward compatibility
  - No changes needed for settings sources as the codebase doesn't rely on automatic settings file loading
- Updated @anthropic-ai/sdk from v0.62.0 to v0.64.0 for latest Anthropic SDK improvements

### Packages

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.25

#### cyrus-core
- cyrus-core@0.0.13

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.32

#### cyrus-ai (CLI)
- cyrus-ai@0.1.49

## [0.1.48] - 2025-01-11

### Added
- **Direct OAuth authorization support**: The CLI can now handle OAuth authorization directly when `LINEAR_DIRECT_WEBHOOKS=true`
  - New `/oauth/authorize` endpoint in SharedApplicationServer for self-hosted OAuth flow
  - Automatic OAuth code exchange when using direct webhooks mode
  - Support for custom Linear OAuth applications via `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET` environment variables
  - Maintains backward compatibility with proxy-based OAuth for standard deployments

### Packages

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.31

#### cyrus-ai (CLI)
- cyrus-ai@0.1.48

## [0.1.47] - 2025-01-09

### Fixed
- Fixed webhook signature verification for LinearWebhookClient
  - Corrected signature verification to properly handle webhook payloads
  - Ensures webhook authenticity when using direct webhook forwarding mode
  - Resolves security validation issues in direct webhook configurations

### Packages

#### cyrus-linear-webhook-client
- cyrus-linear-webhook-client@0.0.2

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.30

#### cyrus-ai (CLI)
- cyrus-ai@0.1.47

## [0.1.46] - 2025-01-09

### Added
- **Dynamic webhook client selection**: Support for choosing between proxy-based and direct webhook forwarding
  - New environment variable `LINEAR_DIRECT_WEBHOOKS` to control webhook client selection
  - When `LINEAR_DIRECT_WEBHOOKS=true`, uses new `linear-webhook-client` package for direct webhook forwarding
  - When unset or `false`, uses existing `ndjson-client` for proxy-based webhook handling
  - Maintains full backward compatibility with existing deployments
- **Sub-issue assignee inheritance with workspace context**: Sub-issues created by orchestrator agents now automatically inherit the same assignee as their parent issue, with complete workspace awareness
  - Enhanced label-prompt-template to include assignee information (`{{assignee_id}}` and `{{assignee_name}}`)
  - Added workspace teams context (`{{workspace_teams}}`) with team names, keys, IDs, and descriptions
  - Added workspace labels context (`{{workspace_labels}}`) with label names, IDs, and descriptions  
  - Updated orchestrator prompt instructions to require `assigneeId` parameter in sub-issue creation
  - Modified EdgeWorker to fetch and inject Linear workspace data (teams, labels, assignee) into orchestrator context
- **Mandatory verification framework for orchestrator agents**: Enhanced parent-child delegation with executable verification requirements
  - Parent orchestrators can now access child agent worktrees for independent verification
  - **Orchestrator prompt v2.2.0** with mandatory verification requirements in sub-issue descriptions
  - Child agents must provide detailed verification instructions (commands, expected outcomes, visual evidence)
  - Parents gain filesystem permissions to child worktrees during verification process
  - No more "verification theater" - actual executable validation required before merging child work
- **@cyrus /label-based-prompt command**: New special command for mention-triggered sessions
  - Use `@cyrus /label-based-prompt` in comments to trigger label-based prompts instead of mention prompts
  - Automatically determines and includes appropriate system prompts based on issue labels
  - Maintains full backwards compatibility with regular `@cyrus` mentions
  - Logged as "label-based-prompt-command" workflow type for easy identification
- **Tool restriction configuration**: New `disallowedTools` configuration option to explicitly block specific tools
  - Can be configured at global, repository, prompt type, and label-specific levels
  - Follows same hierarchy as `allowedTools` (label > prompt defaults > repository > global)
  - No default disallowed tools - only explicitly configured tools are blocked
  - Environment variable support: `DISALLOWED_TOOLS` for global defaults
  - Passed through to Claude Code via `disallowedTools` option
- **New Linear MCP tool**: `linear_agent_session_create_on_comment` for creating agent sessions on root comments
  - Enables orchestrator agents to trigger sub-agents on existing issue comment threads
  - Must be used with root comments only (not replies) due to Linear API constraints
  - Maintains parent-child session mapping for proper feedback routing

### Changed
- Updated @anthropic-ai/claude-code from v1.0.90 to v1.0.95 for latest Claude Code improvements. See [Claude Code v1.0.95 changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#1095)
- Replaced external cyrus-mcp-tools MCP server with inline tools using SDK callbacks for better performance
- Cyrus tools (file upload, agent session creation, feedback) now run in-process instead of via separate MCP server
- Enhanced orchestrator prompt to explicitly require reading/viewing all screenshots taken for visual verification

### Removed
- Removed cyrus-mcp-tools package in favor of inline tool implementation

## [0.1.45] - 2025-08-28

### Added
- New `cyrus-mcp-tools` package providing MCP tools for Linear integration
  - File upload capability: Upload files to Linear and get asset URLs for use in issues and comments
  - Agent session creation: Create AI/bot tracking sessions on Linear issues
  - **Give feedback tool: Allows parent sessions to send feedback to child sessions**
  - Automatically available in all Cyrus sessions without additional configuration
- PostToolUse hook integration for tracking parent-child agent session relationships
  - Automatically captures child agent session IDs when linear_agent_session_create tool is used
  - **Triggers child session resumption when linear_agent_give_feedback tool is used**
  - Maintains mapping of child sessions to parent sessions for hierarchical tracking
  - **Persistent storage of child-to-parent mappings across restarts**
  - Child session results are automatically forwarded to parent sessions upon completion
- New "orchestrator" label system prompt type
  - Joins existing "builder", "debugger", and "scoper" labels as a default option
  - Configured with read-only tools (cannot directly edit files)
  - Specializes in coordination and oversight of complex development tasks
  - Automatically triggered by "Orchestrator" label on Linear issues
- **Label-based Claude model selection**: You can now override the Claude model used for specific issues by adding labels
  - Add "opus", "sonnet", or "haiku" label to any Linear issue to force that model
  - Model labels take highest priority (overrides both repository and global settings)
  - Case-insensitive label matching for flexibility
  - Automatically sets appropriate fallback models (opus→sonnet, sonnet→haiku, haiku→haiku)

### Changed
- Updated @anthropic-ai/claude-code from v1.0.88 to v1.0.89 for latest Claude Code improvements. See [Claude Code v1.0.89 changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#1089)
- Upgraded @linear/sdk from v38/v55 to v58.0.0 across all packages for latest Linear API features
- Enhanced ClaudeRunner and EdgeWorker to support Claude Code SDK hooks for tool interception

### Packages

#### cyrus-mcp-tools
- cyrus-mcp-tools@0.3.0 - Already published (not part of this release)

#### cyrus-core
- cyrus-core@0.0.11

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.23

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.28

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.17

#### cyrus-ai (CLI)
- cyrus-ai@0.1.45

## [0.1.44] - 2025-08-19

### Changed
- Updated @anthropic-ai/claude-code dependency to use exact version (1.0.83) instead of caret range for improved consistency
- Updated CLAUDE.md documentation with clearer MCP Linear integration testing instructions

### Packages

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.22

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.27

#### cyrus-ai (CLI)
- cyrus-ai@0.1.44

## [0.1.43] - 2025-08-18

### Added
- Model configuration support for Claude Pro users
  - Configure Claude model selection (priority order: env vars → repository config → global config → defaults)
  - Environment variables: `CYRUS_DEFAULT_MODEL` and `CYRUS_DEFAULT_FALLBACK_MODEL`
  - Global config: `defaultModel` and `defaultFallbackModel` in `~/.cyrus/config.json`
  - Repository-specific: `model` and `fallbackModel` fields per repository
  - Defaults: `"opus"` (primary) and `"sonnet"` (fallback)
  - Resolves errors for Claude Pro users who lack Opus model access

### Changed
- Updated @anthropic-ai/claude-code from v1.0.81 to v1.0.83 for latest Claude Code improvements. See [Claude Code v1.0.83 changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#1083)

### Fixed
- Fixed git worktree creation failures for sub-issues when parent branch doesn't exist remotely
  - Added proper remote branch existence checking before attempting worktree creation
  - Gracefully falls back to local parent branch or default base branch when remote parent branch is unavailable

### Packages

#### cyrus-claude-runner  
- cyrus-claude-runner@0.0.21

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.26

#### cyrus-ai (CLI)
- cyrus-ai@0.1.43

## [0.1.42] - 2025-08-15

### Changed
- Updated @anthropic-ai/claude-code from v1.0.77 to v1.0.80 for latest Claude Code improvements. See [Claude Code v1.0.80 changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#1080)
- Updated @anthropic-ai/sdk from v0.59.0 to v0.60.0 for latest Anthropic SDK improvements

### Fixed
- Fixed issue where duplicate messages appeared in Linear when Claude provided final responses
  - Added consistent LAST_MESSAGE_MARKER to all prompt types to ensure Claude includes the special marker in final responses
  - Marker is automatically removed before posting to Linear, preventing duplicate content

### Packages

#### cyrus-core
- cyrus-core@0.0.10

#### cyrus-claude-runner  
- cyrus-claude-runner@0.0.20

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.25

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.16

#### cyrus-ai (CLI)
- cyrus-ai@0.1.42

## [0.1.41] - 2025-08-13

### Added
- Dynamic tool configuration based on system prompt labels
  - Restrict Claude's tools per task type: give debugger mode only read access, builder mode safe tools, etc.
  - Use case: scoper can only read files, debugger can't use Bash, builder gets full access
  - Use presets (`"readOnly"`, `"safe"`, `"all"`) or custom tool lists in your `labelPrompts` config
  - Improves security and keeps Claude focused on the right tools for each job
  - See [Configuration docs](https://github.com/ceedaragents/cyrus#configuration) for setup details

### Changed
- Updated @anthropic-ai/claude-code from v1.0.72 to v1.0.73 for latest Claude Code improvements

### Fixed
- Fixed Windows compatibility issues that caused agent failures on Windows systems
  - Replaced Unix-specific `mkdir -p` commands with cross-platform Node.js `mkdirSync` 
  - Implemented intelligent shell script detection supporting Windows (.ps1, .bat, .cmd) and Unix (.sh) scripts
  - Added graceful fallback for Windows users with Git Bash/WSL to still use bash scripts
  - Resolves "A subdirectory or file -p already exists" and "bash command not found" errors
- Resolved issue where Cyrus would fail to respond when it was initially delegated when the receiver was down
  - Now properly creates new sessions when prompted if none existed
  - Sessions are correctly initialized even when no prior session history exists
  - Improved code organization and type safety in session handling logic

### Packages

#### cyrus-core
- cyrus-core@0.0.10

#### cyrus-claude-runner  
- cyrus-claude-runner@0.0.19

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.24

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.16

#### cyrus-ai (CLI)
- cyrus-ai@0.1.41

## [0.1.40] - 2025-08-10

### Added
- Customer subscription validation for Cyrus Pro users
  - Automatically checks subscription status when using the default proxy with a customer ID
  - Blocks access if subscription is expired, cancelled, or invalid
  - Shows appropriate messages for returning customers vs new customers
  - Validates subscription when setting customer ID via `cyrus set-customer-id` command
- Label-based repository routing - Route Linear issues to different git repositories based on their labels
  - New `routingLabels` configuration option allows specifying which labels should route to a specific repository
  - Useful when multiple repositories handle issues from the same Linear team (e.g., backend vs frontend repos)
  - Label routing takes precedence over team-based routing for more granular control

### Changed
- Updated Linear SDK from v54 to v55.1.0 to support Agent Activity Signals
  - Stop button in Linear UI now sends a deterministic `stop` signal that Cyrus responds to immediately
  - When you click the stop button while Cyrus is working, it will cleanly halt all operations and confirm the stop action
  - The stop signal implementation ensures no work continues after the stop is requested
- Updated Anthropic AI SDK from v0.57.0 to v0.59.0 and Claude Code from v1.0.61 to v1.0.72 for improved Claude integration

### Packages

#### cyrus-core
- cyrus-core@0.0.9

#### cyrus-claude-runner  
- cyrus-claude-runner@0.0.18

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.23

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.15

#### cyrus-ai (CLI)
- cyrus-ai@0.1.40

## [0.1.39] - 2025-08-08

### Changed
- Simplified initial setup by removing configuration prompts for MCP, labels, Linear teams, allowed tools, and workspace directory
  - MCP configuration is now optional with no default prompt
  - Allowed tools default to all standard tools plus Bash(git:*) and Bash(gh:*) for immediate productivity
  - Label-based system prompts now have defaults: "Bug" for debugger mode, "Feature,Improvement" for builder mode, and "PRD" for scoper mode
  - Team-based routing defaults to all workspace issues (no team filtering)
  - Workspace directory automatically uses `~/.cyrus/workspaces/<repo-name>`
  - Streamlined first-time user experience with sensible defaults

### Added
- Configuration documentation in README explaining all customizable settings
- Link to configuration docs in CLI output after setup completion

### Fixed
- Fixed duplicate OAuth authorization messages during Linear login flow while ensuring browser still opens automatically

### Packages

#### cyrus-core
- cyrus-core@0.0.8

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.17

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.22

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.15

#### cyrus-ai (CLI)
- cyrus-ai@0.1.39

## [0.1.38] - 2025-08-06

### Added
- Native Linear attachments (like Sentry error links) are now included in the issue context sent to Claude
  - Cyrus now fetches attachments using Linear's native attachment API
  - Attachments appear in a dedicated "Linear Issue Links" section in the prompt
  - Particularly useful for Sentry error tracking links and other external integrations
- New command **`cyrus add-repository`** - Add a new repository configuration, thanks new contributor @Maxim-Filimonov !
- Attachment support for comments - Cyrus now downloads and provides access to attachments added in Linear comments
  - Attachments are automatically downloaded when users post comments with URLs or files
  - Downloaded to `~/.cyrus/<workspace>/attachments` directory
  - Attachment manifest is generated and included in Claude's prompt
  - Attachments directory is always available to Claude during sessions
- Differentiation between issue delegation and @ mentions for more focused responses
  - @ mentions now trigger focused responses without system prompts
  - Delegations continue to use full system prompts for comprehensive task handling
  - Aligns with Linear's expected agent activity behavior
- Subscription management built right into the CLI (because who wants another dashboard?)
  - `cyrus billing` - Opens your Stripe portal to manage subscription, payment methods, and download invoices
  - `cyrus set-customer-id` - Saves your customer ID after signup (copy-paste friendly)
  - Interactive prompt on startup if you're using our proxy without a subscription
  - Self-hosting option for the DIY crowd who prefer their own Linear app and infrastructure
  - existed in v0.1.34 but was missing since then

### Fixed
- Fixed attachments not being accessible to Claude during active streaming sessions
  - Pre-create attachments directory for every session to ensure future attachments are accessible
  - Always include attachments directory in allowedDirectories configuration
- Fixed issue where messages from @ Cyrus mention comments weren't being added to context
- Fixed issue where sub-issue base branches weren't being added to the user-prompt template, causing Cyrus to create PRs against the default branch instead

### Packages

#### cyrus-core
- cyrus-core@0.0.8

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.16

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.21

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.15

#### cyrus-ai (CLI)
- cyrus-ai@0.1.38

## [0.1.37] - 2025-08-03

### Fixed
- Fixed "RateLimit exceeded" and `Cannot query field "agentContext" on type "AgentActivity".` errors when interacting with Linear API by updating SDK from v52 to v54
  - Linear API had breaking changes that caused compatibility issues with SDK v52
  - The outdated SDK was triggering excessive API calls leading to rate limit errors
  - Upgrading to v54 resolves these compatibility issues and restores normal operation

### Packages

#### cyrus-core
- cyrus-core@0.0.8

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.15

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.20

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.15

#### cyrus-ai (CLI)
- cyrus-ai@0.1.37

## [0.1.36] - 2025-08-01

### Added
- Instant response is now sent when receiving follow-up messages in an existing conversation, providing immediate feedback that Cyrus is working on the request
  - Shows "I've queued up your message as guidance" when Cyrus is still processing a previous request
  - Shows "Getting started on that..." when Cyrus is ready to process the new request immediately
- Parent branch inheritance for sub-issues - sub-issue branches now automatically use their parent issue's branch as the base instead of the default repository branch
  - Maintains proper Git hierarchy matching Linear's issue structure
  - Gracefully falls back to default base branch if parent branch doesn't exist
  - Clear logging shows branch inheritance decisions
- Model notification at thread initialization - Cyrus now announces which Claude model is being used (e.g., "Using model: claude-3-opus-20240229") when starting work on an issue
- Task tool execution markers in Linear comments - Cyrus now clearly indicates when automated Task tools are running
  - Tools invoked within a Task display "↪ ToolName" to indicate they're part of the Task
  - Shows "✅ Task Completed" when the Task finishes and displays the output from the Task

### Packages

#### cyrus-core
- cyrus-core@0.0.7

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.14

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.19

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.14

#### cyrus-ai (CLI)
- cyrus-ai@0.1.36
## [0.1.35-alpha.0] - 2025-07-27

### Added
- Instant acknowledgment responses when Cyrus receives a request, providing immediate feedback to users
- Role mode notifications when issue labels trigger specific workflows (e.g., "Entering 'debugger' mode because of the 'Bug' label")
- You can now append custom instructions to Claude's system prompt via `appendInstruction` in repository config (~/.cyrus/config.json) - because sometimes Claude needs a gentle reminder that your variable names are art, not accidents

### Changed
- TodoWrite tool messages are now displayed as "thoughts" instead of "actions" in Linear for better visual organization

### Packages

#### cyrus-core
- cyrus-core@0.0.6-alpha.0

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.13-alpha.0

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.18-alpha.0

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.13-alpha.0

#### cyrus-ai (CLI)
- cyrus-ai@0.1.35-alpha.0

## [0.1.33] - 2025-07-11

### CLI
- cyrus-ai@0.1.33

### Fixed
- Made conversation history of threads be resumable after Cyrus restarts
- Fixed the issue with continuity of conversation in a thread, after the first comment

### Packages

#### cyrus-core
- cyrus-core@0.0.6

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.13

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.18

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.13

## [0.1.32] - 2025-07-09

### CLI
- cyrus-ai@0.1.32

### Fixed
- Missing prompt template file in published package (the one thing you need to actually run the thing)

### Packages

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.17
  - Fixed missing prompt-template-v2.md in package files

## [0.1.31] - 2025-07-09

### CLI
- cyrus-ai@0.1.31

### Added
- Work on multiple tasks within a single Linear issue - each comment thread maintains its own Claude session, letting you tackle different parts of a problem in parallel without context mixing. New root comments start focused sessions that see the full conversation history in a threaded view (just like Linear's UI) while concentrating on your specific request
- Automatic ngrok tunnel setup for external access
  - No more manual port forwarding or reverse proxy setup required
  - Cyrus will ask for your ngrok auth token on first run and handle the rest
  - Free ngrok account required (sorry, we can't make the internet work by magic alone)
  - Skip ngrok setup if you prefer to handle networking yourself
- Webhook debugging via `CYRUS_WEBHOOK_DEBUG=true` environment variable - see exactly what Linear is (or isn't) sending you

### Fixed
- Fresh startup no longer crashes with "EdgeWorker not initialized" error when trying to connect to Linear
- OAuth flow now works properly on first run (turns out asking for credentials before having a way to receive them was... problematic)
- Git worktrees now work with local-only repositories (no more "fatal: 'origin' does not appear to be a git repository" when you're just trying to test things locally)
- Webhooks now register with the correct URL (ngrok/public URL instead of localhost)

### Packages

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.16
- Added ngrok tunnel support for automatic public URL generation
- Fixed webhook URL registration to use public URLs
- Added getPublicUrl() method to SharedApplicationServer

#### cyrus-ndjson-client
- cyrus-ndjson-client@0.0.12
- Fixed webhook URL registration to use external server's public URL when available

## [0.1.30] - 2025-07-07

### CLI
- cyrus-ai@0.1.30

### Fixed
- Fixed critical crash issue where subprocess failures would bring down the entire application
  - Added global error handlers to prevent uncaught exceptions from terminating the process
  - Improved error isolation for individual Claude sessions - failures no longer affect other running sessions
  - Enhanced error logging with detailed stack traces for better debugging

### Packages

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.15

## [0.1.28] - 2025-07-06

### CLI
- cyrus-ai@0.1.28

### Fixed
- Fixed critical streaming hang where sessions would never complete
  - Auto-completes streaming prompt when Claude sends result message
  - Prevents infinite wait in for-await loop

## [0.1.27] - 2025-07-06

### CLI
- cyrus-ai@0.1.27

### Changed
- Updated to use edge-worker 0.0.12 with fixed claude-runner dependency

## [0.1.26] - 2025-07-06

### CLI
- cyrus-ai@0.1.26

### Fixed
- Fixed critical streaming hang issue where Claude Code would block waiting for messages
  - Corrected `abortController` placement in query options (was at wrong nesting level)
  - Fixed system prompt parameter name (now uses `customSystemPrompt` as expected by Claude Code)

### Added
- Added `appendSystemPrompt` option to ClaudeRunner config for extending default system prompt

## [0.1.25] - 2025-07-06

### CLI
- cyrus-ai@0.1.25

### Fixed
- Fixed streaming session detection to prevent "I've queued up your message..." when sessions have completed
- Improved isStreaming() method to check both streaming state and session running status


## [0.1.23] - 2025-07-06

### CLI
- cyrus-ai@0.1.23

### Fixed
- Fixed streaming input sessions not properly cleaning up after completion
  - Resolves issue where "I've queued up your message..." appeared even after sessions had resolved
  - Properly closes input streams when Claude sessions complete naturally

### Added
- Added `cyrus check-tokens` command to validate all Linear OAuth tokens across repositories
- Added `cyrus refresh-token` command with OAuth flow integration to renew expired tokens
- Improved error handling for expired Linear tokens with graceful degradation
  - Shows clear error messages with suggested resolution steps
  - Continues running with valid repositories when some tokens are expired

### Changed
- Configuration file location moved from `.edge-config.json` in current directory to `~/.cyrus/config.json`
  - Automatically migrates existing `.edge-config.json` files to the new location
  - Uses standard user configuration directory for better cross-platform compatibility
  - Reports migration status when detected
- Default workspace directory changed from `{repository}/workspaces` to `~/.cyrus/workspaces/{repo-name}`
  - Centralizes all cyrus-related files in the user's home directory
  - Uses sanitized repository names as namespace folders
  - Existing configurations remain unchanged

## [0.1.22] - 2025-07-05

### CLI
- cyrus-ai@0.1.22

### Added
- Automatic Linear MCP (Model Context Protocol) server integration
  - Claude can now use Linear API tools directly within sessions
  - Automatically configures `@tacticlaunch/mcp-linear` server with repository's Linear token
  - Adds 30+ Linear MCP tools for issue management, comments, projects, and more
  - No additional configuration needed - works out of the box with existing Linear tokens

### Changed
- ClaudeRunner now supports array of MCP config paths for composable configurations
- ClaudeRunner supports inline MCP server configurations alongside file-based configs
- MCP configurations from files and inline sources are merged together

### Fixed
- Fixed webhook signature verification failures after restarting cyrus by extending edge worker registration TTL from 1 hour to 90 days
  - Resolves "Webhook signature verification failed for all registered handlers" error that occurred when cyrus was stopped and restarted
  - Edge worker registrations in the proxy now persist for 90 days instead of expiring after 1 hour

### Improved
- New comments on Linear issues queue up when Cyrus is already busy working, so that you can send multiple in a row ([#77](https://github.com/ceedaragents/cyrus/pull/77)) (now feed into existing Claude sessions instead of killing and restarting the session

### Packages

#### cyrus-claude-runner
- cyrus-claude-runner@0.0.8

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.10

## [0.1.21] - 2025-07-05

### CLI
- cyrus-ai@0.1.21

### Added
- Added `CYRUS_HOST_EXTERNAL` environment variable to enable external server access ([#78](https://github.com/ceedaragents/cyrus/pull/78))
  - Set to `true` to listen on `0.0.0.0` (all interfaces) instead of `localhost`
  - Enables Docker container deployment and external webhook access scenarios
  - Maintains backward compatibility with `localhost` as default

### Changed
- **BREAKING**: Renamed `CYRUS_WEBHOOK_BASE_URL` to `CYRUS_BASE_URL` for clearer naming
  - **Action Required**: Update environment configuration to use `CYRUS_BASE_URL` instead of `CYRUS_WEBHOOK_BASE_URL`
  - **Legacy Support**: `CYRUS_WEBHOOK_BASE_URL` is still supported for backward compatibility but deprecated
  - The variable serves both webhook and OAuth callback purposes since they run on the same server

### Packages

#### cyrus-edge-worker
- cyrus-edge-worker@0.0.9

## [0.1.19] - 2025-07-04

### CLI
- cyrus-ai@0.1.19

### Added
- Added `CYRUS_OAUTH_CALLBACK_BASE_URL` environment variable to configure OAuth callback URL (defaults to `http://localhost:3457`) ([#69](https://github.com/ceedaragents/cyrus/pull/69))
- Added `CYRUS_OAUTH_CALLBACK_PORT` environment variable to configure OAuth callback port (defaults to `3457`)
- OAuth callback URL is now fully configurable for different deployment environments (Docker, remote development, custom domains)
- Supports `--env-file=path` option to load environment variables from custom file
- Added `CYRUS_BASE_URL` environment variable to configure base URL for edge workers ([#74](https://github.com/ceedaragents/cyrus/pull/74))
- Added `CYRUS_WEBHOOK_PORT` environment variable to configure webhook port (defaults to random port 3000-3999)
- Implemented shared webhook server architecture to eliminate port conflicts between multiple Linear tokens

### Changed
- **BREAKING**: Migrated from Server-Sent Events (SSE) to webhook-only architecture ([#74](https://github.com/ceedaragents/cyrus/pull/74))
  - **Action Required**: Edge workers now receive webhooks instead of SSE streams
  - **Action Required**: Set `CYRUS_BASE_URL` environment variable if using custom deployment URLs (e.g., ngrok tunnel, server domain)
  - **Action Required**: Set `CYRUS_WEBHOOK_PORT=3456` environment variable to ensure consistent webhook port
  - **Action Required**: Ensure edge workers can receive inbound HTTP requests on webhook ports
- Renamed repository setup script from `secretagentsetup.sh` to `cyrus-setup.sh`

### Fixed
- Resolved SSE connection reliability issues by migrating to webhook architecture
- Improved disconnection message formatting
- Removed duplicate disconnection logging

### Packages

#### cyrus-claude-runner
- Upgraded @anthropic-ai/claude-code dependency to version 1.0.31

## [0.0.3] - 2025-06-17

### Packages
- cyrus-claude-runner@0.0.3
- cyrus-core@0.0.3
- cyrus-edge-worker@0.0.3
- cyrus-ndjson-client@0.0.3

Initial changelog entry

## [0.1.9] - 2025-06-17

### CLI
- cyrus-ai@0.1.9

Initial changelog entry
