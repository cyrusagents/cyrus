# Test Drive: ScheduleWakeup Tool Delivery (CYPACK-1310)

**Date**: 2026-06-11
**Goal**: Determine whether the `ScheduleWakeup` tool is operational for Cyrus Claude agent sessions, and whether `CYRUS_ENABLE_WARM_SESSIONS=false` (the default) breaks wakeup delivery by letting the SDK subprocess exit at turn end.
**Test Repo**: `/tmp/f1-wakeup-test-1310` (cold), `/tmp/f1-wakeup-test-1310-warm` (warm)

## Hypothesis

When `CYRUS_ENABLE_WARM_SESSIONS` is unset, `ClaudeRunner` calls
`streamingPrompt.complete()` as soon as the SDK emits a `result` message
(`packages/claude-runner/src/ClaudeRunner.ts:815-821`). The Claude Code CLI
subprocess then exits at end of turn. The ScheduleWakeup timer lives inside
that subprocess, so any pending wakeup dies with it and never fires.

## Method

Each run creates an F1 issue instructing the agent to:

1. Call `ScheduleWakeup` with `delaySeconds=60` and a wakeup prompt telling it
   to create `wakeup-fired.txt` and reply `WAKEUP_OK`.
2. Report the tool result verbatim.
3. End its turn immediately.

Then observe (a) the tool result, (b) the subprocess lifecycle, (c) whether
any wakeup activity occurs after the scheduled deadline.

## Run 1: Cold mode (`CYRUS_ENABLE_WARM_SESSIONS` unset) — port 3611

Timeline (PDT / UTC-7, server log `2026-06-11`):

| Time (UTC) | Event |
|---|---|
| 18:21:18 | Session started; repository-selection elicitation posted |
| 18:22:23 | Repo selected; Claude session spawned with `ScheduleWakeup` in allowedTools (37 tools) |
| 18:22:31 | Agent called `ScheduleWakeup(delaySeconds=60, ...)` |
| 18:22:31 | Tool result: **"Next wakeup scheduled for 11:24:00 (in 88s). Nothing more to do this turn..."** — tool call **accepted** |
| 18:22:34 | SDK emitted `result` (success, num_turns=2), then `session_state_changed: idle` |
| 18:22:35 | EdgeWorker `session_completed` (15 messages) |
| 18:23:11 | Verified: **F1 server has zero child processes** — CLI subprocess already exited, 49s before the scheduled wakeup |
| 18:24:00 | Scheduled wakeup deadline — **nothing fired** |
| 18:26:22 | Server shut down (2m22s after deadline). Last session jsonl entry remains 18:22:34. No `wakeup-fired.txt` anywhere. Zero session activity after 18:22:35. |

**Verdict: ScheduleWakeup is NOT operational in cold mode.** The CLI accepted
the schedule and even reported `session_state_changed: idle` (it intends to
stay resident and wait for the timer), but Cyrus completes the streaming
prompt on `result`, the subprocess exits, and the timer dies with it.

Notable detail: the CLI emits `result` *before* going idle to wait for a
pending wakeup. So "wait for result before completing the prompt" — the exact
cold-mode strategy in `ClaudeRunner` — is indistinguishable from a genuinely
finished turn. Fixing this requires either keeping the prompt open when a
wakeup is pending (tracking `ScheduleWakeup` tool_use in the turn) or an
EdgeWorker-level scheduler that re-prompts the session via `--resume` at the
wakeup time.

### Meta-evidence from the orchestrating session itself

The Cyrus session running this very test drive called `ScheduleWakeup`
(delay 284s) at the end of a turn. The wakeup prompt was never delivered;
the session was only revived later by a human comment. Additionally, ending
that turn killed the SDK subprocess and with it the (non-detached) F1 server
background processes — direct production evidence of both the bug and the
subprocess-exit mechanism.

## Run 2: Warm mode (`CYRUS_ENABLE_WARM_SESSIONS=1`) — port 3613

Timeline (UTC, session jsonl `session-ddd6c07f-*`):

| Time (UTC) | Event |
|---|---|
| 18:53:07 | Session started, repo selected |
| 18:53:24 | Agent called `ScheduleWakeup(delaySeconds=60, ...)` |
| 18:53:30 | Tool result: "Next wakeup scheduled for 11:55:00 (in 96s)"; SDK emitted `result` (success), then `session_state_changed: idle` — **subprocess stays alive** (streaming prompt held open by warm mode) |
| 18:55:00.793 | `session_state_changed: running` — **the wakeup timer fired in-process** |
| 18:55:04 | Agent thinking: "The wakeup fired. I need to create a file named wakeup-fired.txt..." |
| 18:55:06 | `Write` → `wakeup-fired.txt` containing `FIRED` ✅ |
| 18:55:10 | Agent replied `WAKEUP_OK` ✅ |
| 18:55:21 | (stop-hook feedback) committed the file: `64b4db2 Add wakeup-fired.txt to confirm ScheduleWakeup delivery` |
| 18:55:38 | Second `result` (success); EdgeWorker posted all post-wakeup activities to the session timeline (16 total) |
| 18:57:33 | Verified: claude subprocess **still alive** (warm) |

**Verdict: ScheduleWakeup IS fully operational in warm mode**, end to end:
timer fires in the resident CLI process, the wakeup prompt is injected as a
new turn, the EdgeWorker streams the post-wakeup activities to the issue
timeline, and a second `result` completes cleanly.

### Test-harness gotchas encountered (worth knowing for future drives)

1. **F1 servers must outlive the orchestrating agent's turn** when testing
   cross-turn behavior. Background Bash tasks die with the orchestrator's SDK
   subprocess at turn end (cold mode) — which is itself the bug under test.
   Detaching via `setsid` fails differently: detached processes get 401s
   because Claude child auth comes from `CLAUDE_CODE_OAUTH_TOKEN` on the
   runner process, which is stripped from the agent session env. Workaround:
   forward the token explicitly and keep the orchestrator's turn open with
   foreground `until` loops.
2. A stale F1 server from a previous drive was holding port 3600 (uptime ~2
   days). Drives should `lsof` the port first.

## Verification Results

### Issue-Tracker
- [x] Issue created (DEF-1 / issue-1, both runs)
- [x] Issue ID returned
- [x] Issue metadata accessible

### EdgeWorker
- [x] Session started
- [x] Worktree created
- [x] Activities tracked (elicitation, prompt, thought, action, response)
- [x] Agent processed issue and called ScheduleWakeup as instructed

### Renderer
- [x] Activity format correct (timestamps, types, content)
- [x] Tool call visible as `action` activity with parameters

## Addendum: SDK learning tests — what signals "safe to shut down"?

Follow-up question (Connor): is there anything other than `result` messages
that tells us it's safe to terminate the subprocess, and what does the
subprocess exit actually come down to?

Method: a standalone harness (`/tmp/sdk-wakeup-lab/lab.mjs`) driving
`@anthropic-ai/claude-agent-sdk@0.3.173` directly with a controllable
streaming input, logging every SDK message verbatim, every Stop-hook input,
and the CLI child PID (300ms polling). Three scenarios, varying one factor
at a time.

### Scenario A — wakeup pending, input stream completed after `result`

```
t=4.97   tool_use:ScheduleWakeup (delaySeconds=60)
t=12.24  STOP_HOOK  session_crons: [{id, schedule:"27 12 * * *", recurring:false,
                     prompt:"WAKEUP: reply with exactly WOKE..."}]   ← THE SIGNAL
t=12.25  result (success) → session_state_changed: idle
t=13.28  input stream completed (simulates ClaudeRunner cold mode)
t=13.89  CLI child process GONE — 0.6s after stdin close,
         ~47s BEFORE the scheduled wakeup
```

**The CLI makes no attempt to survive stdin EOF when a wakeup is pending.**

### Scenario B — control (no wakeup), input stream completed after `result`

Identical message shape: `result` → `session_state_changed: idle`, Stop hook
fired with `session_crons: []`. A field-level diff of the full `result`
messages from A and B (excluding volatile timing/usage fields) found **zero
differences** — the `result` message carries no pending-work information.
Neither does any other stream message: post-`result` emissions are
byte-equivalent in shape between the two scenarios.

### Scenario C — wakeup pending, input stream held open

```
t=6.75   STOP_HOOK  session_crons: [ {…one-shot wakeup…} ]
t=6.75   result #1 → idle          (subprocess stays alive: stream open)
t=68.29  idle → running            ← wakeup timer fired in-process
t=71.23  STOP_HOOK  session_crons: []   ← now empty: safe to close
t=71.23  result #2 ("WOKE") → idle
t=72.23  input completed → t=72.59 child exited cleanly
```

### Answers

1. **What the exit really comes down to:** completing the streaming-input
   AsyncIterable. The SDK then closes the CLI's stdin and SIGTERMs it after a
   ~2s grace window (`GRACEFUL_EXIT_TIMEOUT_MS`; visible in the bundle as
   `stdin.end() … else e.kill("SIGTERM")`). `result` emission alone does NOT
   exit the process — in scenario C it lived 65+ seconds past `result`.
   Conversely, stdin EOF kills it regardless of pending wakeups.
2. **There is no in-band message signal.** Nothing in the message stream
   (`result` fields, `session_state_changed`, or any other emission)
   distinguishes "done" from "paused awaiting wakeup". The
   `session_state_changed: idle` docs call it the "authoritative turn-over
   signal" — turn over, not session over.
3. **The signal exists, in the Stop hook.** `StopHookInput.session_crons`
   (one entry per pending `CronCreate`/`ScheduleWakeup`/`/loop` task, with
   `recurring: false` for one-shot wakeups) and
   `StopHookInput.background_tasks` (in-flight backgrounded work). The SDK
   docs say these exist precisely to "distinguish 'session is done' from
   'session is paused waiting for background work to wake it'". The hook
   fires immediately before `result`, so the decision input is available by
   the time `ClaudeRunner` decides whether to complete the prompt.

### Implication for the cold-mode fix

`ClaudeRunner` can register a Stop hook (it already configures hooks),
record the latest `session_crons`/`background_tasks`, and on `result` only
complete the streaming prompt when both are empty — otherwise hold the
prompt open until a later turn's Stop hook reports them empty. Policy
decisions remain for `recurring: true` crons (never empty — needs a cap or
warm-mode-only support) and for Cyrus restarts (in-process timers die with
the daemon either way, which still argues for EdgeWorker-level scheduling as
the robust long-term design).

## Addendum 2: Fix validation (Stop-hook approach, PR #1313)

The fix implements the Stop-hook protocol: `ClaudeRunner` registers an
internal Stop hook recording `session_crons`/`background_tasks`, and in cold
mode only completes the streaming prompt on a success `result` when both are
empty. `AgentSessionManager` formats wakeup-JSON responses readably and posts
a "⏳ Standing by" thought after the response.

Cold-mode F1 validation run (`CYRUS_ENABLE_WARM_SESSIONS` unset, port 3614):

```
13:12:21  action    ScheduleWakeup(delaySeconds=60) — turn ends ON the bare tool call
13:12:23  log       pending_work_recorded {sessionCronCount: 1}
13:12:24  log       session_held_open_for_pending_work {sessionCronCount: 1}
13:12:24  response  "⏰ Wakeup scheduled — resuming in ~60s. > Cold-mode fix …"  (formatted, not raw JSON)
13:12:24  thought   "⏳ Standing by — this session will wake automatically: - ⏰ W…"
13:14:00  thought   wakeup FIRED (cold mode!) — new turn starts
13:14:04  action    Write wakeup-fired.txt → contains FIRED
13:14:09  thought   WAKEUP_OK
```

The previously-broken scenario now works end-to-end with warm sessions off.
Unit coverage: `packages/claude-runner/test/pending-work-lifecycle.test.ts`
(hold-open/complete decision against an SDK mock that reproduces the real
hook-before-result ordering and stdin-EOF exit) and
`packages/edge-worker/test/AgentSessionManager.pending-work.test.ts`
(response formatting + standing-by thought ordering).

## Addendum 3: Background-bash coverage (does the detector catch long-running commands?)

Follow-up (Connor): a long-running bash command "didn't get caught by the
detector." Probed directly with `assets/2026-06-11-cypack-1310-bgbash-lab.mjs`
(real SDK). The detector keys off the SDK's own background-task registry
(`background_tasks` on the Stop hook), so coverage depends on *how* the
command is launched:

| Launch method | SDK `background_tasks` at Stop hook | Caught? |
|---|---|---|
| `Bash(run_in_background: true)` | `[{type:"shell", status:"running", command:"sleep 120"}]` | ✅ yes |
| Trailing `sleep 120 &` | `[]` — the Bash tool call returns instantly (`task_updated → completed`, exit 0); the `sleep` is an orphan the SDK never tracks | ❌ no (nothing to detect) |

Two decisive observations from the probe:

1. **`run_in_background` is tracked and now held open.** The probe also showed
   that closing stdin while such a task is running *kills* it
   (`status:"killed"`, `task_notification: stopped`) — which is exactly the
   regression the fix prevents. Cold-mode F1 validation (port 3615): the agent
   ran `sleep 70 …` via `run_in_background`, the session was held open
   (`backgroundTaskCount: 1`, CLI child alive at T+25s, "⏳ Standing by — 🛠️
   Background command" thought posted), the task finished at ~70s, and the
   session woke into a new turn (`BG_OK`) before completing cleanly.
2. **Bare `&` is invisible by design.** The Bash *tool call* `sleep 120 &`
   completes the instant the shell forks, so the SDK reports the tool done and
   `background_tasks` is empty. The orphaned process keeps running but neither
   the CLI nor Cyrus has any handle on it — there is no signal to detect, and
   scanning the host process tree for unattributed orphans is not a robust or
   safe basis for keeping a session alive.

**Guidance:** to keep a session alive for long-running work, use
`Bash(run_in_background: true)` (the harness-tracked mechanism the Bash tool
already recommends over `&`). Detached `&` processes are intentionally outside
the detector's scope.

## Final Retrospective

**Answer to CYPACK-1310: the intuition is correct.** ScheduleWakeup is NOT
operational under the default configuration (`CYRUS_ENABLE_WARM_SESSIONS`
unset). The root cause is exactly the suspected one: when warm sessions are
off, `ClaudeRunner` completes the streaming prompt as soon as the SDK emits a
`result` message (`ClaudeRunner.ts:815-821`, behavior introduced in
CYPACK-1116), the Claude Code subprocess exits at turn end, and the
in-process wakeup timer dies with it. With `CYRUS_ENABLE_WARM_SESSIONS=1`
the identical scenario works perfectly.

Fix considerations (for a follow-up issue):

- The CLI emits `result` *before* idling with a pending wakeup, so
  "complete-on-result" cannot distinguish "turn finished, nothing pending"
  from "turn finished, wakeup pending". A correct cold-mode fix must track
  `ScheduleWakeup` tool_use during the turn (Cyrus already parses every
  message) and keep the streaming prompt open until the wakeup fires or is
  superseded — or
- Implement wakeups at the EdgeWorker level: intercept the `ScheduleWakeup`
  call, let the subprocess exit, and re-prompt the session via `--resume`
  with the wakeup prompt when the timer elapses (mirrors how Linear comments
  resume sessions today). This also survives Cyrus restarts, which the
  in-process timer does not — even in warm mode.
- Same concern likely applies to the sibling scheduling tools (`CronCreate`
  timers, `Monitor`, background Bash tasks): all of them die with the
  subprocess at cold-mode turn end. Observed directly: background F1 servers
  spawned by this orchestrating session were killed at its turn end.
