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

## References

- Diagnosis: `docs/codex-hang-diagnosis.md`
- [BRI-1410](https://linear.app/brilliantio/issue/BRI-1410/codex-runner-dry-run-append-marker-capability-report)
- [BRI-1411](https://linear.app/brilliantio/issue/BRI-1411/diagnose-codex-runner-completion-hang-tier-2-contingency-blocker)
- [BRI-1439](https://linear.app/brilliantio/issue/BRI-1439/fix-codex-runner-hang-idle-timeout-watchdog-per-mcp-tool-timeout-sec)
- [BRI-1489](https://linear.app/brilliantio/issue/BRI-1489/watchdog-verification-codex-test-dispatch-bri-1439-follow-up) — production verification dispatch (canceled after observation)
