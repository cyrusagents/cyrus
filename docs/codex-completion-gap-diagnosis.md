# Codex Task-Completion Signal Gap — Diagnosis (BRI-1490)

**Status:** Diagnosis only. No fix applied in this BRI.
**Trigger BRIs:** [BRI-1410](https://linear.app/brilliantio/issue/BRI-1410) (zombie pre-patch, 2026-05-01), [BRI-1489](https://linear.app/brilliantio/issue/BRI-1489) (watchdog-fired post-patch, 2026-05-05).
**Author:** Cyrus, on behalf of Paul.
**Codex CLI version inspected:** `codex-cli 0.125.0` at `/usr/bin/codex`.
**SDK version inspected:** `@openai/codex-sdk@0.107.0` (vendored under `cyrus-ai`).
**Runner SHA inspected:** `1ccc2ee5…` (Tier A watchdog patch live, per `docs/codex-runner-fix-runbook.md`).

---

## 1. Summary (TL;DR)

The brief's framing — "cyrus-codex-runner does not recognise codex's task-completion signal" — is **not what the JSONL evidence shows**. Cyrus's runner correctly recognises codex's terminal events: in `dist/CodexRunner.js:663` it switches on `turn.completed` (the SDK-translated form of codex's `task_complete` `event_msg`) and creates a success result. Successful sessions (e.g. `/root/.codex/sessions/2026/05/02/rollout-…149.jsonl`) end exactly as expected: `agent_message` → `token_count` → `task_complete`, and the runner posts a PR.

The reason no `task_complete` arrives in failed sessions is **the same Linear-MCP `tools/call` hang already diagnosed in [BRI-1411](https://linear.app/brilliantio/issue/BRI-1411)** — manifesting at a different point in the turn. Both [BRI-1410](https://linear.app/brilliantio/issue/BRI-1410) (pre-patch) and [BRI-1489](https://linear.app/brilliantio/issue/BRI-1489) (post-patch) hang on `mcp__linear__save_issue` (and adjacent mutation `mcp__linear__save_comment`). Read calls (`mcp__linear__list_issues`) return cleanly in 1–2 s in the same sessions; the hang is **specifically Linear MCP mutations**. With codex blocked on a tool result, the model can never advance to `task_complete`, the SDK iterator never ends, and the watchdog correctly aborts at +180 s.

The runner-side completion gap is therefore **a downstream symptom of the upstream MCP hang**, not a separate bug. The recommended fix is **not** a runner event-handler patch (none is missing). The recommended fix is **to stop having codex call `mcp__linear__save_issue` / `save_comment` at all**: route Linear status transitions and progress comments through Cyrus's EdgeWorker, which already does this for claude-runner sessions. Watchdog continues to bound any residual hangs.

---

## 2. Symptom

When Cyrus dispatches a BRI to `cyrus-codex-runner` (e.g. via `[agent=codex]`):

1. EdgeWorker creates a worktree, starts a codex session, streams the prompt.
2. Codex begins productive model output: reasoning, `agent_message`, `update_plan` calls, `exec_command` calls, possibly file edits.
3. At some point in the turn, codex dispatches a `mcp__linear__save_issue` (`{state: "In Progress"}`) or `mcp__linear__save_comment` mutation against `https://mcp.linear.app/mcp`.
4. The Linear MCP server accepts the `tools/call` but never returns a `tools/result`.
5. Codex blocks awaiting that result. No further `event_msg`s emit; the rollout JSONL goes silent at `token_count` + a trailing orphan `function_call`.
6. cyrus-codex-runner's idle-watchdog (BRI-1439) fires at +180 s, calls `abortController.abort()`.
7. Codex subprocess receives the signal, the SDK's `child.kill()` cleanup runs, the runner's `finalizeSession` posts an error-result message: `"The operation was aborted"`.
8. Cyrus posts that error to Linear; agent session terminates with `subtype: error_during_execution`. **No PR opens.**

This is the failure mode that takes Tier 2 from fail-fast (after BRI-1439) to **shipping-grade** (still not achieved, this BRI).

---

## 3. Evidence

### 3.1. Three reference sessions

| Run | Session JSONL | Last event | Outcome |
|---|---|---|---|
| BRI-1410 (zombie pre-patch) | `2026/05/01/rollout-…366d.jsonl` (70 lines) | `event_msg token_count` after orphan `function_call mcp__linear__save_issue` (10:15:43.045Z) | 4 h zombie until SIGKILL |
| BRI-1489 (watchdog-fired post-patch) | `2026/05/05/rollout-…03.jsonl` (39 lines) | `response_item function_call_output` for `update_plan` (06:46:38.943Z) — **`save_issue` & `save_comment` outputs missing** | watchdog aborted at +225 s |
| BRI-1439 implementation (successful) | `2026/05/02/rollout-…149.jsonl` (816 lines) | `event_msg task_complete` (12:35:27.691Z) | PR opened, BRI shipped |
| 2026-04-25 reference (successful) | `2026/04/25/rollout-…f5fe.jsonl` (12 lines) | `event_msg task_complete` (23:54:06.055Z) | clean exit |

### 3.2. BRI-1489 event sequence (verbatim, watchdog run)

```
06:45:59.711  session_meta
06:45:59.712  message developer
06:45:59.712  message user
06:45:59.712  task_started
06:45:59.713  turn_context
06:45:59.713  message user
06:45:59.713  user_message
06:46:01.786  token_count
06:46:14.367  reasoning
06:46:15.009  agent_message            ← model is producing output
06:46:17.528  function_call update_plan         call_Brj8u…
06:46:17.541  function_call_output              call_Brj8u… (returned in 13 ms)
06:46:22.700  function_call exec_command        call_eT0wd…
06:46:22.770  function_call mcp__linear__list_issues  call_JSHPK…
06:46:22.771  function_call mcp__linear__list_issues  call_R8l8T…
06:46:22.967  function_call_output              call_eT0wd… (267 ms)
06:46:23.797  function_call_output              call_JSHPK… (1.0 s)   ← list_issues works
06:46:24.955  function_call_output              call_R8l8T… (2.2 s)   ← list_issues works
06:46:28.868  reasoning
06:46:30.206  agent_message
06:46:31.019  function_call exec_command        call_lpD9i…
06:46:31.116  function_call_output              call_lpD9i… (97 ms)
06:46:34.527  reasoning
06:46:38.622  agent_message
06:46:38.737  function_call update_plan                    call_ogrP4…
06:46:38.738  function_call mcp__linear__save_issue        call_GZlbh…  ← orphan
06:46:38.738  function_call mcp__linear__save_comment      call_hkyRH…  ← orphan
06:46:38.943  token_count
06:46:38.943  function_call_output              call_ogrP4… (206 ms)
[ no further events — codex blocked on save_issue + save_comment ]
[ +180 s watchdog fires; abort; subprocess exits ]
```

Type histogram for the same file: 8 `function_call`, 6 `function_call_output`. **Two unmatched function_call → output pairs**, exactly the two Linear mutation calls. No `task_complete` event.

### 3.3. BRI-1410 ends on the same call class

Per `docs/codex-hang-diagnosis.md` §2.1: BRI-1410 also ended on an orphan `mcp__linear__save_issue` (`call_3T4aMKgNG8XPmwWIcbwljJfg`, args `{"id":"BRI-1410","state":"In Progress"}`). 13 prior tool calls (all `update_plan` / `exec_command` / `mcp__linear__list_issues`) paired cleanly within 5–2200 ms. The 14th — also `save_issue` — never returned.

### 3.4. Successful sessions DO end on `task_complete`

```
$ tail -1 /root/.codex/sessions/2026/05/02/rollout-…149.jsonl | jq -r '.payload.type'
task_complete
$ jq -r 'select(.payload.type == "task_complete") | .payload.last_agent_message[:80]' \
    /root/.codex/sessions/2026/05/02/rollout-…149.jsonl
"Implemented and shipped the BRI-1439 artifact set on branch `cyrus2/bri-1439-…`"
```

The `task_complete` `event_msg` carries a `turn_id` and the final `last_agent_message` text. This is the canonical terminal `event_msg` codex emits on natural completion. It exists, it is well-defined, and codex-cli 0.125.0 emits it correctly when it isn't blocked.

### 3.5. The runner already handles the completion signal correctly

`/usr/lib/node_modules/cyrus-ai/node_modules/cyrus-codex-runner/dist/CodexRunner.js:640-683` — the `handleEvent` switch:

```js
case "turn.completed": {
    this.lastUsage = parseUsage(event.usage);
    this.pendingResultMessage = this.createSuccessResultMessage(
        this.lastAssistantText || "Codex session completed successfully");
    break;
}
case "turn.failed": {
    const message = event.error?.message
        || this.errorMessages.at(-1)
        || "Codex execution failed";
    this.errorMessages.push(message);
    this.pendingResultMessage = this.createErrorResultMessage(message);
    break;
}
```

`turn.completed` is the SDK-level event that `@openai/codex-sdk@0.107.0` emits when it parses a codex `event_msg` with `payload.type === "task_complete"` from the NDJSON stream. The runner sets `pendingResultMessage` to the success result. `finalizeSession` (lines 815–844) then emits it to the EdgeWorker, which posts the PR.

`finalizeSession`'s fallback (line 829) — "if no `pendingResultMessage` and no `wasStopped`, treat as success with last assistant text" — only runs when the for-await loop exits without seeing `turn.completed` *and* without an abort. It is not the path exercised in BRI-1489: the abort throws, `caughtError` is set, the error branch runs, and `"The operation was aborted"` is posted. That matches what Paul observed in production.

### 3.6. SDK event mapping

`@openai/codex-sdk@0.107.0` `dist/index.js:78-89` — the SDK is a thin pass-through, `JSON.parse(line)` and `yield`. It does not synthesise terminal events. If codex doesn't emit `turn.completed`, the SDK doesn't either. The runner's switch will simply never reach the success path. The `task_complete` rollout `event_msg` and the `turn.completed` NDJSON stdout event share the same trigger inside codex (turn end), so failure to see either means codex never ended its turn.

---

## 4. Root Cause

**Codex CLI 0.125.0 has no enforced upper bound on streamable-HTTP MCP `tools/call` duration. The Linear MCP server (`https://mcp.linear.app/mcp`) reliably stalls on mutation tools (`save_issue`, `save_comment`) in the Cyrus stack, so codex blocks the turn awaiting a response that never arrives, never reaches `task_complete`, and the runner's `turn.completed` handler is never invoked.**

This is the same family of bug — and indeed the same upstream defect — already documented in `docs/codex-hang-diagnosis.md` §1 + §2. What changed between BRI-1411 and BRI-1490 is the **trigger point**: BRI-1410 hung on a *post-implementation* `save_issue` (mark "In Progress" — codex chose to do this near the end of its turn); BRI-1489 hung on a *pre-implementation* `save_issue` + `save_comment` (codex followed the workspace agent guidance "Update the Linear issue status as you progress" and called both before doing the actual file edit).

Specific code references:

- **Not a runner bug:** `dist/CodexRunner.js:663-666` correctly handles `turn.completed`. No missing case statement. No missing terminal event. No re-mapping needed.
- **Not an SDK bug:** `@openai/codex-sdk/dist/index.js:78-92` correctly passes through `turn.completed` when codex emits it.
- **Upstream bug — codex CLI:** the streamable-HTTP MCP client awaits `tools/result` indefinitely. The default `tool_timeout_sec=60` either does not apply to streamable-HTTP MCP transports in 0.125.0, or fires silently without aborting the in-flight call (see `docs/codex-hang-diagnosis.md` §2.4 and §2.5; companion upstream issue `openai/codex#14470`).
- **Cyrus-side trigger:** workspace agent guidance ("Update the Linear issue status as you progress (In Progress → In Review → Done)") + cyrus-codex-runner exposing the `linear` MCP server with mutation tools. `dist/CodexRunner.js:470-549` (`buildCodexMcpServersConfig`) wires the entire server in/out, no per-tool filter.

The runner-side **completion gap** is therefore a *consequence* of the MCP hang, not an independent defect. The watchdog (BRI-1439) bounds the failure to ~3 minutes; nothing today recovers from it into a shipped PR.

---

## 5. Hypotheses Tested

The brief listed five hypotheses. Three are ruled out by the JSONL evidence; two are unrelated to the actual root cause.

### H1 — "codex needs an explicit 'you're done' signal in the prompt." **Ruled out.**

Both successful sessions (`2026/05/02/…149.jsonl`, `2026/04/25/…f5fe.jsonl`) used the same Cyrus prompt scaffolding (skill list, `<INSTRUCTIONS>`, `<context>`, `<linear_issue>`, agent_guidance) and produced `task_complete` cleanly. The failed sessions used identical scaffolding. The prompt is not the variable; the Linear MCP call is.

### H2 — "`approval_policy=never` confuses the terminal event." **Ruled out.**

`thread.runStreamed`'s `approvalPolicy` is set from `cyrus-codex-runner` at `dist/CodexRunner.js:432` (`approvalPolicy: this.config.askForApproval || "never"`). All four reference sessions ran with `approval_policy=never`. The two that succeeded reached `task_complete`; the two that failed did not. The flag is not the variable.

### H3 — "Skill scaffolding interacts oddly with codex's task lifecycle." **Ruled out.**

The successful 2026-05-02 session contains the same `<INSTRUCTIONS>...skill-creator...skill-installer...</INSTRUCTIONS>` block as the failed BRI-1489 session (verified by inspecting the user-message text in both rollouts). The scaffolding is identical, the lifecycle outcome differs. The skill block does not cause the hang.

### H4 — "Codex emits a terminal event the runner doesn't recognise." **Ruled out.**

There is no terminal event in the failed JSONLs at all — not even one the runner could mis-handle. The last events are `function_call` (orphan) → `token_count`. No `task_complete`, no `turn.failed`, no `error`, no `turn.aborted`. The runner is correctly waiting; codex is correctly not emitting; the bug is upstream of both.

### H5 — "Cyrus does NOT pass through MCP tools that codex needs to 'report done.'" **Not applicable.**

There is no codex protocol for "tool to report done" — completion is signalled by codex emitting `task_complete` on its own when the model finishes the turn. The model finishes the turn when all dispatched tool calls have returned. The bug is one specific tool call not returning, not a missing tool.

### Additional probe — `model_reasoning_effort=high` × `approval_policy=never`

Brief §5 suggested high reasoning + no human-in-the-loop might cause codex to over-think and never reach a terminal state. **Ruled out** by gap analysis: in BRI-1489, time from session start to first `agent_message` was 15 s; from first call to last call was 21 s; there is no stretch where codex "thinks for hundreds of seconds without acting" — the reasoning gaps are 5–13 s, normal for high-effort reasoning. The hang is not a reasoning loop; it is a silent block on a TCP socket.

### Confirming probe — `list_issues` (read) succeeds, `save_issue` (mutation) hangs

In BRI-1489, two parallel `mcp__linear__list_issues` calls (Hot label, Warm label) returned in 1.0 s and 2.2 s respectively (06:46:23.797Z, 06:46:24.955Z). Twelve seconds later in the same session the *same* Linear MCP server stalls indefinitely on `save_issue`. The endpoint is reachable, authenticated, and serving reads. **The stall is specific to write paths** — Linear-side or codex-side bug in mutation handling, not a transport or auth issue.

This narrows the scope of any future upstream investigation: a packet capture during a write hang would isolate "Linear server replies and codex drops it" vs "Linear server never replies." Out of scope for this BRI.

---

## 6. Fix Tiers

### Tier A — Stop having codex call `mcp__linear__save_issue` / `save_comment` (recommended)

**Cost:** small. Single edit to a system-prompt / agent-guidance file. No code in cyrus-codex-runner. No version bumps. No upstream PR.
**Where:**
- Workspace-level agent guidance in Linear ("Brilliantio Agent Operating Protocol") — the line *"Update the Linear issue status as you progress (In Progress → In Review → Done)"* should be qualified to apply only to runners that don't suffer from the codex MCP-mutation hang, OR removed entirely with a note that Cyrus's EdgeWorker handles transitions.
- `packages/edge-worker/src/PromptBuilder.ts` — when building the codex-runner system prompt, append a block instructing the model not to call `mcp__linear__save_issue` or `mcp__linear__save_comment`. Cyrus already moves the issue to `started` on assignment (per CLAUDE.md "Linear State Management") and posts the runner's final message as the completion comment. Codex does not need to drive these transitions itself.
- Optional belt-and-braces: in `packages/codex-runner/src/CodexRunner.ts` `buildCodexMcpServersConfig` (`dist:470-549`), add a per-server tool-allowlist field and filter `linear` to read-only tools (`list_issues`, `get_issue`, `search_documentation`, etc.). Codex 0.125.0's MCP server config does not support a tool-name filter at the transport level, so this would have to be enforced by the runner intercepting/rewriting the prompt's tool descriptions, not by codex itself. Skip this in the recommended path; the prompt-level instruction is sufficient if the model honours it (and codex on `gpt-5.3-codex` reliably does).

**Why this works:** the BRI-1410 and BRI-1489 sessions both hung exclusively on Linear MCP mutation calls. Removing those calls from codex's repertoire eliminates the trigger. The model still emits an `agent_message` final summary (visible in BRI-1489 at 06:46:38.622Z, *before* the hang), which the runner already turns into the Linear completion comment via `pendingResultMessage`. The state transition to `In Review` / `Done` is also a Cyrus-side operation, fired from EdgeWorker on PR creation, so the model attempting it in-turn is redundant.

**Recommended.** Smallest patch, addresses the actual trigger, no upstream dependency, leaves the watchdog as belt-and-braces for any residual write-path tool that ever stalls.

### Tier B — Per-tool-call timeout in cyrus-codex-runner (acceptable, more invasive)

**Cost:** medium-to-high. The runner does not currently sit between codex and the MCP server; it sits between the SDK iterator and the EdgeWorker. To enforce per-tool timeouts, the runner would need to maintain a map of in-flight `function_call` IDs (from `item.started` events) and trigger an abort when any single ID exceeds N seconds without a matching `item.completed` (or rollout `function_call_output`).

**Where:** `dist/CodexRunner.js:629-632` — augment the for-await loop to track call IDs and arm per-call timers in addition to the existing turn-level idle watchdog. Reset/clear timers on `item.completed`. On timer fire, push a diagnostic error message and abort.

**Why acceptable but not recommended:** more diagnostic ("Linear MCP `save_issue` hung at 60 s — aborting") but solves nothing the watchdog doesn't already solve at +180 s. Adds runner complexity for a bug whose better fix is "don't trigger it." Defer until the prompt-level fix is shown to be insufficient (which it should not be, given codex's tool-selection determinism for explicit prompt instructions).

### Tier C — `@openai/codex-sdk` version bump (deferred)

The SDK is a pass-through. Bumping it cannot fix a bug in the codex CLI. Per BRI-1411 §2.5, upstream `openai/codex#14470` documents an analogous "MCP future awaited without timeout" path with no fix yet. Recheck the codex-sdk and codex-cli changelogs every quarter; there is no current evidence that a newer version resolves streamable-HTTP MCP timeout enforcement on `tools/call`. **Deferred.**

### Tier D — Upstream PR to `ceedaragents/cyrus` and/or `openai/codex` (deferred)

A `ceedaragents/cyrus` PR could carry Tier A's prompt-level mitigation upstream after we validate it. An `openai/codex` PR (or follow-up to #14470) would address the actual codex-side MCP timeout enforcement. Both are higher-cost and gated on outside review; neither blocks Tier 2 shipping-grade unblock for our deployment. **Deferred.**

### Rejected

- Adding a `case "task_complete":` (or any other terminal-event case) to `dist/CodexRunner.js:642`'s switch — **rejected**. The runner is already correct; no terminal event is being missed.
- Forking `@openai/codex-sdk` to break the `for await (const line of rl)` loop on a heuristic — **rejected**. Same reason as BRI-1411 §4 Tier C: the SDK is internally consistent, and a heuristic break would risk false completions.

---

## 7. Recommended Path

**Implement Tier A as the next BRI ("BRI-XXXX — codex prompt mitigation: skip Linear MCP mutations").** Single PR. Two changes:

1. Add a `<codex_runner_constraints>` block (or extend the existing `<repository_routing_context>` system prompt section) in `packages/edge-worker/src/PromptBuilder.ts` that, when the active runner is `cyrus-codex-runner`, instructs the model: *"Do not call `mcp__linear__save_issue` or `mcp__linear__save_comment`. Cyrus handles Linear state transitions and the final completion comment automatically. Calls to those tools currently hang the Linear MCP server in this runner."*
2. Update the workspace agent guidance ("Brilliantio Agent Operating Protocol") to scope the *"Update the Linear issue status as you progress"* line — either add the same caveat for codex sessions, or migrate it to a runner-agnostic phrasing such as *"Do not change Linear state from inside the agent turn — Cyrus manages transitions."*

Verification protocol: re-dispatch a trivial codex BRI (e.g. the BRI-1489 watchdog test scope — append one blank line to a markdown file). Expected outcome: clean `task_complete` within 30–60 s; PR opens; no watchdog activation. If the watchdog still fires on a different MCP mutation call, broaden the prompt block to forbid all `mcp__linear__save_*` writes.

Tier 2 is shipping-grade once a single trivial codex BRI completes end-to-end without watchdog activation. The watchdog itself remains as the safety net for any unanticipated stall (per the BRI-1439 verification log, it is now confirmed to fire correctly in production at +225 s).

---

## Appendix — quick-reproduction recipe for the next BRI

To verify the Tier A fix without touching the live workspace, the next BRI's verification step can run codex CLI directly in `/tmp` with the proposed prompt addition and confirm:

1. Start a stub MCP that always stalls on writes (re-using `docs/codex-hang-diagnosis.md` §3.2's recipe), but expose only the *read* tools.
2. Run codex with a prompt that includes the new `<codex_runner_constraints>` block and asks for a trivial file change.
3. Confirm codex never dispatches a write-mutation MCP call, emits `task_complete` cleanly, and the codex subprocess exits with code 0.

If that confirms Tier A holds in isolation, ship it as the first runner-side change in cyrus-codex-runner's prompt path. Watchdog stays.

---

## References

- `docs/codex-hang-diagnosis.md` — original BRI-1411 diagnosis; root MCP-hang pathology.
- `docs/codex-runner-fix-runbook.md` — BRI-1439 watchdog patch + BRI-1489 production verification log.
- [BRI-1410](https://linear.app/brilliantio/issue/BRI-1410) — first observed zombie session.
- [BRI-1411](https://linear.app/brilliantio/issue/BRI-1411) — diagnosis BRI (companion to this one).
- [BRI-1439](https://linear.app/brilliantio/issue/BRI-1439) — watchdog Tier A + B implementation.
- [BRI-1489](https://linear.app/brilliantio/issue/BRI-1489) — watchdog production verification (canceled after observation).
- `openai/codex#14470` — upstream bug, "codex exec --json resume can hang indefinitely on macOS after MCP helpers start."
- `cyrus-codex-runner` `dist/CodexRunner.js:600-684` — `runTurn` + `handleEvent`; verified correct.
- `@openai/codex-sdk@0.107.0` `dist/index.js:78-92` — SDK pass-through; verified correct.
