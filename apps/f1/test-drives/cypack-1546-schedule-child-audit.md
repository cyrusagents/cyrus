# CYPACK-1546: current native schedule and child audit

Installed Runtime `75438a10deb245e172bf07b7435ad321d9b7fa7a`, frozen Hosted
`5429c3cad4aeff975f5c1c668fc0d48754b9c66c`. Same immutable arm64 contained image
`sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f`.
This baseline proof uses the unchanged754 artifact. The patch adds the existing
`instruction-tick` scenario to the native launcher's selectable modes and prepares
the [protocol-only admission contract](../../../docs/mcp-protocol-admission.md).

F1 applies to the launcher change. Actual installed registered routes, SQLite,
Hosted admission/SQL, MCP SDK, native Codex/container and session receipts run with
controlled provider/model decisions and prepared outbox delivery. No live model,
provider, preview runtime or customer mutation.

| Scenario | Completed occurrences | Model requests | Native opens/closes | Result transmissions |
| --- | ---: | ---: | ---: | ---: |
| instruction-tick | 2 | 6 | 2/2 | 3 |
| read-set-direct-child | 2 | 8 | 2/2 | 3 |
| read-set-ticket-child | 2 | 8 | 2/2 | 3 |

PASS:87 tests,965 assertions,74.64s for the existing Hosted SQL suite and these
three native modes. Tick: one instruction plus one scheduled occurrence through
the registered entry, deduplicated instruction, four unauthorized-route denials
and automatic lost-result-ACK recovery. Each child mode: parent and isolated child,
three native child requests, no private parent context in child input, exact
parent/optional issue association, one saved child-result event, ordered timeline
receipts and lost activity/result ACK recovery. Direct creates no Linear session;
ticket metadata/provider identity are controlled, not a live assignment proof.

Focused Runtime regressions:17 pass (47 excluded by test-name filter), covering
offline tick coalescing/FIFO/no paused-time catch-up, bounded recovered tick
fences, invalid child role/parent/ticket/schedule denial, and root/direct/ticket
flush-before-result and receipt-only recovery. Real SDK client suites:5 pass,
including renewal interleaved with initialize/slow writes, current reference
isolation, and a new initial-catalog denial after successful handshake which sends
no tools/call. The new denial runs in both continuation modes; it does not substitute
for Hosted SQL negatives on the proposed protocol-only optimization.

## Remaining boundaries

The child modes stop at the saved result event and do not exercise the production
dispatcher creating a parent successor. Engineering-to-parent has separate
installed754/Hosted70ea production-dispatch proof. Coordinator's live754/5429
observation subsequently confirmed direct child completion and automatic parent
successor4429f73b, but the journey FAILED: the successor applied memory despite
the original no-memory restriction and lost the original work-thread origin.
Hosted's child-result admission omitted the initiating operator instruction;
Runtime preserves admitted definition/input through context refresh but cannot
recover missing instructions from another occurrence's private checkpoint.
Hosted owns the admission/origin correction (handoff a8d8f589).

The parent also repeatedly called read_context while waiting. Runtime prepares
context once per attempt; later calls were model-selected. This patch clarifies
read_context is not a child-status/wait API and that delegation completes through
a later admitted parent input. It changes guidance, not authorization or forced
execution. Controlled native validation checks complete dynamic-tool descriptions
reach the actual provider request; it cannot establish real model compliance.
The context regression checks the entire fresh successor prompt, including
server-supplied original no-memory/no-external-reply constraints, without loading
another occurrence's checkpoint. Live constraint preservation remains unaccepted.

Hosted owns the missing workspace GitHub installation bridge for code handoff/PR
observation. It is not a reason to invent a second runtime or broaden child scope.
Current protocol-only optimization is a proposal until Hosted acknowledges and
publishes it. List/call/provider checks, renewal, result reconciliation and the
existing754 artifact remain unchanged. New tool guidance requires a separately
reviewed executable artifact. Live responsiveness is still unaccepted.

## Reproduction

```sh
CYRUS_TEST_DOCKER_PATH=/usr/local/bin/docker \
CYRUS_TEST_DOCKER_HOST=unix:///var/run/docker.sock \
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f \
CYRUS_NATIVE_JOIN_MODES=instruction-tick,read-set-direct-child,read-set-ticket-child \
node apps/f1/native-context-join/run-hosted-native.mjs HOSTED_CHECKOUT \
  5429c3cad4aeff975f5c1c668fc0d48754b9c66c INSTALLED_PREFIX \
  75438a10deb245e172bf07b7435ad321d9b7fa7a NEW_EVIDENCE_DIRECTORY
```

Original and adapted exact Hosted sources and SHA256s are retained under
`attachments/native-schedule-children-5429-7543` in CYPACK-1546. Frozen source
seams fail if the counterpart changes; no Hosted worktree files are edited.

## Installed async-guidance candidate

Executable `d66ed0a86d0d925fe88469a142da93f640aee416` changes only the runtime
read_context/delegate_investigation descriptions. A fresh isolated install verifies
17 packages and 17 resolved copies, CLI version/help and sourceSha provenance.
Bundle SHA256: `046ebac187a90ec985967b548af421522051687dcc3941ce877ade46c17b8d49`.

Exact installed candidate/frozen Hosted5429 native direct + ticket child modes:
**86 tests,951 assertions PASS in40.49s**. Each completes two occurrences with
8 model requests,2 native opens/closes,3 child requests,3 result transmissions,
ordered receipts and automatic lost-ACK recovery. Each observes the complete new
delegation description on5 actual native provider requests; child context remains
isolated. [Bounded evidence](evidence/cypack-1546-async-child.json).
Focused automation suites:66 pass/1 opt-in skip. The3 context-recovery regressions
pass with Hosted's exact admitted event.continuation shape and whole-prompt
assertions; original instructions, work reference and child findings survive
fresh context preparation without a prior native transcript.

Reproduce the command above with this runtime SHA/prefix and
`CYRUS_NATIVE_JOIN_MODES=read-set-direct-child,read-set-ticket-child`.
No live runtime was upgraded. This guidance is not a containment rule, does not
forbid legitimate context reads, and cannot prove real-model compliance. Hosted's
original-input/work-origin correction and its production callback/admission join
remain required before repeating coordinator-owned live child acceptance.
