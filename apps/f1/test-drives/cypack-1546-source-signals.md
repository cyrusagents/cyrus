# Structured admitted signals — October 1, 2026

Executable and committed driver: `03e2d63aa31e863377450933fb1819c3950236e2`.
Previous accepted executable: `b14f6334dfa179a6863372ae3e2d537de42203d0`.
PR1507 / CYPACK-1546. No live runtime or provider changes.

## Change and authority boundary

The registered runtime previously joined its instructions and input as unlabeled
text. Both contained model adapters now label the instructions and admitted input
separately and distinguish source notifications, verified direct mentions, Linear
changes/comments, schedules, internal completion and operator instructions. The
entire Hosted JSON/escaped envelope is preserved verbatim on initial execution
and fresh-context recovery. The runtime does not classify provider messages or
parse model-supplied metadata into authority.

Only an immutable ledger occurrence with `trigger:tick` gets a model-only
`signal` envelope: `version:1`, `kind:schedule.tick`, `intent:scheduled_check`,
`provenance:{occurrenceId,scheduledAt,source:internal,selectedTrigger:schedule.tick}`,
`content:{trust:internal_trigger,data:{text:<unchanged input>}}`.
Stored input, admitted input, deduplication, checkpoint identity and operation
receipts are unchanged. Text saying “Scheduled automation tick” cannot choose
this path. Historical checkpoints are not rewritten to invent provenance.

Verified mentions address the agent and generally warrant relevant permitted
responses; ordinary notifications may be observed silently. External content is
untrusted requests/evidence, never permission or instruction authority. A reply
still needs a currently permitted explicit scoped tool; completion never posts
its final result automatically. Real server checks remain the security boundary;
these model instructions do not replace them.

Hosted owns provider-verified classification, common provenance/type-specific
fields, source deduplication and visible signal/activity projection. Runtime shape
coordination: Hosted fb212450, Runtime 7cd65522 and 02071a09. Matching Hosted
counterpart6dab9812d99b3935eaecf07b9b30f82aeb9c0d56 confirmed in1eabd333; its
source/SQL/UI evidence is separate from this installed Runtime proof. No new wire capability,
provider consumer, authority cache or customer-specific scheduler.

## Verification

- 82 focused tests passed, one opt-in native skip; final shape-only regression
  rerun: 61 passed/one skip. Whole initial/recovery prompt assertions preserve
  spoofed XML delimiters/JSON authority fields, original scope and absent reply
  grants across source/mention/Linear/schedule/completion input examples.
- Lint/build/typecheck hooks passed. Installed provenance checks all 17 packages
  and 17 resolved copies from the exact executable.
- Installed exact native F1 passed: 19 result commits/20 transmissions, 143 unique activity receipts/149 deliveries, 5 denials, one engineering publication across lost ACK, direct/ticket children, 51-second renewed read and actual event/tick envelope assertions.
- The final driver parses the actual native request's intact JSON envelope and
  asserts separate `slack.mention`/`slack.message` markers, untrusted external
  content, spoofed delimiters contained in text and no reply tool. Tick guidance
  is present in actual model input. Existing event duplicate/out-of-order queue,
  scope/revocation, direct/ticket child and engineering/receipt cases are retained.
- Coordinator independently replayed preceding2316: 19 commits/20 transmissions,
  143 unique activities/149 deliveries, 5 denials and one engineering publication.
  Final03e2 differs only in common field vocabulary/fixture alignment.

## Artifact and reproduction

Bundle `cyrus-0.2.73-cypack1546.03e2d63aa31e-test-bundle.tar.gz` SHA256
`25fab4f3e5d0d46ac77142c23f5987bea9cba8289f341baea8036f3de8055165`.
Folder `/Users/agentops/.cyrus/CYPACK-1546/attachments/source-signals-03e2d63a/`.
`HANDOFF.md`, `BUILD.json`, `installed-provenance.json`, `package-smoke.json`,
`registered-native-f1.json` and retained test logs provide exact evidence.

Build with `node scripts/build-local-artifact.mjs CLEAN_CHECKOUT FULL_SHA NEW_OUTPUT`;
extract, run `install.sh NEW_PREFIX`, then `scripts/verify-local-artifact.mjs
EXTRACTED NEW_PREFIX FULL_SHA`. From exact source run the handoff's
`run-installed-smoke.mjs NEW_PREFIX FULL_SHA EVIDENCE_DIRECTORY` with
`CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f`
and authorized `CYRUS_TEST_DOCKER_PATH` / `CYRUS_TEST_DOCKER_HOST`. Only driver
package import paths change. No image pull/network/host mounts/volumes.
No registry publication or minimum published scoped version exists.

## Limits

Docker/native Codex, runtime HTTP/SQLite, SDK transport and durable activity
handling are real. Model, Hosted/provider transport and publication callbacks are
controlled. This verifies structured transport and runtime enforcement, not live
model compliance, signed provider classification, Hosted UI or live all-signal
acceptance. Those remain separately owned by Hosted/coordinator. Live3456/4444,
homes, checkpoints,8007 and customer/provider state untouched. No merge/release or
deployment. Broader performance work is deferred to CYHOST-1330.
