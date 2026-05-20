# OpenCode Runner Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the OpenCode runner works through replay tests, selection tests, activity formatting tests, guarded live probes, and F1 documentation.

**Architecture:** Keep behavior tests close to the runner package for OpenCode JSON transcript mapping, and use edge-worker tests only where the EdgeWorker/AgentSessionManager boundary is the behavior under test. Live OpenCode execution remains opt-in behind environment variables so normal CI stays deterministic.

**Tech Stack:** TypeScript, Vitest, pnpm workspaces, F1 CLI/server test-drive workflow.

---

### Task 1: Replay Fixture Coverage

**Files:**
- Create: `packages/opencode-runner/test/fixtures/opencode-run-realistic.jsonl`
- Modify: `packages/opencode-runner/test/OpenCodeRunner.test.ts`

- [ ] **Step 1: Write failing replay test**

Add a test that runs a fake `opencode` binary emitting a richer JSONL fixture with `snake_case` fields, pending/completed tool events, error tool events, structured output, and `step_finish` usage/cost.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-opencode-runner test:run -- OpenCodeRunner.test.ts`
Expected: FAIL until the fixture and any missing coercions exist.

- [ ] **Step 3: Implement minimal mapping/coercion fixes**

Only update `packages/opencode-runner/src/OpenCodeRunner.ts` if the replay proves a real missing mapping.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter cyrus-opencode-runner test:run -- OpenCodeRunner.test.ts`
Expected: PASS.

### Task 2: Activity Formatting Coverage

**Files:**
- Create: `packages/edge-worker/test/AgentSessionManager.opencode-runner-activity.test.ts`

- [ ] **Step 1: Write failing AgentSessionManager test**

Instantiate `AgentSessionManager` and `OpenCodeRunner`, drive the runner with a fake OpenCode transcript, pass generated messages into `handleClaudeMessage`, and assert Linear-style activities include OpenCode text plus `Read`/`Edit` action parameter and result entries.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-edge-worker test:run -- AgentSessionManager.opencode-runner-activity.test.ts`
Expected: FAIL if OpenCode messages do not produce timeline activity.

- [ ] **Step 3: Implement minimal activity fixes**

Only update formatter or manager code if action/text visibility is missing.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter cyrus-edge-worker test:run -- AgentSessionManager.opencode-runner-activity.test.ts`
Expected: PASS.

### Task 3: Runner Selection Assertions

**Files:**
- Modify: `packages/edge-worker/test/EdgeWorker.runner-selection.test.ts`

- [ ] **Step 1: Write failing assertions**

Extend OpenCode label and `[agent=opencode]` tests to assert the OpenCode runner receives the expected working directory, allowed tools, model behavior, and that selector precedence is preserved.

- [ ] **Step 2: Run test to verify it fails or confirms current behavior**

Run: `pnpm --filter cyrus-edge-worker test:run -- EdgeWorker.runner-selection.test.ts`
Expected: PASS if existing implementation already satisfies the stronger assertions; otherwise FAIL with the missing config detail.

- [ ] **Step 3: Implement minimal selection/config fix if required**

Keep changes scoped to runner selection/config creation.

- [ ] **Step 4: Re-run selection test**

Run: `pnpm --filter cyrus-edge-worker test:run -- EdgeWorker.runner-selection.test.ts`
Expected: PASS.

### Task 4: Guarded Live Probe

**Files:**
- Create: `packages/edge-worker/test/opencode-cli-probe.live.test.ts`

- [ ] **Step 1: Add guarded live test**

Create a Vitest test skipped unless `OPENCODE_LIVE=1`, using `OPENCODE_PROBE_MODEL` and optional `OPENCODE_PATH`, with a clear skip message and no network assumptions when disabled.

- [ ] **Step 2: Run disabled probe**

Run: `pnpm --filter cyrus-edge-worker test:run -- opencode-cli-probe.live.test.ts`
Expected: PASS/SKIP without requiring OpenCode.

- [ ] **Step 3: Document live command**

Include the command `OPENCODE_LIVE=1 OPENCODE_PROBE_MODEL=openai/gpt-5.5 pnpm --filter cyrus-edge-worker exec vitest run test/opencode-cli-probe.live.test.ts` in the test or F1 report.

### Task 5: F1 Test Drive Report

**Files:**
- Create: `apps/f1/test-drives/2026-05-20-ng64-opencode-runner-validation.md`

- [ ] **Step 1: Run F1 protocol**

Use a fresh `/tmp/f1-test-drive-ng64-*` repo, start F1 on port 3600 or another free port, create an `[agent=opencode]` issue with the `opencode` label, start the session, inspect activities, and stop the session.

- [ ] **Step 2: Write report**

Record commands, timeline evidence, pass/fail checklist, any limitations, and live probe command.

### Task 6: Verification And Ship Readiness

**Files:**
- Modify: `CHANGELOG.internal.md` if this is internal-only validation work.

- [ ] **Step 1: Run focused tests**

Run package-level OpenCode and edge-worker focused tests.

- [ ] **Step 2: Run required validation**

Run: `pnpm test:packages:run`
Run: `pnpm typecheck`

- [ ] **Step 3: Review diff and document limitations**

Ensure remaining limitations are explicit in the F1 report and final summary.
