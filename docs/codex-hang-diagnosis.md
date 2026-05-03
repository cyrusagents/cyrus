# Codex Runner Completion Hang — Diagnosis (BRI-1411)

**Status:** Diagnosis only. No fix applied in this BRI.
**Trigger BRI:** [BRI-1410](https://linear.app/brilliantio/issue/BRI-1410/codex-runner-dry-run-append-marker-capability-report) (2026-05-01).
**Author:** Cyrus, on behalf of Paul.
**Codex CLI version inspected:** `codex-cli 0.125.0` at `/usr/bin/codex`.
**SDK version inspected:** `@openai/codex-sdk@0.107.0` (vendored under `cyrus-ai`).

---

## 1. Root Cause

A single MCP `tools/call` invocation — `mcp__linear__save_issue`, dispatched to the Linear remote MCP server (`https://mcp.linear.app/mcp`) — never returned a response, and **none of the three layers in the Cyrus codex stack has an enforced upper bound on tool-call duration**, so the call sat indefinitely:

1. **codex CLI 0.125.0** sent the `tools/call` over the streamable-HTTP MCP transport and waited for the response forever. The configured default `tool_timeout_sec` (60s per the [Codex config reference](https://developers.openai.com/codex/config-reference)) either does not actually fire on streamable-HTTP MCPs in this version, or fires silently without aborting the in-flight call. The OS process stayed alive, never closed stdout, and never emitted a `task_complete` event.
2. **`@openai/codex-sdk` 0.107.0**'s NDJSON event generator iterates `readline` lines from the child's stdout until **stdout EOF** — it does *not* break on `task_complete` / `task_failed`. Because codex never closed stdout, the SDK's `for await` loop in `dist/index.js:269` blocked indefinitely.
3. **`cyrus-codex-runner`'s `runTurn()`** at `packages/codex-runner/src/CodexRunner.ts:807-815` consumes that SDK iterator with a bare `for await` loop and applies no idle-timeout, watchdog, or process-tree liveness check. So the runner stayed in `isRunning = true` until Paul killed it 4 hours later.

The model session itself had completed all useful work (file edit, plan update, agent message) and was emitting one final post-completion housekeeping call (a Linear status update). The hang is therefore **not a model or business-logic problem** — it is a missing-timeout problem that Cyrus's `claude-runner` happens to escape because Anthropic's runner exposes terminal events that bound the wait.

In one sentence: **Cyrus shells out to `codex exec` and trusts it to exit; codex 0.125.0 will not exit if a streamable-HTTP MCP server stops responding mid-tool-call, and Cyrus has nothing on top of it that says "time's up".**

---

## 2. Evidence Chain

### 2.1. The hung session ended on an orphan `function_call`

Session JSONL: `/root/.codex/sessions/2026/05/01/rollout-2026-05-01T10-14-40-019de308-884f-7121-8a65-728b557d366d.jsonl` (70 events).

A full call/response trace through that file:

```
function_call         update_plan                    call_UTRgX6wvqGRvhoU48rWCdNu1   10:14:55.538Z
function_call_output  -                              call_UTRgX6wvqGRvhoU48rWCdNu1   10:14:55.555Z
function_call         exec_command                   call_hEGPA5iawzkZoSE68uLS4Yka   10:14:59.031Z
function_call_output  -                              call_hEGPA5iawzkZoSE68uLS4Yka   10:14:59.188Z
function_call         exec_command                   call_xGFH8AJJtMb0Xz0A2wRTaGkq   10:15:07.468Z
function_call         mcp__linear__list_issues       call_U7a3MfcDBrVj568KBU4KTqBS   10:15:07.468Z
function_call         mcp__linear__list_issues       call_ZjWVW0xmuPZi77gGRERm1ufe   10:15:07.469Z
function_call_output  -                              call_xGFH8AJJtMb0Xz0A2wRTaGkq   10:15:07.553Z
function_call_output  -                              call_U7a3MfcDBrVj568KBU4KTqBS   10:15:09.659Z
function_call_output  -                              call_ZjWVW0xmuPZi77gGRERm1ufe   10:15:10.776Z
function_call         update_plan                    call_MFQAIgr8mmCtqZrDYm0ZQLxt   10:15:16.025Z
function_call_output  -                              call_MFQAIgr8mmCtqZrDYm0ZQLxt   10:15:16.029Z
function_call         exec_command                   call_nGbYf1tgM8fwxNUbqD8Vg0mq   10:15:20.128Z
function_call_output  -                              call_nGbYf1tgM8fwxNUbqD8Vg0mq   10:15:20.224Z
function_call         exec_command                   call_7rSY6o27Y08d8aSWRf7TiRuZ   10:15:23.428Z
function_call_output  -                              call_7rSY6o27Y08d8aSWRf7TiRuZ   10:15:23.546Z
function_call         exec_command                   call_PC4vw0X23g3IYcOJDjlOP778   10:15:27.660Z
function_call_output  -                              call_PC4vw0X23g3IYcOJDjlOP778   10:15:27.748Z
function_call         exec_command                   call_yeDhWTOvMDtl3jT66jVdjBQN   10:15:30.932Z
function_call_output  -                              call_yeDhWTOvMDtl3jT66jVdjBQN   10:15:31.050Z
function_call         update_plan                    call_aiK3yxUxWVXZMBce9bOB4MxI   10:15:34.267Z
function_call_output  -                              call_aiK3yxUxWVXZMBce9bOB4MxI   10:15:34.274Z
function_call         mcp__linear__save_issue        call_3T4aMKgNG8XPmwWIcbwljJfg   10:15:43.045Z   ← orphan
```

13 prior calls all paired cleanly with their `function_call_output` within 5–2200ms. The 14th call — `mcp__linear__save_issue` with arguments `{"id":"BRI-1410","state":"In Progress"}`, call_id `call_3T4aMKgNG8XPmwWIcbwljJfg` — has **no matching `function_call_output`** anywhere in the file. The very last event in the session (`event_msg` of type `token_count`, 10:15:43.050Z) is the final usage tally codex emits *between* the call dispatch and the awaited response. After that: nothing, for four hours, until SIGKILL.

A working session for comparison — `/root/.codex/sessions/2026/04/25/rollout-2026-04-25T23-52-05-...jsonl` — terminates with an `event_msg` of payload type `task_complete`. The hung session never reached `task_complete` because the model is still mid-turn, blocked on a tool result.

### 2.2. SDK has no terminal-event break

`@openai/codex-sdk@0.107.0`, file `/usr/lib/node_modules/cyrus-ai/node_modules/@openai/codex-sdk/dist/index.js:258-286`:

```js
const exitPromise = new Promise(
  (resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  }
);
const rl = readline.createInterface({
  input: child.stdout,
  crlfDelay: Infinity
});
try {
  for await (const line of rl) {
    yield line;                       // ← yields every event verbatim
  }                                    // ← only exits on stdout EOF
  if (spawnError) throw spawnError;
  const { code, signal } = await exitPromise;
  ...
} finally {
  rl.close();
  child.removeAllListeners();
  try {
    if (!child.killed) child.kill();   // ← cleanup never reached if loop hangs
  } catch {}
}
```

The async generator does not pattern-match on `type === "task_complete"` or `task_failed`. Loop termination is exclusively driven by `child.stdout` reaching EOF. If the codex subprocess holds stdout open (because it is waiting for an MCP response), this loop is unkillable from inside Node.

### 2.3. cyrus-codex-runner does no watchdogging

`packages/codex-runner/src/CodexRunner.ts:802-815`:

```ts
private async runTurn(
    thread: Thread,
    prompt: string,
    signal: AbortSignal,
): Promise<void> {
    const streamedTurn = await thread.runStreamed(prompt, {
        signal,
        ...(this.config.outputSchema
            ? { outputSchema: this.config.outputSchema }
            : {}),
    });
    for await (const event of streamedTurn.events) {
        this.handleEvent(event);
    }
}
```

`handleEvent` only sets `pendingResultMessage` — it does not break the loop, force EOF on stdout, or call `abortController.abort()` even when it sees a `turn.completed` event. The `abortController` is forwarded into the SDK only as the `signal` option, but nothing inside the runner ever fires it on its own initiative. There is no idle-timeout, no `setTimeout(() => abortController.abort(), N)`, no per-tool-call watchdog. The only escape hatch is the global `AbortController` triggered by Cyrus's outer "session stop" path (here: human SIGKILL).

### 2.4. Codex `tool_timeout_sec` default did not save us

The Codex command line invoked by Cyrus (transcribed from the brief) sets only `mcp_servers.linear.url`, `mcp_servers.linear.http_headers.Authorization`, and the equivalent for `cyrus-tools` and `cyrus-docs`. It does **not** set `tool_timeout_sec` for any server. Per the [Codex configuration reference](https://developers.openai.com/codex/config-reference), `tool_timeout_sec` defaults to 60s — yet the call hung for 14,400s. Either:

- the default does not apply to streamable-HTTP MCP servers in 0.125.0, or
- the timeout fires internally but the call is not aborted (the future never resolves to an error), or
- the timeout default has been changed/disabled in 0.125.0.

The follow-up fix BRI should test all three, but for diagnostic purposes the practical fact is: in production conditions on `0.125.0`, no MCP timeout fires. The runner-level watchdog is therefore the only reliable defence.

### 2.5. Related upstream issue (different but adjacent failure mode)

[`openai/codex#14470`](https://github.com/openai/codex/issues/14470) — *"`codex exec --json resume` can hang indefinitely on macOS after MCP helpers start"*. The reporter identifies a code path inside codex where `built_tools()` → `list_all_tools()` awaits an MCP client startup future that never resolves, with no timeout. Affects `codex-cli 0.114.0` macOS arm64. **Status: open, no fix, no workaround.** The Cyrus failure mode here is not the same path (we hang mid-session on `tools/call`, not on startup), but the root pathology — *codex awaits an MCP future without a timeout* — is the same family of bug. Treat #14470 as evidence that the Cyrus-side fix should be defensive and not block on an upstream patch.

### 2.6. MCP server reachability today (2026-05-02)

Sanity check — both endpoints are reachable from the VPS:

```
$ curl -s -o /dev/null -w "cyrus-tools: %{http_code} (%{time_total}s)\n" --max-time 5 http://127.0.0.1:3456/mcp/cyrus-tools
cyrus-tools: 400 (0.002s)

$ curl -s -o /dev/null -w "linear:      %{http_code} (%{time_total}s)\n" --max-time 5 https://mcp.linear.app/mcp
linear:      401 (0.052s)
```

400 / 401 are expected for unauthenticated GETs against an MCP POST endpoint — the servers are alive and answering. The 2026-05-01 hang was therefore not a gross outage of `mcp.linear.app`; it was a single-call non-response (server stall, Cloudflare middlebox stall, dropped TLS connection without RST, or codex-side response-stream stall — Cyrus cannot distinguish these without packet capture).

---

## 3. Bisection

### 3.1. In-session bisection (executed)

Within the BRI-1410 session itself, with all three MCPs (`linear`, `cyrus-tools`, `cyrus-docs`) configured:

- `update_plan` (4×): all returned in <10ms.
- `exec_command` (6×): all returned in <250ms.
- `mcp__linear__list_issues` (2×): both returned in 2.2s and 3.3s.
- `mcp__linear__save_issue` (1×, last call of the session): **never returned**.

The fault is therefore localised to a *single specific call class*: a Linear MCP **mutation** (`save_issue`), not the surrounding read calls (`list_issues`) or the local stdio-equivalent calls (`exec_command`, `update_plan`). `cyrus-tools` and `cyrus-docs` cannot be the culprit in this session because the model never called them.

### 3.2. Out-of-Cyrus minimal bisection (recipe, not executed)

Per the brief's "do NOT run a long-running reproduction without a 2-minute timeout" rule (a previous attempt cost 4 hours), I did **not** run a fresh `codex exec` reproduction in this BRI. The follow-up fix BRI should run it. A deterministic recipe that exhibits the same failure mode without depending on the live Linear MCP weather:

```bash
# Terminal 1 — start a stub HTTP server that accepts MCP POSTs and never replies.
python3 - <<'PY' &
import http.server, time, json
class Stall(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        # Pretend to be an MCP server but never respond.
        time.sleep(86400)
    def do_GET(self):
        self.send_response(200); self.end_headers()
    def log_message(self, *a, **k): pass
http.server.HTTPServer(("127.0.0.1", 9999), Stall).serve_forever()
PY
STUB_PID=$!

# Terminal 1 (or 2) — run codex with that stub as the only MCP, 120s wall-clock cap.
timeout 120 /usr/bin/codex exec \
  --experimental-json \
  --skip-git-repo-check \
  --config 'mcp_servers.stalled.url="http://127.0.0.1:9999/mcp"' \
  --config 'tools.web_search=false' \
  --model gpt-5.3-codex \
  "Use the stalled MCP to call any of its tools, then say done." \
  > /tmp/codex-repro.ndjson 2>&1
echo "exit=$?"
kill $STUB_PID 2>/dev/null

# Inspect — expect to see no task_complete event, and codex was killed by `timeout`.
tail -3 /tmp/codex-repro.ndjson
```

Observed expectation: `timeout` returns 124, the NDJSON tail ends mid-turn with no `task_complete`, and there is no orderly shutdown event from codex. That is the failure mode Cyrus saw.

To bisect MCP-by-MCP outside the stub above, replace `mcp_servers.stalled.url` with each real Cyrus MCP one at a time using a trivial prompt that does *not* require any of them, then with prompts that force each MCP. We expect the local stdio/HTTP `cyrus-tools` and the static `cyrus-docs` server to behave normally; the suspect remains a Linear MCP `tools/call` race that depends on Linear-side timing.

---

## 4. Recommended Fix (Ranked by Cost)

### Tier A — Wrapper-side idle-timeout watchdog in `cyrus-codex-runner` (recommended)

**Cost:** medium (single-file patch in `packages/codex-runner/src/CodexRunner.ts`, ~30 LOC, plus a unit test).
**Where:** `runTurn()` at lines 802-815 of `packages/codex-runner/src/CodexRunner.ts`.
**Change:** wrap the `for await` loop with an inactivity timer. Reset the timer on every event received (i.e. every iteration of the loop). If no event arrives for N seconds (suggested default: 180s, configurable via runner config), call `this.abortController.abort()` and let the SDK's `finally` block kill the subprocess tree.

Sketch:

```ts
const IDLE_TIMEOUT_MS = this.config.idleTimeoutMs ?? 180_000;
let idleTimer: NodeJS.Timeout | undefined;
const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        this.errorMessages.push(
            `Codex idle timeout (${IDLE_TIMEOUT_MS}ms) — no events received; aborting.`
        );
        this.abortController?.abort();
    }, IDLE_TIMEOUT_MS);
};
armIdle();
try {
    for await (const event of streamedTurn.events) {
        armIdle();
        this.handleEvent(event);
    }
} finally {
    clearTimeout(idleTimer);
}
```

This is independent of any codex / SDK / MCP-server fix, lives entirely in code Cyrus already controls, and protects against every "process alive but silent" failure mode (this hang, #14470, future variants). It is the smallest viable change that unblocks Tier 2 contingency.

### Tier B — Cyrus config change in `~/.cyrus/config.json` (cheap, may not fix)

**Cost:** minimal (one config key).
**Change:** add explicit `tool_timeout_sec` and `startup_timeout_sec` overrides for each codex MCP server. Mechanically this would translate to an extra `--config 'mcp_servers.linear.tool_timeout_sec=120'` CLI flag generated by `cyrus-codex-runner` from config.

```jsonc
// in ~/.cyrus/config.json — DO NOT apply to live config until tested in a follow-up BRI
"runners": {
  "codex": {
    "mcpServers": {
      "linear":      { "toolTimeoutSec": 120, "startupTimeoutSec": 30 },
      "cyrus-tools": { "toolTimeoutSec": 120, "startupTimeoutSec": 30 },
      "cyrus-docs":  { "toolTimeoutSec": 120, "startupTimeoutSec": 30 }
    }
  }
}
```

Why this might not fix it: per §2.4, the codex 0.125.0 default of 60s already failed to fire. We cannot rely on this in isolation. Ship it together with Tier A, not instead of Tier A.

### Tier C — Patch-package fork of `@openai/codex-sdk`

**Cost:** expensive (fork, vendor, maintain through SDK upgrades).
**Change:** make the NDJSON generator break out of its `for await (const line of rl)` loop on receipt of a `task_complete` / `task_failed` event, then `child.kill()` and exit cleanly.

Why this is wrong here: in the BRI-1410 hang, no terminal event was ever emitted, so an event-driven break would not have helped. The SDK is internally consistent — it correctly reflects "the model is still in turn" when the model is still in turn. The defect lives in codex's MCP client. Forking the SDK is the wrong shoulder to push on. Reject.

### Tier D — Upstream PR to `ceedaragents/cyrus`

**Cost:** very high (timeline measured in weeks, gated on upstream review).
**Change:** ship Tier A's idle-timeout patch in the upstream `cyrus-codex-runner`.

Worth doing eventually, but not in the critical path for our Tier 2 unblock.

### Recommended order

1. **Now (Tier 2 contingency unblock):** ship Tier A.
2. **Same PR (cheap belt-and-braces):** ship Tier B.
3. **After Tier 2 is restored:** open an upstream PR (Tier D) carrying Tier A's patch.
4. **Optional:** file a separate upstream issue against `openai/codex` describing the streamable-HTTP-MCP hang (companion to #14470).

---

## 5. Tier 2 Readiness Statement

**Today (without any fix): codex runner cannot ship PRs reliably.** A single non-deterministic stall in any remote MCP `tools/call` produces a 4-hour zombie that consumes a Cyrus session slot, emits no PR, and produces only an error activity on Linear when human intervention finally kills it. Mean time to failure depends on Linear MCP server weather, but the failure is silent and unbounded — exactly the failure mode that disqualifies a runner from contingency duty.

**With Tier A applied: codex runner is Tier-2-ready.** A 180s idle-timeout converts the failure from "indefinite zombie" into "explicit `Codex idle timeout` error activity within 3 minutes of the last event". That is the same loss-of-session class as a network blip on a claude-runner BRI, which Cyrus already handles via reassignment / retry. The runner will still occasionally fail-fast on Linear MCP stalls, but failures will be visible, bounded, and actionable.

**Recommendation:** scope a follow-up BRI to implement Tier A + Tier B as a single PR. Until that BRI lands, the codex runner remains in a degraded posture; treat it as best-effort, not contingency-grade.

---

## Appendix: minimal-reproduction command (re-runnable)

The recipe in §3.2 is the canonical re-runnable confirmation. The shortest variant — for someone who only wants to confirm that "codex exec hangs forever on a non-responsive MCP" — is:

```bash
python3 -c '
import http.server, time
class S(http.server.BaseHTTPRequestHandler):
    def do_POST(self): time.sleep(86400)
    def do_GET(self): self.send_response(200); self.end_headers()
    def log_message(self,*a,**k): pass
http.server.HTTPServer(("127.0.0.1",9999),S).serve_forever()
' &
SP=$!
timeout 120 /usr/bin/codex exec --experimental-json --skip-git-repo-check \
  --config 'mcp_servers.stalled.url="http://127.0.0.1:9999/mcp"' \
  --model gpt-5.3-codex "Call any tool from the stalled server then say done."
echo "exit=$?"   # expect 124 (timeout-killed)
kill $SP
```

If this exits with code 124 and no `task_complete` event was emitted, the bug is reproduced.

---
## Update — fix landed

Tier A + Tier B implemented in BRI-1439. See `docs/codex-runner-fix-runbook.md` for apply/verify/rollback. Tier 2 contingency is now shipping-grade.
