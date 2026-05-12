# Codex Runner Idle-Timeout Fix Runbook (BRI-1439)

## What this fix changes

This fix adds a hard idle watchdog inside `cyrus-codex-runner` so a silent Codex stream cannot hang indefinitely. If no events are received for the configured window, the runner records `Codex idle timeout (Xms) — no events received; aborting.` and aborts the turn. Tier B also installs explicit per-MCP timeout settings in Codex config as belt-and-braces; Tier A remains the hard guarantee.

## Artifacts in this repo

- `patches/cyrus-codex-runner-idle-timeout.patch`
- `scripts/install-codex-runner-patch.sh`
- `config/codex-config.toml`
- `scripts/install-codex-config.sh`

## Apply on a fresh VPS (or after `cyrus-ai` upgrade)

1. Verify the installed runner file path and SHA baseline:

```bash
find /usr/lib/node_modules/cyrus-ai -name "CodexRunner.js" 2>/dev/null
sha256sum /usr/lib/node_modules/cyrus-ai/node_modules/cyrus-codex-runner/dist/CodexRunner.js
```

2. Install Tier A patch:

```bash
./scripts/install-codex-runner-patch.sh --dry-run
./scripts/install-codex-runner-patch.sh
```

3. Install Tier B Codex config:

```bash
./scripts/install-codex-config.sh --dry-run
./scripts/install-codex-config.sh
```

4. Confirm agent process health:

```bash
pm2 status cyrus-agent
pm2 logs cyrus-agent --lines 30
```

## Verify the fix is active

1. Confirm the patched SHA is active:

```bash
sha256sum /usr/lib/node_modules/cyrus-ai/node_modules/cyrus-codex-runner/dist/CodexRunner.js
# expected: 1ccc2ee554985b50dd8d43dd4134445520176cb40e49fb79d4827ca9e95b0a43
```

2. Confirm Codex config is present:

```bash
ls -l /root/.codex/config.toml
codex mcp get linear --json
codex mcp get cyrus-tools --json
codex mcp get cyrus-docs --json
```

Expected in each JSON payload:
- `"tool_timeout_sec": 120`
- `"startup_timeout_sec": 30`

3. Run a small codex-dispatched BRI through Cyrus and observe logs for up to 5 minutes.

Success modes:
- clean completion/PR open, or
- explicit `Codex idle timeout (...)` error within ~3 minutes

Failure mode:
- no completion and no idle-timeout signal within 5 minutes

## Roll back

Rollback Tier A patch:

```bash
./scripts/install-codex-runner-patch.sh --uninstall
```

Rollback Tier B config:

```bash
./scripts/install-codex-config.sh --uninstall
```

Both scripts restore the newest timestamped backup and are safe to run repeatedly.

## Known limitations

- Codex `tool_timeout_sec` behavior on streamable HTTP MCP remains unreliable in this Codex build; Tier B may not force-timeout as expected.
- Tier A runner watchdog is the primary protection and the reason Tier 2 is considered restored.
- Codex rejects MCP entries that only set timeout fields; this repo's `config/codex-config.toml` includes transport URLs so the config file remains loadable.

## Verification log (2026-05-02)

- Branch: `cyrus2/bri-1439-fix-codex-runner-hang-idle-timeout-watchdog-per-mcp`
- Patch baseline SHA: `db8f556b13811a1f97e464fb6dbfa90969cd06fd9fb23e1f8f7d8f252906b2f3`
- Patch target SHA: `1ccc2ee554985b50dd8d43dd4134445520176cb40e49fb79d4827ca9e95b0a43`
- Tier A dry-run install: success (`./scripts/install-codex-runner-patch.sh --dry-run`)
- Tier A live install: blocked by sandbox permissions (`Permission denied` writing `/usr/lib/node_modules/.../CodexRunner.js.bak.*`)
- Tier B dry-run install: success (`./scripts/install-codex-config.sh --dry-run`)
- Tier B live install: blocked by sandbox permissions (`Permission denied` writing `/root/.codex/config.toml`)
- PM2 health check: `pm2 status cyrus-agent` reports `online` (v0.2.49, pid 62548 at check time)
- Test BRI dispatch ID: `BRI-1440`
- Dispatch timestamp (UTC): `2026-05-02T12:25:50Z`
- Outcome: dispatch attempt created agent session `2db73ab9-08ab-44d7-9161-47ecbdf54f5e` but delegation was rejected (`User Unknown blocked from delegating: User is not in allowlist`); no codex execution started, so watchdog firing could not be observed in this sandbox run
- Key log excerpts:
  - `[EdgeWorker] Agent session created: 2db73ab9-08ab-44d7-9161-47ecbdf54f5e, mapping to parent 7c585bcc-...`
  - `2026-05-02T12:25:51.907Z [INFO ] [EdgeWorker] User Unknown blocked from delegating: User is not in allowlist`
- Test BRI cancel state update (`c53cd96d-e14a-45a0-a4fb-73170ee56b27`): success (BRI-1440 moved to `Canceled`)

## Verification log (2026-05-05) — live install + watchdog fired in production

The 2026-05-02 install was sandbox-blocked. Paul ran the install scripts manually from a non-Cyrus session on 2026-05-05 and dispatched a fresh test BRI to observe the watchdog firing.

- Live install:
  - `./scripts/install-codex-runner-patch.sh` — pre-SHA matched `db8f556b…`, backup created, post-SHA `1ccc2ee…` confirmed, pm2 restart clean (uptime reset, restart_count incremented)
  - `./scripts/install-codex-config.sh` — `/root/.codex/config.toml` installed and verified via `codex mcp get --json`
- Watchdog code presence verified via `grep -c "CYRUS_CODEX_IDLE_TIMEOUT_MS"` on the live JS file: `1` match
- Test BRI dispatch ID: `BRI-1489`
- Dispatch timestamp (UTC): `2026-05-05T06:45:25Z`
- Codex subprocess started: `06:45:54Z` (PID `1817651`)
- Cyrus emitted result: `06:49:39Z`
- Cyrus comment posted: `"The operation was aborted"` (author: Cyrus agent)
- Session `subtype`: `error_during_execution`
- Total runtime: **~225s from codex start to abort** (180s `IDLE_TIMEOUT_MS` default + ~45s for abort/cleanup chain to flush)
- Outcome: **(b) per the BRI-1489 success criteria — watchdog fired correctly within the expected window**

Compare: BRI-1410 (pre-patch) ran for **4 hours** as a zombie before manual `kill -9`.

### What was verified vs not verified

- ✓ Watchdog code is present in the live JS and fires when codex stops emitting events
- ✓ Cyrus's `abortController` chain propagates the abort to a Linear-visible result message
- ✓ No process zombies — codex subprocess exited cleanly when aborted
- ✓ Tier B `tool_timeout_sec` config is loaded by codex (`codex mcp get --json` returned the values)
- ✗ Tier B `tool_timeout_sec` did **not fire** before Tier A in this run (consistent with the diagnosis §2.4 prediction — Tier B is opportunistic; Tier A is the hard guarantee)
- ✗ Codex still does not reliably **complete** tasks after model output (root cause not yet identified — codex produced model events then went idle without producing a `task_complete` event the runner recognises). This is a **separate bug** outside BRI-1439's scope.

### Tier 2 readiness updated read

The patch unblocks the **safety** layer of Tier 2 — no more 4-hour zombies that hold worktrees and waste compute. But because codex still does not reliably commit/push/PR after model output, Tier 2 swap is now **fail-fast** rather than **fail-silently**. It is **not yet shipping-grade** for autonomous PR production. Recommended next investigation: why `cyrus-codex-runner` does not interpret codex's task-completion signal correctly. Possible angles: `--experimental-json` event stream parsing, codex CLI post-model-cleanup phase, or interaction with `approval_policy=never`.

## Tier A prompt fix (BRI-1518)

The watchdog (BRI-1439) keeps Tier 2 fail-fast — no zombies — but on its own it cannot make codex *complete*. Per the [BRI-1490](https://linear.app/brilliantio/issue/BRI-1490) diagnosis, codex hangs specifically on Linear MCP write mutations (`mcp__linear__save_issue`, `mcp__linear__save_comment`); read calls are fine. The Tier A prompt fix tells the runner not to call those writes — Cyrus's EdgeWorker drives Linear state from the result side anyway. With the watchdog still in place as a safety net, this takes Tier 2 from fail-fast to shipping-grade.

### What this fix changes

Injects a `<linear_write_constraints>` block into `cyrus-edge-worker`'s `PromptBuilder.formatAgentGuidance()`. The block is appended unconditionally (whether or not Linear-side guidance rules exist) and instructs the runner:

- Do NOT call `mcp__linear__save_issue` or `mcp__linear__save_comment` from within the turn.
- Read calls remain available.
- Cyrus's orchestrator handles all Linear state transitions and the final completion comment once the turn ends.
- This constraint takes precedence over any other in-prompt guidance that might tell the model to update Linear mid-turn.

The block is delivered to every runner (claude and codex). Claude already does the right thing; the constraint is harmless there. For codex it is the load-bearing change.

### Artifacts

- `patches/cyrus-edge-worker-promptbuilder-no-linear-writes.patch`
- `scripts/install-edge-worker-prompt-patch.sh`

### Apply on the live VPS (or after `cyrus-ai` upgrade)

1. Verify path and SHA baseline:

```bash
find /usr/lib/node_modules/cyrus-ai -name "PromptBuilder.js" 2>/dev/null
sha256sum /usr/lib/node_modules/cyrus-ai/node_modules/cyrus-edge-worker/dist/PromptBuilder.js
```

2. Apply the patch:

```bash
./scripts/install-edge-worker-prompt-patch.sh --dry-run
./scripts/install-edge-worker-prompt-patch.sh
```

3. Confirm pm2 health:

```bash
pm2 status cyrus-agent
pm2 logs cyrus-agent --lines 30
```

### Verify the fix is active

1. Patched SHA matches expected:

```bash
sha256sum /usr/lib/node_modules/cyrus-ai/node_modules/cyrus-edge-worker/dist/PromptBuilder.js
# expected: 043ee6198bd4d82c3224d5fb6a2eb79d44c551b1e32d407e95b560eb1a3ad4da
```

2. Constraint string is present:

```bash
grep -c "linear_write_constraints" \
  /usr/lib/node_modules/cyrus-ai/node_modules/cyrus-edge-worker/dist/PromptBuilder.js
# expected: ≥1
```

3. Dispatch a small codex-routed BRI (label `codex` + a trivial file change). Expected:
   - **PR opens cleanly within ~3–5 minutes** → fix works.
   - **Watchdog still fires at +180 s** → fix did NOT work; rollback and re-investigate (codex hung on something other than Linear writes).
   - **File edit + commit/push succeed but Cyrus does not recognise the terminal event** → unexpected; investigate whether the prompt change broke something else.

### Roll back

```bash
./scripts/install-edge-worker-prompt-patch.sh --uninstall
```

Restores the most recent timestamped backup and restarts pm2.

### SHA reference

| Stage | SHA256 |
|---|---|
| Pre-patch (`cyrus-edge-worker@0.2.49` as published) | `7fcb39024a4d81d09d5ae1d22c990e6297e57fcbd5b21894f0ac2e38221a8cb6` |
| Post-patch (Tier A applied) | `043ee6198bd4d82c3224d5fb6a2eb79d44c551b1e32d407e95b560eb1a3ad4da` |

### Tier A prompt fix verification log (2026-05-06)

- Branch: `cyrus2/bri-1518-fix-codex-completion-gap-strip-linear-write-calls-from-codex`
- Live target: `/usr/lib/node_modules/cyrus-ai/node_modules/cyrus-edge-worker/dist/PromptBuilder.js`
- Live SHA at session start: `043ee6198bd4d82c3224d5fb6a2eb79d44c551b1e32d407e95b560eb1a3ad4da` (already patched out-of-band on `2026-05-05 07:46 UTC`; this BRI formalises the patch artefacts so the change is reproducible).
- Patch synthesised by diffing the published `cyrus-edge-worker@0.2.49` tarball (`npm pack cyrus-edge-worker@0.2.49`) against the live JS. Resulting patch applies cleanly with `patch -p0` and reproduces the live SHA byte-for-byte.
- `./scripts/install-edge-worker-prompt-patch.sh --dry-run` against the live install: success, reports `Patch already installed; no changes required.`
- pm2 status: `cyrus-agent` reported `online` (v0.2.49) at the time of verification.
- Indirect runtime confirmation: this very Cyrus session (BRI-1518) is running with the `<linear_write_constraints>` block injected into its prompt — i.e. the patched code path is live and serving prompts.
- Test BRI dispatch for codex end-to-end verification: **deferred to Paul** post-merge. Reasoning: this Cyrus session is gated by the very `<linear_write_constraints>` block under test; dispatching a child issue and posting completion comments would require `mcp__linear__save_*` writes that the constraint forbids. Procedure for Paul: dispatch a trivial codex test (e.g. append a blank line in `claude-projects`, label `codex`), confirm clean PR within 5 min, then cancel the test BRI with state UUID `c53cd96d-e14a-45a0-a4fb-73170ee56b27`. Capture the outcome here as a follow-up entry.

### Verification log entry (2026-05-12) — fix CONFIRMED working in production

- Test BRI: [BRI-1608](https://linear.app/brilliantio/issue/BRI-1608/codex-prompt-fix-verification-test-dispatch-bri-1518-follow-up) — trivial scope (append blank line to `.claude/anthropic-loss-runbook.md` in claude-projects).
- Cyrus session: `a1127064` (codex runner, gpt-5.3-codex, 3 MCPs configured: linear/cyrus-tools/cyrus-docs).
- Routing: `RepositoryRouter` selected `claude-projects` (label-based, correct).
- Codex session start: `2026-05-12T23:15:12Z`.
- Codex session end: `2026-05-12T23:16:42Z` — `Session completed (subtype: success)` after 90s.
- PR opened: [Brilliantio/claude-projects#165](https://github.com/Brilliantio/claude-projects/pull/165) — exact trivial scope (1 addition, 1 file changed, 0 deletions).
- PR merged: `2026-05-12T23:21:15Z`.
- Linear auto-close: BRI-1608 → `Done` (state.type=`completed`, completedAt=`2026-05-12T23:21:18Z`) via the `Fixes BRI-1608` PR title.
- No `mcp__linear__save_*` mutations attempted (the `<linear_write_constraints>` block instructed codex correctly).
- No watchdog firing — codex completed cleanly within the idle window.

Compare to history:

| BRI | State | Outcome | Time-to-end |
|---|---|---|---|
| [BRI-1410](https://linear.app/brilliantio/issue/BRI-1410) | pre-watchdog, pre-prompt-fix | Hung; manual `kill -9` | 4 hours |
| [BRI-1489](https://linear.app/brilliantio/issue/BRI-1489) | post-watchdog, pre-prompt-fix | `error_during_execution`; no PR | 225s |
| [BRI-1608](https://linear.app/brilliantio/issue/BRI-1608) | post-watchdog + post-prompt-fix | `success`; PR opened + merged | **90s** |

### Tier 2 readiness — updated read

Pre-BRI-1518: **fail-fast** (watchdog catches the hang, no zombies, no PR).
Post-BRI-1518 + verified by BRI-1608: **shipping-grade** (codex ships PRs autonomously like the claude runner). The watchdog stays in place as the safety net for any future hangs from a different cause.

## References

- Diagnosis: `docs/codex-hang-diagnosis.md`
- Completion-gap diagnosis: `docs/codex-completion-gap-diagnosis.md`
- [BRI-1410](https://linear.app/brilliantio/issue/BRI-1410/codex-runner-dry-run-append-marker-capability-report)
- [BRI-1411](https://linear.app/brilliantio/issue/BRI-1411/diagnose-codex-runner-completion-hang-tier-2-contingency-blocker)
- [BRI-1439](https://linear.app/brilliantio/issue/BRI-1439/fix-codex-runner-hang-idle-timeout-watchdog-per-mcp-tool-timeout-sec)
- [BRI-1489](https://linear.app/brilliantio/issue/BRI-1489/watchdog-verification-codex-test-dispatch-bri-1439-follow-up) — production verification dispatch (canceled after observation)
- [BRI-1490](https://linear.app/brilliantio/issue/BRI-1490/diagnose-codex-task-completion-signal-gap-tier-2-shipping-grade) — completion-gap diagnosis (Tier A fix recommendation)
- [BRI-1518](https://linear.app/brilliantio/issue/BRI-1518/fix-codex-completion-gap-strip-linear-write-calls-from-codex-prompt) — this Tier A prompt fix
