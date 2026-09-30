# CYPACK-1546: reconcile main after live verification

Original PR head:6f1416f620eabddfe7e10ccb7d0f3f8c2e514b1c.
Main integrated:7d83b3ecf793c1fbb58d64a9d2179d6dea429f44.
Previous common base:819f54520608f741bf642565ab1c979919bf8060.

Merge main into the existing PR branch without rewriting reviewed commits.
Three conflicts: CHANGELOG.md, package.json and pnpm-lock.yaml. Preserve CYPACK-1546
under Unreleased and retain main's0.2.73 release notes/version set. Adopt main's
MCP SDK1.31.0 graph/removal of obsolete SDK and ip-address overrides; align the
feature's added direct edge-worker MCP dependency to ^1.31.0. No runtime TypeScript,
wire contract, containment implementation or existing F1 instrumentation changed.

The mandated post-merge audit found six advisories in the inherited graph. Direct
Fastify owners now require5.12.5; regenerate its compatible graph. Re-resolve the
stale fast-uri3/brace-expansion5 lock entries within their existing upstream ranges,
using pnpm --fix-lockfile; natural resolutions are3.1.8 and5.0.12. Fast-uri4 resolves
4.2.1. The brace-expansion override is redundant and removed; no new override added.
All dependency changes are reviewable in the lockfile and incremental artifact diff.
Audit now reports zero advisories. This dependency change requires fresh runtime
artifact provenance despite unchanged application source.

Package regressions:2070 passed/16 opt-in skipped; edge-worker1000 passed/13 skipped
included. CLI171 passed; withdrawal harness17 passed. Full build succeeds. Registered
source-withdrawal, Pause and stale-revision F1 pass under the updated graph. Historical
live/runtime134 evidence remains untouched; no implied acceptance of a new installed
runtime. New contained native/model/provider F1 evidence is controlled, not live.

Verifier owns whether/when to install and which live proofs need repeating. Neither
connor3456/home nor agentops4444, preview mappings/schedules, model login or saved
customer evidence was changed. No PR merge, release, publishing or deployment.

Messages and immutable native Codex F1 both PASS. Native:136 unique activity receipts,
141 deliveries,18 result commits/19 transmissions,2 children/5 delegation calls,
1 engineering publication/2 calls,5 denials. Both modes exercise ten renewals across
two25-second model turns while preserving references, receipt-only recovery, tick/
event admission, direct/ticket children and current-authority checks. Native also
repairs failing engineering tests and reconciles lost publication ACK. Evidence is
in evidence/cypack-1546-main-{messages,native}-summary.json. Full typecheck passes.

Reproduce: pnpm install --frozen-lockfile; pnpm build; pnpm test:packages:run;
pnpm --filter cyrus-ai test:run; pnpm --filter cyrus-f1 test:run withdrawal-probe.test.mjs;
node apps/f1/automation-drive.mjs; then the same drive with
CYRUS_F1_CODEX_IMAGE=sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f
and the explicitly owned CYRUS_TEST_DOCKER_HOST. Native image has no declared volumes;
no image pull, live credentials/provider calls, model spend or daemon changes.
Also run withdrawal-probe-drive.mjs with default, --source-withdrawal and
--revision-change. Explicit preloader source pin134 remains unchanged intentionally;
new source F1 imports the new built classes, while historical live tooling still
requires its reviewed installed134 target. No silent broadening of that pin.
