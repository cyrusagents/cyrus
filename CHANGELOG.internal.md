# Internal Changelog

This changelog documents internal development changes, refactors, tooling updates, and other non-user-facing modifications.

## [Unreleased]

### Added
- **CYR-89 dev-fleet drive record**
  ([CYR-89](https://linear.app/northrop-digital/issue/CYR-89/verify-the-operator-surface-post-deployment-and-decide-the-recovery)).
  `apps/f1/test-drives/2026-09-10-cyr-89-operator-surface.md` records the
  post-deployment verification of the operator surface against `rg-cyrus`:
  scope items 1 and 2 pass with captured output, item 3 is unrun (recovery
  stays disabled, and the fleet currently has no strand to recover), item 4's
  install half is out of scope. Four rows are marked NOT VERIFIABLE rather
  than passing — redaction has nothing to act on in the source, two Entra rows
  need Graph changes, and workspace ambiguity is unprovable on a single-workspace
  router. Three defects found by running it are filed as #85 (a JSON `null`
  attribute rendered as the string `"null"`), #86 (the `/setup` allowlist
  gating the operator API through the Easy Auth sidecar) and, correcting
  CYR-89's own premise, #82 (`reclaimStranded` does not and will not collect a
  stranded sandbox whose worker is still connected).

### Fixed
- **`scripts/deploy-worker-image.sh` reports why the manifest read failed
  instead of blaming the media type**
  ([CYR-89](https://linear.app/northrop-digital/issue/CYR-89/verify-the-operator-surface-post-deployment-and-decide-the-recovery),
  [#80](https://github.com/nick-boey/cyrus/pull/80)).
  The check ran `az acr manifest show ... 2>/dev/null || true` and attributed an
  empty stdout to the media type, so every way the command can fail — a
  throttle, a credential problem, a change in the preview command group —
  surfaced as `could not read the manifest media type`, pointing at an image
  whose type was correct. It stalled the private deployment repository's
  `Update Cyrus Pin` through 36 consecutive runs from 2026-09-09T11:50Z before
  anyone read the manifest by hand. #79 removed the redirect independently and
  landed first; what remains here is the other half — the failure message no
  longer names the media type at all. By that point the digest is already in
  the registry, so a failure there is never about the image's kind, and saying
  so is what sent everyone to inspect an image that was correct. Case 23 in
  `deploy-worker-image.test.sh` pins both halves: it asserts the real stderr
  reaches the operator AND that the message makes no media-type claim. #79
  also found the root cause the message was hiding — a GitHub Actions OIDC
  login goes stale about ten minutes in, and the image no longer builds in ten
  minutes.
- **The worker image now carries the Bicep, PowerShell, pnpm and .NET 8
  toolchains, and the sandbox can reach the three registries their gates need
  ([CYR-88](https://linear.app/northrop-digital/issue/CYR-88/sandbox-cannot-run-the-bicep-powershell-pnpm-or-net-8-repository-gates),
  [#78](https://github.com/nick-boey/cyrus/pull/78)).** All four gates failed at
  *bootstrap* rather than failing a check, which is a different and worse
  thing: the gate was absent, and a `check-all.sh`-style script aborts at the
  first missing tool, so every later step silently never ran.

  - **`corepack enable` had to move to build time, and the reason is
    permissions, not egress.** `registry.npmjs.org` was allowlisted the whole
    time — the reported "`corepack enable` fails (cannot fetch pnpm)" is
    actually `EACCES: permission denied, symlink … -> '/usr/local/bin/pnpm'`,
    because corepack writes its shims next to `node` in a root-owned directory
    and sessions run as `cyrus`. Diagnosing this from the reported symptom
    leads to the wrong fix. Node 22's corepack creates only
    `pnpm`/`pnpx`/`yarn`/`yarnpkg` — not an `npm` shim — so it cannot shadow
    the image's own npm. `PNPM_VERSION` is the global default for a repo that
    pins nothing; a repo's `packageManager` field still wins and is fetched on
    demand.

  - **Baking `az bicep install` would not have worked.** It writes to
    `~/.azure/bin`, and `$HOME` is `/root` at build time — the same trap
    `fleece`'s `--tool-path` avoids. The binary goes on `PATH` instead, with
    `AZURE_BICEP_USE_BINARY_FROM_PATH=true`, which `run_bicep_command` reads as
    "the user manages the Bicep CLI" and which disables the version check
    outright rather than merely caching it. Set via the env var — Azure CLI
    maps `AZURE_<SECTION>_<OPTION>` onto config — so it stays independent of
    `AZURE_CONFIG_DIR`, which is per-user and is where a runtime `az login`
    writes.

  - **`BICEP_VERSION` and its two per-arch digests are ONE pin, not three.**
    `Azure/bicep` publishes no checksums file beside its release assets, so
    unlike `actionlint` there is nothing to derive them from at build time.
    A bump that lands the version without the digests fails the build loudly,
    which is intended. The replacements come from the release API's per-asset
    `digest` field; `docker/worker/README.md` carries the command.

  - **Pester is baked rather than allowlisted, deliberately.** The PowerShell
    Gallery endpoint set is a moving target — Microsoft retired the
    `psg-prod-*.azureedge.net` hosts its own firewall guidance named for years
    — so the gate is made a property of the image rather than of the network.
    The Gallery hosts are still allowlisted, but for a repo installing its
    *own* modules. `Install-PSResource` rather than `Install-Module`: the
    latter bootstraps the NuGet package provider from a second CDN and prompts.
    The import runs as a separate invocation and is the actual gate — it proves
    the module resolves from a clean session rather than from the state the
    install left behind.

  - **Baking the Bicep compiler is only half the Bicep gate.** `br/public:` is
    an alias for `mcr.microsoft.com/bicep/`, so a template referencing any
    Azure Verified Module fails during *module restore* — before compilation,
    with a `BCP192 … Status: 403 (Forbidden)` that names the registry rather
    than the sandbox. Found in review, reproduced against a live sandbox.

  - **`DEFAULT_EGRESS_HOSTS` and `TRUSTED_DOMAINS` are NOT two locks on one
    door**, and an earlier draft of this change asserted that they were. The
    ACA list is applied to every sandbox at create time; `TRUSTED_DOMAINS`
    expands only when an operator sets `sandbox.networkPolicy.preset:
    "trusted"`, which nothing in the router or CLI does by itself. So the ACA
    entry is what makes a gate work and the mirror is what stops the preset
    becoming the thing that blocks it. Both lists were updated; only the
    rationale was wrong. (CYR-87 added the Playwright hosts to the ACA list
    alone and is not broken.)

  - **`az monitor app-insights query` does NOT return an empty result when its
    extension is missing** — it exits 2 with `ERROR: 'app-insights' is
    misspelled or not recognized`. The empty result is produced by the shell
    pipeline that wraps it and keeps only stdout. The distinction matters
    because the original framing states it as a property of the CLI, which is
    the kind of confidently-wrong comment someone later relies on.

  - **`docker/worker/devcontainer/` is now marked frozen at the NOR-309
    snapshot.** It was never a product artifact, has never carried the Azure
    CLI, and `containers.devcontainers` is not modelled by
    `RouterConfigFileSchema`, so Zod strips it and no `router-config.json` can
    select that path. `features/src/cyrus-worker/install.sh` correctly needed
    no change either: it is boot-contract-only (`ca-certificates curl git jq
    tar xz socat bubblewrap`), with the language toolchain owned by the
    repository's own devcontainer per ADR 0006. The "two image paths" rule in
    CLAUDE.md §15 is scoped to the boot prerequisites, not the toolchain.

  - **Image growth is unaccounted for against the ACA disk-import ceiling.**
    The bicep binary is ~118 MB, `aspnetcore-runtime-8.0` ~130 MB, plus Pester,
    `dotnet-affected` and a pre-installed pnpm — roughly 250–300 MB uncompressed
    on an image already past the 1.71 GB that `scripts/deploy-worker-image.sh`
    measured at 99 s. That script issues ONE PUT with no retry, and its failure
    reads as a network blip (NOR-295). Time the next deploy rather than
    discovering it.

### Added
- **The remote-operator surface now has an end-to-end F1 matrix, and the
  dev-fleet half of its gate is explicitly still open
  ([CYR-78](https://linear.app/northrop-digital/issue/CYR-78/validate-observability-commands-with-f1-and-the-dev-fleet),
  [#77](https://github.com/nick-boey/cyrus/pull/77)).** The deployment-gated
  remainder is
  [CYR-89](https://linear.app/northrop-digital/issue/CYR-89/verify-the-operator-surface-post-deployment-and-decide-the-recovery).

  - **`apps/f1/test/router/observability-commands.test.ts` drives the SHIPPED
    CLI command classes against a real `RouterServer` over a real socket.** The
    unit suites on either side are each stronger at what they cover and share
    one blind spot: the two halves disagreeing. A command that asks for
    `?state=` where the router reads `?lifecycle=`, a capability advertised in
    one vocabulary and gated in another, a cursor the router mints and the
    client cannot parse — each passes both suites and fails in a fleet. So
    nothing in the file fakes a router document: every run row is produced by
    routing a real webhook through `EventRouter`, and every assertion reads it
    back over HTTP. 40 scenarios covering anonymous discovery's non-disclosure,
    all five principal kinds, the remote command tree, the full lifecycle set
    through `runs list`/`watch`/`wait`, the post-restart `410`, log-descriptor
    resolution with budget and redaction, nine guarded-recovery outcomes, and
    trusted-skill checksum enforcement.
  - **The recovery scenarios use a fake ACA control plane with the REAL
    device-side WebSocket stack**, because `RouterRunReconciler` decides on
    `DeviceGateway.isOnline` and on the worker's own `sessions_report`, neither
    of which a stubbed executor can produce. Writing it surfaced the thing worth
    knowing: a fake worker with no `"event"` consumer never acks the router's
    queued event, so `hasPendingEvents` stays true and every recovery correctly
    refuses to judge that worker's silence — the same shape a cold-booted
    sandbox produces. The strand is therefore built the way a real one occurs
    (route, boot, connect, drain, then kill the worker); a run whose event was
    never delivered is un-started, not stranded, and testing that refusal while
    calling it recovery was the easy mistake here.
  - **`./f1 router:strand-run`** (with a `POST /router/strand-run` control
    endpoint) routes an issue and reports whether the resulting run has reached
    the strand a guarded recovery needs — run id, revision, device id, worker
    connectivity, queued-event state, affinity and issue-lock holders, and how
    long ago the session was claimed. It **observes and never fabricates**: what
    makes a run stranded is the worker going away, which is the drive's act, so
    the command waits for that and reports `recoverable: false` with `blockedBy`
    when it has not happened. (The first cut wrote `executor_state = 'stopped'`
    and returned at once — recording a fact about an executor nobody stopped, and
    handing back a run whose event was still queued, which the reconciler
    correctly refuses to judge. A drive would have read that refusal as a
    recovery bug.) It refuses with `409` when the route was rejected outright.
  - **`RouterRig` gained the fleet seams the matrix needs**: multiple served
    workspaces, a `fleetOperations` block, an injected Entra token verifier
    (claims only — `OperatorAuthorizer` still re-checks tenant, issuer,
    audience, expiry, `oid`, and `idtyp` itself), a `runReconciler` override,
    and the three recovery timing knobs. `createdFixture`/`promptedFixture`
    take a workspace and team, without which a rig serving one workspace cannot
    distinguish a router that narrows a grant from one that ignores it.
  - **An independent cross-model review (Codex, read-only) found three real
    defects in the first cut, all fixed and mutation-checked**: the strand
    control above; a `runs watch` assertion satisfied by the opening snapshot
    and a `runs wait` scenario racing a 20ms wall-clock delay, both of which now
    mutate from inside the injected `sleep` and assert on the change event
    itself; and a restart scenario that called the store's cleanup directly
    rather than starting a second `RouterServer` on the same file database — it
    would have kept passing if `RouterServer.start()` stopped calling it. Each
    fix was verified by mutating the production code or the fixture and watching
    the assertion fail. `logs follow` coverage was added, and the "no Linear
    comment" claim — previously a scan of stdout for `linear.app`, which proves
    nothing — is now an assertion that every request the process made went to the
    router's own origin.
  - **Part of the controlled dev-fleet drive ran, read-only, against the live
    `rg-cyrus` router**, and the F1 matrix's predictions held there: anonymous
    discovery returns identity and auth methods and nothing scoped, the three
    authenticated routes answer a bare `401 {"error":"unauthorized"}`, and there
    is no route serving log records at all (`/api/v1/logs` → 404). CYR-72's whole
    canonical attribution set was confirmed present on live sandbox records, and
    ingestion lag measured at p50 ~0.8 s / p95 ~1.2 s. The drive also found two
    real faults it deliberately did not act on: a sandbox stranded `no_progress`
    for 6.1 days on an issue closed since 2026-09-03 (the deployed router
    predates CYR-84's 72-hour reclaim, so deploying current main fixes it), and
    an issue lock held on in-progress work by a stopped, offline container.
    Steps 1, 2 and 5-9 remain blocked on deployment changes — `fleetOperatorGrants`,
    a `logSource`, and `enableFleetRecovery` — none of which an agent may make.
  - **The `cyrus runs` half of the drive then ran against that router with a
    real `fleet.read` operator token**, and behaved as the matrix predicts:
    `connection add --auth local` verified and stored, `connection show` reporting
    exactly `runs.list, runs.changes` with no log source and no advertised skill,
    `runs list` resolving every canonical routing field including team and project
    names, `--issue` filtering, and `runs wait` on a terminal run returning a full
    observation document at exit 0. `logs query` exited **2** naming the missing
    `logs.query` capability — CYR-78's unsupported-capability negative case,
    observed live rather than inferred.
  - **The drive found a live instance of the strand it had only ever built as a
    fixture**: `PAR-200`'s run is `active` with a stopped container, an offline
    worker and the issue lock held — the exact shape `strandRun()` constructs.
    It also found that `NOR-402`'s six-day strand is **invisible to `cyrus runs`**
    (0 rows even with `--all-runs`): its run rows aged out 24 hours past terminal
    while the container and its affinity survived. That is not a defect in a
    command that observes runs, but it is a hole in the `runs list` → investigate
    → recover workflow the operator skill scripts, and it is recorded as a product
    question for the project rather than fixed here.
  - **Recovery stays disabled everywhere, and the docs now say why.**
    `docs/ROUTER.md`, `apps/cli/README.md`, and
    `infra/azure/bicep/main.bicepparam.example` each record that the F1 matrix
    is the automated half of CYR-78 and not the gate: no Entra token was minted
    for a router audience, no Log Analytics workspace was read, and no recovery
    was run against `rg-cyrus-dev`. `enableFleetRecovery` remains `false` and
    needs the controlled dev-fleet drive plus a separately authorized rollout.
    The outstanding steps are enumerated in
    `apps/f1/test-drives/2026-09-09-observability-commands.md`.

### Fixed
- **Every F1 router rig shared one repository registry file, so the first rig
  to seed decided the repositories every later rig saw
  ([#77](https://github.com/nick-boey/cyrus/pull/77)).** `RouterRig` left
  `repositoriesPath` to its default, which derives from `dbPath` — and every
  rig passes `":memory:"`, whose `dirname` is `"."`. All of them therefore
  wrote and read one `apps/f1/repositories.json` in the package directory. A
  non-empty registry is authoritative, so a rig configured for a second
  workspace found nothing registered for it, held its webhooks at the
  repository gate, and reported the run as never routed. It survived because
  the stray file persists between runs: once a rig that wanted both workspaces
  had seeded it, every later local run passed, and only a clean checkout — CI —
  saw the failure. The rig now derives the path from its own temp home, as it
  already did for the Codex KEK for exactly this reason.
- **The guarded-recovery e2e stranded a session its own fake worker had
  already disowned ([#77](https://github.com/nick-boey/cyrus/pull/77)).** The
  worker declared an empty `sessions_query` answer from its very first hello,
  so the hello-time affinity reconcile — running on the suite's deliberately
  tiny 10ms grace — reclaimed the pin before the test asserted it was still
  held. It passed only when the boot handshake beat the grace, which a loaded
  CI runner does not. The worker now declares the session it is actually
  running and empties that list at the strand, which is both what a real worker
  reports and what makes the release the recovery performs meaningful.
- **Playwright's browser revision is the repository's to decide, and the image
  is only a cache ([CYR-87](https://linear.app/northrop-digital/issue/CYR-87/playwright-cannot-launch-in-the-sandbox-the-image-bakes-chromium-1234),
  [#76](https://github.com/nick-boey/cyrus/pull/76)).**

  - **The two halves of the Playwright bake have different lifetimes, and only
    one of them is a version pin.** `--with-deps` apt-installs Chromium's
    shared libraries and fonts — root-only, revision-independent, genuinely
    un-fixable at runtime because sessions run as `cyrus`. The browser binary
    is not in that category: which revision Playwright launches is read from
    the REPOSITORY's `playwright-core` `browsers.json`, and Playwright ignores
    a non-matching directory rather than falling back to it. So the image's
    `PLAYWRIGHT_VERSION` does not decide anything; it only decides whether the
    repository's choice happens to be pre-cached. Verified against the shipped
    package: `playwright-core@1.60.0` asks for chromium/headless-shell 1223,
    `1.62.0` for 1234, and both ask for ffmpeg 1011 — which is why the reported
    evidence showed ffmpeg matching while chromium did not.
  - **No cross-repo lockstep is enforceable from inside the image, so the CDN
    allowlist — not the build arg — is what makes a Playwright bump safe.** The
    image cannot see a downstream repository's `package.json`, and the original
    issue correctly flagged that the "keep in lockstep" half needs an owner or
    it recurs on the next bump. There is no owner to give it. Instead the
    failure mode is downgraded: with `cdn.playwright.dev` and
    `playwright.download.prss.microsoft.com` in `DEFAULT_EGRESS_HOSTS`, drift
    costs one download into the shared `/ms-playwright` instead of an
    unrunnable suite. `PLAYWRIGHT_VERSION` is now 1.60.0 to match the consuming
    repository's pin, but it is an optimisation and is documented as one. A
    repository wanting the reconcile to be automatic rather than
    agent-initiated puts `playwright install chromium` in its
    `cyrus-setup.sh` — the seam that already exists, run per worktree, a no-op
    when the revision matches, and the only place that can see the pin. Its two
    holes are documented rather than papered over: `createSingleRepoWorktree`
    early-returns on an existing worktree, so a container recreated over a warm
    volume skips the hook while `/ms-playwright` (an image layer, not part of
    that volume) has reverted to the baked revision; and a failing setup script
    is non-blocking, so a failed download surfaces only as a Linear activity.
  - **All five download hosts go in, because the version is the repository's
    choice and Playwright has used two different mirror sets.** >= 1.50 ships
    `cdn.playwright.dev` and `playwright.download.prss.microsoft.com`, and
    neither covers for the other: on x64 the Chromium builds resolve through
    the Chrome-for-Testing path, whose only mirror override is the former,
    while ffmpeg and arm64 Chromium fall through the mirror list and can land
    on either. <= 1.49 knows only the three `*.azureedge.net` mirrors —
    dismissing those as legacy was wrong, since a repo pinning an older
    Playwright would have been left on the original failure with no
    self-healing, and they still resolve (re-fronted by Azure Front Door).
    Verified by unpacking 1.44/1.46/1.48/1.49/1.50/1.60/1.62 from npm; the
    mirror-set switch lands in 1.50.0. As with every other entry: a missing
    host costs a destroy-and-recreate of every affected sandbox while a
    redundant one costs nothing.
  - **Egress is set on BOTH create paths, not just create-from-image.** The
    snapshot-restore path passed `lifecycle` but not `egressPolicy`, which is
    spike finding F2 — create-from-snapshot does not carry a policy over —
    applied to a cost control but missed for a security one. Restoring is the
    path an EXISTING issue takes, so this was the difference between "the
    Playwright CDN is allowlisted" and "the Playwright CDN is allowlisted for
    issues created after the upgrade"; the fallback when the field is absent is
    also not our Deny-by-default policy. The F2 lifecycle test now asserts
    egress alongside it, and was confirmed to fail without the fix.
  - **"Egress has no update API" was wrong, and is corrected wherever it
    appears.** ACA exposes `POST /sandboxes/{id}/egresspolicy` and the
    2026-07-25 spike verified it live, applying within seconds with a negative
    control. The true statement is narrower: `AcaSandboxClient` implements no
    such call, so Cyrus reaches only sandboxes created after the change. That
    keeps the "a missing host is expensive" conclusion intact while not
    prescribing a fleet-wide destroy as though the platform left no choice —
    wiring the endpoint up is the obvious follow-up if allowlist churn becomes
    routine.
  - **Not covered: boot-time visibility.** The issue's fourth criterion is
    explicitly conditional on CYR-16's capability probe, which has not landed —
    there is no boot probe to add a browser-revision check to. A mismatch is now
    self-healing rather than fatal, which lowers the stakes, but it is still
    discovered at first use.

### Added
- **Reclaimed stranded sandboxes and obsolete disk images ([CYR-84](https://linear.app/northrop-digital/issue/CYR-84/sweep-stale-aca-sandboxes-and-obsolete-disk-images-automatically), [#75](https://github.com/nick-boey/cyrus/pull/75)).**

  - **`reclaimStranded` is a shorter stale-destroy bought with stronger
    evidence.** `staleDestroyMs` reads three columns — `last_routed_ms`,
    `last_seen_ms`, `created_ms` — and therefore has to wait 14 days; the reclaim
    reads those plus `last_progress_ms`, `parked_at_ms`, the newest agent-run
    stamp on the device and the newest session claim, and fires at 72h. That is
    what "proving there is no active or recent session ownership" costs, and it
    is what pays for the shorter window. The leak it bounds: a leaked affinity
    row on an OFFLINE device ages out of `resolveAffinity` after
    `offlineAgeOutMs` (1h), after which the container sat on the three-column
    14-day clock. The 2026-09-08 audit found ACA sandboxes alive for work
    finished days earlier.

  - **It runs BELOW the `affinity > 0` gate, and the first cut did not — which
    made it unreachable in production while passing its own tests.**
    `resolveAffinity` returns non-zero in exactly two situations, and each is
    individually incompatible with the threshold: for an ONLINE device, whose
    `last_seen_ms` `DeviceGateway`'s pong handler restamps every 30s (so the
    clock is never more than ~90s old), and for an OFFLINE device whose newest
    claim is inside `offlineAgeOutMs`, which the clock folds in. The tests passed
    because their fixture — `isOnline: () => true` with a 24h-stale
    `last_seen_ms` — is a state the gateway makes impossible. Caught in
    implementation review; the suite now uses `isOnline: () => false` and stamps
    real heartbeats.

  - **The `no_progress` shape is deliberately NOT reclaimed.** A connected
    worker's heartbeat keeps `last_seen_ms` fresh, so it can never reach the
    threshold. `last_seen_ms` is excluded from `no_progress` and included here
    for the same reason read two ways: a heartbeating worker is a live process
    holding a workspace, and whether it is making progress is a question for a
    human rather than for a destroy.

  - **`quietSince` is split in two, and the split is the TOCTOU fix.**
    `quietSinceOnRow` is pure arithmetic over the row's own columns and is taken
    BEFORE `resolveAffinity`'s round trip to the device; the full version adds the
    newest agent-run stamp and the newest affinity `established_ms` and runs once,
    immediately before the destroy. Adjacent checks would have been theatre — the
    gate and the veto have to sit on opposite sides of an await for a session
    claimed during that await to veto anything. Same shape as the pre-stop
    re-check on the idle path.

  - **`last_active_ms` is excluded, and including it would have silently disabled
    the branch a second time.** The sweep stamps it on every pinned tick (that is
    the NOR-366 idle-clock reset), so the loop would reset the clock it reads.
    The constructor warns at BOTH ends of the range: at or below
    `sessionNoProgressMs` the destroy lands before the report a human would act
    on, and at or above `staleDestroyMs` the reclaim can never fire because
    stale-destroy reaches the row first. Silently inert is the failure this
    change exists to fix, so a configuration that cannot fire has to say so.

  - **The disk-image GC had never run in the deployment it was needed in.** It
    hung off `DevcontainerImageService`, which is constructed only when
    `containers.devcontainers` is set — and that field is not modelled in
    `RouterConfigFileSchema` at all, so Zod strips it and no `router-config.json`
    can enable it. Meanwhile the images that accumulate are the DEPLOYMENT worker
    images `scripts/deploy-worker-image.sh` registers out of band, one per build,
    which have no cache row and so were not candidates under the old
    `repo_devcontainer_images` iteration either. Fourteen images, 68 GB, eight
    collectable. `RouterServer.scheduleDiskImageGc` is gated on `containers.aca`;
    when the devcontainer service exists its collector is reused, so two cycles
    never race the same inventory.

  - **`DiskImageCollector` reconciles the provider's inventory.** One read per
    resource type per cycle (each is an ARM call), non-reentrant like
    `ContainerLifecycle.sweep`, and any listing failing skips the cycle whole — a
    listing we could not read is not evidence that nothing references these disks.
    Protections, in reported precedence: `cyrus-` name floor, deployment disk,
    sandbox source (both the `cyrus.disk` label and `sourcesRef.diskImage` by name
    AND by id, resolved against the disk listing), snapshot lineage, issue pins
    read DIRECTLY from `issue_disk_images` (a pin outlives its cache row, so
    resolving through `referencedDevcontainerCacheKeys` alone leaves it
    unprotected), devcontainer cache rows, not-`Ready`, and the age floor. Store
    protections are re-read immediately before every delete; provider ones are
    not, because that would be a second inventory call per candidate and a sandbox
    created since is created from a disk a pin or the deployment disk already
    protects.

  - **TWO floors, and neither subsumes the other.** A staged build and a rollback
    candidate are both referenced by nothing, so a pure reference count deletes
    the deploy about to go out and the one you would fall back to — hence
    `imageRetentionMs` (7 days). But an age window alone makes rollback DEPTH a
    function of deploy cadence, silently: a deployment shipping monthly holds the
    current disk and nothing else seven days after each deploy. Hence
    `imageRetentionCount` (3, what the audit kept by hand), counted over
    unreferenced images only so a protected one cannot consume a slot.

  - **A `Failed` import is not "not ready".** Protecting every non-`Ready` state
    indefinitely leaks the storage of an import that will never succeed; the
    protection is for imports still IN PROGRESS, which is what a deployment in
    flight looks like. A failed one falls through to the two floors.

  - **`imageGcEnabled` / `imageGcDryRun`.** Moving the gate from
    `containers.devcontainers` to `containers.aca` turns destructive, unattended
    work ON by default on upgrade, and the first cycle lands 6h after boot with
    nobody watching. Dry-run reports every decision and deletes nothing;
    disabling logs a warning, because a deployment that has switched this off
    accumulates an image per build and it took an audit to notice that state the
    first time.

  - **The snapshot listing is now UNFILTERED, matching the sandbox listing.**
    Filtering on `cyrus.managed` missed a hand-taken snapshot — the documented
    break-glass before `router containers destroy` — whose source sandbox is then
    destroyed and whose issue pin goes with the device row, leaving the source
    image collectable and the snapshot unrestorable. Same single ARM call either
    way, and the justification the sandbox listing already carried applies
    verbatim.

  - **`aca_disk_image_sightings` exists because the provider does not date its
    disk images.** The ACA spike recorded `{id, name, labels, image, status,
    sizeInMB}` and no timestamp, so a retention policy reading only the wire is
    either a silent no-op or silently unbounded depending on what the preview API
    returns this month. Age is `min(provider timestamp, first sight)` — first
    sight can only ever be later than creation. A disk absent from a listing has
    its sighting DROPPED rather than aged out, so a re-registered name is dated
    anew; inheriting the old first-sight would make a brand-new image immediately
    collectable, which is the worst way for the table to be wrong.

  - **The provider timestamp is BOUNDED, and first sight does not cover this.**
    Because the two are combined with `min`, an unsanitised provider value can
    only ever make an image look OLDER — so the fallback gives no protection in
    the dangerous direction. The field is undeclared on the preview API and has
    never been observed, so the realistic failure is not a wrong date but a
    sentinel: .NET's `DateTime.MinValue` (`0001-01-01T00:00:00+00:00`) parses
    cleanly and would delete the entire unreferenced set in one cycle. Values
    before 2020 or in the future are rejected with a warning and fall back to
    first sight. `createdAtUtc` is now declared on `AcaDiskImage` so the read is
    an explicit typed bet on a preview API rather than an untyped index-signature
    access. Caught in implementation review.

  - **Keeps are recorded as fully as deletes.** `sandbox.image_decision` carries
    `action` plus the protection that applied, because a wrongly-DELETED rollback
    image is invisible in any rollup and surfaces only as a boot that cannot find
    its disk, while a wrongly-KEPT one shows up as a bill. Plus
    `sandbox.image_gc_completed`, `sandbox.reclaim_skipped`, `reason=stranded` on
    `sandbox.destroyed`, and `reclaimed` on `sandbox.sweep_completed`. Three
    saved searches added to `monitoring.bicep`. `sandbox.reclaim_skipped` is
    emitted ONLY when the gate passed and the pre-destroy re-check then vetoed —
    the steady state is every healthy pinned container on every tick, and emitting
    that would bury the races the event exists to show.

  - **`containers.devcontainers.gcIntervalMs` was REMOVED**, replaced by
    `containers.aca.imageGcIntervalMs`. It was unreachable — `devcontainers` is
    not modelled in `RouterConfigFileSchema`, so Zod stripped it — and keeping
    both would have been two spellings of one setting, the silent-precedence
    shape this file warns about elsewhere. A deployment that somehow set it will
    now get the 6-hour default.

  - **One router per ACA sandbox group.** Every store-side protection is read from
    that router's own SQLite DB, so two routers on one group would each collect
    the other's images. Documented in `docs/ROUTER.md` rather than guarded in
    code, because a shared group was ALREADY unsafe before this change — the
    lifecycle sweep's orphan GC destroys any sandbox in the group with no device
    row of its own — and the Bicep stack creates one group per deployment.

  - **`./scripts/check-bicep.sh` was NOT run** — `bicep` is absent from the
    implementation sandbox and `az bicep install` is blocked by egress. Per
    CLAUDE.md §12 the new saved searches also still need to be RUN against the
    workspace: ARM stores a saved search as an opaque string and validates
    nothing, so a green `infra` check would not have covered them either.

- **Published and securely installed the trusted fleet-operator skill ([CYR-77](https://linear.app/northrop-digital/issue/CYR-77/publish-and-install-the-trusted-fleet-operator-skill), [#73](https://github.com/nick-boey/cyrus/pull/73)).** Added a deterministic ustar/gzip release builder, GitHub release assets and checksum, a hard-coded official release registry, guarded archive extraction, atomic agent-target installation, remote-profile command wiring, structural/security tests, and an F1 validation record.
- **Reconciled stranded run ownership on the router ([CYR-75](https://linear.app/northrop-digital/issue/CYR-75/reconcile-stranded-run-ownership-safely-on-the-router), [#70](https://github.com/nick-boey/cyrus/pull/70)).**
  `RouterRunReconciler` (`packages/router/src/fleet-operations/`) is the
  production `RunReconciler` CYR-74 left a seam for. Its safety argument is the
  ORDER of its guards: revision, terminal, elicitation and worker-connectivity
  are all checked before anything is started, so a request that was never safe
  costs nothing and mutates nothing. Everything after that is conditional twice
  more — on an authenticated worker having reconnected and disowned the session,
  and on a compare-and-swap.

  Its dependencies are narrowed to the one verb each is allowed. `RunRecoveryExecutor`
  exposes `boot` and nothing else, so "recovery never terminates live work or
  destroys an executor" is a property of what the class was handed rather than of
  what it currently chooses to call; it holds no Linear client at all, which is
  what makes "correctness never depends on a Linear comment" checkable. Every
  wait is injected (`delay`, `awaitOnline`), so the unit suite runs with no real
  sleeps.

  `RouterStore.releaseStaleRunOwnership` is the compare-and-swap, and it is a
  store method rather than three calls for a reason the affinity reconciler does
  not share: a recovery decides from evidence an operator read over HTTP, with a
  container boot and a worker reconnect between the observation and the write. As
  separate statements, a run that goes terminal or moves device in that window is
  left half-released — lock gone, affinity kept, a live worker's run marked
  `unknown` underneath it. It re-checks revision, terminal, and the device inside
  the transaction, and reports a decline by naming which fact moved.

  `releaseEndedRunOwnership` is the second, narrower operation, and it exists
  because the e2e found the gap: booting the container is itself what brings its
  worker back, and the reconnect handshake runs
  `EventRouter.reconcileDeviceAffinity`, which ends the run and clears affinity
  while deliberately leaving the ISSUE LOCK — and `reconcileDeviceLocks`, which
  would have released it, skips a device whose events are still undelivered. So
  "the run ended" is not "the ownership is gone", and a coordinator that treated
  them as the same would report `recovered` over the exact write-only issue it
  was called about. It refuses a live run (`run_active`) so it cannot become a
  way around the swap. That also makes it the COMMON path in production — on a
  session stranded for hours the reconnect reclaim usually wins the race — so
  what recovery adds over the reconnect pass is the issue lock, the ownership
  grace, and the park record.

  Its `superseded` guard is the one that stops it deleting live work. The
  ownership tables are keyed by SESSION and a Linear agent session outlives its
  turns, so `recordAgentRunRouted` starts a fresh run for the same session on the
  same device the moment the previous one is terminal — and the device scoping
  cannot separate them, because the disproved device and the new owner are the
  same device. Replying in-thread is the documented recovery for a lock
  rejection, so the user doing exactly that inside the replay window is the
  likely sequence, not an exotic one.

  Three things the release had to reach beyond affinity and the lock, each found
  by adversarial review rather than by a failing test. **The ownership grace**:
  `getSessionOwner` is `affinity ?? lock ?? grace`, and the park path — the
  canonical shape recovery targets — grants a 24-hour grace and THEN clears
  affinity, so releasing the first two leaves the disproved device owning the
  session for the rest of that window. **The park record**:
  `EventRouter.parkedSessionCreators` is a map, not a row, and it is the only
  thing the `active` branch consults before an unconditional `setSessionAffinity`
  — so a late frame from that device re-pins a run that is now `unknown` and can
  never end again, which is PAR-146 arriving by a new route. It is retired
  through a narrow `forgetOwnership` seam. **The revision**: see below.

  **`worker_online` and `executor_state` are MATERIAL columns**, and
  `DeviceGateway.handleHello` writes connectivity before it emits the
  `deviceConnected` that `awaitOnline` resolves on. Since guard 4 REQUIRES the
  worker to be offline, the offline→online transition is guaranteed — so a
  coordinator that compared the raw revision across its own boot would answer
  `stale_revision` every single time, on the one path the feature exists for.
  `describeRunFactsChange` compares the run's own facts instead (lifecycle,
  device, routed input, published activity, wait, pending work) and the swap is
  handed a revision re-read at the point of decision. The evidence fields are
  excluded by omission rather than by a deny-list: a new material column is
  ignored here until somebody decides it belongs, which is the safe default for a
  guard whose false positives silently disable the feature.

  `describeUnsettledWork` is the CYR-81 guard, absent from the first pass.
  `deviceConnected` is emitted one line before `deliverPending`, so a cold-booted
  worker truthfully answers "running nothing" about a session whose event it has
  not been handed — and about one whose runner is still starting. The router
  already refuses this same decision on both grounds (`reconcileDeviceLocks` on
  `hasPendingEvents`, `reconcileDeviceAffinity` on the affinity grace), and
  recovery must not be the one path that concludes without them. It reuses
  `containers.affinityGraceMs` rather than inventing a third window.

  `recoveryRefusalReasonV1Schema` gains `executor_not_startable`. None of the
  four existing reasons describes an offline physical device, and reporting it as
  `failed` would say something went wrong when the router correctly declined:
  reconciliation rests entirely on getting an authenticated worker back, and a
  machine the router cannot start can never supply that answer. Additive to a v1
  enum with no shipped consumer.

  `ContainerTargetService.bootAndWait` and `DeviceGateway.awaitOnline` are the
  two new seams. The former shares `inFlightBoots` with the fire-and-forget
  `boot`, so a recovery arriving mid-boot joins that attempt rather than racing
  its `mintDeviceToken` and orphaning the container that actually started; it
  reports failure as a value because every path there is written never to reject.
  The latter waits on `"deviceConnected"` — emitted only after the device token
  is verified — never on the raw socket, and keeps its `isOnline` fast path
  because an already-running container emits no further connect and the wait
  would otherwise always time out.

- **Queried and followed Log Analytics from the CLI ([CYR-73](https://linear.app/northrop-digital/issue/CYR-73/query-and-follow-log-analytics-directly-from-the-cli), [#67](https://github.com/nick-boey/cyrus/pull/67)).**
  `LogSourceAdapter` (`apps/cli/src/remote/logs/`) is the seam every historical
  log backend sits behind. It exists so that "no KQL, no table name, and no
  `Log_s` column reaches `LogsCommand` or the router" is a property you can
  check rather than a convention — a command that assembled query fragments
  would have no way to state that an operator's `--text` cannot arrive at the
  backend as syntax. `AzureLogAnalyticsAdapter` is the one production adapter;
  `FakeLogSourceAdapter` is shipped, not test-only, because `fake` is a kind the
  wire contract admits and a router configured against one must exercise the
  same selection code production does.

  The seam owns the FILTER SEMANTICS, not just the interface.
  `matchesLogQuery` / `compareLogRecords` are executable reference definitions
  of what each filter means; the fake IS that function, the Azure adapter
  re-expresses the same rules as KQL, and `LogSourceAdapter.contract.test.ts`
  drives both. Without this, `--text` matching case-sensitively in one backend
  and insensitively in another is not a discrepancy anyone notices — it is an
  operator concluding a message was never logged.

  `compileAzureKql.ts` is the only file that knows KQL. Every value crosses into
  the query through `kqlString`, which is why the injection question is
  answerable: the grammar is fixed by the compiler and the operator contributes
  only string literals. It reads `cyrus.*` attributes with bracket syntax
  throughout — `p["cyrus.run_id"]`, never `p.cyrus.run_id`, which parses as a
  nested lookup and silently returns null — and orders by a TOTAL key before
  `take`, since `take` without an order is explicitly non-deterministic and a
  follow built on it would show records appearing and disappearing. It asks for
  `limit + 1` records so that "exactly `limit`" is distinguishable from "an
  arbitrary prefix of many more"; the golden tests assert the whole query text
  rather than fragments, because a `toContain` check passes for a query that
  also grew a clause nobody intended.

  Budgets REFUSE rather than truncate or clamp (exit `2`, nothing emitted). A
  truncated log window reads exactly like a complete one, and a clamped
  `--limit` answers a different question while saying nothing about having done
  so. Azure partial results are failures for the same reason. The limits live
  beside the interface in `LogSourceAdapter.ts`, not in each adapter, because a
  budget one adapter enforces and the next forgets is indistinguishable — from
  the operator's side — from a quiet fleet.

  `normalizeAzureRows.ts` keeps the two clocks apart: `TimeGenerated` is
  ingestion, `record.timestamp` is emission, and the gap between them is what
  `follow` overlaps for. `recordId` is a content fingerprint over the key-sorted
  row (`parse_json` gives no ordering guarantee across queries), which is what
  makes overlap deduplication possible at all — an assigned id would make every
  poll look like new work. Rows that carry no readable Cyrus record are counted
  and reported, never dropped silently, since a container's stdout also carries
  lines we did not write.

  `redactKnownSecrets.ts` adds two things shape-matching cannot do: key-based
  redaction (a value under a key called `token` is a credential whatever it
  looks like) and matching against the exact values of credentials in this
  process's own environment (the only check that catches one logged as a bare
  argument). It deliberately does no entropy heuristics — a high-entropy string
  is usually a run id or a git SHA, and redacting those turns a working
  investigation into a page of `[redacted]`.

  Azure credentials reuse CYR-67's non-interactive chain against the Log
  Analytics audience, so `createDefaultEntraChain` now takes an OPTIONAL tenant
  (omitted entirely rather than passed as `undefined`, which some credentials
  treat as a supplied option and others as a constructor failure). The SDK
  import stays dynamic, and the client is memoized per kind so a 15-second
  follow does not re-authenticate each poll.

  `logQueryV1Schema` gained `teamId` and `projectId`. CYR-72 stamps
  `cyrus.team_id`/`cyrus.project_id` on every line and CYR-73 lists both as
  filters, but the strict v1 request schema had no field for either — so they
  were queryable only by someone hand-writing KQL, which is what this command
  exists to avoid.

### Fixed
- **Log queries filtered, ordered, and truncated on the wrong clock
  ([CYR-73](https://linear.app/northrop-digital/issue/CYR-73/query-and-follow-log-analytics-directly-from-the-cli),
  [#67](https://github.com/nick-boey/cyrus/pull/67)).** The first version of
  `compileAzureKql` bounded and ordered on `TimeGenerated` — INGESTION time —
  while the records it returned, and the range the output document claims they
  lie in, are on the emitter's clock. Ingestion lag is tens of seconds and
  differs per source (a router line lands almost immediately; a sandbox line is
  relayed through the router's stdout), so a record written inside the window
  and ingested after it was silently dropped, output stopped being chronological
  once the two interleaved, and `take` kept the earliest-INGESTED records rather
  than the earliest. The query now scans a WIDENED `TimeGenerated` window — the
  indexed column, so the scan stays bounded — and filters, orders, and takes on
  `coalesce(todatetime(p.timestamp), TimeGenerated)`. The contract stub that hid
  this gave every row `timeGenerated: record.timestamp`, making ingestion order
  and emission order the same sequence; it now applies a per-record varying lag.
- **The workspace scope dropped almost every router log line
  ([#67](https://github.com/nick-boey/cyrus/pull/67)).** Every query carries an
  implicit `cyrus.workspace_id` clause, but that attribute rides only on
  `logger.event` records and relayed sandbox records — the ~200 plain
  `logger.info`/`warn`/`error` calls render with only the structural keys, and
  `tostring()` of an absent key is `""`. A bare equality therefore excluded all
  of them, including from `cyrus logs query` with no filters, which then
  reported a quiet fleet. The scope now admits records carrying no workspace
  attribution; the explicit filters (`--team`, `--owner`, …) are deliberately
  NOT widened the same way, since asking for a team means a line with no team is
  not a match. It is a narrowing filter, not an authorization boundary — the
  backend is read with the operator's own grant.
- **`{ audience }` is dead config in `@azure/monitor-query-logs@1.0.0`
  ([#67](https://github.com/nick-boey/cyrus/pull/67)).** The option exists on
  the SDK's TypeScript interface and is never read: `createMonitorQueryLogs`
  derives its endpoint from `options.endpoint` and its scopes from
  `options.credentials.scopes`, and the string never appears in the shipped
  JavaScript. A sovereign-cloud descriptor therefore minted a token for
  `api.loganalytics.us` and sent it to the public endpoint, failing as a `401`
  that our own error mapping reported as a missing `Log Analytics Reader` role —
  the exact misdiagnosis the cloud map exists to prevent. Now sets `endpoint`
  and `credentials.scopes`, and the `as unknown as` cast that was disabling the
  structural check is gone.
- **Cancellation was documented, contract-tested, and non-functional
  ([#67](https://github.com/nick-boey/cyrus/pull/67)).** Three breaks in one
  chain: the command never passed a signal, the SDK discards the one it accepts
  (`convertToInternalOptions` rebuilds the options as `{ prefer, requestOptions }`
  before `operationOptionsToRequestParameters` can read `abortSignal`), and the
  contract's cancellation cases passed because the test wrapper short-circuited
  before delegating. Ctrl-C now aborts an in-flight poll, the adapter stops
  waiting via `Promise.race`, and the interface comment says plainly that this
  abandons the WAIT rather than the query — the request finishes server-side and
  is still billed.
- **Three narrower ones ([#67](https://github.com/nick-boey/cyrus/pull/67)).**
  `--to` parsed on `cyrus logs follow` and did nothing, which
  `parseLogsOptions`' own rule forbids — refused now, and no longer declared on
  that subcommand. `--show-query` could print the PREVIOUS poll's KQL for a
  query that failed a request-side budget and generated none; `lastQuery` is
  cleared first. The record-count budget counted readable RECORDS while the
  query took `limit + 1` ROWS, so a capped result whose extra row was unreadable
  passed the check — it now gates on the row count too. And redaction moved from
  the Azure normalizer into the seam's shared `finalizeLogRecords`, so "known
  secrets are removed before output" is a property of the interface rather than
  of today's only production adapter.
- **A bare `logs` in `.gitignore` was swallowing source directories.** It
  matched `apps/cli/src/remote/logs/` — an entire module — with no error at
  `git add` and nothing in `git status` to notice. Anchored to `/logs`, which
  is where the runtime log directory actually is.

- **Correlated fleet logs with agent runs ([CYR-72](https://linear.app/northrop-digital/issue/CYR-72/emit-canonical-run-and-routing-attributes-in-console-logs), [#66](https://github.com/nick-boey/cyrus/pull/66)).**
  `runAttributionAttributes` (`packages/core/src/logging/attribution.ts`) is now
  the one place the sixteen canonical `cyrus.*` correlation keys are built.
  Before this, each logger spelled its own subset by hand — the relay knew
  `issue_key`/`device_id`/`provider`, the routing events knew
  `agent_session_id`/`issue_id`, and nothing knew the workspace, owner, team or
  project — so a second copy of the key list was already how one emitter would
  come to say `owner_id` while another said `owner_user_id`.

  **The builder's input is structural, not an `AgentRunInfo`.** `cyrus-core` is
  depended on by every runner and the CLI and must not learn about the router's
  SQLite; `RouterTelemetry.runAttribution` does the single row-to-vocabulary
  mapping. `null` and `undefined` mean the same thing to it, because the two
  arrive interchangeably from a nullable column (`row.issue_key ?? null`) and an
  optional field (`run.issueKey`), and treating them differently would make the
  emitted shape depend on which one a call site happened to hold.

  **Emitting `null` for an unknown fact is load-bearing twice.** It is what makes
  `where isnull(p["cyrus.project_id"])` work — a dropped key answers that with
  silence, which reads as "there are none". It is ALSO the anti-spoof mechanism
  in `SandboxLogRelay`: worker attributes merge only into keys the router has not
  claimed, so a canonical key that is always present leaves a spoofed value
  nowhere to land, with no denylist for anyone to remember to extend.
  `trace_id`/`span_id` are the exception that proves it — they are legitimately
  absent when no trace exists, so they needed an explicit `RESERVED_TRACE_KEYS`
  guard.

  **`trace_id`/`span_id` stay unnamespaced.** They are W3C-owned names and
  `OperationId` in `AppRequests`/`AppDependencies` is the same value, so
  prefixing them would break the join a correlated log line exists to enable.
  The relay derives them by parsing the frame's `traceparent`; the router's own
  events read `activeTraceIds()`, since a live span context knows more than
  whatever carrier the process is holding. An id that fails validation yields
  nothing rather than being passed through — an invalid id in the stream would
  join a line to a trace that does not exist, which looks like an answer.

  **New `run.*` family, and the `finished`/`unknown` split is the point.** Both
  end a run; only `unknown` means the outcome was never observed. Reasons are a
  closed set (`lock_reconciled`, `affinity_reconciled`, `dangling_affinity`,
  `event_expired`) so `summarize by reason` is bounded. Emission order is
  deliberate at two sites and commented at both: `run.finished` fires AFTER
  `finishAgentRun` because the terminal frame is the only point an ordinary run
  ever reports its runner and model (emitting first would leave every such run's
  closing record saying `runner = null`), and `run.routed` fires BEFORE the
  fire-and-forget routing enrichment, because it records what was known when the
  route happened rather than what a Linear round trip later discovered.

  **`resolveLogRunAttribution` is a correctness rule, not an optimisation.** A
  frame naming a session gets that session's run, gated on the router's own row
  agreeing the session belongs to this device — `frame.sessionId` is
  device-supplied. A frame naming none falls back to the device's latest run
  ONLY for a container, which serves one issue for life. A physical device serves
  many issues concurrently, so "latest run" there would attribute one session's
  lines to another session's run: a wrong answer dressed as a measured one, which
  is worse than null columns declining to answer. Extracted from `RouterServer`
  onto a narrow `RunAttributionLookup` seam so the rule is testable without
  standing up a server.

  **`AgentSessionManager` claims only what the worker is the authority on** —
  the Linear `session_id`, `runner`, `model`. Note `session_id` is NOT the same
  id as the runner's own `cyrus.agent_session_id` (the agent SDK's); the two
  families do not join and KQL returns nothing rather than erroring, so both are
  emitted under distinct names. It deliberately sends no workspace/owner/team/
  project/run/device: the relay stamps those router-side and would discard a
  worker's copy, so sending one would only be believed on the deployment where
  nothing checks it.

  **Every pre-CYR-72 attribute name is still emitted verbatim.**
  `monitoring.bicep`'s projections gained columns rather than having any
  substituted, so every existing saved search returns what it did before; the
  pinned wire-format tests in `RouterTelemetry.test.ts` and
  `SessionOwnership.test.ts` were extended, not rewritten. One deliberate
  behaviour change: `routing.rejected` now falls back to the run's issue key when
  the rejection carries none (the `prompted` path reads it off an activity that
  need not have one), so `cyrus.issue_key` is populated where it used to be null.
  Queries filtering on a value gain rows; none lose any.

  **Implementation-review fixes, each a defect the first pass shipped:**

  - *A lifecycle event must describe a real transition.* `finishAgentRun` and
    `markAgentRunUnknown` both early-return on an already-terminal run, and both
    of those are ROUTINE: `routePrompted` re-establishes affinity for a terminal
    session (PAR-146), and `RouterServer` applies a `session_state` frame before
    acking it, so devices replay frames the router already applied. Emitting
    regardless filed healthy completed runs under `run.unknown` — the exact
    misdiagnosis the split exists to prevent — and double-counted one run id
    under two outcomes. Both store methods now return whether they mutated a
    row and `emitRunLifecycle` gates on it.
  - *`Cyrus-Runs-By-Dimension` returned systematically wrong numbers.* It
    grouped raw events by dimensions the emitters guarantee differ between the
    two halves of a run: `run.routed` precedes the enrichment so its project is
    null, and `run.finished` is the only point runner/model are reported. So
    `routed` and `finished` could never co-occur in a bucket and the percentage
    divided by a guarded zero into the hundreds. Now collapses to one row per
    run first. Wrong-but-valid KQL, i.e. precisely what a green
    `check-bicep.sh` cannot catch.
  - *The "no denylist needed" anti-spoof claim was false for the structural
    keys.* `key in attributes` only guards keys set UNCONDITIONALLY; `event`,
    `args`, `traceparent`, `tracestate`, `cyrus.dropped`, `cyrus.emitted_at` and
    the `cyrus.reported_*` pair are set only when the frame supplies the
    corresponding field, leaving them free in the attribute bag. `event` is the
    dangerous one — a relayed line now carries authentic router-stamped
    attribution, so a forged `event` would be indistinguishable from a
    router-emitted lifecycle record, and `event startswith "sandbox."` scopes
    every alert rule. `WORKER_RESERVED_KEYS` replaces the two-element trace set.
  - *A rejected session claim blanked the line instead of falling back.*
    `resolveLogRunAttribution` returned `undefined` on a failed ownership gate,
    handing a container a way to null its own canonical columns and evade
    `where p["cyrus.run_id"] == …`. It now falls through to the container
    fallback, which the device cannot influence. Also fires benignly for a run
    row not yet written and for a destroyed-and-recreated container.
  - *The worker's `runner`/`model` were discarded in every router deployment.*
    They are canonical, hence always claimed, so the relay dropped them exactly
    in the window the comment claimed they were needed. The relay now reads
    those two off the line when its own copy is null. This is principled, not a
    concession: the worker is the ORIGINAL authority on its own execution
    identity and the router's copy is a cache of what a worker previously
    reported on a frame, so it grants no trust a container did not already have.
  - *`cyrus.reported_session_id` fired on "the router has no run", not on
    disagreement* — `frame.sessionId !== origin.run?.sessionId` is true against
    `undefined`, so it was stamped on every line a container writes before its
    first route. Now gated on a run existing.
  - *`"unknown"` reached a canonical column.* `recordAgentRunRouted` stores that
    literal for a webhook with no issue key (the column is NOT NULL).
    `runAttribution` normalises it back to `null`, so `isnull(...)` finds those
    rows instead of a sentinel gathering every unrelated key-less run under one
    plausible-looking issue.
  - *`OperationId` claim softened.* The trace id VALUE matches, but the join is
    manual: a console record carries no `OperationId`, and neither does the OTLP
    copy — `OtelLogSink.emit` passes no OTel context, so a relayed worker's
    trace id lives only in `Properties["trace_id"]`.
  - Cleanups: `getLatestAgentRunForSession` folded into `getAgentRunForSession`
    (same query, same index, narrower return) and its stranded JSDoc reattached.

  Known and accepted: `resolveLogRunAttribution` adds one synchronous SQLite
  point read per forwarded log frame, bounded by `RouterLogForwarder`'s 2/s
  sustained per-device token bucket, so cost scales with fleet size rather than
  log verbosity. A relayed line also gains ~450-600 bytes; `OtelLogSink`'s
  64-attribute cap drops the LAST keys offered, and the canonical set is built
  first, so a chatty worker loses its own attributes rather than the correlation
  columns.

  **The new saved searches have NOT been run against a live workspace.**
  `check-bicep.sh` compiles the template, but ARM stores KQL as an opaque string
  it never validates — the trap CLAUDE.md §12 names, and the one that let
  `Cyrus-Sessions-Never-Terminal` ship a `leftanti` that was valid KQL answering
  the wrong question. No Azure credentials exist in the implementation sandbox.
  Run each of `Cyrus-Run-Timeline`, `Cyrus-Runs-Ended-Unobserved` and
  `Cyrus-Runs-By-Dimension` with `az monitor log-analytics query` before relying
  on them.

- **Advertised the configured historical log source ([CYR-71](https://linear.app/northrop-digital/issue/CYR-71/advertise-the-configured-historical-log-source), [#64](https://github.com/nick-boey/cyrus/pull/64)).**
  `router-config.json` gains an `observability.logSource` block that
  `RouterConfigFileSchema` normalizes into a `LogSourceDescriptorV1` on
  `fleetOperations.logSource`. The router side needed no change: `FleetOperations`
  already gates the descriptor on the `logs.query` capability and
  `RouterServer.servedOperatorCapabilities` already derives that capability from a
  configured source. What was missing was a form an operator could write by hand.

  **The normalization is a schema `.transform()`, not a helper each reader calls.**
  The config is `safeParse`d at six sites in `RouterCommand`, and a
  hand-maintained copy site is precisely how a field gets honoured on one path and
  silently dropped on another — the `strictMcpConfig` / `slackAllowedTools` shape
  in CLAUDE.md §9. A transform leaves exactly one place to miss, and it is
  unmissable: `observability` is destructured out, so nothing downstream ever sees
  the friendly form and `RouterServerConfig` has one shape to handle.

  **The friendly form has no `table` field and never will.**
  `ContainerAppConsoleLogs_CL`, the KQL compiled against it, and the response
  columns are the Azure adapter's knowledge. The block is `strictObject` at both
  levels for the same reason the wire descriptor is: the property that makes it
  safe to disclose is that it CANNOT carry a way to reach a backend, so
  `endpoint`, `authorityHost`, `sharedKey` and friends are refused rather than
  stripped.

  **The two Azure identifiers are format-checked in the CONTRACT, not in the
  config schema that happens to produce a descriptor.** `workspaceId` becomes a
  GUID and `resourceId` a `Microsoft.OperationalInsights/workspaces` ARM path in
  `azureLogAnalyticsDescriptorV1Schema` itself, because a router accepts this
  shape from more than one place: a hand-written `router-config.json` AND the
  whole-block `CYRUS_ROUTER_FLEET_OPERATIONS_JSON` that `main.bicep` and
  `docker/router/entrypoint.mjs` render straight through. Validating only the
  friendly alias would have left the rule true of the path nobody uses and merely
  documented on the path every Azure and Docker deployment takes — with the
  CHANGELOG stating it unconditionally. `resourceId` is the one free-form field,
  hence the one place a URL could hide, so it is pinned over ARM's own name
  charset and terminated with `(?![\s\S])` rather than `$`: `$` also matches
  before a trailing newline, which would admit a CRLF into whatever URL or header
  a future client builds from it.

  `fleetOperations.logSource` now uses `logSourceDescriptorV1Schema` itself rather
  than a hand-rolled copy of its shape. Both forms already refused to start the
  router — `FleetOperations.validateConfig` runs in its constructor — so what the
  earlier check buys is the MESSAGE: a cross-field violation now names
  `lookbackMinutes`, not a `defaultLookbackSeconds` in units the operator never
  wrote. Declaring the source under both keys is a config error: two spellings of
  one setting is a silent-precedence bug, where whichever lost gets edited for
  hours with no effect.

  **A configured log source is logged at startup**, kind and all. Omitting the
  block and misspelling the key are observationally identical from outside — the
  router starts clean, advertises no `logs.query`, discloses nothing — and
  `RouterConfigFileFieldsSchema` is `z.object`, so a typo'd top-level key is
  stripped in silence. One line makes the two distinguishable without making
  every other top-level typo fatal.

  The budget ceilings (525600 minutes, 8760 hours, 1e6 records, 86400 seconds) are
  not policy — they exist so a slipped digit cannot multiply out into a wire
  descriptor. Real deployments are orders of magnitude below them.

  No log-query route was added, and `RouterServer.test.ts` now pins that: four
  plausible log paths 404 on both GET and POST, and a KQL-shaped `?query=` on
  `/api/v1/runs` is refused with `invalid_query` rather than ignored. The
  "no Azure token can be serialized" claim is checked from the other side too —
  `routes.test.ts` asserts the disclosed descriptor's key set is exactly
  `{schemaVersion, kind, displayName, azure, budgets}`.
- **Captured routing and worker-reported run facts ([CYR-68](https://linear.app/northrop-digital/issue/CYR-68/capture-routing-and-worker-reported-run-facts), [#61](https://github.com/nick-boey/cyrus/pull/61)).**
  The `session_state` frame gains an explicit `waiting` state carrying
  `wait { reason, since, reportedCondition }`, a separate `executorMayPark`
  declaration, and `runner` / `model` / `pendingWorkCount`. `agent_runs` gains
  matching columns plus a routing snapshot and a `revision`, and `runs.ts` grows
  an internal `RunObservation` that the frozen `GET /runs` shape is rendered
  from.

  **The park/wait split is the whole point.** `parked` conflated two independent
  facts — the RUN is blocked on a user, and its CONTAINER may be suspended — so
  `createAskUserQuestionCallback` had to suppress the report entirely when
  `hasPendingWork` was true, because reporting it would also have released
  affinity and let the sweep freeze a live build. The result was that the one
  case most worth seeing produced no signal. The frame now separates them:
  the wait is always reported, and `executorMayPark` alone gates
  `clearSessionAffinity` / `setDeviceParkedAt` in `EventRouter`.

  **`waiting` is capability-gated, not version-bumped** — `RUN_FACTS_CAPABILITY`,
  following `LOG_INGEST_CAPABILITY` exactly. The additive FIELDS are already safe
  against an old router (`z.object` strips unknown keys); the new `state` VALUE is
  not, because `state` is a closed enum and `DeviceGateway.handleMessage` closes
  the socket on any frame it cannot parse. Without the gate a worker would be
  disconnected on its first elicitation and reconnect into the same loop.

  **The gate is at the SEND, in `trySendSessionState`, not at the call site.** A
  `waiting` entry is durable, so it can be replayed minutes later — most likely
  onto a router that was rolled back, which is exactly when it matters. An
  ungated replay is rejected, the socket closes with 1002, we reconnect, we
  replay: a permanent loop that `loadSessionStateEntries` cannot clear (it does
  not reload non-terminal entries) and that takes down event delivery, RPC, and
  every OTHER session's terminal frame queued behind it. `handleDisconnect` also
  clears `serverCapabilities` — a capability is one router's answer on one
  connection, and carrying it across a disconnect turns an answer into an
  assumption about whatever build the next dial lands on.

  Degradation: a parkable wait becomes the legacy `parked` frame; a non-parkable
  one sends NOTHING and logs. Lossy in one direction on purpose — an old router
  has no way to record a wait without also releasing affinity, and releasing it
  for a run whose executor must not park freezes a live build.

  **Terminal frames carry `runner`/`model` too, and that is not cosmetic.** The
  ORDINARY run — no elicitation, no deferred pending work — never passes through
  `setAgentRunState`, so its terminal frame is the only point at which execution
  identity is ever offered. Dropping it there left the common case with
  `runner = NULL` permanently, which no later backfill could close (the worker is
  gone) and which would have made `runObservationV1Schema` — where `runner` is
  required — unemittable for exactly that case.

  **An unmodelled wait reason is narrowed, not rejected.** `sessionWait.reason` is
  an open string on the wire and `EventRouter.narrowWaitReason` maps anything but
  `elicitation` to `other`, preserving the raw reason as the condition. A closed
  enum would have implemented criterion (b) as a parse failure, and a parse
  failure closes the device's whole socket over one unrecognised string — the
  precise failure `RUN_FACTS_CAPABILITY` exists to prevent, reintroduced by the
  field meant to be the most forward-compatible thing on the frame.

  **Legacy `parked` is read, not inferred.** `EventRouter` treats an explicit
  `parked` frame as waiting-on-elicitation plus executor parking, which is what
  that frame has always meant. The router still never derives a wait from silence,
  elapsed time, or executor state.

  **The `active` branch had to stop requiring a park on record.** A non-parking
  wait leaves no `parkedSessionCreators` entry, so the old early-return would have
  left such a run labelled `waiting` forever. It now falls through to a
  gated-on-ownership, grants-nothing path that records facts only — no affinity,
  no grace, no park entry. The pre-existing behaviour for a stray `active` from a
  non-owner (log and ignore) is unchanged.

  **`sendRunFacts` is deliberately fire-and-forget**, unlike every other
  `session_state`. Making it durable would make it replayable, and a replayed
  `active` against a router that has since recorded a park mints affinity back — a
  real hazard bought for a count.

  **Revision increments on material change only.** `updateAgentRun` diffs the
  patch against the row and bumps only when a `MATERIAL_RUN_COLUMNS` member
  actually moved; `last_routed_ms` is excluded, since a real route also changes
  `inputs_json`. An idempotent frame replay must not look like a change to a
  watching client.

  **Migration converts non-terminal `state = 'parked'` to `waiting` +
  `wait_reason = 'elicitation'` and leaves terminal rows alone.** Nothing else is
  backfilled: a run routed before this migration was routed by a router that
  captured no snapshot and knew no runner, and writing one now would fabricate
  history into exactly the columns whose purpose is to be faithful. That is the
  constraint `runObservationV1Schema`'s doc comment hands to whoever adds
  `/api/v1/runs` — scope it to post-migration runs, or backfill. `toAgentRunInfo`
  reads a legacy row's state through `readAgentRunState`, where `ended_ms` wins:
  an ended `parked` row is `unknown`, not `waiting`, so it cannot produce a
  terminal run carrying live wait evidence.

  **Routing snapshots are captured in two passes, because the webhook cannot
  answer the whole question.** Linear's `AgentSessionEventWebhookPayload.issue` is
  an `IssueWithDescriptionChildWebhookPayload` —
  `{description?, id, identifier, team, teamId, title, url}` — so the team is free
  and the PROJECT is not on the payload at any nesting. Owner, workspace id and
  team are written from the webhook and the device row inside
  `recordAgentRunRouted`'s own transaction, keeping the routing path free of a
  Linear call; the project comes from `LinearExecutor.fetchRoutingContext`, fired
  off the delivery path and gated by `runRoutingNeedsEnrichment` so it is one
  round-trip per RUN, not per webhook.

  `enrichRunRouting` fills only blanks and never overwrites, which is what keeps
  the snapshot immutable despite arriving late: an issue moved between the route
  and the read would otherwise rewrite its own history seconds after it was
  recorded. The gate is a dedicated `routing_enriched_ms` stamp rather than any
  snapshot column, and neither column could have served — gating on the team means
  the read essentially never fires (it is on the webhook), and gating on the
  project re-fetches forever for an issue that is in no project. Only "did we ask?"
  separates not-yet-asked from asked-and-there-was-nothing.

  **What `revision` does not cover.** It moves for durable run facts only. Two of
  the change kinds `runChangeKindV1Schema` names — `worker_connectivity` and
  `executor_state` — are joined at query time from `devices.last_seen_ms` and the
  sandbox gauge and are deliberately not persisted, so a worker going offline and
  returning leaves the number where it was. A `stale_revision` guard on
  `POST /api/v1/recoveries` therefore proves the RUN's facts have not moved and
  proves nothing about connectivity; a recovery that cares must re-read it.

  **`observeRun` omits BOTH executor-state fields for an unsampled container**
  rather than emitting `"unknown"` with no observation time — the v1 schema
  refuses that pair, because a sample that cannot be aged has to be treated as
  current, which is how a stale gauge comes to look like a live fact. The frozen
  `/runs` shape reconstitutes its `"unknown"` placeholder in `toLegacyObservation`,
  so the wire is unchanged.

  **The `parked` → `waiting` conversion is one-way and a downgrade strands rows.**
  An older router's non-terminal set has no `waiting`, so such a row is never
  ended, never reclaimed, never swept, and each new input starts a duplicate run
  beside it. Not fixable forward, and not migration-only (a row written by this
  build is `waiting` too); the forward direction IS handled — `parked` stays in
  `NON_TERMINAL_RUN_STATES` for a rolling deploy. The rollback SQL is recorded at
  the migration site.

- **Provisioned fleet-operator roles and Log Analytics access ([CYR-66](https://linear.app/northrop-digital/issue/CYR-66/provision-fleet-operator-roles-and-log-analytics-access), [#60](https://github.com/nick-boey/cyrus/pull/60)).**
  New `fleetOperatorGrants`, `enableFleetRecovery`, and
  `fleetOperatorLogReaderPrincipalIds` parameters on `infra/azure/bicep/main.bicep`,
  a `logAnalyticsReaderPrincipalIds` loop in `modules/role-assignments.bicep`, and
  a new `CYRUS_ROUTER_FLEET_OPERATIONS_JSON` env var that
  `docker/router/entrypoint.mjs` maps to `fleetOperations` in `router-config.json`.

  The two authorizations are kept structurally independent and neither is derived
  from the other. `fleetOperatorGrants` decides what the ROUTER answers; the Azure
  `Log Analytics Reader` role decides what the operator's OWN client reads. Log
  records never pass back through the router, so deriving the reader list from the
  grant table would have quietly made `fleet.read` an Azure data-plane grant — the
  exact widening `FleetOperations.capabilitiesFor` refuses for device tokens.

  `enableFleetRecovery` STRIPS `fleet.recover` from each rendered grant rather than
  refusing the deployment, and then drops any grant left with no roles, because the
  router's Zod schema requires `roles.min(1)`. A read+recover principal therefore
  degrades to read-only instead of vanishing, and the Entra assignment is untouched
  either way — the kill switch lives in the deployment, not the directory.

  Rendered as ONE JSON env var, mirroring `CYRUS_ROUTER_CONTAINERS_JSON`: the
  router re-validates it against its own schema, so remapping fields in the
  entrypoint would only give the deployed shape and the router's shape a way to
  drift. `logSource` uses the descriptor `fleetOperations.logSource` already
  accepts (CYR-71 adds the friendlier `observability.logSource` alias), and its two
  identifiers come from new `foundation.bicep` outputs — `logAnalyticsCustomerId`
  and `logAnalyticsWorkspaceResourceId` — rather than from parameters, so a
  deployment cannot name a workspace it did not create. `cloud` is omitted rather
  than hardcoded: the protocol enum values do not match `az.environment().name`.

  The whole block renders only when grants are configured. With no grants there is
  nobody the router could disclose the log source to, so an unconfigured deployment
  publishes no workspace metadata at all.

  `scripts/bootstrap-azure-role-assignments.sh` forwards the reader list through a
  new `param_array` helper. That path is not optional plumbing: northrop-dev (and
  every stack past bootstrap) runs `manageRoleAssignments = false`, so the
  privileged script is the ONLY way that grant reaches Azure — wiring it into
  `main.bicep` alone would have left it dead on exactly the deployments that use
  it. Deployment itself goes through CD in the private `cyrus-deploy` repository,
  which pins a Cyrus commit and calls this repository's `scripts/deploy-azure.sh`;
  the new parameters must be added to `env/*.bicepparam` there before they take
  effect.

  `fleetOperatorGrants` is a user-defined `fleetOperatorGrant[]` rather than a bare
  `array`, with `@minLength(1)` on all three lists to match the router's Zod
  schema. A missing key, a misspelled role, or an emptied `workspaceIds` would
  otherwise type-check, survive `build-params` AND `what-if`, render into the env
  var, and fail the router's parse at startup — a crash-looping revision from a
  parameter typo. `Log Analytics Reader`, by contrast, has no per-workspace bound
  available to it: one Log Analytics workspace holds the logs of every Linear
  workspace, so that role is all-or-nothing over the stack no matter how narrow
  the matching grant is. That asymmetry is documented at each of the three places
  the list is configured rather than left to be discovered.

  Coverage: `scripts/check-bicep.sh` type-checks the new parameters via
  `main.bicepparam.example` and two `infra/azure/bicep/testdata/` fixtures — every
  parameter omitted, and every parameter populated with a read-only principal, a
  read+recover principal, two workspace grants and the reader list — then asserts
  the recovery strip, the conditional env var and the workspace-scoped role
  assignment survive in the COMPILED ARM. Those assertions read the compiled
  template because ARM lambdas are evaluated at deployment time, so nothing local
  can see what a grant table renders to; `az deployment sub what-if` stays the gate
  for the rendered value. `scripts/bootstrap-azure-role-assignments.test.sh`
  pins the array forwarding (including comment stripping and the empty case);
  `docker/router/entrypoint.test.mjs` pins the env-var mapping and its
  `anyProvided` gate — and CI now actually runs it. `docker/` is not a pnpm
  workspace package (`pnpm-workspace.yaml` is `packages/*` + `apps/*`), so
  `pnpm -r test:run` never reached that file and its assertions had been
  inert since it was written. It joins the three shell suites the `infra`
  job already lists by name, which is the only place an out-of-workspace
  test is reachable from.

- **Remote command profile and named router connections ([CYR-67](https://linear.app/northrop-digital/issue/CYR-67/add-the-remote-command-profile-and-named-router-connections), [#59](https://github.com/nick-boey/cyrus/pull/59)).**
  New `apps/cli/src/remote/` module — `errors.ts`, `credentials.ts`,
  `ConnectionStore.ts`, `OperatorHttpClient.ts` — plus
  `commands/ConnectionCommand.ts` and a command profile in `buildProgram.ts`.
  The CLI side of the CYR-64 contracts and the CYR-65 router routes; it depends
  on `cyrus-operator-protocol` and never on `cyrus-router`.

  `ConnectionStore` is the only code that reads or writes stored connections and
  `OperatorHttpClient` the only code that reaches a router, so "where do
  connections live" and "how is a router request authenticated, validated, and
  version-negotiated" each stay one decision. Every other module takes a
  resolved record or a parsed document.

  **Version negotiation runs BEFORE schema validation**, and the order is the
  whole point. `operatorApiVersionV1Schema` is a closed enum, so a router
  serving only `v2` fails the strict parse and would be reported as a MALFORMED
  document — the one case where "this router is newer than your CLI" is exactly
  what the operator needs to hear. `discover()` therefore reads
  `operatorApiVersions` permissively first and refuses a disjoint set with the
  upgrade message.

  **The Entra chain is ours, not `DefaultAzureCredential`.** Order is pinned —
  workload identity, managed identity, service-principal env, Azure CLI — and
  asserted by a test, because a CI runner has both a federated token and a
  managed identity and a workstation often has stale `AZURE_CLIENT_*` exports
  beside an `az login`: whichever comes first decides who the router sees. There
  is deliberately no browser or device-code link, since a credential that can
  block on a human turns a failed authentication inside an orchestrating agent
  into a hung session with no output. Walking the chain ourselves is also what
  produces `source`, which is the single most useful fact when a command is
  authorized in one shell and refused in another; the winning credential is
  remembered, and a token is acquired on every request so each credential's own
  expiry-aware cache stays authoritative.

  **`--connection`/`--workspace` are attached to each fleet command, not to the
  program.** Commander resolves an option a parent and child both declare in
  favour of the PARENT: a program-level `--workspace` swallows
  `router operators create-token --workspace a --workspace b` into a
  single-valued parent option and hands the subcommand an empty array — silently
  minting a token authorized over no workspaces. `enablePositionalOptions()`
  fixes that collision but breaks `cyrus start --cyrus-home /x`, which works
  today. Both behaviours are pinned by tests in `buildProgram.test.ts`.

  The remote profile returns from `buildProgram` with **no program-level action
  handler**, also deliberately: Commander then rejects `cyrus router unlock X`
  as `unknown command 'router'` and prints help for a bare `cyrus`. Registering
  an action to print help instead makes Commander read the subcommand as excess
  program arguments and report "too many arguments. Expected 0 arguments but got
  3", which explains nothing.

  **The Entra chain falls through on a router REFUSAL, not only on an
  acquisition failure**, via the optional `rejectAndAdvance` on
  `OperatorCredentialProvider`. Minting a token and being allowed to use it are
  different questions and only the router answers the second: three of the four
  links produce APP-ONLY tokens, which `OperatorAuthorizer.authenticateEntra`
  refuses outright (`idtyp === "app"` → 403) regardless of grant, so on a router
  emitting that claim only `azure-cli` can ever succeed. Without the fallback the
  first credential the environment happens to produce is final, and the operator
  gets a 403 telling them to request a grant that cannot help. Rejection is
  recorded per SOURCE so the loop is bounded by the chain length and can never
  re-present a refused credential. Each acquisition is also bounded
  (`acquireTimeoutMs`, 15s): `ManagedIdentityCredential` against a blackholed
  169.254.169.254 stalls past the HTTP deadline, which would defeat the reason
  the chain excludes interactive credentials.

  `REMOTE_PROFILE_COMMANDS` is a LOAD-BEARING allowlist — `buildProgram`
  registers from a name-keyed table filtered by `REMOTE_PROFILE_REGISTERED`, so
  profile membership cannot be granted by where a `register*` call sits relative
  to a branch, and the test asserts an EXACT set rather than a subset (a subset
  passes for a command accidentally registered under a name already in the
  vocabulary). The two constants answer different questions: `…COMMANDS` is the
  approved vocabulary including `logs`/`recover`/`skills` (CYR-73/76/77) and
  `runs`; `…REGISTERED` is what exists and works today. `runs` is approved but
  NOT registered in the remote profile — `RunsCommand` reads
  `config.router.deviceToken`, written only by `cyrus connect`, which this
  profile does not register and `connection add` deliberately never writes, so
  registering it would ship a command that always fails while advising a command
  the profile hides. CYR-70 moves it onto `OperatorHttpClient`. Per ADR 0011 this
  is a product boundary, not an authorization one — the server-side tests in
  `OperatorAuthorizer.test.ts` remain the security proof.

  `operatorConnections` is a new `EdgeConfigSchema` field, classified into
  `RELOAD_EXEMPT_KEYS`: no EdgeWorker code path reads it, and merging it would
  fire a `configChanged` event on every `cyrus connection add`. Its auth union is
  `z.strictObject` so a hand-added `token:` is REFUSED rather than silently
  stripped, which keeps the "a stored connection carries no credential"
  invariant enforceable rather than aspirational.

- **Authenticated scoped fleet operators and exposed discovery ([CYR-65](https://linear.app/northrop-digital/issue/CYR-65/authenticate-scoped-fleet-operators-and-expose-discovery), [#58](https://github.com/nick-boey/cyrus/pull/58)).**
  New `packages/router/src/fleet-operations/` module — `types.ts`,
  `OperatorAuthorizer.ts`, `FleetOperations.ts`, `routes.ts` — implementing the
  router-side authentication boundary for the CYR-64 v1 contracts, plus a new
  `operator_tokens` table and `cyrus router operators` admin commands.

  `OperatorAuthorizer` is the ONLY code that turns a credential into an
  `OperatorPrincipal`, which is what makes "a container token gains no recovery
  authority" a property of the system rather than a rule each route remembers. It
  tells the three credential kinds apart by SHAPE — an operator token carries the
  `cyop_` prefix, an Entra token is a three-segment JWT, anything else is a device
  token — rather than probing each store in turn, which would have made a revoked
  operator token fall through to the device lookup and be reported as an unknown
  device. Entra claims are re-checked here (`tid`, exact-string `aud`, `oid`)
  rather than trusted from the verifier: `jose` accepts an ARRAY `aud` merely
  CONTAINING the expected value, which would admit a token minted for a different
  API in the same tenant. Grants are additive across `oid` and `groups`, keyed on
  immutable object ids, and narrowed to the workspaces the router actually serves;
  a verified identity with no role, or none over a served workspace, is 403.

  A device principal carries `ownerUserId`, and its PRESENCE is the scope
  mechanism rather than a note for later: `FleetOperations.capabilitiesFor`
  withholds from an owner-scoped principal every capability outside
  `OWNER_SCOPE_ENFORCEABLE` — that is, every capability the router does not serve
  itself and therefore cannot narrow to that owner. `logs.query` is the one that
  matters today, because under it the client queries the log backend DIRECTLY
  with no router-side filter, so granting it to a device token would have
  converted "read your own runs" into unfiltered read of every workspace's logs
  and disclosed the Log Analytics workspace GUID and ARM resource id with it.
  `OperatorPrincipal.authKind` includes
  `"device"` beyond the `"entra" | "local"` pair in the brief, because
  `OperatorContextV1.authMethod` is a required field over a closed three-member
  enum and the authorizer is the only thing entitled to decide which one a caller
  presented.

  `FleetOperations` validates BOTH documents against their v1 schema before they
  leave the class. That is a control, not a formality: `publicRouterMetadataV1Schema`
  is strict precisely so an additive change slipping a workspace list or log-source
  hint onto the anonymous document throws rather than discloses. Capabilities are
  the intersection of the principal's roles with what `RouterServer` says it
  SERVES — computed from registered routes, never read from the config file, and
  the config schema does not model the field — so the context cannot advertise a
  capability with no route behind it. Today that is `logs.query` when a log source
  is configured, and nothing else; the run and recovery routes land in later
  issues. The log-source descriptor is gated on the capability rather than on the
  config, so it is never disclosed to a principal who may not query it.

  Local credentials live in a new `operator_tokens` table (`label`, `token_hash`,
  `roles_json`, `workspaces_json`, `created_ms`, `revoked_ms`), separate from
  `devices.token_hash`. `getOperatorTokenByToken` filters revoked rows in SQL so
  the grant is fail-closed by construction and no caller can forget the check;
  `listOperatorTokens` still shows them, since "did my revocation take" is what an
  operator opens that command for. `revokeOperatorToken`'s `revoked_ms IS NULL`
  guard makes the write itself the arbiter of concurrent revocations. The
  `cyrus router operators` commands are local-only — they mint and revoke the
  credentials the operator API authenticates, so serving them over it would let a
  token mint another, and revoking a compromised token would depend on that token
  still working.

  Entra claims are re-checked here for tenant, issuer, audience, `exp`/`nbf`
  (60s skew), `oid`, and `idtyp !== "app"`. Temporal and issuer validity are
  re-checked for the same reason tenant and audience are: the stated threat model
  is that a verifier swapped in by a test or a future deployment must not weaken
  the gate by OMISSION, and "the default verifier happens to call
  `jose.jwtVerify`" is exactly the trust the class declines to extend. An Entra
  `groups` overage (`_claim_names` instead of `groups`, above ~200 groups) fails
  closed and now warns, because it fails closed for precisely the senior operator
  a `fleet.recover` group grant exists for and otherwise presents as an
  unexplained 403. The container check is an ALLOW-LIST on `kind === "device"`:
  `devices.kind` is a bare `TEXT` column with no `CHECK`, read through an
  unchecked cast, so a third value must default to denial.

  `FleetOperations` validates its `logSource`/`skill` config and builds the
  discovery document in its CONSTRUCTOR, so a config the wire schema would reject
  refuses to start the router rather than 500-ing the one authenticated route for
  as long as the process lives — the config file's schema cannot express
  `logSourceDescriptorV1Schema`'s cross-field rules. Both route handlers also
  catch: Fastify has no error handler on this instance, so an uncaught throw is
  rendered by its default handler, which puts the Zod issue list — naming the
  offending key — in the response body, turning the control that prevents a
  disclosure into the disclosure. The context route sends `Cache-Control:
  no-store`, since the document is per-principal and carries the caller's email
  on a device token.

  `/enroll`, `/workspaces`, `/runs`, and `/healthz` are untouched. Both new routes
  register unconditionally, in the constructor before `start()` — Fastify v5
  refuses routes on a listening server — and a router with no `fleetOperations`
  block still serves discovery and still accepts device and local operator tokens.

- **Defined versioned remote-operator contracts ([CYR-64](https://linear.app/northrop-digital/issue/CYR-64/define-versioned-remote-operator-contracts),
  [#57](https://github.com/nick-boey/cyrus/pull/57)).**
  New `cyrus-operator-protocol` package holding the v1 wire contracts the router's
  fleet-operations API and the CLI's remote-operator commands will both depend on,
  so neither side imports the other's implementation modules. Exports
  `PublicRouterMetadataV1`, `OperatorContextV1`/`OperatorRoleV1`/`OperatorCapabilityV1`,
  `LogSourceDescriptorV1`/`LogQueryV1`/`LogRecordV1`,
  `RunObservationV1`/`RunObservationPageV1`/`RunObservationChangeV1`/`RunChangePageV1`,
  and `RecoveryRequestV1`/`RecoveryPhaseV1`/`RecoveryOperationV1` — each a Zod
  schema with a literal `schemaVersion: 1` and an inferred type. Dependencies are
  Zod and nothing else: no router, Fastify, Commander, Azure, or filesystem
  imports. No HTTP route or user-visible command is added yet.

  The schemas encode the approved distinctions as cross-field rules rather than
  leaving them to prose, so a violation is a test failure: run lifecycle is a
  separate closed enum from executor state and only a container carries a sampled
  one; `waiting` and its worker-reported evidence travel together; a captured
  routing name may not appear without its canonical ID; change cursors are opaque
  and carry the router-start stream epoch, and a page may not mix epochs; the
  log-source descriptor is strict so it cannot carry a credential; and recovery is
  asynchronous, with a `RecoveryRequestV1` that is strict — silently stripping a
  misspelled `expectedRevision` would turn a conditional recovery into an
  unconditional one.

  Where a rule would have been tighter than the router's real data, it is
  deliberately not: pending work is refused only on a run that has ENDED, not on
  a waiting one, because a session blocked on a user answer with a live
  background build is the state the worker's own "safe to park?" gate exists for
  (`pending_work` stays distinct from a wait reason by `waitReasonV1Schema` being
  a closed enum, not by forbidding the two to coexist); and a run input may carry
  neither an activity nor a comment ID, because a delegation produces exactly
  that and requiring one would make the run it started unrepresentable. Emitting
  `RunObservationV1` still requires a store migration — `agent_runs` today has no
  `issue_id`, `runner`, or routing snapshot — which the schema documents rather
  than papering over with optional identity.

- **Adopted the observability domain language and decisions ([CYR-63](https://linear.app/northrop-digital/issue/CYR-63/migrate-cyr-62-domain-context-and-adrs-into-the-repository),
  planned on [CYR-62](https://linear.app/northrop-digital/issue/CYR-62/create-plan-for-project),
  [#56](https://github.com/nick-boey/cyrus/pull/56)).**
  Migrated the approved planning artifacts into the repository ahead of any
  implementation code, so the observability work argues from versioned, reviewed
  terms. `CONTEXT.md` gains **Waiting run**, **Elicitation**, **Run observation
  change**, **Command profile**, **Fleet operator**, **Log source**, **Run
  recovery**, and **Recovery operation**; **Agent run**, **Run observation**,
  **Router connection**, and **Park** were revised to match. ADRs 0009–0016
  record the decisions: separate user and fleet-operator principals, clients
  querying router-described log sources, role-specific command profiles,
  event-time run facts, ownership-reconciling run recovery, discovered and
  versioned operator HTTP capabilities, the resource-interface/workflow-CLI
  split, and durable material change feeds for watches.
- **Separated agent-run waiting from container parking.** The glossary previously
  let *park* name both an idle container being stopped and an agent run blocked
  on a user answer. *Park* is now the container fact only; the run fact is a
  **waiting run**. `docs/ROUTER.md` and ADR-0008 were amended to say so and to
  note that the wire and store still spell the run state `parked` — ADR-0012
  replaces that with an explicitly worker-reported wait reason, and the rename
  ships with that work, not here. No production code changed.

### Changed
- **`AgentRunObservation` and `AgentRunsResponse` now live in `cyrus-operator-protocol`
  ([CYR-64](https://linear.app/northrop-digital/issue/CYR-64/define-versioned-remote-operator-contracts),
  [#57](https://github.com/nick-boey/cyrus/pull/57)).**
  The unversioned `GET /runs` shapes moved out of `cyrus-router` so that
  `RunsCommand` stops importing a router implementation module for a wire type.
  `cyrus-router` re-exports them, so existing importers are unaffected, and
  `observeRun` is annotated with the published type — which makes a drift between
  the router's own `AgentRunState`/`SandboxGaugeState` unions and the wire contract
  a compile error rather than a silent wire change. Shipped `cyrus runs` behavior
  is unchanged; the types are marked deprecated and go away with their route.
- **Merged `cyrusagents/cyrus` main into the fork ([CYR-24](https://linear.app/northrop-digital/issue/CYR-24/bring-our-fork-up-to-date-with-the-upstream-cyrus-repo)).** The fork had diverged 33 ahead / 21 behind
  since 2026-08-08. Merged rather than rebased: `cyrus-deploy` pins a 40-character
  SHA of this branch and derives the router image tag from it, so rewriting these
  SHAs would orphan every deployed image tag from the history it was built at, and
  five open pull requests target `main`. Notable reconciliations, each preserving
  both sides' intent:
  - `WorkerService.startEdgeWorker` no longer lists `platform`, `router`,
    `userAccessControl`, `sandbox`, `issueUpdateTrigger`, `prReviewTrigger`,
    `promptDefaults` or `linearWorkspaces` explicitly. Upstream's `...edgeConfig`
    spread (CYPACK-1478) forwards plain pass-throughs generically — the same
    dropped-field bug those lines were added for — and its comment forbids
    listing them. `platform` and `router` were added to `RELOAD_MERGED_KEYS` so
    upstream's compile-time exhaustiveness check and hot-reload watch cover them.
  - `RunnerSelectionService.inferRunnerFromModel` gained upstream's OpenCode
    provider/model inference in the *public method*, not just the local closure,
    so `RunnerConfigBuilder` — which calls it through the `RunnerSelector`
    interface — cannot infer a different runner than the service does.
  - `PersistenceManager` keeps the fork's pid+counter temp filename rather than
    upstream's fixed `.tmp`: two overlapping in-process saves would otherwise
    interleave writes to one path. Upstream's requirement that a crashed save
    not leak its temp file is met by sweeping siblings on *load*, when no save
    of this process's is in flight. The empty-file and corrupt-file paths are now
    distinct — an intentionally cleared file is "no state", not a corruption.
  - Dropped the `@anthropic-ai/sdk: '>=0.115.0'` floor from
    `pnpm-workspace.yaml`. An override replaces the specifier outright, so it
    silently pinned the package at 0.115.0 and defeated upstream's bump to
    `^0.123.0`. Removing a floor a direct-dep bump has made redundant is what the
    Dependency Security Policy in `CLAUDE.md` requires.
  - Added the `opencode` arm to the router's `RUNNER_REQUIRED_SECRET_KEYS` and
    `MODEL_ENV_BY_RUNNER` maps, which upstream's widened `RunnerType` made
    non-exhaustive. Neither is reachable yet: OpenCode is not in `RUNNER_CATALOG`.
  - Cleared nine pre-existing `noUnsafeOptionalChaining` errors in upstream's
    `OpenCodeRunner.test.ts`. They fail `pnpm biome ci`, which this fork's CI
    gates on; upstream's `main` is currently red on its own lint step.

### Fixed
- **[CYR-1](https://linear.app/northrop-digital/issue/CYR-1/a-never-terminating-agent-session-makes-an-issue-permanently) — implementation review of #49: the disambiguation query could not answer the question the severity-1 alert routes operators to it with.** Four independent read-only reviewers went over the merged #49; three of them landed on the same query, from different directions.
  - **`Cyrus-Sessions-Never-Terminal` was valid KQL that answered the wrong question.** The anti-join compared set MEMBERSHIP, not recency: `AgentSessionManager.addAgentRunner` clears `terminalEmittedSessions` on every runner re-attach, so each cleanly finished turn emits its own `session.terminal_signalled` under the same Linear agent session id — and any session that completed turn 1 and then deferred forever on turn 3 was deleted from the result by turn 1's record. That is the ordinary multi-turn case, and replying in-thread is the documented recovery for a lock rejection, so **the workaround for this very bug manufactured the shape the query was blind to**. An operator would then read zero rows as "not waiting" and take the `cyrus router unlock` the query exists to gate. Now compares `last_deferred > last_signalled`, and uses `arg_max` so the pending-work columns describe the current stall rather than an arbitrary earlier turn's.
  - **A row's meaning, and zero rows' meaning, are both stated.** The old comment claimed the residue "IS the population of permanently locked issues". It is not: `reconcileDeviceLocks`, terminal teardown, `cyrus router unlock` and event-TTL expiry all release a lock without the device emitting a signal, leaving a permanently unpaired deferral. The alert description now says explicitly that zero rows does not mean healthy, and sends the operator to `cyrus router sessions list` to cross-check.
  - **AC3 was only half met: `routing.rejected` covered the `created` path only.** Four refusals in `routePrompted`/`resumeHeldSelection`/`ensureRepositoryDecision` emitted nothing, two of them still at `info`. This is not a coverage gap so much as an inversion: `ISSUE_LOCKED_MESSAGE` answers a lock rejection by directing the user to reply in the holding session's thread — i.e. it routes every lock-rejected user *out of* the instrumented path and *into* the uninstrumented one. Added `non_creator_prompt`, `prompt_unroutable` and `repositories_unavailable`, all at `warn` with an event.
  - **The lock message sent a non-creator round a closed loop.** With `creatorOnlyPrompting` on (the default), "reply inside the running session's thread" is false advice for anyone who did not start the holding session: that reply is rejected and told to start its own session, which lands back on the lock — and before the previous item, neither hop emitted anything. New `ISSUE_LOCKED_BY_OTHER_MESSAGE` names the holder and explains why replying will not work. The original message's "(session owned by another user)" was dropped in #49 because CAN-133 was a self-collision; correct for that case, wrong for the multi-user collision the issue lock exists for, so the choice is now made per-rejection from the holder's stored creator.
  - **`cyrus router unlock` no longer appears in the Linear-facing message at all.** It was offered on the precondition "if that session is no longer doing anything" — the one determination #49 spends forty lines of doc comment establishing the router *cannot* make. Every operator-facing surface gates it; this was the only surface read by a Linear user, who has strictly less information than the router and no way to run the check. `unlock` also releases the lock but not session affinity, so acting on it against a waiting session manufactures the very divergence the detector cannot see.
  - **`containers.sessionNoProgressMs` is now settable.** It was the only `ContainerLifecycle` threshold with no path from `router-config.json`, while shipping a documented false-positive class (a cron with a period over 4h) on a severity-1, 15-minute-evaluation rule. The only available remedy was muting the rule — which also mutes `offline_pinned`, and is the alert-fatigue failure this whole issue is about. Validated as a positive integer for the same reason `terminalSettleMs` is: 0 or negative silently turns the detector into one that reports every pinned sandbox on every tick.
  - **`formatPendingWorkSummary` could reject the terminal path.** `truncate` called `.replace` on `task.command ?? task.description`, which is `undefined` for a background task carrying neither — and it is called from `completeSession`'s `finally`, so a malformed runner payload would throw out of the one path whose job is to release the issue lock. Now degrades to `(unnamed)`. The item COUNT is also capped (it was bounded only by a downstream sink's clamp, on an attribute exported to a per-GB backend), and the previously untested `backgroundTasks` branch has a dedicated test file.
  - **The `rpc_request` progress-stamp warning is latched.** `rpc_request` is the highest-frequency device→router frame there is and the failures it guards (`SQLITE_FULL`, readonly database) are persistent, so an unlatched `warn` turned one full disk into a per-frame log storm billed per GB.
  - **Added `RouterTelemetry.test.ts`**, pinning the `routing.rejected` event name and its six `cyrus.*` attribute keys verbatim. The generic `eventsNamed` helper strips the `cyrus.` prefix by design, so nothing was asserting the strings `Cyrus-Routing-Rejections` actually queries — a rename would have left every test green and the operator's columns empty.
  - **Documented a correlation trap rather than half-fixing it.** `session.held_open` / `session.pending_work_recorded` carry `cyrus.agent_session_id` too, but theirs is the *Claude SDK* session id, not the Linear one — so joining them to `session.terminal_deferred` silently returns nothing. Renaming only those two would leave `packages/claude-runner`'s vocabulary internally inconsistent; the whole family has to move at once, which is its own change. Noted at both emit sites and in the saved search.
  - **`scripts/check-bicep.sh` now actually run** (standalone Bicep CLI 0.46.1): all 9 templates plus `main.bicepparam.example` compile clean under the warnings-are-failures rule. #49's "176 uncompiled Bicep lines" caveat is retired. Note this validates the *template*, never the KQL inside it — which is precisely how the query defect above survived a green `infra` check. The queries were subsequently RUN against `log-cyrus-dev` (2026-09-03): both `Cyrus-Sessions-Never-Terminal` and `Cyrus-Routing-Rejections` parse, and that run also retired a claim made earlier in this review — `distinct <alias> = <expr>` is accepted by Log Analytics and joins correctly, so the defect here was semantic only, never syntactic.
- **[NOR-402](https://linear.app/northrop-digital/issue/NOR-402/a-never-terminating-agent-session-makes-an-issue-permanently), [#49](https://github.com/nick-boey/cyrus/pull/49) — the stranded-session detector could not see the fault it was named for, and the fault itself was unfalsifiable.**
  - **`noteStranded` gained a second shape, `reason=no_progress`.** Its `notRunning && !online` gate excluded `running && online && sessions>0` **by definition**, which is exactly what CAN-133 reported once a minute for 5h17m — so `alert-cyrus-dev-sandbox-stranded-sessions` (enabled, severity 1, 15-minute evaluation) could never fire for it. "Looks healthy" cannot be the exclusion when a healthy-looking container is what the fault produces. `offline_pinned` keeps its own faster 10-minute grace because there the *state* itself proves no progress; `no_progress` is state-independent and defaults to 4 hours (see the follow-up entry below for why that value, and for the `containers.sessionNoProgressMs` knob). Both stay DETECTION ONLY for the reasons in `noteStranded`'s doc comment. `offline_pinned` wins when both hold, and the once-per-entry error latch is now keyed by reason so a change of diagnosis is not swallowed.
  - **The clock is a new column, `devices.last_progress_ms`, and the omissions are the design.** The ticket proposed thresholding `last_routed_age_ms`, which cannot work on its own — the router stamps nothing while an agent works, so a genuinely long turn is indistinguishable from a strand (the NOR-366 observation, from the other direction). `last_seen_ms` is the heartbeat and a wedged worker sends it faithfully. `last_active_ms` is stamped by the sweep on **every pinned tick**, so a detector reading it would reset its own clock and never fire. The new column is stamped ONLY from a device-originated `rpc_request` in `DeviceGateway`: a sandbox holds no Linear token, so every activity its agent posts arrives as one, making it the only clock moved by the agent working rather than by something the router did. Backfilled on migration — a NULL would report every pre-upgrade pinned sandbox as stranded on the first restart, and a sev-1 rule that storms on deploy gets muted. Deliberately NOT an input to the idle clock.
  - **Root cause of the non-termination is identified but not yet confirmed against the incident, and no timeout was added.** The single unbounded path in the terminal chain is `AgentSessionManager.completeSession`'s pending-work deferral: `emitTerminalOnce` is withheld while the runner reports crons/background/live-background tasks, and is retried only when a later `result` arrives — so a background task that never exits holds the issue lock forever. It was **unfalsifiable from the incident logs** because the branch logged `info`, and a sandbox worker's `RouterLogForwarder` is WARN+ by default, so the line never left the container. It is now `session.terminal_deferred` (with the pending work's identity) paired with `session.terminal_signalled`; `event()` records bypass the forwarding threshold. Together they make "did this session ever finish?" answerable, which is the prerequisite the ticket set before any timeout is considered.
  - **Routing refusals are observable.** `routing.rejected` (new `ROUTING_EVENTS` family in `RouterTelemetry.ts`) with `reason` ∈ `issue_locked` / `unenrolled_creator` / `invalid_issue_key`, carrying the holding session and device for a lock rejection, and all three refusal paths raised from `info` to `warn`. On CAN-133 three prompts were lost at the lock over four hours as `info` lines among 220 near-identical ones. `ISSUE_LOCKED_MESSAGE` no longer claims the holder belongs to another user (it was the same person) and leads with the verified recovery — replying in-thread produces `AgentSessionEvent/prompted`, which is not lock-gated.
  - **Monitoring.** The alert query coalesces a missing `cyrus.reason` to `offline_pinned` so mid-rollout records are grouped rather than dropped into an empty dimension, and `reason` is a dimension so the two shapes alert separately. Two new saved searches: *Cyrus-Sessions-Never-Terminal* (a left-anti join of `terminal_deferred` against `terminal_signalled` — the population of permanently locked issues) and *Cyrus-Routing-Rejections*.
  - **`no_progress` cannot distinguish a strand from a deliberate idle, and says so rather than hiding it.** Found by adversarial review of the first cut, which had this backwards: the detector fired on any hour of silence, and its remedy line asserted "its agent session never reached a terminal state" and advised `cyrus router unlock`. But the pending-work deferral this ticket identifies as the root cause is ALSO what a healthy session waiting on a `ScheduleWakeup` or cron does — affinity held, nothing posted, every clock frozen — and the two facts only ever meet on the device. So the first cut would have paged at severity 1 for normal operation and told the operator to unlock a run that was about to resume, manufacturing the lock-without-affinity leak. That is the same alert-fatigue failure the ticket warns about, inverted. Fixed three ways: the default threshold moved 1h → 4h (above `ScheduleWakeup`'s 1h clamp, still under CAN-133's 5h17m; a cron with a period over 4h remains a known, documented false-positive class), the log line and alert description now name both possibilities and route the operator to `Cyrus-Sessions-Never-Terminal` to disambiguate, and `cyrus router unlock` is explicitly gated on having confirmed it is not waiting. The real fix is to propagate the deferral to the router so the branch can exclude it; that is a device→router protocol change and is deliberately not attempted here.
  - **`cyrus.pending_work` was null for exactly the case the commit calls the prime suspect.** It used `formatPendingWorkThought`, which renders the user-facing "standing by" message and lists only scheduled wakeups — returning null for a session held open solely by a LIVE background task, i.e. "a background task that never exits". New `formatPendingWorkSummary` covers all three lists for telemetry; the Linear-facing thought is unchanged.
  - **The `rpc_request` progress stamp is now guarded.** It sits in `DeviceGateway.handleMessage`, which runs straight off `ws.on("message")` with only `parseDeviceFrame` in a try — so a `SQLITE_FULL`/readonly-database throw would have escaped into the socket callback and taken the router down for every teammate. The neighbouring `log` and `span` branches already carry an explicit "must never break the socket" contract; a purely diagnostic stamp has less business doing so.
  - **Known gap, not fixed here.** Both stranded shapes are reached only from the sweep's `affinity > 0` gate, but what makes an issue unreachable is the ISSUE LOCK — and the two diverge deliberately: a `parked` session releases affinity and RETAINS its lock. An elicitation nobody answers therefore locks an issue with no affinity, is invisible to `noteStranded`, and surfaces only in `RouterStore.listSessions`' orphan-lock query behind `cyrus router sessions list`. That class has no event and no alert. Stated in `noteStranded`'s doc comment so the detector is not read as covering every locked issue.
  - **Not done, and why.** The end-to-end demonstrations the acceptance criteria ask for (construct the state, watch the alert raise) need the deployed `log-cyrus-dev` workspace and were left to the operator — and the ticket explicitly rules out fixtures as sufficient, so AC2 is **half met**: the detector fires in unit tests, the alert has not been observed to raise. AC1 (restart via a top-level comment) is not met and belongs to [NOR-409](https://linear.app/northrop-digital/issue/NOR-409/a-comment-on-a-locked-issue-is-rejected-rather-than-queued-and-the); AC3 (observable refusals) is met and tested. The ticket's *Documentation deltas* item is unaddressed here because the `implement-project-with-cyrus` guidance lives in `~/.claude/skills`, outside this repository — it already describes the lock behaviour correctly, but it cannot be committed from here. Adding `reason` as an alert dimension changes the alert's grouping identity, so any currently-firing stranded alert will auto-mitigate and re-fire once after deploy.

### Added
- **`socat` + `bubblewrap` in both image paths, and subprocess env scrubbing made opt-in-and-fatal ([NOR-412](https://linear.app/northrop-digital/issue/NOR-412/subprocess-env-scrubbing-is-off-in-every-sandbox-socat-and-bubblewrap), [#46](https://github.com/nick-boey/cyrus/pull/46)).** Both packages were absent from `docker/worker/Dockerfile`, so `checkLinuxSandboxRequirements()` reported every sandbox unsupported and logged `Linux sandbox requirements are not met — skipping CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` once per session.
  - **The warning's premise was false, which is why the finding read as a security regression it was not.** `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` has not been set by any code path since CYPACK-1108 disabled it, so installing the packages would have silenced the warning and changed nothing. The precheck was pure diagnostics for a flag with no consumer. `resolveSubprocessEnvScrub` now owns the decision end to end: absent the `CYRUS_SUBPROCESS_ENV_SCRUB` opt-in it returns disabled **without probing the host at all** — the requirements of a control nothing would have enabled are not interesting, and probing for them is the entire source of the noise.
  - **Requested-but-unavailable throws.** `SubprocessEnvScrubUnavailableError` aborts the session and names every unmet requirement with its install command. This is the answer to the issue's "consider whether this should be fatal": a control that degrades to off with a `warn` is off again the next time a dependency goes missing, and the abort is the alert that nothing else provides.
  - **The SDK flag is now set *or unset* explicitly at both call sites.** `buildBaseSessionEnv` spreads the whole parent `process.env`, so the old "intentionally not set" comment was only true of a worker whose own environment happened not to carry the variable — a latent path to the SDK sandbox turning on behind the precheck's back. `EdgeWorker.warmupRecentSessions()` resolves it the same way. Note what that does and does not buy: when `config.warmSession` is set, `ClaudeRunner` discards `queryOptions` wholesale and calls `warmSession.query()`, so the runner-side assignment is **inert** on that path and the warmup's value is the operative one. The two agree only because both call `resolveSubprocessEnvScrub` against the same `process.env` in the same process — nothing reconciles them, and the first change that makes the decision per-repository or hot-reloadable will diverge silently. Both halves are now pinned by tests.
  - **The third prerequisite is a runtime property and was verified, not assumed.** Adding the packages is necessary but not sufficient — bubblewrap also needs an unprivileged user namespace. The exact probe `runBwrapSandboxProbe` issues was run inside a **live ACA sandbox** against a real `bwrap` binary and exits 0, so ACA does grant it; NOR-364 phase 3 recorded the opposite (`bwrap: No permissions to create a new namespace`) on a **local Docker** drive. Hence opt-in per host rather than on by default.
  - **Not deployed by this change.** Two artifacts must move, not one: the worker image (rebuilt, with `workerImage` + `acaDiskName` moved as a pair via `scripts/deploy-worker-image.sh`, gating on `disk list` showing `Ready`) and the `cyrus-worker` Feature (published at `0.2.0`, with `workerFeatureRef` + `workerFeatureVersion` moved together). Both are operator steps requiring `az`, `docker`, registry credentials and the gitignored `infra/azure/bicep/main.bicepparam`, none of which exist in a sandbox. Until both run, sandboxes keep images without the packages — so the opt-in must stay off in the cloud. The warning is gone either way, because it no longer fires on the default path.
  - **Review fix — the "fatal" abort was not fatal.** As first written, `resolveSubprocessEnvScrub` was called inside `startWithPrompt`'s `try`, whose `catch` **does not rethrow**: it emits `"error"` and returns `sessionInfo`, and `EventEmitter` only rethrows an *unhandled* `"error"`. Every production caller registers `onError`, so the throw would have resolved `start()` normally and left a Linear agent session hanging with no activities and no terminal state — the NOR-402 shape, and precisely the "off, with a log line nothing alerts on" outcome the issue objected to, now with a CLAUDE.md invariant asserting otherwise. Resolution moved above the `try`, where nothing is yet allocated for the `finally` to clean up. The test that pinned it passed only because its config supplied no `onError`; it now registers one, which is what makes it a regression guard rather than an accident.
  - **Known gap, recorded rather than closed:** `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is undocumented in `sdk.d.ts` and the SDK README — it lives only in the bundled env-var registry read by the CLI binary — and the scrub itself has never been observed end to end. The ACA verification covered the bubblewrap prerequisite, which is not the same claim. The SDK exposes a typed alternative, `options.sandbox.credentials.envVars` (`{name, mode: "deny" | "mask"}`), settable from the `sandbox` object `RunnerConfigBuilder` already builds and free of the bubblewrap/socat/userns chain; it is the likely successor. Both are noted in CLAUDE.md §15.
  - **Second review round — the abort was fatal to `start()` and to nothing else.** Moving the resolve above the `try` made `start()` reject, but every caller of that promise swallows it: `initializeAgentRunner` rethrows into `handleAgentSessionCreatedWebhook`, which does not catch, into `handleWebhook`, whose catch logs and deliberately does not rethrow so a bad webhook cannot kill the process. Nothing on the path reaches `createErrorActivity`, `updateSessionStatus(Error)` or `emitTerminalOnce`, and `postInstantAcknowledgment` has already posted a thought — so the session rendered as working forever, with the router's issue lock and affinity still pinned. The same shape existed on the prompted path. `AgentSessionManager.failSession()` now posts the reason and goes terminal, and both start sites call it before rethrowing; the handling is general, because every start-time throw had this shape, not just this one.
  - **The opt-in was silently enabled on platforms nothing had checked.** `checkLinuxSandboxRequirements` reports every non-Linux host as `supported: true` — correct for a bubblewrap precheck, wrong as the sole predicate for a credential control. `CYRUS_SUBPROCESS_ENV_SCRUB=1` on macOS therefore returned enabled having probed nothing, on the platform where the undocumented flag is most likely to be a no-op and could never fail loudly: the exact failure this issue is about, on the other half of the platform matrix. `checkSubprocessEnvScrubRequirements` now refuses off Linux and says why.
  - **A cached negative made the error's own remediation impossible to apply.** `cachedResult` memoised failures for the process lifetime, so an operator who ran the `apt-get install` line the error printed got the identical fatal error on the next session and every session after — on a long-lived ACA sandbox, a `router containers destroy` and re-prompt to apply a fix we asked for. Only supported results are cached now; the re-probe costs two or three `spawnSync` calls on a path that is already fatal. The test that claimed to pin "keeps throwing on every session" passed only because of that cache, and now supplies fresh probes.
  - **`socat`/`bubblewrap` were added to the default image only.** A repository with its own devcontainer gets its image from ADR 0006's path, which never runs `docker/worker/Dockerfile`; its packages come from `features/src/cyrus-worker/install.sh`. Since the opt-in rides the per-user secret bundle into every container rather than being per-image, a half-equipped fleet means enabling it fails every session on the devcontainer repos. Both packages added to all four family branches, and the Feature version bumped to `0.2.0` — it participates in the devcontainer image cache key, so the bump is what invalidates cached images built without them.
  - **The posture is now queryable.** `session.env_scrub_resolved` carries `cyrus.requested` / `cyrus.enabled` / `cyrus.platform` / `cyrus.failures`, with two saved searches in `monitoring.bicep`. Prose log lines were the original complaint; a control whose off-state is only visible as rendered text reproduces it. Alert on `requested and not enabled` — every such record is a session that failed to start.
  - **A hand-set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is now called out rather than dropped.** Every call site overwrites it from the resolver's verdict, including over a repository `.env` and `additionalEnv`, so anyone who set it directly to re-enable the control after CYPACK-1108 had it silently removed — indistinguishable from the control working. Warned once per process, naming `CYRUS_SUBPROCESS_ENV_SCRUB` as the switch that now governs.
- **Owner-scoped agent-run observations (related to [NOR-402](https://linear.app/northrop-digital/issue/NOR-402/a-never-terminating-agent-session-makes-an-issue-permanently), [#44](https://github.com/nick-boey/cyrus/pull/44)).** The router now retains each
  routed work episode, its Linear activity/comment references, latest published
  agent activity, exact or unknown terminal outcome, worker liveness, and the
  lifecycle sweep's cached executor state for 24 hours. Authenticated clients
  can query `GET /runs`, while `cyrus runs [issue] --comment <id> --watch`
  reuses the URL and bearer token saved by `cyrus connect` and exits non-zero
  for non-success terminal outcomes.
- **NOR-309 — per-repository devcontainer images, Tasks 1–7 and 9 ([NOR-309](https://linear.app/northrop-digital/issue/NOR-309/support-devcontainers), [#43](https://github.com/nick-boey/cyrus/pull/43)).** A registered repository's `devcontainer.json` is read on the router, built in ACR, registered as an ACA disk, and pinned per issue. `containers.devcontainers` gates the whole thing and additionally requires `containers.aca` (a per-repository image *is* a per-repository disk image); omitting it leaves every deployment byte-identical to before. Design is `docs/adr/0006` + `docs/adr/0007`; operator documentation is `docs/ROUTER.md` → *Per-repository devcontainer images*.
  - **Task 0's gate is discharged.** `docker/worker/devcontainer/build.sh` was run on Docker 29.7.2 (darwin/arm64): **23/23 boot-contract assertions pass**, `devcontainer build` takes 205s, and the image is **7.76 GB** against the Dockerfile's 6.53 GB on the same host — about 1.2 GB more, plausibly the feature scaffolding plus the worker's deliberately private second Node. Same order of magnitude, so nothing here relieves the disk-import constraints, and nothing contradicts the plan's non-goal of shrinking the default image.
  - **`--buildkit never` is not the lever the spike claimed, and the correction is load-bearing.** The devcontainer CLI shells out to plain `docker build` (its own log: `Start: Run: docker build --build-arg _DEV_CONTAINERS_BASE_IMAGE=…`), so the flag only decides which flags *it* passes; the daemon picks BuildKit anyway and attaches provenance/SBOM attestations, producing the `application/vnd.oci.image.index.v1+json` the ACA disk importer cannot consume. `DOCKER_BUILDKIT=0` **in the environment** selects the classic builder — verified in both directions. Since every such mechanism is a property of the daemon rather than of anything we can pass, the build script also sets `BUILDX_NO_DEFAULT_ATTESTATIONS=1` and **asserts the pushed manifest's media type**, failing where the run id and the log are rather than at a disk import hours later that reports a media type and nothing about where it came from. `build.sh`'s own last assertion had an inverted result for a different reason — `container-boot` exits non-zero when it correctly refuses to start, and `pipefail` made the pipeline's status the `docker run`'s, not the `grep`'s.
  - **The `cyrus.disk` staleness split lives in the PIN's lifetime, not in a second label.** An issue is pinned to a disk once (`issue_disk_images`), and the label is compared against that pin — so a repository author's devcontainer edit cannot retro-replace live containers, which matters because the replace rule *also deletes the sandbox's snapshots* and would cold-restart every in-flight issue on that repository while destroying the warm path that would have made the restore cheap. The pin additionally records the `deploymentDisk` it was made under, so a move of the deployment's own worker image invalidates every pin and does still replace everything. One label, two lifetimes, and no new comparison logic in the provider. `ensureDisk`'s best-effort registration now **refuses** to invent one for a repository disk: it knows only the deployment's image ref, so inventing one would import the wrong environment under the right name and report success.
  - **Three tables, because they are three views of one thing.** `repo_devcontainer_images` is the build cache keyed by a content hash of (repository, devcontainer bytes, its path, worker feature version, worker payload) — length-prefixed, so no field can impersonate the start of the next; `issue_disk_images` is the per-issue pin, dropped with the container device row so the GC can collect what it referenced; `pending_devcontainer_builds` holds `created` webhooks exactly as `pending_repo_selections` already does. Claiming a build is `INSERT … ON CONFLICT DO NOTHING`, which makes single-flight a property of SQLite's single writer rather than of this process — two issues on the same repository seconds apart schedule **one** ACR run, not two pushing the same tag from two checkouts of the same ref. A `failed` row is re-claimable so a transient ACR fault does not poison the key until someone edits the repository.
  - **Disk names are derived digests, and had to be.** The `cyrus.disk` label value is capped at 63 characters while `REPOSITORY_NAME_RE` permits repository names up to 64, so a readable composition cannot fit; identity is recovered from the tables, which is also what the GC reads.
  - **`createDiskImage` was sending a body the service does not read.** It now matches the shape `scripts/deploy-worker-image.sh` proved under NOR-337 — `labels.name` (the server assigns its own GUID as `name`), `registryCredentials` as a **sibling** of `image`, credential field `token` — and uses the slow-operation deadline, because the import is synchronous and scales with image size. `waitForDiskImageReady` gates on `Ready`: a 2xx says the request was accepted, not that the image imported. The ACR pull credential is minted by the same `oauth2/exchange` `az acr login --expose-token` performs, with the tenant read from the ARM token's own `tid` claim rather than configured separately, since a configured value can only ever disagree with it.
  - **The build runs in ACR and nowhere else (ADR 0007), and the run id is the report.** An `EncodedTaskRunRequest` whose one `cmd` step clones the repository (token through a git `extraheader`, never in the remote URL), overwrites the devcontainer at **the path it was found at** so every relative path inside it still resolves, builds, applies the finalize stage, pushes, and checks the manifest. Everything needing judgement — JSONC parsing, feature merging, install ordering — happens on the router and arrives as finished JSON. Failures relay the run id plus a bounded tail, never the full log: that build ran with unrestricted egress over repository-controlled content, so the log stays behind Azure's own authorization where `az acr task logs --run-id` can reach it.
  - **The worker feature is composed FIRST, and that is not cosmetic.** `rust`, `node` and `github-cli` all resolve `USERNAME="${USERNAME:-"${_REMOTE_USER:-automatic}"}"` and silently fall back to `USERNAME=root` when `id -u` fails, so a toolchain feature running before the one that creates the worker user produces a root-owned `CARGO_HOME` — every `cargo build` failing at runtime in an image that built without a warning. The repository's own feature options still win on a key collision, because the repository is trusted and this is its environment.
  - **`postCreateCommand` is read from the CLONE, by the worker.** It is the only lifecycle command honoured: the source is cloned at boot and never baked into the image, so `onCreateCommand`/`updateContentCommand` cannot be honoured faithfully, and `postStartCommand` is actively wrong because a parked container resumes many times per issue. Reading it worker-side rather than passing it down means an issue gets the command on its own branch, and put the JSONC parser in `cyrus-core` — the one part that must not drift between the router's reader and the worker's.
  - **Review fixes (code review of #43).** Seven defects found by a two-axis review and fixed in the same PR:
    - **A router restart mid-build stranded every issue on that repository, permanently.** A `building` cache row is durable; the `finally` that clears it and the callback that releases the webhooks held behind it are in-process, and `claimDevcontainerBuild` re-claims only a `failed` row. The single-replica router restarts on every deploy, so this was the ordinary case. `recoverInterruptedBuilds()` runs at startup, deletes the abandoned rows and releases what they held — deleting rather than failing, because an interrupted build says nothing about whether the devcontainer builds, and a `failed` row would send every issue to the default image until someone edited the repository.
    - **`containerEnv` was documented as honoured and silently dropped.** `devcontainer build` records it as a `devcontainer.metadata` label that only the devcontainer CLI reads, and ACA boots the image's own OCI config — the same mechanism, and the same outcome, as the `USER`/`ENTRYPOINT` finding the spike already recorded. It is now emitted as real `ENV` by the finalize stage, with `${containerEnv:VAR}` translated to Docker's own `${VAR}` so `PATH` extension (what almost every real `containerEnv` does) works.
    - **`dockerComposeFile` did not fail loudly at registration.** The rejection existed but was raised inside the fire-and-forget warm build, where it could only become a `logger.warn` nobody reads, and registration succeeded. Validation now runs before the repository is written — one GitHub API call — and refuses the form with the reason. A read that *fails* is not a rejection: GitHub being unreachable says nothing about the devcontainer.
    - **The cache key missed the referenced `build.dockerfile`.** A repository that edited only its Dockerfile never invalidated and booted a stale image indefinitely. Its path and bytes are now part of the key, resolved against the folder the devcontainer file was found in.
    - **`postCreateCommand` ran on physical devices**, which never enabled the feature. Unlike `cyrus-setup.sh`, whose presence is the opt-in, a `devcontainer.json` is a general-purpose file written for VS Code — honouring it on a teammate's own machine ran uninvited shell for every repository carrying one. Gated to sandbox workers.
    - **The worker payload was published as an `actions/upload-artifact`**, which needs an authenticated API call to download and expires on a retention clock, while the feature fetches it with a bare credential-free `curl`. It is now a release asset: tags publish to their own release, `main` to a rolling `worker-payload-main` prerelease.
    - **`parseJsonc` corrupted string literals containing `, }` or `, ]`.** The trailing-comma pass was a regex over the finished text, discarding the `inString` state the loop above maintains — so a `postCreateCommand` of `npm i, ]` silently lost its comma in a file that parsed without error. Trailing commas are now decided in the same pass.
    - Also: every new outbound `fetch` carries a deadline (Node's has none — the GitHub read sits on the `created` webhook path), the GC lists ACA disk images once instead of once per row, and the duplicated disk lookup is one helper.
  - **Task 8 is deliberately not implemented.** Its open question — which environment wins when an issue deliberately fans out across repositories — is unresolved, and a second elicitation flow is a lot of machinery for a rare, deliberate case. A multi-repository issue uses the **default worker image**, which is the plan's own recommended answer (it is the only image carrying every toolchain, and a fan-out is exactly the polyglot case), and Cyrus says on the issue what that costs. Choosing silently is what would make a missing toolchain look like a Cyrus bug rather than a consequence of the fan-out.
  - **Still unproven, and named rather than assumed:** `devcontainer build` inside an ACR task (the mechanism exists and the build is proven on an ordinary Docker host, but nobody has run it on an ACR agent), and the Alpine/RHEL branches of the worker feature.
- **NOR-309 Task 0 spike — the default worker image expressed as a devcontainer ([NOR-309](https://linear.app/northrop-digital/issue/NOR-309/support-devcontainers), [#43](https://github.com/nick-boey/cyrus/pull/43)).** A falsification exercise against ADR 0006's central assumption, that an arbitrary base plus a self-contained worker feature can boot Cyrus. **The assumption holds** — every component of `docker/worker/Dockerfile` maps onto the Dev Containers model and nothing was found that cannot be expressed — but two of the ADR's claims do not survive contact, and both are now recorded in the ADR and in `docs/spikes/2026-09-01-nor-309-devcontainer-spike.md`. Artifacts: `features/src/cyrus-worker/` (the Feature, in the canonical publishable layout) and `docker/worker/devcontainer/` (the reproduction, four local Features, the finalize stage, and a build script).
  - **A Feature structurally cannot set `USER` or `ENTRYPOINT`, and the devcontainer CLI does not either.** The generated Dockerfile ends with `USER $_DEV_CONTAINERS_IMAGE_USER` bound to the *base image's* user, never `containerUser`, and no `ENTRYPOINT` is emitted anywhere in the CLI. `containerUser`/`remoteUser` are a `devcontainer.metadata` label that only the devcontainer CLI reads when it execs in — ACA does not read it and boots the image's own OCI entrypoint as the image's own user. So a build of a `node:22-slim`-based repo runs as **root** with **node's** entrypoint whatever the config says. Fixed by a uniform two-instruction stage over the built image (`Dockerfile.finalize`), which is not the bespoke grafting ADR 0006 rejects because it does not vary with the base's shape. It asserts the feature actually ran, since the alternative failure presents as a sandbox stuck `Running` with no worker attached.
  - **The worker payload cannot come from public npm, and cannot be `npm install`ed at all.** `cyrus-ai@0.2.70` on the public registry is a different, older CLI: 21 dist files, no `buildProgram`, and no `container-boot` command anywhere in the package (verified by installing it). An image built that way builds cleanly and dies at boot with `error: too many arguments for 'start'` — the parser treating `container-boot` as a positional to `start`, naming neither the missing command nor the wrong package, in the ACA window where nothing collects the worker's stdout. The obvious repair fails too: `cyrus-ai` declares nine `workspace:*` dependencies and a `pnpm deploy` tree sets no `bundledDependencies`, so npm would discard the `node_modules` the tree carries and then fail to rebuild it. The payload is a gzipped `pnpm deploy --prod --legacy` tree **extracted as-is** — what the Dockerfile `COPY`s today — which makes the Feature's `tarball` option the primary delivery mechanism rather than an escape hatch, and adds ~256 MB compressed / ~956 MB extracted of per-release artifact storage the plan does not currently account for. `install.sh` asserts `container-boot` is registered and fails the **build** if not; verified to fire on the npm package and to pass on the deploy tree.
  - **The non-root question — the spike's stated highest risk — resolves better than expected.** `rust` declares exactly the `RUSTUP_HOME=/usr/local/rustup` / `CARGO_HOME=/usr/local/cargo` the Dockerfile hand-rolls, then `groupadd -r rustlang` / `usermod -a -G` / `chown` / `chmod g+r+w+s`; `rust`, `node` and `github-cli` all resolve `_REMOTE_USER`, which the CLI supplies from the composed config. But those same features fall back to `USERNAME=root` when `id -u` fails, so a toolchain feature running before the one that creates the worker user silently produces a root-owned `CARGO_HOME` — every `cargo build` failing at runtime on a container that built without a warning. The worker feature must be first in `overrideFeatureInstallOrder`; that is a requirement on the build pipeline, not a nicety.
  - **Two structural findings for the remaining tasks.** Anything needing a toolchain must be a Feature, not a `build.dockerfile` step, because Features install strictly after the base is built — so Fleece, Playwright and the agent CLIs become local Features with `installsAfter`, and Task 2 ships a small *set* of features rather than one. And the worker's Node must be installed **off `PATH`**: the agent runs the repository's own builds, so a worker Node shadowing the repository's pinned one makes a version mismatch look like a bug in the repository.
  - **Build location is plausible but unverified.** ACR Tasks `cmd` steps accept `docker run` parameters including volumes, and the build agent has a Docker daemon at `/var/run/docker.sock` (`acr-builder` mounts it for its own steps), so a `cmd` step can run `devcontainer build` — `az acr build` alone cannot, since it builds a single Dockerfile. Nobody has run it. It also surfaced a constraint that will bite: `devcontainer build` under a recent buildx attaches provenance/SBOM attestations and produces an OCI image index, which the ACA disk importer cannot consume and which `deploy-worker-image.sh` already gates on — `--buildkit never` is the lever, and that script's "rebuild with `az acr build`" advice does not apply on this path.
  - **Devcontainer file precedence needs no change.** The reference implementation's well-known paths are `.devcontainer/devcontainer.json` then `.devcontainer.json`, matching the spec and the order chosen in `9bb3e8e`. The list has only those two entries — the CLI does not implement multi-config discovery at all — so treating it as unsupported matches the reference implementation rather than diverging from it.
  - **The spike could not build an image**, and says so at the top rather than in a footnote: its sandbox has no container runtime, no `sudo`, and an egress allowlist that blocks `nodejs.org`. What *was* executed is real — the whole worker-payload path end to end (build, deploy, tar, extract, and `/entrypoint.sh` reaching `container-boot`'s "Missing required environment variable(s)" with the boot log written to `$HOME`, which is the decisive criterion short of a container); the npm finding and its build-time assertion in both directions; the `gh` install path including the checksum-column parse most likely to hide a silent bug; `dash -n` on every script. The rest is analysis of primary sources with file and line references. `docker/worker/devcontainer/build.sh` carries the unexecuted half as 23 boot-contract assertions, so discharging Task 0's gate is one command on a Docker host rather than a reconstruction.
- **The edge-worker suite is isolated from the ambient environment ([NOR-365](https://linear.app/northrop-digital/issue/NOR-365/install-the-mattpocock-plugin-for-claude-code-in-the-sandboxes), [#39](https://github.com/nick-boey/cyrus/pull/39)).** `test/setup.ts` now points `HOME` at an empty per-run temp directory and clears `CYRUS_DEFAULT_SKILLS`, `CYRUS_ISSUE_KEY` and `CYRUS_DEVICE_TOKEN`. The prompt-assembly tests assert the *entire* system prompt, and that prompt now includes whatever is in `$HOME/.claude/skills` — which is precisely where the dotfiles delivery path installs skills, so the environment most likely to break was a Cyrus worker container running the suite. This also fixes the pre-existing `McpConfigService.router-mode` failure in a container, where the two router env vars tripped `isHeadlessContainerMode()` and filtered out the server the test asserts.
- **User-selectable default runners — phases 1 and 2 of [NOR-364](https://linear.app/northrop-digital/issue/NOR-364/allow-users-to-select-default-runners).** Implements the plan on the issue: a typed per-user runner/model picker on `/setup`, runner-dependent required credentials, forced-`aca` executor resolution, and router-held Codex subscription credentials per [ADR 0005](docs/adr/0005-codex-authenticates-by-router-held-subscription-tokens.md) (now `accepted`).
  - **Storage is two new `users` columns** (`default_runner_json`, `codex_auth_sealed`) via the idempotent `PRAGMA table_info` migration already used for `executor_json`/`entra_object_id`. Neither is backfilled: NULL means "no preference", which is exactly what every pre-upgrade user already had, and writing a value would be inventing a choice nobody made.
  - **The picker is a curated `<select>`, not free text, and that is the whole design.** `WorkerService` cast `CYRUS_DEFAULT_RUNNER` with no `RunnerTypeSchema.parse`, so a typo reached `createRunnerForType` and threw *inside the sandbox at session start* — experienced as a dead session, not a setup error. The cast is now a parse, and only catalog values are accepted at the route. Gemini and Cursor are **absent, not disabled**: neither runs in a container, and rendering a guaranteed failure is worse than not rendering it. The accepted cost is maintenance when a vendor ships a model, which the old label regex did not carry.
  - **`CYRUS_DEFAULT_RUNNER` and the per-runner model vars are now reserved**, because once the router owns a key a stale hand-typed value must not shadow the picker. That creates a class the codebase had not had before — keys reserved *after* users could store them — so `applyEdits` treats exactly those four (`LATE_RESERVED_ENV_KEYS`) as stale-and-ignored rather than as tampering. Failing the whole save on them would leave such a user unable to change anything at all; `PATH` and friends still hard-fail, since they could never have come from a rendered row.
  - **`DEFAULT_REQUIRED_SECRET_KEYS` becomes `requiredSecretKeysFor(runner, extra)`** — parameterised, not duplicated, so the single expression shared by the `/setup` banner, `SetupBootstrap`'s record backfill, and `ContainerTargets.buildEnv` survives. Without this a codex-only user could not boot a container at all, which made the picker a lie for anyone without an Anthropic subscription. `ContainerBootCommand.REQUIRED_ENV_VARS` had the identical defect and is fixed on the same terms; both sides had to move or they would disagree about what a bootable container is.
  - **`resolveExecutor` gains `forcedExecutor`, which deliberately inverts its one-way degradation.** That rule ("never silently escalate to a billable sandbox") is right when several executors exist; where ACA is registered there is no escalation to guard against, and degrading *away* from the only working executor drops users onto a device they may not have enrolled, where the event is **silently discarded**. `RouterServer` sets it iff `executors.has("aca")`, and stored `executor_json` is left untouched so removing `containers.aca` restores prior behaviour exactly. The registered-provider startup check specified in the `/setup` management-UI plan and never implemented lands alongside it.
  - **Codex credentials are sealed on the `users` row, not in the secret bundle** (ADR 0005): a background refresher would 412 any open `/setup` form and discard the user's typed input under a message that would be false. `CodexTokenStore` reuses `sealBundle`/`openBundle` — they take a `KeyWrapper` and an `aad`, so they are backend-agnostic — with the AAD keyed by `user_id` rather than email, since a UPN rename would otherwise strand the credential. Sealing is never skipped: `users` is plaintext SQLite and `StateBackup.upload` PUTs the raw `.db` to Blob, so a "no Key Vault, store it clear" branch would put a live refresh token in every backup. `LocalKeyWrapper` (0600 key file beside the db) covers deployments with no KEK and documents precisely what it does and does not buy.
  - **Refresh is lazy at container boot with a five-minute buffer**, matching `GitHubAppTokenProvider`, the ACA `tokenProvider`, and the Linear OAuth refresh — and matching Codex's own window, so a container handed a token at boot never reaches its refresh point and the rotation race dissolves rather than being mitigated. No periodic sweep: it would burn rotations for dormant users. The rotated `refresh_token` **replaces** the stored one; persisting the old one makes the next refresh fail with an error that reads like a revocation.
  - **Delivery follows the two existing env-var-to-dotfile precedents** in `ContainerBootCommand` (`~/.git-credentials` from `GIT_TOKEN`, `config.json` carrying `LINEAR_API_TOKEN`): `CODEX_AUTH_JSON` → `$CODEX_HOME/auth.json` at 0600, written via temp-file-and-rename, before `launch()`. Fatal on failure rather than best-effort, unlike dotfiles — continuing would start an unauthenticated Codex that fails at its first request with an error nothing connects back to this step. On refresh failure the boot fails naming the remedy, falling back to `OPENAI_API_KEY` when set; it never falls back to Claude, since running a different runner than the user chose erodes trust in the whole picker and they would have no way to tell.
  - **All three OpenAI hosts go into `DEFAULT_EGRESS_HOSTS` in code**, regardless of which auth mode a user runs. `chatgpt.com` is the load-bearing one — under subscription auth inference goes to `chatgpt.com/backend-api/codex/responses` and `api.openai.com` is never touched, so allowlisting only the latter gives the worst available failure shape. Not via `containers.aca.egress`, which replaces the whole allowlist including the router's own host; and unconditionally, because egress applies at create time only with no update API, so an unnecessary entry costs nothing and a missing one costs a fleet-wide destroy-and-recreate.
  - **Two folded-in defects.** `fly` and `codespaces` were in `EXECUTOR_TYPES` and every help string with no provider class behind either: choosing one created a device row, enqueued the event, then failed in `bootInnerTraced`, stranding the event on a device nothing would ever connect to. Deleted rather than implemented. And `repository.model`/`fallbackModel` were unreachable — `determineRunnerSelection` always returns a non-empty `modelOverride`, so the middle term of `modelOverride || repository.model || default` could never be reached and the comment above it described intent, not behaviour. The selection now also reports `explicitModel`, which is what makes that level reachable; a repository model is applied only when `inferRunnerFromModel` does not assign it to a *different* runner, since the field is shared across every runner an issue in that repo might route to.
  - **Phase 3 — the first Codex-in-a-container run there has ever been ([NOR-364](https://linear.app/northrop-digital/issue/NOR-364/allow-users-to-select-default-runners), [#41](https://github.com/nick-boey/cyrus/pull/41)).** Driven through the F1 router-mode rig against a real `LocalDockerProvider` container, a real ChatGPT subscription credential and a real GitHub repository, by a seeded user holding NO Claude token. It found three defects, all of which are only reachable by running it — every Codex F1 drive before this was local macOS and every container drive was Claude-only:
  - **Codex enforces its sandbox through bubblewrap, and bubblewrap cannot create a user namespace inside a worker container.** `bwrap: No permissions to create a new namespace`. EVERY shell command exits 1 before it starts, so the agent burns its turns discovering it cannot read a file, tries the patch tool, tries MCP, and then terminates with `subtype: success` having changed nothing — the session looks healthy in the timeline and produced no pull request. This is the failure a Claude-only container fleet could never surface. Fixed by disabling the nested sandbox in `isHeadlessContainerMode()` only, which is the same reasoning that already disables Cyrus's own egress sandbox there: the ephemeral single-issue container IS the boundary. A workstation `cyrus start` keeps it, where it is the only boundary there is; the test asserts BOTH signals are needed so a stray `CYRUS_ISSUE_KEY` cannot disarm it.
  - **Three of the four models in the Codex catalog cannot run on a ChatGPT subscription.** `400 invalid_request_error — The 'gpt-5.5-codex' model is not supported when using Codex with a ChatGPT account`. This is a *semantic* rejection after a successful auth, so it cannot be probed for and does not degrade. Measured against a live account inside the worker image: `gpt-5.5` answered; `gpt-5.5-codex`, `gpt-5.2-codex`, `gpt-5.1-codex`, `gpt-5`, `gpt-5-codex`, `gpt-5.5-codex-mini`, `gpt-5.5-mini`, `gpt-5.5-pro` and `codex-mini-latest` were all rejected. The catalog is now `gpt-5.5` alone. Keeping the others for the `OPENAI_API_KEY` fallback's sake would invert the point of a curated control — rendering a guaranteed dead session for every user on the credential the product mandates, to serve the path documented as the fallback.
  - **A fourth defect, found reviewing the fix for the second.** `resolveDefaultRunner` dropped the ENTIRE selection when a stored model left the catalog — and the selection carries the runner, which is what `requiredSecretKeysFor` keys off. So retiring `gpt-5.5-codex` would have turned every user who picked it back into a Claude user, demanded a `CLAUDE_CODE_OAUTH_TOKEN` they were never required to hold, and refused to boot any of their containers. A one-off migration would have covered this instance; a same-runner model fallback covers the class, and retiring a model is the routine change here. The picker's whole premise is that choosing Codex must not require an Anthropic subscription, and a catalog edit must not be able to revoke that.
  - **The subscription path was never wired into the Azure deployment at all**, which no local drive could have surfaced: `grep -i codex infra/azure/` returned nothing. `RouterServer` builds the `CodexTokenStore` only `if (containers.codex)`, so on ACA it was always `undefined` — `/setup` rendered no **Codex account** section (gated on `deps.codexTokens`) while `SELECTABLE_RUNNERS`, which is static, went on offering Codex. Selectable, unconnectable, and the boot error named a section that deployment does not have. `main.bicep` now renders `containers.codex`, and the no-store message names `OPENAI_API_KEY` instead. The F1 rig needing a hand-written `codex: {}` was the signal, read at the time as a test-harness gap rather than a deployment one.
  - **The KEK was read only from `containers.tableStore.keyId`, coupling Codex to an unrelated migration.** `enableSetupSecretStore` provisions the KEK *and* the router's *Key Vault Crypto User* role; `enableSetupTableBackend` is the separate, staged cutover of the secret backend. In the window between them a perfectly good vault key existed and was ignored. `containers.codex.keyId` is now read first, so a subscription never waits on the Table migration.
  - **A local sealing key on an ephemeral disk loses every credential while still reporting them connected.** `StateBackup` uploads `router.db` alone — never the key beside it — so on ACA a revision brings the database back without its KEK, `openBundle` fails, `CodexTokenStore.get` logs and returns `undefined`, and the user sees "no account connected": indistinguishable from never having connected one, days after they did. The Bicep therefore renders `containers.codex` only under `enableSetupSecretStore` (an honest capability gap beats silent data loss), and the router warns at startup whenever it falls back to a local key, naming the file and both remedies. Five tests pin the selection order and that warning.
  - **Still unproven: a successful live refresh.** Access tokens carry a 240-hour lifetime, so the drive's credential never reached its refresh window and `mint()` returned it unchanged; only the failing path ran. The negative check does establish that OpenAI *accepts* `DEFAULT_CODEX_OAUTH_CLIENT_ID` — a dead token returned `refresh_token_reused`, a token-state error, rather than `invalid_client` — which rules out the failure mode that would make every refresh fail identically. Related unfixed hazard: refresh rotates the stored token while the Blob backup runs every 5 minutes, so a restore inside that window resurrects a consumed refresh token and produces exactly that `refresh_token_reused`, permanently, until the user re-pastes — the NOR-263 shape, tracked separately.
  - **`CODEX_AUTH_JSON` stayed set after the credential was written to disk.** Two costs. It is a live OAuth access + refresh token in the environment of every command the agent runs, so any `env`/`printenv` prints it into the transcript. And it is multi-line JSON, which the Codex CLI's shell-environment snapshot dumps into a `/bin/sh` script — `Syntax error: Unterminated quoted string`, snapshot discarded, and the agent visibly narrating a broken shell for the rest of the session. Deleted from both `this.env` and `process.env` once `auth.json` exists; nothing downstream reads it.
  - **What passed unchanged:** the boot gate let a Codex-default user with no Claude token through (`requiredSecretKeysFor` doing exactly its job); the sealed credential was absent from `router.db` and its WAL; `mint` → `CODEX_AUTH_JSON` → `$CODEX_HOME/auth.json` at 0600 round-tripped byte-identically to the real `codex login --device-auth` output; and `Bash`/`Grep`/`WebSearch` tool calls streamed as `action` activities — the Codex-integration lesson holding.
  - **`DEFAULT_CODEX_OAUTH_CLIENT_ID` remains unverified against a live refresh**, deliberately: a refresh rotates and invalidates the token, which would break the operator's own `codex` login. It stays overridable via `containers.codex.clientId`, and `OPENAI_API_KEY` stays supported. The ACA half of the checklist (memory park/resume, and the Azure egress allowlist as actually applied at sandbox-create time) also remains unrun — this drive was local Docker.
- **`Runner` and `Model` are defined in `CONTEXT.md`, and the Codex credential decision is recorded as `docs/adr/0005` ([NOR-364](https://linear.app/northrop-digital/issue/NOR-364/allow-users-to-select-default-runners), [#41](https://github.com/nick-boey/cyrus/pull/41)).** The glossary defined *Executor* — which machine an issue runs on — but had no entry for the coding agent that runs there, which is how "Claude Code runs on the ACA-hosted option" ended up naming two orthogonal axes as one. `Runner` and `Model` now sit alongside `Executor`, with `harness` and `provider` pushed to `_Avoid_` since *provider* already means an executor implementation here.
  - **ADR 0005 records that Codex will authenticate by router-held ChatGPT subscription tokens rather than `OPENAI_API_KEY`.** The rejected alternatives are the point: an API key bills separately from a subscription the team already holds, and transplanting `auth.json` races on refresh-token rotation across the per-issue containers one user runs concurrently — the configuration OpenAI's own CI/CD guidance names explicitly. Making the router the sole refresher dissolves the race rather than mitigating it.
  - **Three consequences are recorded because each is easy to get wrong and expensive to discover late.** Under subscription auth inference goes to `chatgpt.com/backend-api/codex/responses`, so an allowlist built around `api.openai.com` authenticates fine and then fails every request — and ACA applies egress at sandbox-create time only, with no update API. Refreshed tokens must not live in the per-user secret bundle, whose one-writer-with-a-render-time-ETag invariant would make a background refresher 412 any open `/setup` form and discard the user's typed input under a message that would be false. And the per-user credential model is what keeps this inside OpenAI's terms, which prohibit sharing credentials between humans rather than automation.
- **`scripts/deploy-worker-image.sh` — the worker half of the image deploy ([NOR-295](https://linear.app/northrop-digital/issue/NOR-295/automate-worker-image-deploy-the-aca-cli-cannot-register-disks-past-1), [#35](https://github.com/nick-boey/cyrus/pull/35)).** Builds the worker into ACR from a clean tree, registers the ACA disk, repins `workerImage` and `acaDiskName`, and stops at the what-if — the sibling of `deploy-router-image.sh`, which never handled the worker.
  - **It registers the disk with a raw `PUT …/diskimages`, because `aca sandboxgroup disk create` cannot do it any more.** The import is synchronous and scales with image size while the preview CLI abandons each attempt at ~60s (two attempts, ~120s total), reporting `Error: Network issue — retry policy expired`. Measured: 1.02 GB → ~18s → Ready; 1.71 GB → 99s → Ready only via raw PUT; the 1.40 GB build in between was never registered at all. Everything past ~1 GB is over the ceiling and NOR-296 reviewed the growth and accepted it, so this does not resolve itself. Two details cost real time to rediscover and are now in code and in the runbook: the token audience is `https://dynamicsessions.io`, not `https://management.azure.com/` (which 401s), and the credential field is `token`, not `password` (which 400s naming the required property, reading like a malformed body).
  - **One attempt, no retry.** Aborting the client does not abort the server-side import, so a retry races an import that is still running rather than replacing it — which is how the CLI turns a slow success into a reported failure. The deadline is `RAW_PUT_TIMEOUT` (default 900s, matching the ACA client's own `SLOW_OPERATION_TIMEOUT_MS`) and is raisable rather than fixed.
  - **Gates on `disk list` showing `Ready`, not on the exit code.** A 2xx says the request was accepted, not that the image imported. Nothing is repinned until the disk reports `Ready`, so a failed import cannot leave the parameter file advertising an image whose disk does not exist.
  - **`workerImage` and `acaDiskName` move as a pair or not at all.** They describe one build — what the router advertises and what the group boots — so a rewrite landing one without the other is undetectable downstream. Both are written in a single verified pass using `deploy-router-image.sh`'s mode-600 temp-file protocol (the target is gitignored and may hold the Linear client secret and both OAuth tokens, with no git copy to restore from). Each disk is named after its build (`cyrus-worker-sha-<sha>`), so a disk name that did not move is a visible sign the image did not either.
  - **Also carried over from the manual runbook:** refuses a dirty tree, verifies the pushed manifest is a plain Docker v2 manifest rather than a `buildx` OCI index the importer cannot consume, refuses a disk name already holding a different image, and refuses an image outside the target registry (the ACR token is scoped to it, and the resulting server-side failure reads like a permissions problem). Credentials travel via `curl --config` on stdin, never argv — the import is a call that can run for minutes.
  - **`--image <ref>` skips the build** to register something already pushed. That is the recovery path for exactly the state NOR-295 was found in: an image in the registry that the CLI timed out registering.
  - Covered by `scripts/deploy-worker-image.test.sh` (50 assertions, wired into the CI `infra` job): the rewrite's pair-atomicity and secrets-file protection, both data-plane response shapes (bare array vs paging envelope, string vs object `status`, `labels.name` resolution), and an end-to-end run over stubbed `az`/`curl` asserting the PUT route and body, the Ready gate in both its failing forms, idempotency on re-run, and that no credential reaches argv.

### Fixed
- **Worktree teardown resolved its path from `<cyrusHome>/worktrees` while creation used the repository's `workspaceBaseDir` ([NOR-411](https://linear.app/northrop-digital/issue/NOR-411/wip-snapshot-refs-leak-permanently-teardown-looks-for-the-worktree), [#48](https://github.com/nick-boey/cyrus/pull/48)).** The two agree on a default self-host install and differ on every container sandbox (`/workspaces` vs `/workspaces/.cyrus/worktrees`), so teardown pointed at a directory that had never existed. Reported in the dev-fleet findings as "`git` is not on `PATH` for the reaper's spawn": it is not — Node reports a missing `cwd` from `execFileAsync` as `spawn git ENOENT`, which is indistinguishable from a missing binary, and the `sweep()` immediately after was already logging that the same path did not exist.
  - **`resolveIssueWorkspacePath` in `cyrus-core` is now the single derivation**, called by `createGitWorktree`, `createSingleRepoWorktree` and `deleteWorktree`. It returns `source` (`override` / `repository` / `default`) as well as the path, because "nothing to delete" is only distinguishable from "we looked in the wrong place" if the message says where the path came from — `deleteWorktree` now names the base directory in both, and warns rather than informs when it had no repository to resolve from.
  - **The reaper runs against each repository's MAIN checkout, not the worktree.** Deleting the ref is a remote operation, so any checkout carrying the same `origin` will do — and `refs/cyrus-wip/*` is a shared ref, so the local `update-ref -d` has the same effect from either. Preferring the durable one removes the reconstructed path entirely AND lets `WipSnapshotReaper.sweep()` retry at all: it discards any entry whose path has since disappeared, which a worktree always has by the next sweep. `reap()` also `existsSync`es before spawning, so the log names the missing checkout instead of surfacing ENOENT.
    - **That retry is a physical-device guarantee only, and the mode this bug was reported from is the one it does not cover.** The reaper's durable file is `<cyrusHome>/state/wip-snapshot-deletions.json`, and in a container sandbox `cyrusHome` is `$CYRUS_WORKSPACES_DIR/.cyrus` — inside the same per-issue sandbox as `repositoryPath`, with terminal teardown the last thing that sandbox does before `destroy()`. A sandbox serves one issue, so neither trigger for `sweep()` (the next terminal teardown, or process start) ever fires for it again: a remote unreachable for the duration of a container teardown still leaks the ref permanently. `reap()`'s failure message no longer promises "it will be retried" and instead names the `git push origin --delete` remedy, since a log line is the only thing that outlives the container. Recorded in ADR 0001 rather than fixed — surfacing the failure on the teardown callback is the actual fix and is out of scope here.
  - **Terminal cleanup latches the issue against further capture (`WorkspaceSyncService.abandonIssue`) between its final forced sync and the reap.** `deleteWipSnapshot` drops the LOCAL ref first and unconditionally, and that local ref is exactly what `captureWipSnapshot` reads to decide the remote is already current — so a capture landing after the reap does not race it, it is GUARANTEED to push the ref back, with nothing recorded as failed for `sweep()` to retry and no log line saying so. Fixing the path (above) is what made this reachable: before it, the reap in container mode deleted nothing, so a later capture was harmless. Stopping the runners does not close the window — `requestSessionStop` only sets a flag, the runner's real terminal arrives later and fires `syncIssueOnTermination` from a listener, and the 5-minute periodic tick keeps firing across the seconds-to-minutes that teardown scripts and `git worktree remove` take. The latch is set synchronously (so no new capture can start) and then awaits the in-flight one; `touch()` lifts it, so a reopened issue is protected again rather than running with no floor for the life of the process.
  - **`deleteWorktree` prefers the workspace path creation RECORDED (`session.workspace.path`) over re-deriving it.** Deriving is only correct while the configuration that produced the path is still present and unchanged; an operator editing `workspaceBaseDir` mid-flight (`EdgeWorker` hot-reloads it) or a repository leaving the config moves the derivation out from under a workspace that is still on disk, and the miss then looks exactly like a workspace already cleaned up. Derivation remains the fallback for the redelivered-webhook case, where the sessions carrying the recorded path are gone. A disagreement between the two is logged at `warn`.
  - **`sweep()` moved out of the reap branch and now runs unconditionally.** It retries deletions a PREVIOUS teardown failed, which has nothing to do with whether this issue got as far as reaping its own — so gating it meant the one delivery that admits it is a retry (a redelivered webhook with no sessions left) was also the one that declined to retry. The same branch no longer claims the snapshots "were reaped on an earlier delivery": nothing records that a reap SUCCEEDED (the durable file records only failures), so that was an assumption stated as fact at `info`. It now warns and names the manual remedy. A teardown that finds no repositories at all — reachable on a cold container that restored no state while the remote still carries refs its previous incarnation pushed — previously skipped the whole block with no output; it now warns too.
  - **`CreateGitWorktreeOptions.workspaceBaseDir` is honoured on every creation path and expressible at teardown.** It was silently discarded for single-repo workspaces (`createGitWorktree` did not forward it to `createSingleRepoWorktree`) despite both docstrings promising it, the 0-repo branch bypassed the shared helper entirely, and `DeleteWorktreeOptions` had no such field — so the `override` source was unreachable from teardown by construction, and any caller that started passing the option would have reinstated the exact divergence this fix exists to remove.
  - **`teardownRepositories` now unions the sessions' repositories with the issue's cached routing decision**, and that is load-bearing twice over. A session records only its PRIMARY repository, so a multi-repo issue's secondary snapshots were never reaped even though `WorkspaceSyncService` pushes one per repository; and on a REDELIVERED terminal webhook (the router replays unacked events by design, and the first delivery calls `removeSession`) the list was empty, which after this change would have resolved the workspace from the default base directory — reintroducing the bug on the retry path whose whole purpose is to be safe.
  - **The refs already leaked are not swept automatically**, for the reason ADR 0001 gives: a snapshot whose issue branch was never pushed is indistinguishable from an orphan by looking at the remote. The decision and the manual procedure are recorded in `docs/adr/0001`; the audit on `nick-boey/cyrus` found 11 refs, 2 of them for still-open issues. **Canopy and Parrot are audited-pending** — unreachable from the sandbox this was written in, and the remotes with the confirmed leaks (the three logged occurrences were CAN-129, CAN-55 and PAR-258, none on `nick-boey/cyrus`). Note the leak window is #26 (2026-08-21) to now, ~2 weeks, none of it released: the last release is 0.2.68 (2026-08-05) and the snapshot mechanism is still unreleased, so no user of the published CLI has ever taken one of these refs.
- **The idle-stop clock never reset on agent activity, so the affinity pin was the only thing keeping a busy sandbox alive — and the implement→review handoff is exactly where that pin lapses ([NOR-366](https://linear.app/northrop-digital/issue/NOR-366/sandbox-idle-stop-races-the-session-affinity-pin-and-silently-kills), [#40](https://github.com/nick-boey/cyrus/pull/40)).** Killed 5 of 9 agent sessions on 2026-08-29 (CAN-69/94/95/98 and CAN-81), surviving 3s–176s each, and went unnoticed for ~9 hours. Every input to `ContainerLifecycle`'s idle clock — `created_ms`, `last_routed_ms`, `parked_at_ms` — is stamped by something the ROUTER does, and the router does nothing at all while an agent works. In every observed kill `cyrus.idle_for_ms` equalled `cyrus.age_ms` to the millisecond on containers that had been continuously busy for 28–38 minutes: past `idleStopMs` the whole time, and skipped only by the `affinity > 0` gate. Three changes, each sufficient for a different half of the race:
  - **`devices.last_active_ms`, stamped by `RouterStore.markDeviceActive`, joins the idle clock.** Written by `setSessionAffinity` (so a claim resets the clock in the same call that creates the pin, not one sweep later) and by the sweep on every tick a device is pinned. Deliberately UNCONDITIONAL, the inverse of `markDeviceRunning`'s set-if-null contract: `running_since_ms` answers "how long has this been up" and must survive re-stamping, this answers "when did it last do anything". Backfilled on migration, also unlike `running_since_ms` — the column only ever DELAYS a stop, so a NULL makes every pre-upgrade container instantly eligible for the stop it exists to prevent, while backfilling costs at most one extra `idleStopMs`.
  - **The affinity gate is re-checked immediately before `executor.stop()`.** The gate is separated from the stop by two awaits (the reconciler's round trip to the device, then `status()`), and CAN-98 was stopped 3s after its session was created. The re-check compares against a snapshot of the session ids taken before the gate and fires only on ones MISSING from it — a blanket "any affinity at all" re-check would look more defensive while re-litigating the two decisions that deliberately reach the stop with rows still in the table (a leaked row the reconciler declined to trust, an offline device's row aged out past `offlineAgeOutMs`), restoring the permanent pin PAR-146 removed.
  - **`sandbox.stranded_session` reports the resulting impossible state.** `state=stopped sessions=1 online=false` never self-heals — CAN-95 held it across four consecutive sweeps — and produced no signal at all: the gauge records it as three unremarkable fields, no lifecycle transition fires, Linear renders a normal in-progress agent session throughout, and none of the three existing alert rules cover it. That combined blind spot, not the 38-second race, is what made this a nine-hour outage. Emitted per tick (an alert rule needs a non-zero count in its window) with the ERROR line latched to once per entry. Excluded: `unknown` provider state, anything within `strandedSessionGraceMs` (10m, sized against a cold ACA boot — which presents identically), and issues with a pending terminal teardown. Detection only, deliberately: booting the container back would also resurrect PAR-146-shaped leaked rows and undo idle-stop for the sandboxes it exists for. `infra/azure/bicep/modules/monitoring.bicep` gains a severity-1 rule and a saved search joining each stranded device back to the `sandbox.idle_stopped` that preceded it.
  - Covered by 13 new tests. Each fix was verified to fail without its production change: reverting the `last_active_ms` term fails the 30-tick busy-container test, disabling the pre-stop re-check fails the mid-sweep-claim test, removing the `noteStranded` call fails four. The regression that a naive re-check would cause is pinned by its own test.
- **`scripts/deploy-worker-image.sh` sent `registryCredentials` in the wrong place and could never register a disk ([NOR-337](https://linear.app/northrop-digital/issue/NOR-337/deploy-worker-imagesh-sends-registrycredentials-in-the-wrong-place-and), [#36](https://github.com/nick-boey/cyrus/pull/36)).** The script shipped in [#35](https://github.com/nick-boey/cyrus/pull/35) failed 100% of the time at the registration step with `401 RegistryAuthFailed` — it had never successfully registered a disk; the build half worked. The request body nested `registryCredentials` inside `image` and put the disk name at the top level, where `aca sandboxgroup disk create` sends `{labels:{name}, image:{base}, registryCredentials:{username, token}}`. Nested, the credentials are never read: the service attempts an anonymous pull against a private ACR and returns a 401 asking for the field that was just sent. That is why every credential *value* failed identically and within seconds — the ACR refresh token, an exchanged ACR access token, `managedIdentityClientId` for the group's system-assigned identity, and an explicit `AcrPull` grant, independent of digest vs tag. Corrected with the CLI's own shape, captured from its `--verbose` output; a raw PUT with that body registered `cyrus-worker:sha-8527a7e` first time (200, `Ready`, 5906 MB, 90s — consistent with NOR-295's 99s for this size). The hand-rolled recipe in `infra/azure/README.md` had the identical defect and is fixed alongside it, with the 401's misleading wording called out.
  - **The tests could not have caught it, and now can.** The stubbed `curl` asserted that the credential field was named `token` rather than `password` and that no credential reached argv — both true of the broken body. A per-field lookup that already knows where to look cannot see a misplaced key, so the PUT body is now compared as a whole object against the CLI's shape, with two named assertions (`registryCredentials` is a sibling of `image`; the name travels in `labels.name`) so a regression reports the cause rather than a diff. This was the specific gap #35's own "not run against Azure" caveat was pointing at.
- **The raw-PUT workaround is back in `infra/azure/README.md`, and the advice that caused the incident is gone ([NOR-295](https://linear.app/northrop-digital/issue/NOR-295/automate-worker-image-deploy-the-aca-cli-cannot-register-disks-past-1), [#35](https://github.com/nick-boey/cyrus/pull/35)).** The runbook said to retry a failed disk registration later, treating the CLI's message as a transient network fault. That is how `sha-d7fb6a3` was built on 2026-08-06 and silently never deployed — the worker sat on a build from four days earlier while the router moved ahead. The size-driven diagnosis, the measurement table, the raw PUT with both non-obvious auth details, and the "do not retry, do not rebuild" instruction now sit under their own heading, with the genuine-transport-failure checks kept separately beneath. Step 6's `disk create` block is retained for its arguments but explicitly marked as not working for the current image. The same correction is reflected in `main.bicep`'s parameter descriptions, `main.bicepparam.example`, and `CLAUDE.md`'s ACA invariants.

### Changed
- **Agent skills are no longer vendored twice.** Removed the 37 Matt Pocock
  skill directories previously copied into this repository; personal skill
  delivery remains owned by the dotfiles installer, while the 20 Cyrus-owned
  shared skills stay under `skills/` for harness linking.
- **Telemetry Phase 5 — distributed tracing across router and sandbox ([NOR-283](https://linear.app/northrop-digital/issue/NOR-283/telemetry-phase-5-distributed-tracing-across-router-and-sandbox), [#33](https://github.com/nick-boey/cyrus/pull/33)).** One trace spans Linear webhook → routing decision → container boot → device dispatch → agent session, across the router/sandbox process boundary. New vendor-neutral `cyrus-otel-traces` package, a `span` protocol frame relayed over the existing WSS connection, and instrumentation at the five points the phase brief names.
  - **Sampling was decided before instrumenting, per the brief.** `ParentBased(root = TraceIdRatioBased(ratio))`, ratio defaulting to 1, recorded in `docs/adr/0004-parent-based-head-sampling-for-traces.md`. Parent-based is not a preference here, it is a correctness requirement: the router and the worker cannot see each other's sampler, so independent decisions produce *half-collected* traces — a complete-looking story with a hole where the agent session should be, indistinguishable from work that never happened. Tail sampling was rejected on two deployment-specific grounds: it needs a Collector (a new always-on stateful service in front of a deliberately single-replica router), and Cyrus traces routinely outlive a tail sampler's seconds-long decision window — a cold ACA boot alone is ~60s — so it would emit the partials it exists to prevent. The known cost of head sampling (cannot preferentially keep failures) is mitigated by Phase 3/4: WARN+ log records are unsampled and now carry `traceparent`, so an unsampled trace still leaves a queryable error record with a trace id.
  - **`cyrus-otel-traces` mirrors `cyrus-otel-logs`' vendor-neutrality**: exporter injected, nothing Azure-aware, Azure confined to `packages/router/src/telemetry/otelTracing.ts`. One deliberate divergence — it DOES register globally (`setGlobalTracerProvider`, `setGlobalPropagator`, `setGlobalContextManager`), because `trace.getTracer()` returns a no-op otherwise and every span in the tree would silently record nothing. The concern that made the logs bridge avoid the global registry (capturing a dependency's volume) does not apply: a library emits spans only under auto-instrumentation, and we install none. Consequence worth knowing: the propagation helpers are inert until that context manager exists, which is why an untraced process pays nothing for the call sites.
  - **Resource is built once and shared.** `buildRouterResourceInput` was extracted out of `startRouterOtelLogging` so both pipelines get byte-identical resource attributes. Two derivations that ever disagreed about `service.instance.id` would split one replica's logs from its own traces in the backend — defeating the correlation the phase creates. It also has to be callable with logs disabled, which a value hanging off the logging handle could not be.
  - **Trace context is persisted on the `events` row, not just injected on the wire.** New `traceparent`/`tracestate` columns plus an independent-per-column `ALTER` migration (the DDL runs outside a transaction, so a paired existence check would skip the repair forever after a crash between them). Captured at ENQUEUE time: delivery happens minutes later from a socket callback with no relation to the enqueue's call stack, and that gap is exactly what the trace exists to show. `reconcileDeviceSeq` carries the columns across a resequence — a resequenced event is the same event, and NOR-263 skew is precisely when you want the trace.
  - **The join is `RouterConnection.onEvent` activating the extracted context around its emit.** A `worker.event_received` CONSUMER span wraps it, and AsyncLocalStorage carries the context into everything the listener starts — including work it does not await. So a session's spans land in the router's trace with zero call-site changes. The span is created with `startSpan`/`end` inside `withSpanActive` rather than `withSpan`, because `withSpan` is async and awaiting anything there would break the synchronous-handoff contract that keeps the inbox entry replayable.
  - **Relayed spans go straight to the exporter, never through a tracer.** `SandboxSpanRelay` reconstructs a `ReadableSpan` from the frame. Re-minting through `tracer.startSpan` would assign a fresh span id and orphan every child the worker already recorded against the original — the trace returns as fragments. The frame carries the worker's own `resource` (so `service.name` stays `cyrus-worker`), while `cyrus.source`/`device_id`/`issue_key` are stamped from the authenticated device row OVER the span's own attributes, mirroring `SandboxLogRelay`'s rule that a worker cannot claim someone else's issue.
  - **`span` frame is capability-gated, not version-bumped.** `SPAN_INGEST_CAPABILITY` follows `LOG_INGEST_CAPABILITY` exactly — the gateway closes any socket sending a frame it cannot parse, so a new worker at an old router would disconnect on its first batch and reconnect into the same loop. Kept separate from `log_ingest` so tracing can be turned off during an incident without losing sandbox logs. `traceparent`/`tracestate` were added to the `event` and `rpc_request` frames as optional fields; the `LogFrame` pair reserved in Phase 2 is now populated. Times ride as OTel `HrTime` tuples — a millisecond float discards the sub-millisecond precision that is the point of a span, and nanoseconds exceed `MAX_SAFE_INTEGER`. The wire shape is declared twice on purpose (Zod in `router-protocol`, TS in `otel-traces`) so neither package takes a dependency on the other's domain; `packages/router` sees both.
  - **`RouterSpanForwarder` reports `SUCCESS` even when it drops.** A `FAILED` export result makes `BatchSpanProcessor` retry — including a batch dropped deliberately for cost, which is the loop the volume guard exists to prevent. Loss is reported via `dropped` on the next frame that lands. Its bucket is 200/s + 2000 burst, far above `RouterLogForwarder`'s 2/40: spans arrive in batches of up to 512 and a log-sized bucket would shred most of every batch, producing traces that look broken rather than sampled. Volume is governed by the head sampler instead. Same `inWrite` re-entrancy guard and no self-logging, for the sharper version of the usual reason — it touches `RouterConnection`, whose logger feeds `RouterLogForwarder`, which touches the same socket.
  - **HTTP instrumentation is four Fastify hooks, not the official auto-instrumentation.** `@opentelemetry/instrumentation-fastify` monkey-patches the module and therefore needs an ESM loader hook before Fastify is imported; every other piece of Cyrus telemetry is deliberately free of that constraint, and adding `--import` to the router entrypoint would make telemetry a startup-ordering concern for the one process that must never fail to start. Fastify's own pino logger stays OFF for a different reason: it writes to stdout on its own path, bypassing the `LogSink` seam and therefore the OTLP export. Spans are named from `request.routeOptions.url` (the template) and query strings are stripped — several router routes carry tokens in query position. `/healthz` gets neither a span nor a log line: probed every few seconds forever, it would set the volume floor at ratio 1.0 and answer nothing. 4xx is deliberately not a span error, per semconv.
  - **Dependency spans.** `AcaSandboxClient.request` wraps every data-plane call, carrying `cyrus.aca.timeout_ms` and the RBAC-retry attempt number recorded *before* the await — the attempt count is the only thing distinguishing "the first call stalled" from "we burned the whole retry budget and the last one stalled". Paths are templated to `sandboxes/{name}/stop` for cardinality; the ARM prefix is stripped as deployment-invariant. `LinearExecutor.dispatch` is parented on the `rpc_request` frame's traceparent, so the Linear round-trip lands inside the worker's trace, and sets `cyrus.rpc_ok` explicitly because `dispatch` never throws by contract and `withSpan` would otherwise report every failed RPC as a success.
  - **`ContainerLifecycle.sweep` gets a root span.** Fired by a bare 60s `setInterval`, it has no caller to inherit from, and without it every ACA call it makes would be a root of its own with no way to reconstruct the tick. It is also the one place the ratio bites: unlike a webhook it fires whether or not anyone is working.
  - **Sandbox tracing env is propagated router → sandbox and reserved.** `CYRUS_OTEL_TRACES_ENABLED` / `CYRUS_OTEL_TRACES_SAMPLE_RATIO` are added to `RESERVED_ENV_KEYS`, so a user's stored secret cannot override them: a sandbox that disagreed with the router about sampling is precisely how a half-collected trace happens. No Application Insights connection string is passed into a sandbox, deliberately — that would need a wider egress allowlist and an ingestion credential in every sandbox.
  - **`monitoring.bicep` gains a `Cyrus Traces` category** (five saved searches, gated on `enableOtelTraces`). Note the tables: spans are `AppRequests` (SERVER/CONSUMER) and `AppDependencies` (CLIENT/PRODUCER/INTERNAL) — a *third* pair, distinct from `ContainerAppConsoleLogs_CL` and from the `AppTraces` Phase 3 log records go to. `OperationId` is the W3C trace id and the join key across all of them. Bracket syntax for dotted keys applies unchanged. `main.bicep` enforces `enableOtelTraces ⇒ enableOtelLogs` through the existing `parameterGuard` idiom, since the Application Insights component both signals share is only created by the latter. The sample ratio is a decimal *string* parameter because Bicep has no float type.
  - **Coverage.** New: `otel-traces` (sampling honours a remote parent in both directions, serialisation round-trip, propagation with and without an SDK, env parsing), `span` frame parsing, `RouterStore` trace columns including the migration and the resequence path, `SandboxSpanRelay` (identity preserved, attribution not spoofable, hostile-input bounds), `RouterSpanForwarder` (capability gate, drop accounting, SUCCESS-on-drop), `httpTracing` (route naming, query stripping, 4xx-vs-5xx, `/healthz` skip, request logging). `packages/router/test/distributed-trace.e2e.test.ts` is the phase's "done when" as an executable assertion: a real `RouterConnection` over a loopback WebSocket to a real `DeviceGateway`, asserting one trace id from the router's `router.route` span through to a relayed `session.turn` span.
  - **A new public package has to be added to `scripts/release-packages.mjs`**, which `apps/cli/release-workflow.test.ts` enforces by diffing the configured list against every non-private `packages/*`. `cyrus-otel-traces` goes in early — right after `core` — because unlike `otel-logs` (consumed only by the router) its call sites are spread across `claude-runner`, `router-executors`, `router-client` and `router`, so it must precede all of them in publish order.
  - **A note on running the suite inside a Cyrus container.** `McpConfigService` treats `CYRUS_ISSUE_KEY` + `CYRUS_DEVICE_TOKEN` both being set as headless-container mode and drops the interactive-OAuth `cyrus-docs` server, so `McpConfigService.router-mode.test.ts` fails inside a sandbox purely because of the ambient environment. It is not a real failure and does not reproduce in CI; `env -u CYRUS_ISSUE_KEY -u CYRUS_DEVICE_TOKEN pnpm -r test:run` is the faithful local reproduction of the CI step. Worth knowing before writing it off as pre-existing, which is exactly the mistake it invites.
- **Telemetry Phase 4 — semconv where it pays ([NOR-282](https://linear.app/northrop-digital/issue/NOR-282/telemetry-phase-4-semantic-conventions-where-they-pay), [#31](https://github.com/nick-boey/cyrus/pull/31)).** Exception semconv on error paths, a normalised event vocabulary under a `cyrus.*` attribute namespace, and the raw `console.*` cleanup. The ~950 interpolated prose log calls are explicitly untouched — they become OTel log records with good resource attributes and stay prose, which is what they are for.
  - **`exception.*` is the one place we adopt semconv wholesale.** `LogRecord` gains a structured `exception` field (`packages/core/src/logging/exception.ts`), populated by `Logger` from the trailing-args `Error` at **any** level — `logger.warn("retrying", err)` describes a real exception and belongs in the same `summarize by exception.type` as an error. `OtelLogSink` emits `exception.type` / `exception.message` / `exception.stacktrace`; those three are stable OTel semconv, describe nothing Cyrus-specific, and are what makes a backend render the record as an exception rather than a line of text. The stacktrace folds in the `cause` chain as `Caused by:` blocks, cycle- and depth-guarded, because semconv has no attribute for a cause and a wrapper's own stack routinely points only at our retry helper. It gets an 8 KB cap rather than the generic 1 KB attribute cap, which would clip a Node stack around the tenth frame — usually before it reaches our code.
  - **A sandbox worker's exception survives the trip to the router.** `logFrame` gains an optional `exception` object (additive; does **not** bump `PROTOCOL_VERSION`), `RouterLogForwarder` fills it, and `SandboxLogRelay` rebuilds an `Error` from it and passes it back through `logger.error(msg, err)`. Rehydrating rather than stamping attributes is what makes the router derive the same semconv it would locally *and* capture it in Sentry as an exception; the reconstructed error deliberately carries the **worker's** stack, since a fresh one describes only how the line reached the router. Previously this rode inside `args`, a lossy one-line summary that discarded the stack entirely.
  - **Event names are dotted lowercase, attributes are namespaced `cyrus.*`.** `session_completed` → `session.completed`, `sandbox_gauge` → `sandbox.gauge`, and so on for all ~20 names; the cross-package vocabulary is now a constant map (`CYRUS_EVENTS` in `packages/core/src/logging/events.ts`) alongside the router-local `SANDBOX_EVENTS`. The domain prefix stays load-bearing — `event startswith "sandbox."` still selects the whole family. `cyrus.*` matches the labels already on ACA sandboxes (`cyrus.issue`, `cyrus.device-id`, `cyrus.disk`), so one scheme runs from the ARM resource to the log record.
  - **Namespacing is applied at the call site (`cyrusAttributes`), not inside a sink.** A sink that rewrote keys would need a list of reserved structural ones (`event`, `args`, `traceparent`, …) that must *not* be rewritten, and that list rots the first time someone adds a field. A key already containing a `.` is treated as pre-namespaced and passed through, which is what lets `exception.*` — and a future `gen_ai.*` — flow unchanged. `ClaudeRunner`'s query-options prefix moved from `cqo.` to `cyrus.cqo.` for the same reason: a bare `cqo.` would have escaped the namespace by looking already-qualified.
  - **What is deliberately NOT renamed.** The per-record structural keys (`component`, `sessionId`, `issueIdentifier`, `repository`, `platform`, `event`, `args`) keep their Phase 0 names. They ride every record including prose lines, so renaming them is the exhaustive rewrite this phase excludes, and it would break every saved query while making nothing newly queryable. The cost/benefit separates cleanly: the attribute bag is written by ~15 event call sites plus the relay; the context keys are written by hundreds.
  - **`monitoring.bicep` was updated in the same change, and the KQL gotcha is real.** A dotted key is *not* reachable with dot syntax — `p.cyrus.issue_key` parses as a nested lookup and silently returns null rather than erroring — so every attribute read is now `p["cyrus.issue_key"]`. Five saved searches and three alert rules key on these literal strings; the compiled ARM output was checked to confirm the bracket syntax and dotted event names survive template assembly.
  - **`console.*` cleanup, and what was left alone.** All 19 in `EdgeWorker.ts` converted to `this.logger` (their `[EdgeWorker]` prefixes were duplicating the component name). `createBootLogger` in `ContainerBootCommand` now emits through `ILogger` while keeping its best-effort file copy — container boot is the one phase where a failure means the issue gets no agent at all, and its output previously reached stdout and nothing else. `app.ts`'s fatal-error handler likewise, so the failure that killed the process carries exception semconv. The other ~66 in `apps/cli` are interactive UI (OAuth walkthroughs, status tables, prompts) and stay `console.*`: routing them through `ILogger` would stamp timestamps and level labels onto text a human is reading. The "56 in `packages/core`" from the issue description are JSDoc examples — the only real ones are in `Logger.ts`, which *is* the console sink.
  - **GenAI semconv evaluated and deferred**, per `docs/adr/0003-defer-genai-semantic-conventions.md`. Still pre-stable; moved out of the main semconv repo at v1.42.0 into `open-telemetry/semantic-conventions-genai`, which has no tagged release and no schema URL to pin against, and the agent/tool-orchestration attributes — the ones we would actually use — are the least settled part. Adopting now renames facts that are already queryable under `cyrus.*` and buys the interoperability of a moving target.
  - **Test seam.** Router behavioural tests read events through a shared `eventsNamed` helper that strips the namespace, so ~30 assertions about *lifecycle behaviour* are not coupled to key spelling; `SandboxTelemetry.test.ts` owns the naming contract and asserts the emitted keys verbatim. New unit coverage for the exception shaping (cause chains, cycles, depth bound, frameless errors) and for `cyrusAttributes` (idempotence, pre-namespaced pass-through, null vs undefined).
  - Pre-existing and unrelated: `packages/edge-worker/test/McpConfigService.router-mode.test.ts` has two failures (`cyrus-docs` MCP entry) that reproduce unchanged at the merge base.
- **Azure RBAC is now a split bootstrap instead of a standing CD privilege ([NOR-299](https://linear.app/northrop-digital/issue/NOR-299/establish-private-northrop-bicep-cd-and-retire-terraform), [#30](https://github.com/nick-boey/cyrus/pull/30)).** `modules/role-assignments.bicep` is the single owner of all deterministic runtime and operator break-glass grants. Both the conditional `manageRoleAssignments` module in `main.bicep` and the resource-group-scoped `bootstrap-role-assignments.bicep` entry point call it, so scopes, conditions, role GUIDs, and `guid(...)` resource identities cannot drift between bootstrap and full deployment. `scripts/bootstrap-azure-role-assignments.sh` defaults to what-if, forwards only non-secret environment fields, and requires `--apply` to reconcile grants. After bootstrap, a private environment sets `manageRoleAssignments = false` and its OIDC identity needs Contributor only. Existing deployments require no migration: Incremental ARM retains omitted role assignments, and the bootstrap reuses the exact names created by the pre-split template. Live `rg-cyrus` validation confirmed the bootstrap targets the existing resource IDs and a full routine what-if with the flag false contains no `Microsoft.Authorization/roleAssignments` resource.
- **Bicep replaces Terraform for the Azure deployment (NOR-318, [#29](https://github.com/nick-boey/cyrus/pull/29)).** Decision, rejected alternatives, and the full consequence list in `docs/adr/0002-bicep-replaces-terraform-for-azure.md`. `infra/azure/terraform/` is deleted along with `scripts/bootstrap-tfstate.sh`, the `backend*.hcl` mechanism, and `scripts/check-aca-arm-parity.sh` — the last of which existed only to keep an AzAPI body and a Bicep reference file in step with a bespoke Python HCL parser, and had nothing left to compare once there was one copy of the sandbox-group shape. New layout is `infra/azure/bicep/main.bicep` (subscription scope: parameters, cross-parameter validation, resource group, module orchestration, outputs) plus six modules; `scripts/deploy-azure.sh` is the entry point and `scripts/check-bicep.sh` is the CI gate.
  - **Statelessness is the point.** The state file was a second independently-corruptible record of the deployment, needed its own resource group specifically because `terraform destroy` would otherwise delete the container holding the file it was mid-write to, held the Linear client secret and both OAuth tokens in plaintext regardless of `sensitive = true`, and had a documented failure mode — a wrong backend `key` producing a plan that proposed creating an existing stack from scratch — with no analogue under ARM. `az deployment sub what-if` reads the resources.
  - **Three simplifications fell out.** `prevent_destroy` is unnecessary: incremental ARM deployments do not delete a resource that leaves the template, so the per-user secret store's Table and KEK survive `enableSetupSecretStore` being cleared, retiring the asymmetric flag and the `terraform state rm` step in the decommissioning runbook. The `routerUrlForContainers` two-apply flow is gone: the router FQDN is `<app>.<managedEnvironment.defaultDomain>` and the environment is a separate resource, so there is no dependency cycle. And there is no import step — incremental deployments adopt existing resources, which is why the ACR bootstrap is now two `az` commands rather than a `-target`ed apply.
  - **Two pre-existing guarantees moved out of the template into `scripts/deploy-azure.sh`, and this is the real cost.** (1) The `/setup` stage-1-before-stage-2 ordering: Terraform enforced it at plan time with a data source that read the deployed `authConfigs` child out of Azure — evidence about deployment history no input value could fake. Bicep has no plan phase and no equivalent existence read, so the script asks `az containerapp auth show` and refuses stage 2 unless the child exists *and* reports `platform.enabled` and `identityProviders.azureActiveDirectory.enabled`. Same class of evidence, newly bypassable by calling `az deployment` directly. (2) The character-level half of the image-tag policy: ARM has no regex engine, so `main.bicep` checks ref *shape* (`@sha256:`+64, `sha-`+7–40, `v?X.Y.Z` with decimal-leading components) and the script checks those characters are hex/decimal. Doing it in-template would need either a 16-deep `replace` chain per image or a user-defined function, and UDFs emit `languageVersion: 2.0` — a template-dialect change a validation nicety does not justify. One deliberate narrowing: a bare hex tag (`repo:a1b2c3d`, no `sha-`) was accepted by the Terraform regex and is rejected now; `docker-router.yml` only publishes `sha-<sha>` and `v<semver>`.
  - **Secret writes now have a two-key guard and routine CD is secretless.** `writeLinearSecrets` and `writeSetupAuthSecrets` default false, all eight value parameters default empty, and `foundation.bicep` omits those Key Vault child resources in steady state; Incremental mode preserves the existing versions while the router keeps its fixed, versionless secret URIs. Both Bicep validation and the deploy script reject populated secret fields when the corresponding write flag is false, so stale bootstrap inputs are not even transmitted to ARM. A bootstrap or rotation also needs the independent `--allow-secret-writes` CLI switch. `deploy-azure.sh --params` accepts a private environment file and `--router-image` adds a later immutable image override, so `Northrop-Digital/cyrus-deploy` can pin a reviewed public checkout/image and invoke the public deployment contract without copying modules or receiving secret values in its routine workflow.
  - **Cross-parameter invariants stayed in the template**, via a `parameterViolations` array and a `parameterGuard` that indexes `{ valid: {} }` with the violation text — a key ARM cannot resolve, so the deployment fails before touching a resource with the rule named in the error. The guard is folded into `defaultTags` through `union(x, {})` because an unread variable is not guaranteed to be evaluated. `assert` was rejected: it requires an experimental feature flag and emits `languageVersion: 2.1-experimental`, which the compiler itself warns against for production.
  - **`--mode Complete` is the one new footgun** and would delete the Table and KEK. `deploy-azure.sh` does not offer it; noted in `CLAUDE.md`, both READMEs, and the parameter example.
  - **Smaller behavioural deltas.** Deliberately enabled Key Vault secret writes and creating the `/setup` KEK are now management-plane writes (`Microsoft.KeyVault/vaults/secrets` and `/keys`), so the deploying principal no longer needs *Key Vault Secrets Officer* or *Key Vault Crypto Officer*; every optional secret parameter is `@secure()` so values are not persisted into deployment history. Built-in role GUIDs are constants in `modules/foundation.bicep` because Bicep has no name lookup, with the preview *Container Apps SandboxGroup Data Owner* role kept as an overridable parameter. `cyrusRepositories` is passed through verbatim in the router's own camelCase shape rather than re-mapped from three snake_case fields, which makes `projectKeys`/`teamKeys` routing reachable from the stack for the first time. `enable_custom_domain` + `custom_domain_name` + `custom_domain_certificate_zone_id` are replaced by a `routerCustomDomains` array passed into `configuration.ingress.customDomains`, because ARM owns the whole ingress object and a hostname added out of band would be removed by the next deployment. `project`/`environment` gained length caps (10/9) derived from Key Vault's 24-character limit on `kv-<project>-<environment>`, which previously failed at create time rather than validation.
  - **One pre-existing doc/code inconsistency resolved rather than carried over.** `setup_ui_auto_provision_users` defaulted to `true` in `variables.tf` while its own README documented `false` and claimed a validation — "Terraform enforces it … fails validation unless a membership gate is in place" — that was never written. The Bicep parameter implements the documented, stricter contract: default `false`, membership gate genuinely required by `parameterViolations`.
  - **Test and ignore-file updates.** `scripts/deploy-router-image.test.sh` retargets the mode-600 rewrite suite at `.bicepparam` syntax and covers `is_immutable_ref` (every immutable form accepted, every mutable one rejected including `deploy-aca-disk-fix`), `param_value`, `check_image_pins`, the two-key secret-write guard, and external parameter/image forwarding. `.dockerignore`'s load-bearing-for-secrecy block now excludes `*.bicepparam` instead of tfvars/tfstate/tfplan — `az acr build` uploads the working directory, and bootstrap/rotation parameters may temporarily be plaintext on disk. `.gitignore` mirrors it.
  - **Verified against Azure.** The Bicep stack was applied successfully as subscription deployment `cyrus-cyrus-dev` to the existing `rg-cyrus` resource group in `dit-development` on 2026-08-24. After the private-CD refactor, `./scripts/deploy-azure.sh` passed the live `/setup` gate and completed a steady-state what-if against that deployment: the proposed resource list contained no `Microsoft.KeyVault/vaults/secrets` children, while all seven Container App entries retained their fixed versionless Key Vault references. The what-if also surfaced the already-merged OpenTelemetry rollout; it was deliberately previewed rather than applied as part of this refactor. `./scripts/check-bicep.sh` still compiles every template and type-checks the example with zero warnings.
- **WIP snapshots move off the issue branch ([#25](https://github.com/nick-boey/cyrus/issues/25), [#26](https://github.com/nick-boey/cyrus/pull/26)).** Decision and rejected alternatives in `docs/adr/0001-wip-snapshots-off-the-issue-branch.md`; vocabulary in `CONTEXT.md`. `GitService.pushWipIfDirty` (`git add -A` + commit as `Cyrus WIP` + push to the issue branch) is replaced by `captureWipSnapshot` / `restoreWipSnapshot` / `wipSnapshotExists` / `deleteWipSnapshot` over `refs/cyrus-wip/<branch>`.
  - **Capture must not touch `HEAD`, the index, or the worktree** — redirecting the push alone is insufficient, because a capture that advanced the local branch would have the agent's own `git push` carry every snapshot commit to the remote and pollute the PR identically. So it builds the tree in a throwaway index (`GIT_INDEX_FILE` + `read-tree HEAD` + `add -A` + `write-tree` + `commit-tree`) rather than porcelain. `read-tree HEAD` is not optional: seeding an empty index makes a sparse checkout record phantom deletions. `git stash create` is not a substitute — it has no `--include-untracked`, the flag is silently swallowed as the commit message, so every new file the agent created would be dropped. The throwaway index also succeeds while the real index lock is held, which matters because `IntentToAddHook` stages entries on a hot path during live sessions; the old index-lock backoff is therefore gone.
  - **The snapshot commit carries its own identity** (`GIT_AUTHOR_*` / `GIT_COMMITTER_*` per invocation, not git config). `commit-tree` hard-fails with "Author identity unknown" when neither is set, which is the state of a freshly-created container and of every CI runner — so inheriting the ambient identity takes the floor down exactly where it holds the only copy of the work. It is also the honest attribution: a snapshot is machine-authored and never merged.
  - Snapshots are parented on `HEAD` and so are siblings, never descendants — **every push after the first is non-fast-forward by construction** and is forced deliberately. `--force-with-lease` would make the floor fail in precisely the situations where it most needs to succeed. The local `refs/cyrus-wip/<branch>` records the last snapshot that actually reached the remote and is advanced **only after** the push succeeds, so a failed push cannot convince the next tick that the remote is up to date; capture skips the push when both the tree and the parent match it.
  - Restore checks out the snapshot's parent, applies its tree with `read-tree -m -u`, then `reset --mixed` back to the parent — reproducing modifications, deletions and untracked files as *uncommitted* work. Because it writes a whole tree rather than a patch, it applies a snapshot only when `origin/<branch>` is an ancestor of the snapshot's parent, and otherwise reports `stale` and leaves the published branch alone. Existence checks test `ls-remote` **output**, never its exit code — `git ls-remote` exits 0 when nothing matches, and this check decides whether an agent's only copy of its work gets restored.
  - Both former WIP-push call sites moved. The periodic floor sync (`WorkspaceSyncService`) now captures; the pre-teardown push in `EdgeWorker.handleIssueStateChangeMessage` — which was **not** gated on `floorSync` and so ran on every deployment, including contributors' own devices — is now a ref deletion, since refs are advertised on every clone and fetch repository-wide.
  - `WipSnapshotReaper` retries deletions that failed, from a durable list under `cyrusHome`. Deliberately **not** a heuristic sweep of `refs/cyrus-wip/*`: a snapshot whose issue branch has never been pushed is indistinguishable from an orphan by looking at the remote alone, and deleting one would destroy the only copy of another device's uncommitted work.
  - Capture failures are surfaced onto the issue timeline (`WorkspaceSyncServiceOptions.onCaptureFailure` → `EdgeWorker.reportWipSnapshotFailure`), coalesced to once per unbroken run of failures per issue and re-armed by a success. Per-repository isolation is unchanged. This is new because the issue branch is no longer a fallback: a failed capture now means the only copy never left the machine, and push rulesets (file size, path, extension) apply to every push regardless of ref.
  - `Workspace.wipRestores` (new, in `cyrus-core`) carries the per-repository restore outcome so `EdgeWorker.withRestoredWorkPreamble` can explain restored work to an agent whose transcript could not be resumed. Scoped narrowly to that case and cleared after one use.

### Fixed
- **`/setup` sign-in no longer 500s when only `identities` gate membership.** `router-auth.bicep` emitted `allowedPrincipals` as a fixed pair, so a deployment configuring `setupUiAllowedPrincipalObjectIds` alone still shipped `groups: []` — an **empty** key, not an **absent** one. EasyAuth sidecar 1.12.9.0 short-circuited on the empty array; 1.14.0.0 does not. It resolves group membership whenever the key is present, through Azure AD Graph (`graph.windows.net`, retired), so the lookup cannot succeed, and the failure is uncaught: it escapes as a `500` (SubStatus 73) on `POST /.auth/login/aad/callback` **after** sign-in has already completed (`LoginComplete` is logged, the token is written to the token store) and **before** `identities` is ever consulted — so listing a user there did not save them. The module now emits each key only when its list is non-empty, matching the reasoning already applied one level up to the block as a whole. `allowedPrincipalsConfigured` is unchanged, so the `setupUiAutoProvisionUsers` membership-gate guard in `main.bicep` still holds.
  - **Nothing was deployed to trigger it.** ACA replaced the replica of the *already-running* revision `app-cyrus-dev-router--0000029` at 2026-08-24T13:16:43 — same image, system log `No revision restart or provisioning was needed` — and the new replica came up on 1.14.0.0 at 13:17. Sign-in worked on 1.12.9.0 as late as 2026-08-20 (8 × `LOGIN_OK`, zero Graph calls) and every attempt after the roll failed. A platform-side sidecar upgrade is therefore part of this stack's blast radius whether or not the template changes.
  - Verified live against `rg-cyrus`: the fix was applied to the deployed `authConfigs/current` first, and a real sign-in then returned `302` with no group-membership lookup on the same 1.14.0.0 sidecar. The compiled ARM was checked to confirm `union(if(empty(…)))` yields `{ identities: […] }` for the current parameters. ([#34](https://github.com/nick-boey/cyrus/pull/34))
- **The release package list covers the router packages, and publishes `cyrus-core` before `cyrus-mcp-tools`.** `scripts/release-packages.mjs` came over from upstream listing 15 packages and never learned about this fork's five (`router-protocol`, `router-executors`, `workspace-sync`, `router-client`, `router`), so `release-workflow.test.ts`'s "publishes every public package in dependency order" failed on `main` itself. Fixing the set then exposed a second violation the first assertion had been masking: `mcp-tools` depends on `cyrus-core` but was published ahead of it. The five are inserted ahead of their consumers — `edge-worker` needs `router-client` and `workspace-sync`, `apps/cli` needs `router` and `workspace-sync`. Unrelated to the WIP-snapshot work; carried here because rebasing onto the upstream sync inherited the red.
- **Worktree continuity is no longer suppressed by a commit-ish base override.** `ensureSessionWorkspaceExists` re-passes a session's original `[repo=name#branch]` selector on *every* workspace recreation, and `createSingleRepoWorktree` skipped the `origin/<issueBranch>` check whenever an override was present — so a destroyed-and-recreated container rebranched from base and silently discarded published work. Published work now wins; the override still decides the start point when there is nothing to continue from. This sat inside the restore logic being rewritten, and the durability claim could not honestly be made while it remained. `GitService.continuity.test.ts`'s "override wins" case is inverted accordingly.
- **`container-boot` failures are no longer invisible.** A boot that dies before `launch()` produces nothing anywhere: its stdout is collected by nothing (the ACA `sandboxGroups` resource has no log collection), and the Phase 2 relay cannot help because `RouterLogForwarder` forwards only after the router advertises `log_ingest` in `hello_ack` — which never happens if the process dies first. The observable symptom is the documented S5 zombie: ACA reports `Running`, `/proc` holds only `tini -- sleep infinity`, and the router logs `waiting for the worker to connect` forever. `createBootLogger` now tees every `ContainerBootLogger` line to a file, and `execute()` wraps `boot()` so the fatal error's stack is persisted before it is re-thrown to `app.ts` unchanged. The path is `$HOME/cyrus-boot.log`, **not** `/var/log`: the worker image runs as `cyrus` (uid 1001) and `/var/log` is root-owned, so writes there fail with EACCES — and since persistence is best-effort by design, that failure would be swallowed and the log would silently never exist. Verified live against a real sandbox in `cyrus-dev-sandbox-grp`; a unit test pins the constraint so the path cannot regress back under `/var/log`. ([#27](https://github.com/nick-boey/cyrus/pull/27))
- **`container-boot` preflights the GitHub credential before it is used.** An expired token previously surfaced as `git clone`'s `fatal: Authentication failed for '<url>'`, which reads as a repository-access problem and sends the operator to the wrong place; classic PATs (`ghp_…`) expire on a schedule, so this is the routine failure. `verifyGitHubToken()` reuses `probeGitHubTokenScopes` from `cyrus-router` (already a dependency of `apps/cli`, and already in the worker image) and the `GITHUB_TOKEN_SECRET_KEYS` precedence constant, so GH_TOKEN-over-GIT_TOKEN is stated in exactly one place. **Only HTTP 401 is fatal** — it is the single status meaning "this credential is dead". 403 is GitHub's rate-limit status and a network error may be a blip or an egress-allowlist gap; neither is evidence about the token, so both warn and let the clone speak for itself. The thrown message names the secret key, never its value, and prescribes the destroy-and-re-prompt remedy, because a rotated per-user secret reaches only a create-from-image (D3).
### Testing
- `packages/edge-worker/test/helpers/git-fixtures.ts` lifts the bare-origin-plus-clone helper that was copy-pasted across `GitService.continuity`, `EdgeWorker.resume-workspace-recreation` and `RunnerConfigBuilder.stop-hook-guardrail`. Two Windows-only traps are fixed in the process, both of which produce *silently wrong* git rather than errors: the helper no longer shells out (`execSync` routes through `cmd.exe`, where `^` is the escape character, so `git rev-parse <sha>^` loses its caret and resolves to the commit itself — which made a sibling-parent assertion pass vacuously), and it pins `core.autocrlf=false` via `GIT_CONFIG_*` so round-trip assertions do not depend on the developer's OS.
- `GitService.wip-snapshot.test.ts` asserts observable git state against real repositories — never mocked `execSync` arguments, which would pass against a capture that silently drops every untracked file. Covers: worktree/index/`HEAD` unchanged by a capture; the issue branch unchanged; a second capture succeeding despite being non-fast-forward; a failed push retried rather than recorded as sent; `.gitignore`d files excluded; the restored `status --porcelain` byte-identical to the pre-capture state; a commit made but never pushed surviving the round trip; a stale snapshot refused; a non-existent ref treated as absent; and a capture succeeding on a machine with no git identity configured, which is reproduced by pointing `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` at files that do not exist rather than by mutating the developer's real config. Clones go over `file://` rather than a filesystem path, because a local-path clone hardlinks the whole object database and would make "an ordinary clone fetches none of Cyrus's objects" pass for the wrong reason.

### Added
- **Telemetry Phase 3 — vendor-neutral OpenTelemetry logging foundation (NOR-281, [#28](https://github.com/nick-boey/cyrus/pull/28)).** `ILogger` is the chokepoint (957 calls across 95 files), so backing it with the OTel Logs API is one new sink plus a bootstrap, not a thousand call sites. The `LogSink` seam this needed already landed in Phase 2 — deliberately built one phase early — so work item 1 required no change; the seam is unmodified.
  - **New package `cyrus-otel-logs`**, not code in `cyrus-core`. Two reasons. `packages/core` is depended on by every runner and the CLI, so putting `@opentelemetry/sdk-logs` there would push the OTel tree into every upstream install for a feature only the router uses. And the vendor boundary is the deliverable: the package depends on nothing but `@opentelemetry/*` and `cyrus-core`, takes its exporter as a constructor argument, and never names a cloud — `cloud.provider`/`cloud.platform` are *inputs* to `buildResourceAttributes`, never defaults. `cyrus-core` gains no dependency at all.
  - **Severity maps onto the base of each OTel band** (DEBUG→5, INFO→9, WARN→13, ERROR→17) rather than an arbitrary slot, so an exporter rendering severity back to a name recovers exactly the level the call site used. `SILENT` is a threshold, not something a call site can emit, so it degrades to `UNSPECIFIED` rather than throwing — a log line must never break the call it was describing.
  - **Attribute keys deliberately match Phase 0's JSON console format** (`component`, `sessionId`, `issueIdentifier`, `repository`, `platform`, `event`, `args`) instead of being translated to semconv. OTel defines no semconv for any of them, and operators already have queries written against those names; a rename would silently break every saved query for no gain. Call-site attributes win a collision with context keys, matching `Logger.formatJson`, so the OTLP payload and the JSON console line can never disagree about a shared key.
  - `OtelLogSink` mirrors `RouterLogForwarder`'s defences for the same reasons: an `inWrite` re-entrancy guard (the sink is called *from* the logger and the exporter beneath it does I/O, so one log line on that path would recurse without bound), size caps on body/args/attributes because the destination is billed per GB, and a `dropped` counter rather than a silent swallow. The attribute cap explicitly does not block an *overwrite* of a key already present — otherwise which of two colliding keys won would depend on iteration order.
  - **No ESM loader hook is required, contrary to the issue's flagged risk.** `register()`/`--import` are needed only for auto-instrumentation, which monkey-patches modules and so must run before they are imported. This bridge patches nothing — it calls the Logs API from a sink the application installs — so it has no import-order constraint. It is also deliberately *not* registered as the OTel global logger provider: that would capture any dependency that grabs a logger off the global API, making the volume we pay for a function of our dependency tree.
  - `startOtelLogging` restores the previous sink *before* `provider.shutdown()`, because that call awaits an export and anything logged meanwhile would be handed to a closing pipeline. `RouterCommand`'s SIGTERM path bounds the flush at 5s — shorter than the exporter's own 30s export timeout — so a wedged ingestion endpoint cannot hold the process open until the platform escalates to SIGKILL. Losing a few buffered lines beats a killed shutdown, which loses them anyway *and* skips the rest of the handler.
  - **Azure lives only in `packages/router/src/telemetry/otelLogging.ts`**, which is the sole file that imports `@azure/monitor-opentelemetry-exporter`, and is called from `RouterCommand.start()` before the server so startup logging (secret-backend selection, registry seeding, token resolution — the lines that explain a bad boot) is captured. Gating is two-stage and fails safe: `CYRUS_OTEL_LOGS_ENABLED` must be *explicitly* truthy (`ENABLED=false` means disabled — a truthiness check would get this wrong), and a missing connection string warns and returns `undefined` rather than throwing, because telemetry misconfiguration must not stop the router routing issues. When disabled the exporter is never even constructed.
  - **`AzureMonitorLogExporter` is wrapped, not cast.** The beta is built against `@opentelemetry/sdk-logs@^0.200.0`, which predates `forceFlush()` becoming a required member of `LogRecordExporter`, so it satisfies the interface's behaviour but not its shape. Explicit delegation keeps the gap visible and gives a later beta one place to delete; a cast would silently shadow the real method forever. `forceFlush` resolving immediately is honest rather than a stub — the buffer lives in `BatchLogRecordProcessor` one level up, whose own `forceFlush` drains through `export()`.
  - **Azure Bicep**: `enableOtelLogs` (default **true**, a deliberate departure from the default-off norm the router-config parameters follow — it adds telemetry rather than changing routing, though it does roll the single replica once) creates a **workspace-based** Application Insights component pointed at the existing Log Analytics workspace. Workspace-based is not optional: classic mode keeps its own store, putting router logs somewhere the existing saved searches cannot reach. The connection string is an inline ACA `secret` rather than a Key Vault reference — unlike the Linear credentials it is computed from a resource in this same deployment, so a vault round trip would add a write, a role, and a rotation story for a value regenerated on every apply. **Records land in `AppTraces`, not `ContainerAppConsoleLogs_CL`**, so every existing query in `modules/monitoring.bicep` is unaffected and blind to them; `otelLogsQuery` outputs paste-ready KQL.
  - `scripts/release-packages.mjs` gains `cyrus-otel-logs` ahead of the router block. `release-workflow.test.ts` enforces that every public package is listed in dependency order, so a new publishable package fails the suite until it is — which is how this was caught.
- **`RecordingLogSink` + `installRecordingLogSink` in `cyrus-core`**, and the log-assertion tests converted onto them (NOR-281 work item 2). The issue estimated 44 files; the real number is five. Of the 33 files that spy on `console.*`, most do so to *silence* it, and the assertions in `packages/core/test/logging/` are testing the text formatter itself, where asserting on rendered output is correct. The genuinely brittle ones asserted `ILogger` behaviour through its presentation — `ClaudeRunner.test.ts` regexed a full `<ts> [INFO ] [ClaudeRunner] [event:x] {"y":"z"}` line to check an event's attribute, and `disallowed-tools`, `EdgeWorker.versioning` and the two `AgentSessionManager` error tests matched formatted prefixes. Those break on a timestamp format change, a level-label width change, or `CYRUS_LOG_FORMAT=json`, none of which alter what the test is about; they now assert `{ event, attributes, level, component, args }` directly. `find`/`findAll` take a query object and match messages by substring, since most call sites interpolate an id a test should not have to reproduce. `restore()` returns the *previous* sink rather than resetting to the no-op — resetting unconditionally would silently disarm an outer sink for the rest of a suite — and is idempotent so an `afterEach` and a `finally` can both call it. The duplicate `RecordingSink` in `LogSink.test.ts` is now the shared class.
- **Telemetry Phase 2 — ship sandbox worker logs off the box (NOR-280, ([#21](https://github.com/nick-boey/cyrus/pull/21))).** A sandbox worker's stdout is collected by nothing: the ACA sandbox group is a `Microsoft.App/sandboxGroups` resource distinct from the Container Apps environment, so the environment's Log Analytics wiring never reaches it, and the data-plane API exposes no logs endpoint. Worker logs now ride the WSS connection the device already holds, as a new `log` device frame in `cyrus-router-protocol`, and `SandboxLogRelay` re-emits each one through the router's own logger — which is already collected into `ContainerAppConsoleLogs_CL`. Deliberately not direct-to-Azure export: sandbox egress is deny-by-default with the router's host as its one allowlist entry, so an exporter would mean widening that allowlist *and* getting a workload credential into every sandbox.
- **`LogSink` seam in `cyrus-core`** (`setGlobalLogSink` / `getGlobalLogSink` / `resetGlobalLogSink`), mirroring the existing `setGlobalErrorReporter` pattern so a host installs one destination and every component's logger forwards to it without the sink being threaded through each constructor. `Logger` offers a structured `LogRecord` to the sink independently of `this.level`: the local level governs the console, the sink governs what leaves the process, so a container running quietly still ships its errors. A sink's `minLevel` is a cheap pre-filter that `event()` deliberately bypasses, matching `ILogger.event`'s existing "always reaches the structured stream" contract — which is what keeps the Phase 1 `sandbox_*` vocabulary flowing under a WARN forwarding threshold. A throwing sink is swallowed; a log line must never break the call it was describing. This is the seam Phase 3 (NOR-281) needs for its OTel logs sink, built one phase early because Phase 2 needs a non-hacky interception point now.
- **`LogContext.attributes`** — flat extra attributes carried by a contextual logger and spread into the JSON record exactly like an `event()`'s attributes. The named `LogContext` fields cover what most call sites need; this is the escape hatch for identifiers a host has and core does not model, which is how the relay attaches `device_id` / `issue_key` / `source` without core learning about routers.
- **Version skew is negotiated, not assumed.** `PROTOCOL_VERSION` is deliberately **not** bumped — a bump fails the handshake closed and would reject every not-yet-updated worker outright, which is far worse than not shipping its logs. Instead the ROUTER advertises `LOG_INGEST_CAPABILITY` in `hello_ack.capabilities` (a new optional, additive field mirroring `hello.capabilities`) and the device forwards nothing until it sees it. This direction is the load-bearing one: `DeviceGateway.handleMessage` closes any socket carrying a frame it cannot parse, so an unnegotiated `log` frame at an old router would disconnect the worker on its **first log line** and reconnect it straight into the same loop — a far nastier failure than the `parked`/`active` deploy-ordering requirement, because it recurs per line. Capabilities are re-read on every `hello_ack`, since a reconnect may land on a rolled-back router.
- **Volume guard (`RouterLogForwarder`).** Three gates in order: level threshold (`CYRUS_LOG_FORWARD_LEVEL`, default WARN — the workspace is PerGB2018 and every sandbox pays into it), a token bucket (`CYRUS_LOG_FORWARD_RATE` 2/s, `CYRUS_LOG_FORWARD_BURST` 40 — a burst on session start or crash passes whole, a stuck retry loop is clamped), and size caps on message/args/attribute count. The bucket refills from elapsed **wall-clock** time rather than on a timer, for the same reason `RouterConnection`'s liveness watchdog compares wall clocks: an ACA memory suspend freezes every JS timer, and a timer-driven refill would resume with an empty bucket and throttle exactly the post-resume lines an operator is looking for. Nothing is dropped silently — discarded records (rate-limited, or emitted while the socket was down) are counted and the count rides the next frame that lands as a `dropped` attribute, so `summarize sum(dropped)` reports the real loss with no extra traffic. A record produced *during* a send is discarded but **not** counted: the sink is called from the logger and everything on the send path has loggers of its own, so the `inWrite` re-entrancy guard is what stops one log line becoming an unbounded loop, and counting its own plumbing as volume loss would be misleading.
- **`log` frames are fire-and-forget** — no ack, no durable buffer, no replay, unlike `session_state`. Losing a log line costs visibility; the disk writes and replay machinery that make a frame durable cost more than the line is worth, and replaying a reconnecting worker's backlog would bill for stale lines exactly when live ones are wanted.
- **Attribution is router-side.** `issue_key` / `device_id` / `provider` come from the device row the gateway authenticated, never from the frame, so a worker cannot label its logs with someone else's issue; worker-supplied attributes are spread underneath and can never overwrite those keys. A device's own `issueIdentifier` is recorded as `reported_issue_identifier` only when it *disagrees*, so a mismatch is visible rather than silently resolved. The relay caps message/attribute sizes again on receipt (the device already truncates, but the router must not depend on a well-behaved device — these values land in a stream billed per GB), bounds its per-component logger cache at 64 entries since `component` is device-supplied, and never throws: an exception on the gateway's message path would take down the socket that sent the malformed line. A worker's WARN/ERROR is re-emitted at the **same** level, inheriting the router's Sentry forwarding — a sandbox error is a real product error, and burying it at INFO because it happened one process away would defeat the point.
- The `log` frame reserves optional `traceparent` / `tracestate` from the start, so Phase 5 (NOR-283) propagates W3C Trace Context across the sandbox boundary by populating a field rather than renegotiating the frame. Nothing writes them yet and both sides tolerate their absence.
- Ownership question from the issue resolved: `packages/router`, `packages/router-client` and `packages/router-protocol` are **fork-local**, not upstream-shared (`SYNC-UPSTREAM.md`) — so all three are safe to change here. Only the `cyrus-core` half (the `LogSink` seam and `LogContext.attributes`) is shaped as an upstream-mergeable addition.
- `packages/router/test/sandbox-logs.e2e.test.ts` exercises the whole path in one process: a real `RouterConnection` dialling a real `DeviceGateway` over loopback, forwarder installed as the global sink exactly as `EdgeWorker` installs it, asserting a `createLogger(...).warn(...)` lands on the router's stdout with the right attribution — including the case where the worker's own console is SILENT.
- **Telemetry Phase 1 — sandbox lifecycle events, uptime, and Azure alerts (NOR-279, ([#18](https://github.com/nick-boey/cyrus/pull/18))).** A `sandbox_*` event vocabulary (`packages/router/src/SandboxTelemetry.ts`) emitted through `ILogger.event()`, so it reaches the structured stream — `debug`/`info` are deliberately never forwarded, so a gauge emitted via `info()` would be invisible to every query built on it. Eight lifecycle transitions (`boot_started`, `running`, `boot_failed`, `parked`, `unparked`, `idle_stopped`, `destroyed`, `teardown_completed`) plus `sandbox_gauge` and `sandbox_sweep_completed`. Every event carries `issue_key` / `device_id` / `provider`; `device_id` is emitted as `null` rather than dropped for an orphan (a container a provider owns with no device row), so `where isnull(device_id)` finds them. Attribute keys are flat snake_case for the same reason Phase 0's JSON keys are — Log Analytics projects each into its own dynamic column.
- **`devices.running_since_ms`.** `created_ms` is the device ROW's age and survives every stop/resume cycle, so it cannot answer continuous uptime — a three-day-old row whose sandbox came up four minutes ago reads as three days old. The new column is stamped on the transition to running and cleared on every transition out. `RouterStore.markDeviceRunning` is deliberately **set-if-null** and returns whether it changed anything: `boot()` runs on every routed event and `ensureRunning` returns immediately for a container that is already up, so an unconditional stamp would reset the clock on every user comment and a sandbox genuinely pinned for eight hours would report an uptime of seconds — precisely the case the six-hour alert exists to catch. The migration deliberately does **not** backfill; NULL ("not currently running") is the honest answer for a pre-upgrade row, and inventing a start time would feed fabricated uptimes straight into the alert. The lifecycle sweep reconciles every row against real provider state within one 60s tick, so the gap is bounded and self-healing.
- **`ContainerExecutor.listStates?()`** (optional) — every managed container's issue key AND state in one provider call, implemented for both `LocalDockerProvider` (one `docker ps -a` with a `{{.State}}` column) and `AcaSandboxesProvider` (the same single label-filtered `listSandboxes` call `listManaged` already made). This is what makes the per-tick gauge affordable: at one ARM request per sandbox per minute, a per-row `status()` fan-out would become the most expensive thing the router does and would throttle exactly when the fleet is largest. `ContainerLifecycle.sweep()` now reads each provider **once** up front and reuses the result for both the gauge and orphan GC, so adding the gauge costs zero extra provider calls — it replaced the `listManaged()` the orphan pass already made. Listing before the per-row loop rather than after it also narrows the TOCTOU window the orphan pass guards against. The ACA implementation collapses an issue's several sandboxes (mid-replacement, or a stale-disk sandbox awaiting deletion) using the same ranking `ensureRunningLocked` uses, so the gauge reports the sandbox the router would actually retain. The per-row `executor.status()` call on the idle-stop path is unchanged — it only fires once a row's idle clock already qualifies, and reads fresher state at decision time.
- **Gauge semantics.** `sandbox_gauge` is emitted for **every** device row including ones pinned by session affinity — those are precisely the sandboxes burning 4 vCPU, and the pre-existing early-`continue` on the pinned branch would have left the gauge counting only idle sandboxes. Each sample carries the provider's `state` **and** the router's own liveness view (`online`, a live WSS socket; `last_seen_age_ms`, the age of the last heartbeat pong, which `DeviceGateway` stamps on every pong). Both are required: per our own documented invariant ACA reports `Running` for a sandbox whose entrypoint has exited, so an alert on `state` alone fires on zombies and stays silent on hung workers. A provider that fails to list yields `state: "unknown"` and — critically — does **not** clear any running clock, so one throttled ARM call cannot silently reset every uptime in the fleet; `readProviderListings` returns `undefined` rather than an empty map for exactly this reason, since "manages nothing" would additionally make every one of that provider's rows look like an orphan. A provider with no bulk-state seam also reports `unknown` rather than guessing.
- **Azure monitoring (`infra/azure/terraform/monitoring.tf`).** Five saved KQL searches (open sandboxes with issue keys and uptimes; fleet size over time; sessions per issue; one issue's full lifecycle; boot outcomes) and three `azurerm_monitor_scheduled_query_rules_alert_v2` rules over `ContainerAppConsoleLogs_CL`. The long-running rule splits fired alerts by a `worker` dimension (`live` / `stale-heartbeat` / `never-connected`) derived from combining provider state with heartbeat age, so the responder knows whether they are looking at a stuck agent, a zombie, or a boot failure. The staleness threshold is derived from `HEARTBEAT_INTERVAL_MS × MAX_MISSED_HEARTBEATS` in `cyrus-router-protocol` rather than picked. A third rule alerts on the **absence** of `sandbox_sweep_completed` — every sandbox alert derives from the 60s sweep, so a stalled sweep would otherwise make them all go quietly blind; that rollup is emitted unconditionally, including on ticks with zero sandboxes, precisely so a quiet fleet stays distinguishable from a dead router. Its query uses a bare `summarize` (which returns one row even for empty input) rather than a `where` filter, which is the classic way a count-of-zero alert gets written so that it can never fire. `enable_monitoring_alerts` defaults true — unlike the router-config variables these resources touch nothing the router reads, so they cannot roll the single replica; `alert_email_receivers` defaults empty, which still records fired alerts but creates no action group. Note `terraform validate` was not run: no Terraform binary is available in this environment.
- **Remote Terraform state and a keyless GitHub Actions deploy identity ([#20](https://github.com/nick-boey/cyrus/pull/20)).** `scripts/bootstrap-tfstate.sh` creates, out of band and in its own `rg-cyrus-tfstate` resource group, the storage account and `tfstate` container backing the Azure stack's state, plus the user-assigned identity that CI assumes over GitHub OIDC. State deliberately does not live in `azurerm_resource_group.this` (`main.tf:28`): that group is created by the stack, so `terraform destroy` would delete the container holding the state file it is mid-write to, and on a first run it would not exist at all. Blob versioning and 30-day soft delete are on because state loss is the only failure in this stack with no recovery path. The federated credential's subject is pinned to a single branch of a single private repo — never a wildcard ref or a `pull_request` subject, either of which would let a fork PR mint a token. No client secret is created, so there is nothing to store in a repo or rotate. The script validates its arguments before the first `az` call (a bad storage account name otherwise fails several seconds into `create`, after the resource group already exists) and is safe to re-run; re-running with a different `--repo`/`--branch` re-points the trust rather than silently skipping it. Role assignments are split by scope: `Storage Blob Data Contributor` on the state *container* only, and `Contributor` + `Role Based Access Control Administrator` + `Key Vault Secrets Officer` + `Key Vault Crypto Officer` at subscription scope. The subscription scope is a deliberate ceiling, documented inline — the natural scope is the stack's resource group, but the stack creates it, so it does not exist to be scoped against until the first apply has succeeded. The RBAC role is needed because `Contributor` cannot create the nine `azurerm_role_assignment` resources the stack declares, and the two Key Vault data roles because the vault is RBAC-authorized (`main.tf:57`) and control-plane `Contributor` grants no data-plane access to the five Linear secrets, the two setup-UI secrets, or the envelope-encryption KEK (`setup_ui.tf:417`).
- `infra/azure/terraform/env/backend.dev.hcl.example`, mirroring the existing `dev.tfvars.example` convention. `.gitignore` gains `backend*.hcl` with a `!backend*.hcl.example` negation.
- **Telemetry Phase 0 — structured router logging (NOR-278, ([#15](https://github.com/nick-boey/cyrus/pull/15))).** `createLogger` gains a `json` rendering mode selected by `CYRUS_LOG_FORMAT=json` (or a per-logger `format` option, which wins over the env var). It emits one flat JSON object per line — `timestamp`, `level`, `component`, `message`, the `LogContext` fields promoted to top level, a hoisted `error: {name, message, stack}` for the first `Error` in the trailing args, and everything else under `args`. The format is resolved per call rather than cached at construction, because several modules build their logger at import time and would otherwise freeze the format before a host could set the variable. Serialization cannot throw: circular references collapse to `"[Circular]"` and a total failure degrades to a minimal record. Text output is produced by the same expression as before and is byte-identical. `CYRUS_LOG_FORMAT=json` is set on the router Container App in `infra/azure/terraform/router.tf`, which is what makes the already-wired Log Analytics workspace queryable by field.
- `createNoopLogger()` in `cyrus-core`: a full `ILogger` that discards everything including the Sentry-forwarding side effects of `warn`/`error`. It exists so an optional `logger` dependency can be typed as the full interface without every caller constructing a real logger — it replaces the `{ info: () => {}, warn: () => {} }` object literals that previously served as defaults.
- `DeviceGateway` logs for the first time: gateway attach, device connect (user, `lastAckedSeq`, active-session count, capabilities), disconnect with close code, stale-socket close under second-connection-wins, pending-event delivery counts, heartbeat misses, and watchdog termination. Rejected handshakes (protocol-version mismatch, unknown token) log at `error`, and the previously fully-swallowed socket `error` handler now warns. Device connect/disconnect is the only device-side liveness signal the router has for a container target — ACA reports `Running` for a sandbox whose entrypoint has exited.

### Changed
- **`var.location` no longer defaults to `australiaeast` ([#20](https://github.com/nick-boey/cyrus/pull/20)).** The region is now a required variable, and `scripts/bootstrap-tfstate.sh` likewise requires `--location`. A default region is the kind of value that is only ever right for the deployment it was written for: it does not surface in a plan diff, so a stack applied without an explicit `location` lands somewhere nobody chose and only announces it via the resource IDs. The description retains the spike S7 guidance (ACA sandbox groups are supported in 35 regions; `australiaeast` is the verified one for this tenant, and an unsupported region fails at sandbox-group create rather than at plan). `env/dev.tfvars.example` already set `location` explicitly, so a deployment following the documented path is unaffected; one relying on the implicit default now fails at plan with a missing-variable error, which is the point. The bootstrap script's `--location` need not match the stack's — the state group holds only blobs and a managed identity, neither of which carries the sandbox-group region restriction.
- **Router logger widened from `{ info, warn }` to the full `ILogger` (NOR-278, ([#15](https://github.com/nick-boey/cyrus/pull/15))).** The narrowing adapter in `RouterCommand` (and the one feeding `createAcaSandboxesProvider`) is gone; `this.logger` is passed straight through, since the CLI `Logger` already implements `ILogger`. The inline two-method type is replaced across `RouterServer`, `EventRouter`, `ContainerLifecycle`, `ContainerTargets`, `AcaProviderFactory`, `StateBackup`, `LinearExecutor`, `TerminalTeardown`, `RepositoryResolver`, `RepositoryRegistry`, and the two `setup/*` route modules. The `{ warn(msg) }`-only types (`KeyVaultSecretStore`, `TableSecretStore`, `TableRepositoryRegistry`, `setup/bootstrap`, `setup/envelope`) are deliberately left alone — they already accept an `ILogger` structurally, and `resolveExecutor` is called with an inline `{ warn }` closure that widening would break.
- `packages/router/src` had **zero** `logger.error` call sites because the narrowed type made the method unreachable. Failures that lose or leak something now log at `error`: container boot failure and unexpected boot throws, destroy of a stale-provider container, lifecycle sweep and orphan GC failures, `reconcileDeviceLocks`/`reconcileDeviceAffinity`, event and container-lifecycle sweeps, registry seed and registry reads, state backup/restore, terminal-teardown destroy and handler failures, RPC dispatch failures in `LinearExecutor`, a lost or unreadable held delegation, and a failed idempotency claim. Self-healing paths (dangling affinity rows, corrupt stored creator, a retained artifact bundle that could not be deleted) stay at `warn` — they describe a condition the code recovers from.
- Exceptions are no longer pre-stringified with `String(err)` before logging. The `Error` is passed as a trailing arg so its stack survives to the JSON renderer and to any later capture. Sites that build a *user-facing* string (`containerBootFailedMessage`, the `rpc_response` error field, `GitHubTokenScopes`' returned probe result) keep their flattening — those are payloads, not logs. `StateBackup.restoreIfNeeded` additionally rethrows with `{ cause }` rather than discarding the original.
- The 8 raw `console.*` calls in `packages/router-client/src/RouterConnection.ts` — including the heartbeat-watchdog line — now go through an injectable `logger` (default: a `"RouterConnection"` component logger), so they honour `CYRUS_LOG_LEVEL`/`CYRUS_LOG_FORMAT`. The `[RouterConnection]` message prefixes are dropped since the component name now carries that.
- Test loggers: new `packages/router/test/helpers/logger.ts` exports `testLogger()` (all five levels as `vi.fn()`, accepting per-method overrides) and `silentLogger()`, replacing the `{ info: vi.fn(), warn: vi.fn() }` and `{ info: () => {}, warn: () => {} }` literals across 17 router test files. `RouterRigOptions.logger` in F1 is now `Partial<ILogger>` merged over a noop. Assertions that read a cause out of an interpolated message were repointed at the `Error` arg; this was the minimal patch called for by the issue — the broader rewrite to structured assertions is Phase 3.
- Deliberately **not** done: Sentry was not enabled as a shortcut. `createErrorReporter` falls back to a `DEFAULT_SENTRY_DSN` belonging to the upstream vendor's org, so setting `CYRUS_TEAM_ID` would ship this deployment's operational data to a third party.
- The Azure deployment docs now build the **worker** image with `az acr build` instead of local `docker buildx --push`. Recent buildx attaches provenance/SBOM attestations by default, which makes the push an OCI image index (`application/vnd.oci.image.index.v1+json`) carrying the real `linux/amd64` manifest plus an `unknown/unknown` attestation child; the ACA sandbox disk importer cannot consume an index, and every worker disk that has imported successfully is a plain `application/vnd.docker.distribution.manifest.v2+json`. `az acr build` produces that shape and, being server-side, builds natively on amd64 rather than under emulation on an arm64 workstation. The router image was never affected — `scripts/deploy-router-image.sh` already used `az acr build`.
- Added a troubleshooting note for `aca sandboxgroup disk create`'s `Error: Network issue — retry policy expired`, which is emitted for any transport-level failure of the `PUT …/diskimages` call and is frequently not a network fault. The note gives the discriminating checks (`--verbose` showing `failed to execute 'reqwest' request` with no HTTP status and ~120 s total is a client-side timeout, not a network error), records that piping the command into `tail`/`grep` masks its exit status so `disk list` showing `Ready` is the only authoritative gate, and notes that a failed registration changes nothing — so the router can be deployed alone and the disk registered afterwards.
- Environment-specific identifiers for the deployment this repository is operated against (ACR, resource group, Key Vault, storage account, Container Apps environment, sandbox group, router app name, ingress hash, subscription id, Linear workspace id, and repository slug) are no longer committed. Operational docs, Bicep samples, Terraform variable/output descriptions, historical plans/specs/test-drives, and code fixtures now use placeholders. `scripts/deploy-router-image.sh` no longer hard-codes the registry: it reads the ACR host from the `router_image` already in the (gitignored) tfvars, so the zero-argument invocation still works, and `REGISTRY=` remains an override. Terraform state, plan files, and `dev.tfvars` legitimately hold real values and are gitignored. Note that scrubbing the working tree does not remove these values from git history.

### Added
- Setup management UI (`/setup`, NOR-265..273): an authenticated per-user page for editing the container secret bundle, gated behind an explicit `setupUi.auth` strategy union (`entra-token` | `easyauth-headers` | `dev-insecure-headers`) rather than any inference from ingress topology or the presence of `RouterServerConfig.entra` — the router refuses to start on an ambiguous or unsafe combination (missing `auth`, `easyauth-headers` without a hand-set `verifiedHeaderStrip: true`, `dev-insecure-headers` off loopback). `entra-token` mode adds a second ID-token verifier (`createSetupIdTokenVerifier`) pinned to the bare client-id GUID rather than the `api://` audience `createEntraTokenVerifier` uses for enrollment. `GET /setup` is genuinely read-only; provisioning moved to a CSRF-protected `POST /setup/provision` so a cross-site navigation can't create an account. The record version used to detect concurrent edits is captured at render time and bound to the principal via a signed token, not re-read inside the save handler, so the two-tab conflict path actually fires. A new envelope-encrypted Table backend (`TableSecretStore`) stores each user's bundle as `Edm.Binary` ciphertext under a per-record `KekVersion` (never a stored URL — building the unwrap request from anything but the configured vault name would be an authenticated SSRF), enforces a 32 KiB pre-encryption size cap, and layers Table-specific concurrency semantics (`POST` insert vs. `PUT` + `If-Match`, treating a missing ETag as a protocol error rather than falling back to an unconditional write) on top of the existing file/Key Vault backends, selected via `containers.tableStore`. `cyrus router secrets migrate --from keyvault --to table [--dry-run]` copies between the two backends named in config, with injectable backend factories for testing and public paginated enumeration on the Key Vault side. Frontend assets (Pico CSS, htmx) are vendored as TypeScript string constants rather than fetched from a CDN, since ACA egress is deny-by-default; an `htmx:beforeSwap` handler allows swaps for 400/403/409 specifically, since htmx does not swap 4xx/5xx responses by default and the plan's original CSP would have blocked that inline handler entirely. Terraform stages the rollout across two independently-applied variables (`enable_setup_auth` then `enable_setup_ui`), each gated by a live-verification attestation variable, so the `authConfigs` sidecar attaching to the Container App can never precede an apply that also exposes `/setup`; the Table and its KEK are created unconditionally with `prevent_destroy = true` and are decommissioned only through an explicit export-verify-disable-retire sequence, never a flag flip.
- Fixed a latent bug in the Entra enrollment domain gate found while building the setup UI's own domain check: `tokenEmail.split("@")[1]` accepted `alice@example.com@evil.test` against an `allowedDomain` of `example.com`, because it read the first `@`-segment instead of the last. Entra's UPN format constrains this in practice, so it was defense in depth rather than an open door, but the gate should not have depended on that; both the enrollment and setup-UI domain checks now use `.split("@").pop()`.
- `resolveExecutor` / `users.executor_json` gains a third state alongside NULL (physical device, unchanged historical meaning) and an explicit `{"type":"device"}`: `{"type":"default"}`, meaning "inherit `containers.defaultExecutor`" for that user. NULL is deliberately never reinterpreted as this new sentinel — no migration can recover which of "explicitly device" or "never configured" a historical NULL row meant, so existing users move onto a router-wide default only via an operator-supplied allowlist, never automatic inference. Corrupt/unparseable `executor_json` keeps degrading to physical device with a warning, never to a cloud sandbox.
- Azure Container Apps Sandboxes support: typed preview data-plane client, labels-only and device-lineage-aware provider, deny-by-default egress, memory suspend/resume, explicit snapshot retention/GC, and router/CLI configuration wiring.
- Azure router readiness: single-replica Terraform stack plus Bicep parity reference, managed identity/RBAC, Key Vault `SecretStore` backend, atomic Blob backup/restore service, and optional Entra-gated device enrollment.
- Terminal container teardown: router relay for `issueStatusChanged` and `Issue/remove`, forced floor flush and worker callback, provider destroy/device-row cleanup, deleted-bundle removal, and stale/grace backstops.
- F1 fake-ACA router lifecycle drive covering delegation, prompt routing, idle stop, resume, synthetic terminal webhooks, wake, callback destruction, device cleanup, and deleted-bundle cleanup. See `apps/f1/test-drives/2026-07-26-router-mode-fake-aca-lifecycle.md`.
- **F1 router-mode credentialed drive support** (used by the 2026-07-17 per-user-secrets drive, `apps/f1/test-drives/2026-07-17-router-mode-container-drive.md`):
  - Split env templates: `apps/f1/.env.example` is now router/control-plane-only; new `apps/f1/.env.user.example` documents per-user container secrets (`CLAUDE_CODE_OAUTH_TOKEN`, `LINEAR_API_TOKEN`, `GIT_TOKEN`, `GIT_USER_NAME`/`GIT_USER_EMAIL`, `DOTFILES_REPO`) seeded via `./f1 router:seed-user --env`, with quoting/rotation/reserved-key guidance. `apps/f1/.gitignore` unignores the new template.
  - `F1_ROUTER_REQUIRED_SECRET_KEYS` (comma-separated) → `startRouterServer`/`RouterRigOptions.requiredSecretKeys` → `containers.requiredSecretKeys`, so F1 drives can exercise the additive boot gate; the effective gate is printed in the startup banner. Exported `parseRequiredSecretKeys` helper.
  - `router-server.ts` now passes a console-backed `[router]`-prefixed logger to the rig (previously the rig's silent default logger swallowed router warnings — including the boot-gate "not fully authenticated" message drives need to observe), and `startRouterServer` accepts a `logger` for tests.
  - `RouterRig.seedUser` is idempotent: re-seeding an existing user updates executor + secrets instead of crashing on the `users.email` UNIQUE constraint (required for the "blocked → seed missing key → re-inject" drive flow).
  - New `seedIssue()` test fixture (`packages/router/test/helpers/fixtures.ts`): seeds a tracker issue with caller-chosen id/identifier. The `/workspaces/<KEY>` invariant e2e test needs it — the in-container EdgeWorker fetches the full issue before creating the worktree, so `seedSession` alone 404s and the worktree never appears.

### Changed
- Un-skipped the `/workspaces/<ISSUE-KEY>` real-directory invariant test in `packages/router/test/containers-real-docker.e2e.test.ts` — the 2026-07-17 credentialed drive supplied the empirical confirmation Task 11 deferred (live container: not a symlink, realpath-stable). Fixed its never-run fixture with `seedIssue` (above); it now passes against real Docker.
- Cyrus Router per-user device routing. Three new packages: `cyrus-router-protocol` (wire-frame Zod schemas + the RPC method allowlist), `cyrus-router` (SQLite-backed device registry/event queue/RPC executor: `RouterStore`, `DeviceGateway`, `EventRouter`, `LinearExecutor`, `RouterServer` + `POST /enroll`), and `cyrus-router-client` (device-side `RouterConnection` with durable inbox/outbound buffers, `RouterEventTransport`, and `RouterIssueTrackerService`). EdgeWorker gains a `platform: "router"` mode; the CLI gains `cyrus router start|users|devices|unlock` and `cyrus connect`.
- In-process end-to-end integration test (`packages/router/test/e2e.test.ts`): a real `RouterServer` on port 0 backed by a `CLIIssueTrackerService`, driven by a real `RouterConnection`/`RouterEventTransport`/`RouterIssueTrackerService` over localhost. Covers enrollment, online routed delivery + queue drain, offline queue + one-time waiting notice + reconnect delivery, issue-lock rejection, creator-only prompt gating, the webhook→`"message"` (SessionStart/UserPrompt) translation round-trip, and session-scoped RPC authorization.
- Docker deployment assets for the router: multi-stage `docker/router/Dockerfile` (pnpm filtered install + `pnpm deploy --legacy` from monorepo source, node:22-slim, non-root, HEALTHCHECK against `/healthz`), env-driven `entrypoint.mjs`, compose file + `.env.example`, root `.dockerignore`, and a GHCR publish workflow (`.github/workflows/docker-router.yml`, multi-arch, `ghcr.io/<owner>/cyrus-router`).
- **Ephemeral container executors, phase 1 (Docker only)** — implements the design in `docs/superpowers/specs/2026-07-13-ephemeral-container-executors-design.md`, now marked "Implemented (phase 1)". Spans two new packages, a schema migration, new router components, a test seam, and an e2e test suite:
  - `cyrus-workspace-sync`: the persistence-floor primitives shared by the router and the worker container — `buildBundle`/`restoreBundle` (tar an issue's Claude transcripts + `SerializableEdgeWorkerState` session slice, and restore them), `sanitizeCwdForClaudeProjects` (mirrors the Agent SDK's own transcript-directory naming — verified manually against the live `claude` CLI v2.1.207: the SDK sanitizes the **realpath-resolved** cwd, not the literal path passed to it, which is also the source of the spec correction below), and `uploadBundle`/`downloadBundle` (HTTP transport with independently-tuned upload/download timeouts, since a failed download starts a container with zero prior context while a failed upload just retries next tick).
  - `cyrus-router-executors`: the `ContainerExecutor`/`IssueExecutionContext`/`ExecutorRegistry` interfaces and the first concrete provider, `LocalDockerProvider` (shells out to the `docker` CLI via an injectable `ExecFn` test seam: `inspect`/`status`/`ensureRunning`/`stop`/`destroy`/`listManaged`, one container + one named volume per issue key).
  - Router schema v2 migration (`RouterStore.migrate()`): the `devices` table gains `kind` (`'device' | 'container'`), `issue_key`, and `provider` columns, and `users` gains `executor_json`. A v1 database (no `kind` column) is rebuilt in place — `devices` is recreated with the new shape, existing rows are migrated as `kind = 'device'`, and `AUTOINCREMENT` continuity is preserved via `sqlite_sequence`. Two new partial unique indexes enforce "one physical device per user" and "one container device per issue key" without a single constraint that would forbid both coexisting for the same user.
  - New router components: `SecretStore` (per-user container secret bundle — Claude OAuth token, git identity, GitHub PAT, dotfiles repo URL — a single 0600 JSON file), `ContainerTargetService` (resolves/boots a user's per-issue container device, replacing it when the user's configured executor provider changes, with an in-flight-boot dedup map and a once-per-issue-until-success boot-failure notice), `ContainerLifecycle` (idle-stop / stale-destroy / orphan-GC sweep, run alongside the existing event-expiry sweep), and artifact endpoints `PUT`/`GET /artifacts/issues/:issueKey/bundle` (device-token-authenticated, issue-scoped) serving as the floor's server side.
  - `RouterServerConfig.executorRegistryFactory` test seam (added mid-Task-8 as a fix-pass finding): lets tests inject a fake `ExecutorRegistry` at the composition root instead of the router always constructing a real `LocalDockerProvider` — this is what let Task 12's e2e suite exercise the full container-routing path without a real Docker daemon or `vi.mock("node:child_process")`.
  - In-process end-to-end integration test (`packages/router/test/containers-e2e.test.ts`), following the same real-`RouterServer`-plus-`trackerFactory` harness pattern as `e2e.test.ts`. A `FakeBootExecutor implements ContainerExecutor`, injected via `executorRegistryFactory`, mints a device token via `ctx.mintDeviceToken()` and connects a real `RouterConnection`/`RouterEventTransport` device stack over localhost WebSocket — exercising cold-boot queue-drain (and confirming no "device offline" notice is posted for an expected cold start), terminal-`session_state`-triggered idle-stop (via a second `ContainerLifecycle` instance sharing the router's store/executors with an injected clock, since `RouterServer`'s own lifecycle always runs on the real `Date.now`), an executor switch (old provider `destroy()`d, new device row + boot for the new provider), and a boot failure posting exactly one `containerBootFailedMessage` activity per issue until a boot succeeds. This suite is what caught the `inFlightBoots` keying bug above.

### Fixed
- `ContainerLifecycle.sweep` now reconciles session affinity against the device's declared session set before applying its `affinity > 0` gate, via a new `sessions_query`/`sessions_report` frame pair. Closes the PAR-146 leak: `routePrompted` re-establishes affinity for an already-terminal session without an issue lock and without logging, so a session that never goes terminal again pinned its device out of idle-stop permanently. Offline devices age affinity out after `offlineAgeOutMs` so stale-destroy can proceed. Pinned/unpinned transitions are now logged.
- **`scripts/deploy-router-image.sh` would have uploaded the Linear client secret, both live OAuth tokens, and plaintext Terraform state to Azure on its very first run.** `az acr build … .` is not a local build: it tars the working directory and **uploads** it to the registry, honouring `.dockerignore`. The manual `docker buildx build` path it replaced kept the context on the local daemon, so nothing ever left the machine; that difference was never assessed when the script was written. `.dockerignore` did not exclude `infra/azure/terraform/`, so every run would have shipped `env/dev.tfvars` (mode 600) and `terraform.tfstate` — Terraform stores `sensitive` values in state as **plaintext**; `sensitive = true` only redacts CLI output — plus the 638 MB provider cache, which also busted the `COPY . .` layer cache every run. Now excluded, with the entries marked load-bearing for secrecy so nobody prunes them as dead weight. Note that ACR compiles its own subset of Docker ignore syntax (`_archive_utils.IgnoreRule`): a trailing slash yields a pattern ending in `/$` that no archive entry can match, so `**/.terraform/` is a silent no-op, and `**/x` and `*.x` each miss half the tree. Both forms of every rule are required; verified by running the CLI's own packer over a mirror of the repo layout.
- **A failed `awk` in the same script could destroy the secrets file it exists to protect.** `main` calls the rewrite as `rewrite_router_image … || die`, and putting a function on the left of `||` disables `set -e` for its entire body — so an `awk` killed partway through (disk full, OOM) had its status discarded, and the verification that followed only asked whether exactly one `router_image` line survived and carried the new ref. A file truncated *after* that line answers yes to both, and the `mv` then overwrote the only copy. The function was safe exactly where it was tested (bare calls keep `set -e`) and unsafe exactly where it was used. Now checks `awk`'s status explicitly and compares line counts, which also enforces the "every other line byte-identical" rule that nothing previously checked. Also: the digest now comes from the build run (`--no-logs --query 'outputImages[0].digest'`) instead of a post-hoc lookup of a mutable tag; the provenance-comment rewrite no longer falsifies `worker_image`'s identically-worded comment; the temp file is named so SIGKILL residue is gitignored and out of the build context; and a failing `git status` no longer reads as a clean tree. CI now runs `scripts/deploy-router-image.test.sh` — `pnpm test` is workspace-only, so nothing ran it before, and the first Linux run immediately caught a `stat -f`/`stat -c` fallback that silently misreported file modes on GNU coreutils.
- **CRLF line endings silently broke every container image built on Windows.** Root cause of the 2026-07-27 ACA outage (issue PAR-166). The committed blob of `docker/worker/entrypoint.sh` was always LF, but with no `.gitattributes` and Git's Windows default `core.autocrlf=true`, checkouts rewrote it — and 743 other tracked files — to CRLF. The image then carried a shebang of `#!/bin/sh\r`, so the kernel looked for an interpreter literally named `/bin/sh\r` and the exec failed with a bare `No such file or directory`. Because ACA's own `tini -- sleep infinity` keep-alive is always PID 1, the sandbox still reported `Running` with a healthy infrastructure state while no worker process existed, nothing dialed the router, and the delegation hung indefinitely. CI-built (Linux) images were unaffected, which is why this only ever reproduced from a local build. Added a repo-wide `.gitattributes` pinning `text=auto eol=lf` plus explicit rules for the executable assets, renormalized the working tree, and added `packages/router/test/worker-entrypoint-line-endings.test.ts` as a regression guard.
  - Ruled out during diagnosis, against the live preview data plane: ACA **does** honour a disk image's OCI `ENTRYPOINT` (a `redis:alpine` disk booted `redis-server` with no override), and **does** honour an explicit `entrypoint` override (a `/bin/sleep 999` override appeared as a child process). Neither the provider nor spike finding S1 was wrong — only the file was. Note that an entrypoint runs as a CHILD of PID 1, so PID 1 is never evidence about whether the workload started.
- **`AcaSandboxCreateBody.entrypoint`/`cmd` had the wrong wire type.** Declared `string`, but the 2026-02-01-preview API expects `IReadOnlyList<string>` and rejects a bare string with `400 "The JSON value could not be converted to System.Collections.Generic.IReadOnlyList\`1[System.String]"`. Latent (nothing sets these today, since the image ENTRYPOINT is used) but guaranteed to 400 the first time anyone did. Now `string[]`, with the exec-form contract documented.
- **Three root `package.json` scripts were silent no-ops on Windows**, all exiting 0 while doing nothing — including two that CLAUDE.md instructs contributors to run before every PR:
  - `build` filtered on `!@cyrus/electron`, a package that no longer exists (`apps/electron` is gone; the workspace is `apps/cli` and `apps/f1`). Replaced with a plain `pnpm -r build`.
  - `test:packages`, `test:packages:run` and `test:apps` wrapped their path filters in **single** quotes. `cmd.exe` does not strip single quotes, so pnpm received the literal `'./packages/*'` and matched nothing — `pnpm test:packages:run` reported success without running a single test. Switched to double quotes, which cmd.exe does strip; 19 packages now match.
- **Direct-mode Linear webhook rejections were completely silent.** Both `LinearEventTransport` 401 paths — missing `linear-signature` header, and a signature that fails to verify — returned without logging, so a rejected delivery left no trace anywhere and was indistinguishable from Linear never having sent the event. Both now warn, naming the source IP and (when the body parsed) the `type/action`, and point at the signing secret. Note `LinearWebhookClient.verify()` **throws** on a malformed signature rather than returning false, so the throw path is a normal rejection and is handled as one.
- **A listener fault was reported to Linear as a bad signature.** One `try` in `handleDirectWebhook` wrapped both verification and the `emit("event")`/`emitMessage` calls, so an exception raised by a downstream listener produced `401 Invalid webhook signature` — pointing the operator at a non-existent signing-secret problem and asking Linear to retry a delivery that had already been accepted. Verification now has its own scoped try/catch; listener faults fall through to the 500 path in `register()`.
- **The router logged only the work it refused, never the work it accepted.** `routeCreated` wrote session and issue affinity, queued the event and dispatched a container boot without emitting a single line, while every ignored or rejected webhook logged one. A console showing nothing but `ignoring non-agent-session webhook` therefore looked exactly like an agent-session event that never arrived — which is precisely how the PAR-166 diagnosis was initially misread. Added an acceptance line in `routeCreated` and a boot-dispatch line in `deliverOrNotify`. Separately, every logging call in `ContainerTargets.ts` was `logger.warn`: the container lifecycle only ever spoke on failure, so a boot that succeeded said nothing. `bootInner` now logs both edges, which matters most for ACA where `ensureRunning` returning only means the infrastructure came up — the worker still has to dial back over WSS.
- Phase-1 container-executor validation gaps closed (TODO phase-1 items 1–5), all test-only except `.dockerignore`:
  - **Real-Docker boot serialization.** Spec A2's fourth lifecycle behaviour had only a `FakeBootExecutor` test with a hand-held gate. Now exercised against a real `LocalDockerProvider` — created-then-prompted mid-`docker run`, asserting one `ensureRunning`, one labelled container, one container device row. Uses a counting provider because container count alone cannot detect a broken dedup (a duplicate `docker run` just name-clashes).
  - **In-container floor upload.** The prior round-trip test built and PUT the bundle from the *test process*, so the trigger → `pushWipIfDirty` → PUT chain was never exercised in CI. The bundle is now attributed to the container's own `WorkspaceSyncService` via its log line, followed by a fresh container rung-2 restoring from that bundle. Idle-stop flush and the 5-minute periodic tick remain unit-covered only — neither can be forced in a container, because by the time it can be stopped the floor has usually converged and deliberately dropped the issue from its touched set.
  - **`host.docker.internal` never resolved on plain Linux Docker Engine** (`LocalDockerProvider` passes no `--add-host`; `getent hosts` confirmed to fail). Every Docker e2e suite hardcoded it, so on Linux the `/workspaces/<ISSUE-KEY>` invariant test and the floor round-trip test could not have passed — they failed or flaked rather than validating anything. New `routerHostForContainers` helper probes the name and falls back to the bridge gateway.
  - **`dockerAvailable()` could report a false green.** A transient `spawnSync` failure silently skipped the entire opt-in suite, indistinguishable in the reporter from "no daemon". Now memoized and retried; a real non-zero exit still means no daemon.
  - **`.dockerignore` excludes test sources.** They never reach the image (tsconfigs build `src/**`, excluding `**/*.test.ts`) but invalidated `COPY . .`, forcing the ~8-minute rebuild that blows the suite's own 300s `beforeAll` build hook. Cached rebuild after a test edit is now ~1.4s.
  - **`/workspaces/<ISSUE-KEY>` invariant** strengthened to the explicit lstat form the spec is stated in (`stat -c %F` → `directory`, alongside `test ! -L` and `realpath`).
- ACA live-deployment follow-ups from `apps/f1/test-drives/2026-07-26-live-aca-nor-252.md` (TODO items 1–7):
  - **Device WebSocket liveness watchdog.** `RouterConnection` stamps every inbound router signal with `Date.now()` and terminates the socket once the stamp is older than `MAX_MISSED_HEARTBEATS × heartbeat`, feeding the existing `handleDisconnect → scheduleReconnect` path. Wall-clock rather than tick counting is load-bearing: timers are frozen for the whole ACA memory suspend and fire late on resume, so a tick-counting watchdog concludes nothing happened. `HEARTBEAT_INTERVAL_MS`/`MAX_MISSED_HEARTBEATS` moved to `cyrus-router-protocol`; `hello_ack` now advertises the gateway's configured `heartbeatMs` (additive, no protocol version bump). `AcaSandboxesProvider` no longer trusts `resumeSandbox` returning — it polls the router's `deviceConnectivity` seam to a deadline and replaces a sandbox whose worker never rejoins.
  - **Webhook idempotency.** New `webhook_claims` table plus `RouterStore.claimWebhookEvent`, a single `INSERT OR IGNORE` inside `db.transaction(...).immediate()` arbitrated by the PRIMARY KEY — never a read-then-write. `EventRouter.route()` claims before any dispatch, so no queue row, issue lock, activity, or MCP mutation can happen twice for one delivery. `busy_timeout = 5000` added so the loser of a write-lock race waits instead of throwing `SQLITE_BUSY`. Key is `<type>/<action>:<organizationId>:<entityRef>:<createdAt>`: Linear's payload carries no delivery id (verified against the SDK's generated types — it lives in an HTTP header the transport never surfaces), and `createdAt` is a property of the payload, so a redelivery reproduces it exactly. **Limit:** each ACA router revision keeps `router.db` on ephemeral local storage, so during a rollout overlap the two revisions have separate databases and a duplicate whose claim postdates the last Blob backup is not caught. Closing that needs a shared claim store.
  - **Session completion integrity.** Root cause was that `updateSessionStatus` mutated memory only — `savePersistedState()` ran at runner attach and in `stop()`, never on completion — so the last durable snapshot of a cleanly-finished session read `active` with no runner, byte-identical to a host that died mid-run. `reconcileInterruptedSessions` could not tell them apart and posted a bogus terminal `error`. `WorkspaceSyncService.readState()` re-reads that file off disk, so the bundle a replacement container restored from carried the same lie. `emitTerminalOnce` is now async and flushes durable state before signalling; a new `terminalState` field on `CyrusAgentSession` is the durable half of the one-shot and makes reconciliation skip finished sessions. Terminal-frame replay is now monotonic (`discardBufferedSessionState` on resume; newer frames supersede older ones for a session). Reconcile moved ahead of `sharedApplicationServer.start()` and the router dial deferred via `pendingRouterDial`, so no queued prompt can race a terminal signal.
  - **Terminal teardown durability.** `TeardownCallbackQueue` persists intent + idempotency key to `~/.cyrus/router-client/teardown-callbacks.jsonl` synchronously, before `handleIssueStateChangeMessage`'s first `await` — inside the still-unprocessed inbox window, since `RouterConnection` marked the entry processed as soon as its `"event"` emit returned, long before the async cleanup it started had finished. Replay gated on reconnect; a positively-rejected callback (400/401/403/404) is dropped rather than replayed forever. Router-side `container_teardowns` table backs the `TEARDOWN` column and distinguishes `callback retry` from `grace expired` in logs.
  - **Joining an in-flight boot was treated as proof the container is running.** `inFlightBoots` dedups overlapping `ensureRunning`/`mintDeviceToken` work, but the joined attempt may have begun *before* the event the joiner is reacting to and can finish having achieved nothing. A terminal-teardown wake that joined such an attempt returned believing the container was up: nothing started it, the queued terminal webhook was never delivered, and only the grace deadline reclaimed it — this is item 4's live symptom. `bootStart` now re-checks `executor.status()` after joining and boots for real if the container is not running; the dedup itself is unchanged. Also bounded two ways against a permanent wedge: an attempt in flight past `BOOT_JOIN_TIMEOUT_MS` is abandoned rather than joined, and `AcaSandboxClient` carries a per-request deadline (`requestTimeoutMs`, default 120s) — Node's `fetch` has no overall request timeout, so a blackholed data plane could hang a call indefinitely while holding the provider's per-issue mutex and the boot slot behind it.
  - **MCP connection health.** `ClaudeRunner`'s `case "system":` was a literal no-op, so the SDK's only per-server status report (`SDKSystemMessage`, `subtype: "init"`) was discarded and Cyrus had zero signal — combined with `MCP_CONNECTION_NONBLOCKING=true` on every session, a failed or reconnecting server was invisible by construction. Now surfaced via `onMcpServerStatus`, with `packages/core/src/mcp/` providing bounded-backoff retry and an ordered transient/permanent classifier (unknown → transient, since the budget is bounded). `cyrus-tools` gets `alwaysLoad: true` (loopback, in-process) to stop turn-1 tool availability being a race; `linear` deliberately does not, to avoid adding a round trip to every session start. `cyrus-docs` is omitted in headless container mode, detected by requiring *both* `CYRUS_ISSUE_KEY` and `CYRUS_DEVICE_TOKEN` so a dev shell or a client device doesn't trip it.
  - **Immutable image tags.** `router_image`/`worker_image` now validate as a digest, release tag, or git-SHA tag, with `allow_mutable_image_tags` as a deliberate escape hatch that shows up in the tfvars diff. Terraform state records the tag *string*, so a re-pointed mutable tag produces no plan diff while the deployed bits change — which is how `:deploy-aca-disk-fix` and `:deploy` diverged. A positive allowlist rather than a blocklist, since a blocklist would have missed `deploy-aca-disk-fix`. Publishing the immutable tag remains a manual operator step; runbook in `infra/azure/README.md`.
  - **GitHub token scopes.** Documented `repo` as the functional minimum and `read:org` as org-queries-only, and corrected a real discrepancy found while verifying: `EdgeWorker.resolveGitHubToken()` reads `GITHUB_TOKEN` only — `GH_TOKEN` is exclusively a router/container credential consumed by `ContainerBootCommand`. Opt-in `--check-scopes` distinguishes an absent `X-OAuth-Scopes` header (fine-grained PAT/App token, un-introspectable) from a present-but-empty one, so it never reports a false deficiency.
- Final whole-branch review fix-pass on the ephemeral container executors feature, ahead of release:
  - `RouterStore.revokeDevice` ran `DELETE FROM devices WHERE user_id = ?` with no `kind = 'device'` filter, unlike every other kind-scoped path (`getDeviceForUser`). Revoking a user's physical device deleted their container device rows too, which `ContainerLifecycle`'s orphan-GC sweep then reaped (container **and** volume) within one tick — no session-affinity guard on that path. Now scoped to `kind = 'device'`. `RouterStore.removeUser` had a related bug: it purged scoped rows (`issue_locks`/`session_affinity`/`issue_affinity`/`rpc_mutations`) for only the FIRST device row found via `.get()`, stranding the rest when a multi-device user (physical + container(s)) was removed; now loops over every device row. `removeUser` still does not call into any executor to proactively `destroy()` a removed user's containers — that reaping remains the orphan-GC sweep's job, deliberately, since `RouterStore` has no executor wiring; the CLI's `users remove` now prints a note saying so.
  - `EdgeWorker`'s `router.floorSync` gate was `!== false` (opt-out, defaulting **on**) for every router-platform device, including existing physical-device deployments that never asked for it — a violation of the design's own "existing router+physical-device behavior must not change" constraint, since `WorkspaceSyncService` runs on every session end and a 5-minute timer (not just worktree teardown, its pre-existing behavior). Flipped to `=== true` (opt-in, defaulting **off**). `ContainerBootCommand.writeConfig` already set `floorSync: true` unconditionally for containers, so they are unaffected; a physical device now opts in explicitly.
  - `docker/worker/README.md`'s copy-pasteable `router-config.json` never set `host`, and the router defaults to `127.0.0.1` — but a container reaches the router over the Docker bridge/gateway, not loopback, so the connection was refused outright. Added `"host": "0.0.0.0"` to the example with an explanatory callout, corrected the troubleshooting section (previously misdirected the reader to `routerUrlForContainers`), and added a reminder that `router-config.json` is read once at startup (no watcher) so the router must be restarted after editing it.
  - The runbook's "verify persistence" section asserted a `docker volume rm` + re-prompt "should resume from the last synced state rather than starting over" — true again after `b003ce15` fixed the underlying bug, but the section was rewritten to describe the actual current mechanics precisely: `container-boot` restores the floor bundle (transcripts + state) and canonicalizes the workspace path, but does NOT recreate the git worktree itself; `EdgeWorker.resumeAgentSession`'s `ensureSessionWorkspaceExists` recreates it on the NEXT resume, checking out `origin/<issue-branch>` so any WIP commits the floor pushed survive.
  - `EventRouter.resolveTarget`'s container-routing branch computed `extractIssueKey(webhook) ?? issueId ?? sessionId`. Both fallbacks are Linear-internal UUIDs that pass `ContainerTargetService`'s `ISSUE_KEY_RE` format gate fine, so a webhook missing `agentSession.issue.identifier` (a real, `Maybe<...>`-typed possibility, not just theoretical) would silently mint a container keyed by a UUID — and the in-container edge worker always uploads its floor bundle under `session.issue.identifier`, so every floor upload for that container's life would 403 against the artifact endpoint's issue-key scoping, silently. Now fails closed: a missing identifier throws `InvalidIssueKeyError` immediately instead of falling back.
  - `LocalDockerProvider.ensureRunning` `docker rm -f`'d a RUNNING container unconditionally on an image-tag mismatch, with no session-affinity guard (unlike `ContainerLifecycle`'s idle/stale sweep). Now logs a warning naming the issue key and both images before destroying a running container, so an operator can tell a session died from an image bump rather than an unrelated crash.
  - `LocalDockerProvider.stop` called `docker stop` with no `-t`, so Docker's default 10s grace period could let SIGKILL land before `WorkspaceSyncService`'s 20s stop-flush cap (run last, in `EdgeWorker.stop()`) finished. Now passes `-t 30`.
- `ContainerTargetService`'s in-flight-boot dedup map (`inFlightBoots`) was keyed by issue key, not device id. `ensureDevice` destroys and replaces a container's device row (new device id, same issue key) when a user's executor provider is switched — if that switch happened *while the old provider's container was still cold-booting* (a `docker run` image pull can take minutes, per the code's own docs), the new device's `boot()` call would see the stale in-flight entry for the destroyed device under the same issue key and silently join it instead of starting a real boot for the new provider. The new container was never actually started; its queued event never drained until some unrelated later event happened to re-trigger `boot()`. Found by Task 12's e2e suite (scenario 3, executor switch) — `pnpm --filter cyrus-router test:run` failed deterministically until `inFlightBoots` was rekeyed by device id, which still dedupes concurrent `created`+`prompted` webhooks for the *same* device while no longer conflating two different devices that happen to share an issue key.
- `AgentSessionManager.completeSession()` emitted `"sessionTerminal"` *before* `await this.addResultEntry(...)`. In router mode that emit drives `RouterConnection.sendSessionState`, and `EventRouter.handleSessionState` releases the issue lock **and** `session_affinity` — which `LinearExecutor.dispatch` authorizes `createAgentActivity` against (it is in `SESSION_SCOPED_RPC_METHODS`). The device therefore disowned itself microseconds before posting its own final result, which the router then rejected with `session not owned by this device`. Every normally-completing router session lost its final result entry; PAR-98's session `85303860` showed the signature exactly (last activity 22:00:56, terminal `complete` 22:01:35, zero `Response` activities across 625). The emit now runs after the result is posted, inside a `finally` so an unexpected throw still relinquishes the lock (sink failures are swallowed by `syncEntryToActivitySink`, so that is belt-and-braces). Second half of the same bug: an `SDKResultMessage` ends a *turn*, not the session — a runner holding `getRunnerPendingWork()` (ScheduleWakeup/cron/backgrounded tasks) keeps streaming afterwards, so the terminal signal is now skipped entirely while work is in flight and emitted on the later result when the runner actually closes (`emitTerminalOnce` keeps it once). PAR-97 lost 467 messages / 16 minutes to that mode. Pending work is sampled *before* the awaits so a task finishing mid-post cannot race the decision. `abortSession()`'s kill path is unchanged. New `AgentSessionManager.terminal-signal.test.ts`; 5 of its 7 tests fail against the old ordering.
- Killing a session never signalled its terminal state, leaking the router's issue lock permanently. `"sessionTerminal"` — the event that drives `RouterConnection.sendSessionState` — was emitted from exactly one place: `AgentSessionManager.completeSession`, reachable only from the `case "result"` branch of the message loop. `EdgeWorker.handleStopSignal`'s full-kill branch (a non-warm runner, or a double-stop) calls `AgentRunner.stop()`, which tears the SDK query down before it can yield an `SDKResultMessage`, so `completeSession` never ran. `requestSessionStop()` does not help: it only sets a flag that `completeSession` consumes. The `wasStopRequested → "stopped"` logic in `completeSession` was written for the *interrupt* path (where the query still returns) and was dead code on the kill path. Observed in the wild: a stopped session held its issue lock for 72 minutes until `cyrus router unlock`; the router's sweep never reclaims it because that only covers devices offline past `eventTtlMs`. New `AgentSessionManager.abortSession()` emits the terminal state for kill paths, and a `terminalEmittedSessions` guard keeps the emit exactly-once across both entry points. `EdgeWorker`'s `sessionTerminal` listener now try/catches, because `sendSessionState` writes to disk synchronously inside the emit and a failure there would otherwise abort session teardown. Note the pre-existing `EdgeWorker.missing-session-recovery` mock lacked `abortSession` and still went green — `handleWebhook`'s catch-all swallows the `TypeError` — so the mock was extended and the wiring is now asserted directly.
- `session_state` is now delivered durably, closing a *second*, independent issue-lock leak (the frame could be dropped in flight). The frame is the only thing that releases `issue_locks` + `session_affinity`, but `RouterConnection.sendSessionState` was fire-and-forget (`if (!this.isOnline()) return;`) with no ack, retry, or buffer — unlike mutating RPCs, which already had a durable outbound buffer keyed by `mutationId`. `EventRouter.sweepExpired` only reclaims locks from devices offline past `eventTtlMs` (48h), so a device that stayed *connected* but lost its terminal frame stranded the issue forever, recoverable only via `cyrus router unlock`. Observed in the wild: a session posted 114 successful RPCs, ended, and never released its lock. `PROTOCOL_VERSION` 1 → 2: `session_state` gains a correlation `id`, and the router replies `session_state_ack` **after** applying the release (crash-before-ack ⇒ replay). The device persists each frame to `session-state-buffer.jsonl` before sending and replays the buffer on every `hello_ack` until acked, dropping the entry only on a matching ack. Delivery is at-least-once; `handleSessionState` is idempotent. The version bump is deliberate and fails closed: a v2 device against a v1 router would buffer terminal frames forever (no ack ever arrives) and a v1 device would reject the unknown ack frame, so the handshake rejects the skew instead. Tests were mutation-checked — all six fail against the pre-fix implementation.
- One-shot CLI commands hung after completing their work. `Application` opens `fs.watch` handles on `.env` and `config.json`; those keep the event loop alive indefinitely, which is what long-running `start`/`router start` want but leaves every one-shot command idling after it has done its job. `cyrus connect` was the worst case — it enrolled the device, printed "Next: run `cyrus start`", then never returned. New `Application.disposeWatchers()` closes both watchers; the CLI action layer calls it in a `finally` for `connect`, `auth`, `check-tokens`, `refresh-token`, and every `router` admin subcommand, letting the process exit naturally with code 0. `router start` now has its own action that deliberately retains the watchers for `.env` hot-reload. Note the fix is in the action layer rather than a `process.exit(0)` inside the commands: `RouterCommand.test.ts` mocks `process.exit` to throw so that error branches surface, so forcing an exit on the happy path would have broken the suite while looking correct.
- Router RPC dispatch (`LinearExecutor.dispatch`) invoked the tracker method through a bare extracted function reference (`fn(...rest)`), dropping the `this` binding so every real `LinearIssueTrackerService` RPC threw `Cannot read properties of undefined (reading 'linearClient')`. Now invoked via `fn.call(tracker, …)`. Unit tests missed it because they used mock trackers; the in-process e2e (real tracker over the wire) caught it.
- `DeviceGateway.close()` now detaches per-socket lifecycle handlers before closing, so a late `ws` "close" event during shutdown no longer calls `store.touchDevice()` against an already-closed database.

### Changed
- Ran `pnpm update -r` across the workspace, refreshing in-range dependencies in all 20 packages and taking `pnpm audit` from 8 advisories to **0**. No direct-dep version bumps or new overrides were needed — every remaining advisory (`body-parser`, `find-my-way`, `js-yaml`, `postcss`, `shell-quote`, `@hono/node-server`, `@opentelemetry/propagator-jaeger`) was already reachable inside existing semver ranges; the lockfile had simply been holding packages below what their carets allowed (e.g. `fastify` pinned at 5.8.5 against a `^5.8.5` range with 5.10.0 available). Note `pnpm update -r` also rewrites declared ranges to match, including normalising `zod` to the exact `4.3.6` demanded by the override.
- Investigated bumping `@google/gemini-cli-core` 0.47.0 → 0.52.0 to reach the `@opentelemetry/propagator-jaeger` advisory via a direct-dep bump (policy-preferred over an override). **Rejected:** 0.52.0 resolves to an older, more vulnerable transitive set, taking the audit from 0 to 21 advisories including a critical `shell-quote`. The 0.47.0 pin stays. Recorded here so the next person doesn't retry it.
- Evaluated pruning the migrated override floors now that the dependency refresh may have made them redundant (per the Dependency Security Policy). Removing all 29 inherited `>=` floors and re-auditing showed only 6 still load-bearing (`semver`, `uuid`, `brace-expansion`, `@hono/node-server`, `@opentelemetry/core`, `@opentelemetry/sdk-node`) — i.e. ~23 are candidates for removal. **Not applied:** the lean set was validated against a lockfile that the rejected 0.52.0 experiment had already perturbed, so the result is indicative rather than trustworthy. Worth redoing from a clean resolution as a standalone change.
- Migrated the root `package.json` `pnpm` block to `pnpm-workspace.yaml`, completing the follow-up flagged below. All 34 `overrides` entries plus `sqlite3` from `onlyBuiltDependencies` moved across, and the `pnpm` block was deleted so the two can no longer drift. Three workspace entries (`semver`, `esbuild`, `brace-expansion`) were keyed to narrow version ranges that the migrated plain-key floors strictly supersede, so they were dropped as redundant. Note the overrides were never actually inert in practice — `pnpm-lock.yaml` carried its own copy from before the pnpm 10 upgrade and kept applying them — so the tree barely moved; the real fix is that the config is now authoritative and editable again. The one behavioural change is `@anthropic-ai/sdk`, whose stale `>=0.110.0` floor had been silently capping `cyrus-claude-runner`'s direct `^0.115.0` specifier.
- Raised four stale security floors in `pnpm-workspace.yaml` to the versions that actually carry the fix: `brace-expansion` `>=5.0.6`→`>=5.0.7`, `fast-uri` `>=3.1.2`→`>=3.1.4`, `hono` `>=4.12.25`→`>=4.12.27`, `protobufjs` `>=8.6.0`→`>=8.6.5`. Each floor sat one or two patches below its advisory's `patched_versions`, so the open-ended `>=` range was still satisfied by a vulnerable version. `pnpm audit` drops from 17 advisories to 8.
- Filled the `usage.fallback_credit` field added by `@anthropic-ai/sdk` 0.115.0 in the Codex and Gemini runners (6 sites). The field is nullable on `BetaUsage` but required on `NonNullableUsage`, so assistant-message blocks use `null` while result blocks use `{ status: { type: "not_applied", reason: "not_enabled" } }` — neither provider performs an Anthropic fallback-credit reprice.
- Pinned Node to the 22 LTS line: added `.nvmrc` (`22.23.1`) and an `engines.node` range (`>=22.0.0 <23.0.0`) to the root `package.json`. The repo previously pinned nothing, which let a host drift into running the router under one Node and its tooling under another. `better-sqlite3` is the tree's only native module, so an ABI mismatch (`NODE_MODULE_VERSION 147` vs `127`) between the two silently survives until the long-lived process restarts — the rebuilt `.node` loads fine in the already-running process and only fails on the next boot.
- Corrected the CLAUDE.md Dependency Security Policy to reflect that pnpm ≥10 (`packageManager: pnpm@10.33.1`) no longer reads the `pnpm` field in root `package.json`; `overrides` and `onlyBuiltDependencies` now live in `pnpm-workspace.yaml`. Flagged that override entries still in `package.json`'s `pnpm` block are inert until migrated (a separate, `pnpm audit`-verified follow-up).

### Boundary invariant
- Package layering is one-directional: `cyrus-router-protocol` (frames only, no cyrus-core dependency) ← `cyrus-router` (server; never imports `cyrus-router-client`) and `cyrus-router-client` (device). The e2e test's dependency on `cyrus-router-client` is a **devDependency** of `cyrus-router` — test-only, so the runtime server→client non-dependency invariant is preserved.

### Removed
- Reverted multi-user env-var credential injection (UserCredentialResolver, credential-env scrub, cyrus users CLI); SessionCreator threading and F1 creator payloads retained for the router architecture.
## [0.2.71] - 2026-09-04

### Changed
- Recorded, after the fact, why #1426 removed the `linear_agent_session_create` and `linear_agent_session_create_on_comment` cyrus-tools: they allowed concurrent child sessions to be started on the same issue. That removal also silently dropped the only runtime caller of `GlobalSessionRegistry.setParentSession`, breaking parent resumption. `EdgeWorker.linkChildSessionToParentIssueSession` now derives the child-to-parent session link from Linear's issue hierarchy on `AgentSessionEvent/created` (and after repository selection), so the removed tools stay removed. ([#1454](https://github.com/cyrusagents/cyrus/pull/1454))

### Fixed
- The release workflow's npm registry visibility check now waits up to 10 minutes per package instead of 60 seconds. The v0.2.70 release run aborted mid-graph because npm's publish processing exceeded the old 12×5s window even though the publish itself succeeded; the new deadline matches npm's own "may take a few minutes" guidance. ([CYPACK-1478](https://linear.app/ceedar/issue/CYPACK-1478/if-a-mcp-server-has-no-enabled-tools-will-it-not-be-allowed-as-an-mcp), [#1442](https://github.com/cyrusagents/cyrus/pull/1442))

## [0.2.70] - 2026-08-27

### Added
- Guardrails against silently dropped `EdgeConfig` fields (the CYPACK-1478 / CYHOST-967 bug class): `WorkerService.startEdgeWorker` now spreads the entire file config so pass-through fields forward automatically, `ConfigManager`'s hot-reload merge and global-change watch are driven by a single `RELOAD_MERGED_KEYS` list with a compile-time exhaustiveness check that names any unclassified schema key, and a schema-complete CLI test asserts every `EdgeConfig` field survives into the `EdgeWorkerConfig`. ([CYPACK-1478](https://linear.app/ceedar/issue/CYPACK-1478/if-a-mcp-server-has-no-enabled-tools-will-it-not-be-allowed-as-an-mcp), [#1440](https://github.com/cyrusagents/cyrus/pull/1440))

### Fixed
- Release workflows now preflight npm package existence before running release work, with actionable first-publish and trusted-publisher guidance for newly added packages ([#1436](https://github.com/cyrusagents/cyrus/pull/1436)).

## [0.2.69] - 2026-08-26

### Fixed
- Removed obsolete synthetic `fallback_credit` usage fields so all runner packages build against the current shared SDK types. ([#1428](https://github.com/cyrusagents/cyrus/pull/1428))

## [0.2.68] - 2026-08-05

### Added
- Added an on-demand, main-only Cyrus CLI release workflow using npm trusted publishing. It validates the coordinated monorepo version and changelogs, runs release gates, inspects every package tarball, publishes the complete dependency graph in order, and creates the matching git tag and GitHub release without a long-lived npm token. ([#1398](https://github.com/cyrusagents/cyrus/pull/1398))

### Fixed
- Made CLI releases safely resumable after a partial npm publish and tolerant of short registry visibility delays, while still rejecting existing versions that do not carry the requested distribution tag or whose published tarballs differ from the recovery run. CI now tests supported Node.js 22 and 24 releases, and CI/release actions run on their current Node.js 24-based majors. ([#1401](https://github.com/cyrusagents/cyrus/pull/1401))


## [0.2.67] - 2026-07-25

### Added
- F1 release smoke validating the v0.2.67 release branch can start the F1 server, create an issue, start a Gemini-backed session, render/paginate activities, and stop cleanly before publishing. ([CYPACK-1404](https://linear.app/ceedar/issue/CYPACK-1404/run-a-release), [#1386](https://github.com/cyrusagents/cyrus/pull/1386))

## [0.2.66] - 2026-06-19

### Security
- Patched open CLI security advisories and documented the F1 dependency smoke validation. Direct bumps were used where available, with root overrides retained only for vulnerable transitives whose owning packages are already at their current npm latest. ([CYPACK-1334](https://linear.app/ceedar/issue/CYPACK-1334), [#1330](https://github.com/cyrusagents/cyrus/pull/1330))

## [0.2.65] - 2026-06-11

### Added
- F1 release smoke validating the v0.2.65 release branch can start the F1 server, create an issue, start a session, and render/paginate activities before publishing. ([CYPACK-1314](https://linear.app/ceedar/issue/CYPACK-1314), [#1315](https://github.com/cyrusagents/cyrus/pull/1315))
- F1 test drive verifying `ScheduleWakeup` delivery: confirmed the tool is non-operational when `CYRUS_ENABLE_WARM_SESSIONS` is unset (the default) because `ClaudeRunner` completes the streaming prompt on the SDK `result` message, the Claude Code subprocess exits at turn end, and the in-process wakeup timer dies with it; the identical scenario works end-to-end with `CYRUS_ENABLE_WARM_SESSIONS=1`. See `apps/f1/test-drives/2026-06-11-cypack-1310-schedulewakeup.md` for evidence and fix considerations. ([CYPACK-1310](https://linear.app/ceedar/issue/CYPACK-1310), [#1313](https://github.com/cyrusagents/cyrus/pull/1313))

## [0.2.64] - 2026-06-11

### Changed
- Removed stale Slack setup skill guidance that pointed agents back to the retired hosted preview initialization workflow. ([CYHOST-1078](https://linear.app/ceedar/issue/CYHOST-1078/remove-legacy-agent-led-deploy-preview-skills-and-references), [#1310](https://github.com/cyrusagents/cyrus/pull/1310))
- Codex app-server execution now shares app-server processes across sessions instead of spawning one per session. `AppServerProcessManager` pools processes by launch configuration (command + args + env): sessions with an identical config share one process and open their own app-server thread over the shared JSON-RPC connection, while sessions with a differing config (e.g. a different `CODEX_HOME`) transparently get their own process rather than failing. Notifications are routed to the owning session by `threadId` (falling back to the sole registered thread when a notification omits it), so concurrent sessions stay isolated; a process is torn down once its last lease is released (after a short idle grace) or when it exits, and a crash is confined to the sessions sharing that exact configuration. Validated with real-binary concurrent sessions (no cross-talk) and unit tests for pooling, idle eviction, and threadId routing. ([CYPACK-1288](https://linear.app/ceedar/issue/CYPACK-1288), [#1293](https://github.com/cyrusagents/cyrus/pull/1293))
- Bumped `@openai/codex-sdk` from `0.125.0` to `^0.137.0` in `cyrus-codex-runner`. Codex 0.128 (`#19449`) removed the inline `SandboxPolicy.readOnlyAccess` read-restriction mechanism and migrated it to named **permission profiles**; the per-thread sandbox was reworked onto that model (see the Codex sandbox entry below). Streaming/steer, startup-gap follow-ups, cross-process `thread/resume`, and full sandbox enforcement (write confinement + read restriction) were all re-validated end-to-end against the 0.137 binary. ([CYPACK-1288](https://linear.app/ceedar/issue/CYPACK-1288), [#1293](https://github.com/cyrusagents/cyrus/pull/1293))
- Reworked how `cyrus-codex-runner` locates/launches `codex app-server`. Previously it re-derived the platform->vendor native-binary path itself (a copy of the SDK's private resolver, coupled to the vendor layout - which is why the 0.137 bump needed a `bin/` vs `codex/` fallback). Now `@openai/codex` is a direct dependency and we invoke its **public** `bin/codex.js` launcher via Node (read from the package's `package.json` `bin` entry), letting that launcher own platform/vendor resolution. The `@openai/codex-sdk` is retained for its TypeScript types. Because the launcher spawns the native binary as a grandchild, the app-server child is now spawned `detached` (its own POSIX process group) and torn down with a group-kill, so the native process is reaped immediately on `close()`/`stop()` instead of lingering until its stdin pipe closes - re-validated leak-free against the concurrency and abrupt-stop soak harnesses. ([CYPACK-1288](https://linear.app/ceedar/issue/CYPACK-1288), [#1293](https://github.com/cyrusagents/cyrus/pull/1293))
- Refactored the `cyrus-codex-runner` package from a single ~1580-line `CodexRunner` god class into focused collaborators behind a `CodexBackend` transport strategy: `CodexConfigBuilder` (config/model-fallback resolution), `mcpConfigTranslator` (Cyrus->Codex MCP config), `CodexSkillStager` (managed-skill symlink lifecycle), and `CodexEventMapper` (normalized-event->`SDKMessage` mapping). Both transports - `ExecCodexBackend` (existing `codex exec` path) and the new `AppServerCodexBackend` - emit a backend-neutral `NormalizedCodexEvent` stream so the mapper is transport-agnostic. Behavior is unchanged for the default exec path (all existing tests green). ([CYPACK-1288](https://linear.app/ceedar/issue/CYPACK-1288), [#1293](https://github.com/cyrusagents/cyrus/pull/1293))

### Fixed
- App-server Codex sessions no longer wrongly defer (and silently drop) a fast follow-up that arrives during the session startup window. Previously `isStreaming()` only returned true once a turn was active, but the turn becomes active several seconds in (after config build / `codex login status` / process spawn / `thread/start`), so a quick second Slack message hit "I'm still working... I'll pick up your new message once I'm done" and was never picked up. Now the runner reports streaming for the whole running window, buffers follow-ups that arrive before the turn is steerable, and flushes them via `turn/steer` once the server emits `turn/started` (steering before that is rejected with "no active turn"). Validated end-to-end against the real binary (a gap follow-up is incorporated into the turn). ([CYPACK-1288](https://linear.app/ceedar/issue/CYPACK-1288), [#1293](https://github.com/cyrusagents/cyrus/pull/1293))

### Added
- Per-thread Codex sandbox via the app-server. A `resolveCodexSandbox` unit maps Cyrus sandbox intent to a transport-neutral `ResolvedCodexSandbox` union (`workspace-mode` for the default coarse mode, or a granular `profile`); `AppServerCodexBackend` serializes it - the mode arm via `thread/start.sandbox` + `config.sandbox_workspace_write`, the profile arm via `thread/start.permissions` (the profile id) + `config.permissions.<id>` (the profile body). `RunnerConfigBuilder` plumbs the egress sandbox's filesystem posture (worktree-write, allowed-dirs-read, home denied by omission) into `CodexRunnerConfig.sandboxSettings` for Codex, mirroring Claude. Sandbox logic was consolidated out of `CodexConfigBuilder`/the backend into the single `resolveCodexSandbox` owner; `ResolvedCodexConfig.additionalDirectories` was folded into the sandbox's writable roots. Enforcement (allowed write succeeds, outside write + home read blocked) was confirmed end-to-end through `CodexRunner`. Implementation note: Codex 0.128 (`#19449`) removed the inline `SandboxPolicy.readOnlyAccess`/`readableRoots` mechanism an earlier iteration used and replaced it with named permission profiles. The profile is a flattened `filesystem` map of path -> `read`/`write`/`deny`, keyed by absolute paths or special tokens (`:minimal` = platform defaults - the anti-shell-starvation escape hatch, `:workspace_roots` = worktree, `:tmpdir`, `:slash_tmp`); `permissions` and `sandbox` are mutually exclusive on `thread/start`/`thread/resume`. ([CYPACK-1288](https://linear.app/ceedar/issue/CYPACK-1288), [#1293](https://github.com/cyrusagents/cyrus/pull/1293))
- App-server backend feature parity with exec: `additionalDirectories` (multi-repo sub-worktrees) now map to `config.sandbox_workspace_write.writable_roots` on thread/start (the app-server has no `--add-dir` flag); `outputSchema` is passed on turn/start for structured output; and MCP servers configured via `config.mcp_servers` were confirmed to load and dispatch tool calls under app-server (validated end-to-end against the real binary; `mcp_tool_call` results/errors map through to normalized items). Codex's own ARC safety monitor may still gate external MCP calls on synthetic servers - that is runtime model behavior, not an integration defect. ([CYPACK-1288](https://linear.app/ceedar/issue/CYPACK-1288), [#1293](https://github.com/cyrusagents/cyrus/pull/1293))
- App-server backend robustness hardening: per-request control-plane timeouts in the JSON-RPC client (default 60s - a wedged app-server now rejects pending requests instead of hanging the session); a turn idle-watchdog that fails an in-flight turn after prolonged silence (default 5min, configurable/disable-able); and resilient mid-turn comment dispatch in EdgeWorker - if a steer-only backend rejects a message (turn ended in the race window), the comment now falls back to a fresh resume turn instead of being dropped (no-op for Claude, which never throws there). `thread/resume` across a fresh app-server process was validated end-to-end (context recalled after the process was killed). Concurrency/soak validated against the real binary: N simultaneous runners stay isolated (no cross-talk, distinct threads) and every app-server child process is reaped on both normal completion and abrupt mid-turn `stop()` (zero leaked processes). ([CYPACK-1288](https://linear.app/ceedar/issue/CYPACK-1288), [#1293](https://github.com/cyrusagents/cyrus/pull/1293))
- `AppServerCodexBackend`: drives Codex via the `codex app-server` JSON-RPC protocol (newline-delimited JSON-RPC 2.0 over stdio) with `initialize`->`thread/start`/`thread/resume`->`turn/start` lifecycle, app-server v2 item translation (camelCase->normalized), and `turn/steer` for mid-turn input injection. Includes replay tests built from real `codex app-server` transcripts and an injectable client (`IAppServerClient`) for hermetic backend tests. ([CYPACK-1288](https://linear.app/ceedar/issue/CYPACK-1288), [#1293](https://github.com/cyrusagents/cyrus/pull/1293))
- The `codex exec` backend was removed - Codex now runs exclusively through the app-server. The `ExecCodexBackend`, the `CodexRunnerConfig.useAppServer` field, the `EdgeWorkerConfig.codexUseAppServer` flag (+ its ConfigManager merge/change-detection wiring and the two EdgeWorker injection sites), and the `CODEX_USE_APP_SERVER` env gate are all gone. `CodexRunner.supportsStreamingInput` is now a constant `true`. This also fixes the bug where `codexUseAppServer` was dropped in `WorkerService`'s hand-built `EdgeWorkerConfig` (so the flag never reached self-hosted runs) - there is no flag to drop anymore. ([CYPACK-1288](https://linear.app/ceedar/issue/CYPACK-1288), [#1293](https://github.com/cyrusagents/cyrus/pull/1293))

### Security
- Bumped the Gemini runner test/dev dependency on `@google/gemini-cli-core` to `0.46.0` and added a narrow `@grpc/grpc-js >=1.14.4` override because the latest stable owning package still resolves the vulnerable transitive. Removed the now-redundant `shell-quote` override. ([CYPACK-1311](https://linear.app/ceedar/issue/CYPACK-1311), [#1314](https://github.com/cyrusagents/cyrus/pull/1314))

## [0.2.63] - 2026-06-09

### Fixed
- Fixed two CI failures introduced by CYPACK-1298: (1) `DEBUG_CLAUDE_AGENT_SDK=1` leaked from `process.env` into non-debug sessions — `ClaudeRunner` now explicitly clears the key when not in debug mode; (2) `packages/edge-worker` chat-session test asserted `Glob` in `allowedTools` after `Glob` was removed from the SDK tool registry. ([CYPACK-1301](https://linear.app/ceedar/issue/CYPACK-1301), [#1304](https://github.com/cyrusagents/cyrus/pull/1304))

### Changed
- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.159` to `0.3.170` and `@anthropic-ai/sdk` from `^0.100.1` to `^0.102.0`. Refreshed the tool allowance lists in `packages/claude-runner/src/config.ts` and `packages/core/src/allowed-tools-defaults.ts` to match Claude Code SDK v2.1.170: removed `Glob`, `Grep`, and `LSP` (no longer in the SDK tool registry), added `RemoteTrigger` to `config.ts` and `RemoteTrigger`/`Workflow` to the default allowed-tool lists. Added `fable` (`claude-fable-5`) as a recognized Claude model alias in `RunnerSelectionService.ts` with fallback chain `fable → opus → sonnet`. See [SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md). ([CYPACK-1298](https://linear.app/ceedar/issue/CYPACK-1298), [#1302](https://github.com/cyrusagents/cyrus/pull/1302))

### Security
- Bumped `vitest` (and `@vitest/ui`, `@vitest/coverage-v8`) from `3.x` to `^4.1.0` across all packages to patch the critical advisory [GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp) (arbitrary file read/exec via the Vitest UI server; vulnerable `<4.1.0`). Migrated test mocks to satisfy Vitest 4's `new`-based mock construction (constructor mocks must use `function`/`class`, not arrows) and disabled biome's `useArrowFunction` rule for test files so the autofix can't revert them. Supersedes Dependabot PR #1279. ([CYPACK-1278](https://linear.app/ceedar/issue/CYPACK-1278), [#1285](https://github.com/cyrusagents/cyrus/pull/1285))
- Bumped `@google/gemini-cli-core` from `0.17.0` to `0.45.3` in the Gemini runner test/dev dependency graph and added a narrow `shell-quote >=1.8.4` override because the owning package's latest release still resolved the vulnerable transitive. This patches [GHSA-w7jw-789q-3m8p](https://github.com/advisories/GHSA-w7jw-789q-3m8p) so `pnpm audit` stays clean. ([CYPACK-1302](https://linear.app/ceedar/issue/CYPACK-1302), [#1306](https://github.com/cyrusagents/cyrus/pull/1306))

## [0.2.62] - 2026-06-02

_No internal-only changes._

## [0.2.61] - 2026-06-01

_No internal-only changes._

## [0.2.60] - 2026-05-28

_No internal-only changes._

## [0.2.59] - 2026-05-28

_No internal-only changes._

## [0.2.58] - 2026-05-26

### Added
- **F1: `terminate-issue` command** — F1 can now drive a Linear issue to a terminal state (`completed` / `canceled` / `deleted`) via `apps/f1/f1 terminate-issue --issue-id <id> --action <completed|canceled|deleted>`. The new `CLIIssueTrackerService.terminateIssue` method updates the in-memory state (or removes the issue for `deleted`) and emits an `IssueStateChangeMessage` on the unified message bus via `CLIEventTransport.emitMessage`, so EdgeWorker's terminal-state cleanup path (stop sessions, run `cyrus-teardown.sh`, remove worktrees) is exercised end-to-end in CLI mode. EdgeWorker's CLI setup now subscribes to the transport's `"message"` event in addition to `"event"`. Unblocks F1 testing of the per-repo `cyrus-teardown.sh` feature shipped in [CYPACK-1219](https://linear.app/ceedar/issue/CYPACK-1219), and any future terminal-state behavior. ([CYPACK-1219](https://linear.app/ceedar/issue/CYPACK-1219), [#1233](https://github.com/cyrusagents/cyrus/pull/1233))

## [0.2.57] - 2026-05-22

_No internal-only changes._

## [0.2.55] - 2026-05-22

### Changed
- Documented the path-bearing `EdgeWorkerConfig` field gotcha in `CLAUDE.md`: top-level path fields like `slackMcpConfigs` / `linearMcpConfigs` / `githubMcpConfigs` are read directly off `this.config.<field>` and bypass the per-repo resolution loop, so they must be normalized in `EdgeWorker.normalizeConfigPaths()` (called from the constructor and on `configChanged`). ([#1242](https://github.com/cyrusagents/cyrus/pull/1242))

## [0.2.54] - 2026-05-22

_No internal-only changes._

## [0.2.53] - 2026-05-22

_No internal-only changes._

## [0.2.52] - 2026-05-13

_No internal-only changes._

## [0.2.50] - 2026-04-30

### Added
- Added `push` event support to `GitHubEventTransport` (new `GitHubPushPayload`, `GitHubPushCommit` types, `GitHubCommentWebhookEvent` narrowing type). Push events are emitted without action filtering. Updated `extractComment*` utility functions and `GitHubMessageTranslator` to use `GitHubCommentWebhookEvent` instead of `GitHubWebhookEvent` for type safety. Added `getSessionsByBaseBranch(branchName, repositoryId)` query to `AgentSessionManager`. Added `handleGitHubPushWebhook` to `EdgeWorker` — extracts branch from `refs/heads/*`, finds repo config, looks up active sessions, streams XML rebase notification via `addStreamMessage`. ([CYPACK-978](https://linear.app/ceedar/issue/CYPACK-978), [#1004](https://github.com/ceedaragents/cyrus/pull/1004))
- Added blocked-by dependency deferral to `EdgeWorker`: `checkBlockedByDependencies` fetches issue relations via `fetchBlockingIssues` and filters to unresolved blockers. Blocked sessions are parked in a `parkedSessions` Map (keyed by issue ID). Added `isIssueStateChangeWebhook` type guard to cyrus-core for detecting `stateId` changes in `updatedFrom`. Added `handleIssueStateChange` handler — when blocking issues complete, removes them from parked sessions and replays `initializeAgentRunner`. Added `handleParkedSessionReprompt` (Branch 1.5 in prompted handler) for re-checking blockers on user re-prompt. Added `postThoughtActivity` to `ActivityPoster`. 12 new tests (5 for `getSessionsByBaseBranch`, 7 for `isIssueStateChangeWebhook`). ([CYPACK-978](https://linear.app/ceedar/issue/CYPACK-978), [#1004](https://github.com/ceedaragents/cyrus/pull/1004))

### Changed
- Documented dependency security policy in `CLAUDE.md`: prefer direct-dep bumps in the owning package; only use root `pnpm.overrides` when a direct-dep bump cannot reach the vulnerable transitive; remove overrides when a future bump makes them redundant. ([CYPACK-1101](https://linear.app/ceedar/issue/CYPACK-1101), [#1128](https://github.com/ceedaragents/cyrus/pull/1128))
- Improved `ClaudeRunner` diagnostics when `CYRUS_LOG_LEVEL=DEBUG`: the child subprocess now receives `DEBUG_CLAUDE_AGENT_SDK=1` so the Claude Agent SDK's own debug output (including `--debug-to-stderr`) is forwarded, and the full `query()` options are logged as JSON before dispatch. Non-serializable members (AbortController, async iterables, callbacks) are replaced with diagnostic placeholders so the output is valid JSON. ([CYPACK-1124](https://linear.app/ceedar/issue/CYPACK-1124), [#1153](https://github.com/cyrusagents/cyrus/pull/1153))

### Fixed
- De-flaked `packages/edge-worker/test/EgressProxy.test.ts`. The `Math.random()`-based port allocation in `beforeEach` collided on CI (EADDRINUSE on `127.0.0.1:19281`); tests now bind to port `0` and read the OS-assigned port via `proxy.getHttpProxyPort()` / `proxy.getSocksProxyPort()`. In `EgressProxy.startHttpProxy` / `startSocksProxy`, the stored port is updated to the bound `server.address().port`. Also fixed a `socket.write(reply); socket.destroy()` race in the SOCKS5 handler where the async write could be truncated before the denial reply reached the client — replaced with `socket.end(reply)` so the reply is flushed before FIN. ([CYPACK-1122](https://linear.app/ceedar/issue/CYPACK-1122), [#1147](https://github.com/ceedaragents/cyrus/pull/1147))

## [0.2.49] - 2026-04-22

_No internal-only changes._

## [0.2.48] - 2026-04-20

_No internal-only changes._

## [0.2.47] - 2026-04-20

### Changed
- Stopped deleting workspace-level issue trackers and activity sinks when removing repositories — they are keyed by workspace ID and may be needed by other repos in the same workspace or by repos about to be added in the same `configChanged` cycle. They are naturally replaced when workspace tokens are updated. ([CYPACK-1089](https://linear.app/ceedar/issue/CYPACK-1089), [#1120](https://github.com/ceedaragents/cyrus/pull/1120))

### Fixed
- Fixed typos in `packages/CLAUDE.md` webhook-constraints documentation (`additonal`, `repsoitory`, `agentSesion`, `intitialized`). ([CYPACK-1098](https://linear.app/ceedar/issue/CYPACK-1098), [#1126](https://github.com/ceedaragents/cyrus/pull/1126))

## [0.2.46] - 2026-04-16

### Fixed
- Fixed config reload ordering in `EdgeWorker.configChanged` handler — `updateLinearWorkspaceTokens()` now runs before `addNewRepositories()` so new repositories can look up their Linear workspace token during initialization. Previously, tokens were updated after repo addition, causing failures when both a new workspace and its first repository arrived in the same config change. ([CYPACK-1089](https://linear.app/ceedar/issue/CYPACK-1089), [#1112](https://github.com/ceedaragents/cyrus/pull/1112))

### Changed
- Removed `config: EdgeWorkerConfig` dependency from `PromptBuilder` — it was only used to check `handlers?.createWorkspace` for the working directory placeholder. Working directory is now passed explicitly via `workspaceRepoPaths` parameter through `buildIssueContextPrompt` → `buildIssueContextForPromptAssembly` → `buildNewSessionPrompt`. ([CYPACK-1088](https://linear.app/ceedar/issue/CYPACK-1088), [#1110](https://github.com/ceedaragents/cyrus/pull/1110))

## [0.2.45] - 2026-04-15

### Added
- Added `DEFAULT_REPOS_DIR` constant to `cyrus-core` and `getDefaultReposDir()` utility functions (in `apps/cli` and `packages/config-updater`) mirroring the existing `CYRUS_WORKTREES_DIR` / `getDefaultWorktreesDir()` pattern. Replaced all hardcoded `join(cyrusHome, "repos")` calls in `Application.ts`, `SelfAddRepoCommand.ts`, `repository.ts` handler, and `f1/server.ts`. ([CYPACK-1081](https://linear.app/ceedar/issue/CYPACK-1081), [#1104](https://github.com/ceedaragents/cyrus/pull/1104))
- Added `resolveClaudeCodeExecutablePath()` to `ClaudeRunner` — uses `createRequire(import.meta.url)` + `require.resolve()` to locate the SDK's `cli.js` in pnpm's `.pnpm` symlinked layout, bypassing the SDK's broken `import.meta.url` resolution. Ported from unmerged `cypack-762` branch (`42abcf22`). ([CYPACK-1066](https://linear.app/ceedar/issue/CYPACK-1066))
- Added `pathToClaudeCodeExecutable` option to `ClaudeRunnerConfig` in `types.ts`. ([CYPACK-1066](https://linear.app/ceedar/issue/CYPACK-1066))
- Added `TRUSTED_DOMAINS` constant (~200 domains) in `packages/core/src/trusted-domains.ts` matching Claude Code on the web's default allowlist. Added `preset: "trusted"` field to `NetworkPolicySchema`. `EgressProxy.parsePolicy()` expands the preset into `allow` rules, merging any explicit custom rules on top. ([CYPACK-1066](https://linear.app/ceedar/issue/CYPACK-1066))
- Added `WebhookIpValidator` utility to `cyrus-core` (`packages/core/src/security/`) with CIDR matching, known provider IP lists for Linear/GitHub/GitLab, and GitHub `/meta` API refresh support. Each event transport (`LinearEventTransport`, `GitHubEventTransport`, `GitLabEventTransport`) now accepts an optional `ipAllowlist` config and rejects requests from unauthorized IPs with HTTP 403 in signature/direct verification mode. Enabled `trustProxy` on Fastify server for correct `request.ip` behind reverse proxies. ([CYPACK-1056](https://linear.app/ceedar/issue/CYPACK-1056), [#1094](https://github.com/ceedaragents/cyrus/pull/1094))

### Changed
- PR/MR and changelog-update skills now diff changelog entries against the base branch (not the last commit) to detect existing entries added by the current branch. Prevents duplicate entries and ensures existing entries are updated in-place. ([CYPACK-1063](https://linear.app/ceedar/issue/CYPACK-1063), [#1091](https://github.com/ceedaragents/cyrus/pull/1091))
- Replaced `TodoWrite` with granular Task tools (`TaskCreate`, `TaskUpdate`, `TaskGet`, `TaskList`) across all tool allowance lists, prompt templates, and tests. Tool count updated from 30 to 33. Removed `TodoWrite` from `writeTools` (task management is now read-only). Updated system prompt extensions, builder/debugger/scoper prompts, and prompt-template.md to reference Task tools. ([CYPACK-1067](https://linear.app/ceedar/issue/CYPACK-1067), [#1096](https://github.com/ceedaragents/cyrus/pull/1096))
- Removed GitLab-specific changes (IP allowlist for `GitLabEventTransport`, default bot username changes) from tool allowance PR scope. ([CYPACK-1067](https://linear.app/ceedar/issue/CYPACK-1067), [#1096](https://github.com/ceedaragents/cyrus/pull/1096))
- Auth credentials (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`) are forwarded from `process.env` to the SDK child process, with `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` set to prevent leakage to Bash subprocesses. Only `PATH` + auth tokens are forwarded from `process.env`; repo `.env` vars and `additionalEnv` are merged separately. ([CYPACK-1066](https://linear.app/ceedar/issue/CYPACK-1066))

## [0.2.44] - 2026-04-10

### Fixed
- `buildAgentContextBlock()` now always emits `<agent_context>` with default bot usernames (`cyrusagent`) instead of returning empty string when `GITHUB_BOT_USERNAME`/`GITLAB_BOT_USERNAME` env vars are unset. Updated `verify-and-ship` skill to also include an explicit fallback instruction. ([CYPACK-1054](https://linear.app/ceedar/issue/CYPACK-1054), [#1082](https://github.com/ceedaragents/cyrus/pull/1082))

## [0.2.43] - 2026-04-08

### Changed
- Introduced `ChatRepositoryProvider` interface and `LiveChatRepositoryProvider` implementation to decouple `SlackChatAdapter` and `ChatSessionHandler` from frozen boot-time repository snapshots. Both now read live repository state on demand at session-build time via the provider abstraction. Removed `chatRepositoryPaths`, `repository`, and `linearWorkspaceId` from `ChatSessionHandlerDeps` in favor of a single `chatRepositoryProvider` field. ([CYPACK-1051](https://linear.app/ceedar/issue/CYPACK-1051), [#1078](https://github.com/ceedaragents/cyrus/pull/1078))

## [0.2.42] - 2026-04-06

### Fixed
- Fixed bundled skills not being included in published npm package. ([CYPACK-1046](https://linear.app/ceedar/issue/CYPACK-1046), [#1073](https://github.com/ceedaragents/cyrus/pull/1073))

## [0.2.41] - 2026-04-06

### Changed
- Replaced rigid procedure-based agent session architecture with skills-based approach. Procedures (ProcedureAnalyzer, subroutine sequencing, validation loop) removed in favor of SKILL.md files delivered via Claude Agent SDK plugin (`cyrus-skills-plugin`). Added `plugins` field to `AgentRunnerConfig`, `ClaudeRunnerConfig`, and `IssueRunnerConfigInput`; wired through `ClaudeRunner` to SDK `query()` options. Added Stop hook to `RunnerConfigBuilder` with `stop_hook_active` guard to ensure PRs/summaries are created before session ends. Simplified `AgentSessionManager` by removing procedure completion routing and validation loop logic. Re-exported `SdkPluginConfig` from `claude-runner`. Removed ~7000 lines of procedure/validation/subroutine code. ([CYPACK-996](https://linear.app/ceedar/issue/CYPACK-996), [#1018](https://github.com/ceedaragents/cyrus/pull/1018))
- Extracted `SkillsPluginResolver` from `EdgeWorker` (SRP refactor). Skills plugin resolution, user plugin manifest auto-scaffolding, and `buildSkillsGuidance()` now live in a dedicated module instead of being inline in the 5400-line EdgeWorker. Removed stale `postProcedureSelectionThought` mocks from 7 test files and updated procedure-referencing comments across source and docs. ([CYPACK-996](https://linear.app/ceedar/issue/CYPACK-996), [#1018](https://github.com/ceedaragents/cyrus/pull/1018))

## [0.2.40] - 2026-04-02

### Changed
- Removed `EdgeWorker.buildMcpConfig()` private wrapper — `RunnerConfigBuilder` and `McpConfigService` now handle all MCP config assembly. Chat sessions (`ChatSessionHandler`) pass `linearWorkspaceId` instead of a pre-built `mcpConfig` object, so `RunnerConfigBuilder.buildChatConfig()` calls `mcpConfigProvider.buildMcpConfig()` fresh per session (same pattern as `buildIssueConfig`). ([CYPACK-1029](https://linear.app/ceedar/issue/CYPACK-1029), [#1063](https://github.com/ceedaragents/cyrus/pull/1063))

## [0.2.39] - 2026-03-31

_No internal changes._

## [0.2.38] - 2026-03-25

### Added
- Created `cyrus-gitlab-event-transport` package mirroring `cyrus-github-event-transport`: `GitLabEventTransport` (webhook endpoint with proxy/signature verification), `GitLabCommentService` (post MR notes, discussion replies, award emoji), `GitLabMessageTranslator` (translate GitLab events to `InternalMessage`), and `gitlab-webhook-utils` (payload extractors). ([#857](https://github.com/ceedaragents/cyrus/issues/857), [#1029](https://github.com/ceedaragents/cyrus/pull/1029))
- Added `GitLabPlatformRef`, `GitLabSessionStartPlatformData`, `GitLabUserPromptPlatformData` types to `cyrus-core` messages. Updated `MessageSource` to include `"gitlab"`. Added type guards `isGitLabMessage`, `hasGitLabSessionStartPlatformData`, `hasGitLabUserPromptPlatformData`. ([#857](https://github.com/ceedaragents/cyrus/issues/857), [#1029](https://github.com/ceedaragents/cyrus/pull/1029))
- Added `gitlabUrl` optional field to `RepositoryConfigSchema` and all JSON schemas. ([#857](https://github.com/ceedaragents/cyrus/issues/857), [#1029](https://github.com/ceedaragents/cyrus/pull/1029))
- Added `glab-mr.md` and `changelog-update-gitlab.md` subroutines mirroring `gh-pr.md` and `changelog-update.md` with `glab` CLI commands. ([#857](https://github.com/ceedaragents/cyrus/issues/857), [#1029](https://github.com/ceedaragents/cyrus/pull/1029))
- Added `applyPlatformSubroutines()` to procedure registry for platform-aware subroutine substitution (swaps `gh-pr` → `glab-mr` and `changelog-update` → `changelog-update-gitlab` for GitLab repos). ([#857](https://github.com/ceedaragents/cyrus/issues/857), [#1029](https://github.com/ceedaragents/cyrus/pull/1029))
- Added `handleCheckGlab` handler to config-updater for checking `glab` CLI installation and authentication. ([#857](https://github.com/ceedaragents/cyrus/issues/857), [#1029](https://github.com/ceedaragents/cyrus/pull/1029))
- Added `registerGitLabEventTransport()`, `handleGitLabWebhook()`, `buildGitLabSystemPrompt()`, `buildGitLabChangeRequestSystemPrompt()`, `postGitLabReply()`, `findRepositoryByGitLabUrl()`, `createGitLabWorkspace()` to EdgeWorker. ([#857](https://github.com/ceedaragents/cyrus/issues/857), [#1029](https://github.com/ceedaragents/cyrus/pull/1029))
- Updated `PromptBuilder.generateRoutingContext()` to include `gitlabUrl` in repo identifiers and XML template. ([#857](https://github.com/ceedaragents/cyrus/issues/857), [#1029](https://github.com/ceedaragents/cyrus/pull/1029))
- Updated `RepositoryRouter` to match `gitlabUrl` in description-tag routing and select signal options. ([#857](https://github.com/ceedaragents/cyrus/issues/857), [#1029](https://github.com/ceedaragents/cyrus/pull/1029))
- Updated `SelfAddRepoCommand` to detect GitLab URLs and set `gitlabUrl` field. ([#857](https://github.com/ceedaragents/cyrus/issues/857), [#1029](https://github.com/ceedaragents/cyrus/pull/1029))
- Created `cyrus-setup-gitlab` skill and updated main setup orchestrator to include GitLab as a surface option. ([#857](https://github.com/ceedaragents/cyrus/issues/857), [#1029](https://github.com/ceedaragents/cyrus/pull/1029))
- Created `docs/GIT_GITLAB.md` documentation. ([#857](https://github.com/ceedaragents/cyrus/issues/857), [#1029](https://github.com/ceedaragents/cyrus/pull/1029))

## [0.2.37] - 2026-03-18

### Added
- Wired user-configured MCP support into Slack chat sessions. `RunnerConfigBuilder.buildChatConfig()` extracts `mcp__*` tool entries from the repository's `allowedTools` config and passes them to `buildChatAllowedTools()`, which merges them with read-only tools and built-in MCP prefixes. `mcpConfigPath` is derived from the repository reference following the `buildIssueConfig()` pattern. `EdgeWorker.registerSlackEventTransport()` passes the first repo to `ChatSessionHandler`, which forwards it to `RunnerConfigBuilder`. ([CYPACK-982](https://linear.app/ceedar/issue/CYPACK-982), [#1006](https://github.com/ceedaragents/cyrus/pull/1006))

### Changed
- Extracted `McpConfigService`, `ToolPermissionResolver`, and `RunnerConfigBuilder` from `EdgeWorker` and `ChatSessionHandler` in `packages/edge-worker`. `McpConfigService` owns MCP server config assembly and cyrus-tools context lifecycle. `ToolPermissionResolver` provides unified tool permission calculation for both issue and chat sessions (fully decoupled from `RunnerSelectionService`). `RunnerConfigBuilder` eliminates duplication between `EdgeWorker.buildAgentRunnerConfig()` and `ChatSessionHandler.buildRunnerConfig()` with `buildIssueConfig()` and `buildChatConfig()` factory methods, depending on focused interfaces (`IChatToolResolver`, `IMcpConfigProvider`, `IRunnerSelector`) instead of concrete classes. `RunnerSelectionService` trimmed to pure runner/model selection (SRP). `ChatSessionHandler` deps simplified to accept `RunnerConfigBuilder` injection. No behavioral changes. ([CYPACK-976](https://linear.app/ceedar/issue/CYPACK-976), [#1003](https://github.com/ceedaragents/cyrus/pull/1003))

## [0.2.36] - 2026-03-17

### Added
- Added `IssueStateChangeMessage` type and `isIssueStateChangeWebhook()` type guard to core types for detecting Linear issue state transitions to `completed` or `canceled`. Added `translateIssueStateChange()` to `LinearMessageTranslator` (checked before title/description updates for priority). Added `GitService.deleteWorktree()` with `findWorktreesUnderPath()` and `isGitWorktree()` helpers supporting both single-repo and multi-repo worktree layouts. Added `handleIssueStateChangeMessage()` to `EdgeWorker` that stops active sessions and deletes worktrees. Added `isIssueStateChangeWebhook` to legacy webhook router (returns early, handled via message bus). 9 new unit tests (4 translator, 5 GitService). ([CYPACK-961](https://linear.app/ceedar/issue/CYPACK-961), [#982](https://github.com/ceedaragents/cyrus/pull/982))
- Added `IssueDeletedWebhook` type and `isIssueDeletedWebhook()` type guard for `Issue/remove` webhooks. Added `translateIssueDeleted()` to `LinearMessageTranslator` that reuses `IssueStateChangeMessage` with `isTerminal: true`. Added early return in EdgeWorker legacy webhook handler for deleted issues. 2 new translator tests. ([CYPACK-961](https://linear.app/ceedar/issue/CYPACK-961), [#982](https://github.com/ceedaragents/cyrus/pull/982))
- `handleIssueStateChangeMessage` now posts a response activity to each stopped session's Linear thread before deleting worktrees, giving users visibility into why the session ended. ([CYPACK-961](https://linear.app/ceedar/issue/CYPACK-961), [#982](https://github.com/ceedaragents/cyrus/pull/982))
- Added `AgentSessionManager.removeSession()` to immediately clean up all session tracking state (sessions, entries, activity sinks, tasks, status activities, stop requests). Called in `handleIssueStateChangeMessage` after posting response activities to prevent stale sessions from being resumed with deleted worktrees. ([CYPACK-961](https://linear.app/ceedar/issue/CYPACK-961), [#982](https://github.com/ceedaragents/cyrus/pull/982))

### Changed
- Made `GitService.workspaceBaseDir` dynamic: replaced the cached string field with a getter that re-reads `CYRUS_WORKTREES_DIR` on every access. Stored `cyrusHome` instead of the resolved path. Updated `Application` to pass `{ cyrusHome }` options object instead of a pre-resolved string. ([CYPACK-961](https://linear.app/ceedar/issue/CYPACK-961), [#982](https://github.com/ceedaragents/cyrus/pull/982))
- Moved `workspaceBaseDir` from a per-call parameter on `GitService.deleteWorktree()` to a constructor-level dependency on `GitService`. Removed repo lookup shim from `handleIssueStateChangeMessage()` — worktree deletion is now keyed solely by the Linear issue identifier from the webhook message. ([CYPACK-961](https://linear.app/ceedar/issue/CYPACK-961), [#982](https://github.com/ceedaragents/cyrus/pull/982))
- Added "Cyrus interaction tip" section to `gh-pr.md` subroutine instructing Claude to include a blockquote tip in PR bodies about bot mentions and "changes requested" reviews. Bot username uses `{{github_bot_username}}` template variable resolved from `GITHUB_BOT_USERNAME` env var (fallback: `cyrusagent`) in `PromptBuilder.loadSubroutinePrompt()`. Added `includeCoAuthoredBy: false` to project `.claude/settings.json` and wrote `.claude/settings.local.json` with the same setting to workspace directories in `EdgeWorker.createCyrusAgentSession()` (loaded via SDK `settingSources: ["local"]`). Updated `docs/GIT_GITHUB.md` to remove co-authored-by references. ([CYPACK-974](https://linear.app/ceedar/issue/CYPACK-974), [#1001](https://github.com/ceedaragents/cyrus/pull/1001))

### Fixed
- Added pnpm overrides to resolve all 36 Dependabot security alerts: bumped `@modelcontextprotocol/sdk` to `>=1.26.0`, `qs` to `>=6.14.2`, added new overrides for `hono>=4.12.7`, `@hono/node-server>=1.19.10`, `rollup>=4.59.0`, `flatted>=3.4.0`, `minimatch>=3.1.4` (with path-specific overrides for `test-exclude`, `nodemon`, `glob` to `>=10.2.3`), `simple-git>=3.32.3`, `undici>=7.24.0`, `ajv>=8.18.0`, `diff>=8.0.3`, `@tootallnate/once>=3.0.1`, `@isaacs/brace-expansion>=5.0.1`. ([CYPACK-973](https://linear.app/ceedar/issue/CYPACK-973), [#1000](https://github.com/ceedaragents/cyrus/pull/1000))
- Fixed worktree not being recreated after terminal state cleanup. The `git worktree list` existence check used substring matching (`includes()`), causing `/path/CYSV-56` to falsely match stale entry `/path/CYSV-56/cyrus`. Changed to exact line-by-line path matching. Added stale worktree validation — if a path is listed in git but has no valid `.git` file on disk, prunes the stale entry and recreates the worktree. Fixed `git worktree remove` in `deleteWorktree()` failing with "not a git repository" by deriving the main repo path from the worktree's `.git` file and passing it as `cwd`. Added post-deletion `git worktree prune` for parent repositories. ([CYPACK-961](https://linear.app/ceedar/issue/CYPACK-961), [#982](https://github.com/ceedaragents/cyrus/pull/982))
- Rewrote `CONTRIBUTING.md` — fixed wrong project name (was "Linear Claude Agent"), wrong license (said MIT, is Apache 2.0), wrong test framework (said Jest, uses Vitest), wrong package manager commands (`npm` → `pnpm`), wrong issue tracker (said GitHub issues, uses Linear), reference to non-existent `.env.example`, and wrong code style guidance (said JSDoc, uses TypeScript). Added monorepo structure, prerequisites, changelog requirements, Biome/Husky tooling, and common commands. ([CYPACK-972](https://linear.app/ceedar/issue/CYPACK-972), [#999](https://github.com/ceedaragents/cyrus/pull/999))
- Registered `-l`/`--label` option with Commander for `self-add-repo` command (was documented but never registered, causing `error: unknown option '-l'`). Fixed idle mode messaging to show `cyrus self-add-repo` guidance for self-hosted users (detected via `LINEAR_CLIENT_ID`) instead of cloud URL. Updated `self-auth` error messages to point to `~/.cyrus/.env` instead of `.zshrc`. Made `self-add-repo` URL argument optional so the interactive prompt ("Repository URL: ") is reachable — `cyrus self-add-repo` with no args now prompts for everything. ([CYPACK-967](https://linear.app/ceedar/issue/CYPACK-967), [#991](https://github.com/ceedaragents/cyrus/pull/991))

## [0.2.35] - 2026-03-16

### Changed
- Renamed `createLinearAgentSession` to `createCyrusAgentSession` and `updateAgentSessionWithClaudeSessionId` to `updateAgentSessionWithRunnerSessionId` in `packages/edge-worker`. Both names were leaky abstractions — the methods are runner-agnostic and handle multiple platforms/runners. ([CYPACK-969](https://linear.app/ceedar/issue/CYPACK-969), [#994](https://github.com/ceedaragents/cyrus/pull/994))
- Threaded `workspaceId` from `webhook.organizationId` (Linear-native source) through EdgeWorker webhook-driven paths, replacing `requireLinearWorkspaceId(repo)` calls. Reduced usage from 45 to 25 calls; remaining calls are only in config/setup paths where repo config is the rightful source. Added optional `workspaceId` to `PromptAssemblyInput`. ([CYPACK-966](https://linear.app/ceedar/issue/CYPACK-966), [#990](https://github.com/ceedaragents/cyrus/pull/990))
- Moved `refreshPromise` from closure variable to instance property in `LinearIssueTrackerService` and clear it in `setAccessToken()` to fix stale token refresh bug. Added `getClient()` method to expose the underlying `LinearClient`. Changed `createCyrusToolsServer()` signature to accept `LinearClient` instead of raw token string, ensuring MCP tools reuse the same client with OAuth refresh interceptor. Updated `EdgeWorker` to pass `LinearClient` from `issueTracker.getClient()` to MCP tool server. Added `-l`/`--label` flag to `SelfAddRepoCommand` for custom routing labels with repo-name default. Based on [grandmore/Cyrus-selfhost#2](https://github.com/grandmore/Cyrus-selfhost/pull/2). ([CYPACK-963](https://linear.app/ceedar/issue/CYPACK-963), [#986](https://github.com/ceedaragents/cyrus/pull/986))

### Fixed
- `LinearEventTransport.handleDirectWebhook()` now uses `request.rawBody` (the original request bytes stashed by `SharedApplicationServer`) for HMAC signature verification instead of `Buffer.from(JSON.stringify(request.body))`. `JSON.stringify` does not guarantee the same byte sequence as the original request, causing intermittent signature failures. Falls back to `JSON.stringify` when `rawBody` is unavailable.
- Bumped `file-type` from 18.7.0 to 21.3.2 ([#983](https://github.com/ceedaragents/cyrus/pull/983))

### Added
- `SelfAuthCommand` now starts a Cloudflare tunnel after OAuth authentication completes, so webhooks can reach the local agent immediately. ([#952](https://github.com/ceedaragents/cyrus/pull/952))

## [0.2.34] - 2026-03-13

### Fixed
- Reworked `handleIssueContentUpdate()` in `EdgeWorker.ts` to be streaming-only: issue update events are now ONLY delivered to currently running sessions via `addStreamMessage()`. Idle sessions are no longer resumed. If the runner doesn't support streaming input, the event is silently ignored. Added webhook deduplication using `createdAt:issueId` composite key with bounded `processedIssueUpdateKeys` set (auto-prunes at 500 entries). Added DEBUG-level logging that traces the webhook key and changed fields for each delivery. Replaced 5 tests with 7 tests in `EdgeWorker.issue-update-multiple-sessions.test.ts`. ([CYPACK-954](https://linear.app/ceedar/issue/CYPACK-954), [#977](https://github.com/ceedaragents/cyrus/pull/977))

### Added
- Added JSON Schema export pipeline for config schemas (`EdgeConfigSchema`, `RepositoryConfigSchema`, etc.) via `pnpm generate:json-schema` in cyrus-core. Generates JSON Schema files in `packages/core/schemas/` using Zod v4's native `.toJSONSchema()`. Includes 16 sync/structure tests, `tsx` devDependency, and a pre-commit hook that blocks commits when `config-schemas.ts` changes without regenerating schemas. ([CYPACK-935](https://linear.app/ceedar/issue/CYPACK-935), [#973](https://github.com/ceedaragents/cyrus/pull/973))

## [0.2.33] - 2026-03-10

### Fixed
- ClaudeRunner now infers `type: "http"` for file-loaded MCP server configs that have a `url` but no `type` discriminator. The Claude Agent SDK requires an explicit `type` field — without it, sessions crash with 0 messages. Codex/Gemini runners are unaffected because they do property-based translation. ([#966](https://github.com/ceedaragents/cyrus/pull/966))

### Changed
- Replaced placeholder `testMcp` handler with actual MCP SDK integration: stdio spawns via `StdioClientTransport`, HTTP/SSE connects via `StreamableHTTPClientTransport`, both perform `tools/list` and return discovered tools. Added `@modelcontextprotocol/sdk` dependency to config-updater and `NodeNext` module resolution. ([#966](https://github.com/ceedaragents/cyrus/pull/966))
- Refactored MCP test handler: fixed `withTimeout` timer leak by clearing setTimeout on settlement, extracted `connectAndDiscover()` to eliminate duplicated connect/list/respond logic, avoided mutating `payload.commandArgs` by copying before sort, added 5s timeout to `client.close()` to prevent zombie stdio processes. ([#966](https://github.com/ceedaragents/cyrus/pull/966))
- MCP config files moved to `~/.cyrus/mcp-configs/` subdirectory; config-updater routes consolidated under `/api/update/` prefix. ([#966](https://github.com/ceedaragents/cyrus/pull/966))
- Restored tab indentation in all package.json files.

## [0.2.32] - 2026-03-10

### Changed
- **Consolidated parent-child session mapping to single source of truth** - Removed redundant `EdgeWorker.childToParentAgentSession` map. `GlobalSessionRegistry` is now the sole owner of parent-child session mappings, eliminating the dual-write obligation that caused the orchestrator result-writing regression. Serialization format (`childToParentAgentSession` key) preserved for backward compatibility. ([CYPACK-922](https://linear.app/ceedar/issue/CYPACK-922), [#957](https://github.com/ceedaragents/cyrus/pull/957))
- Moved `linearToken`, `linearRefreshToken`, and `linearWorkspaceSlug` from per-repository/global config into the `linearWorkspaces` map keyed by Linear workspace ID. `EdgeWorker.issueTrackers` now creates one `IIssueTrackerService` per workspace instead of per repository, eliminating redundant Linear clients. Removed `getIssueTrackerForRepository` wrappers from `EdgeWorker` and `ActivityPoster` — callers now use workspace ID directly. `AttachmentService` accepts workspace ID and resolves tokens internally. Includes idempotent config migration, workspace-level OAuth refresh, and updated CLI commands. ([CYPACK-912](https://linear.app/ceedar/issue/CYPACK-912), [#959](https://github.com/ceedaragents/cyrus/pull/959))
- Updated all `PromptBuilder` methods (`determineSystemPromptFromLabels`, `buildLabelBasedPrompt`, `buildIssueContextPrompt`, `determineBaseBranch`, `hasGraphiteLabel`) to accept `RepositoryConfig[]` instead of a single repository. Multi-repo prompts include per-repo XML sections (`<repositories><repository name="...">`) replacing single-repo `<git_context>`/`<context>` blocks. `determineBaseBranch` returns `Map<string, string>` for per-repo base branches. Label prompt conflict resolution uses first-match-wins with logged warnings. ([CYPACK-919](https://linear.app/ceedar/issue/CYPACK-919), [#964](https://github.com/ceedaragents/cyrus/pull/964))
- Updated `buildAllowedTools()` to compute union across `RepositoryConfig[]` (presets resolved per-repo, then unioned) and `buildDisallowedTools()` to compute intersection (only block if ALL repos block). `buildMcpConfig()` now accepts `RepositoryConfig[]` with workspace-level MCP servers (Linear, cyrus-tools, Slack) configured once per session. Added `buildMergedMcpConfigPath()` to concatenate per-repo `.mcp.json` paths. ([CYPACK-918](https://linear.app/ceedar/issue/CYPACK-918), [#963](https://github.com/ceedaragents/cyrus/pull/963))
- Updated `issueRepositoryCache` from `Map<issueId, string>` to `Map<issueId, string[]>` for multi-repo session support. Routing now returns `RepositoryConfig[]` instead of a single repository. Description tag parsing supports multiple `[repo=...]` tags, label-based routing returns all matching repos, and no-match cases return `needs_selection` instead of a default fallback. Includes cache serialization migration from `Record<string, string>` to `Record<string, string[]>`. ([CYPACK-915](https://linear.app/ceedar/issue/CYPACK-915), [#961](https://github.com/ceedaragents/cyrus/pull/961))

### Added
- GitHub @ mention webhooks on PRs attached to multi-repo Linear issues now resolve the correct sub-worktree for the repository where the mention was triggered. Added `getActiveMultiRepoSessionForRepository()` to `AgentSessionManager` and updated `handleGitHubWebhook()` in `EdgeWorker` to use existing multi-repo workspace paths instead of creating new workspaces. Falls back to root workspace with warning if no sub-worktree is found; single-repo sessions are unchanged. ([CYPACK-920](https://linear.app/ceedar/issue/CYPACK-920), [#965](https://github.com/ceedaragents/cyrus/pull/965))
- `GitService.createGitWorktree()` now accepts `RepositoryConfig[]` and creates the correct folder layout for 0, 1, or N repositories. Added Graphite blocked-by base branch resolution (`determineBaseBranch`, `hasGraphiteLabel`, `fetchBlockingIssues`) directly into `GitService` so worktrees start from the correct base branch without agents needing to rebase. Extended `Workspace` type with `repoPaths` for multi-repo path mapping. ([CYPACK-917](https://linear.app/ceedar/issue/CYPACK-917), [#962](https://github.com/ceedaragents/cyrus/pull/962))
- Added `RepositoryContext` type and `repositories: RepositoryContext[]` field to `CyrusAgentSession`. Each session now explicitly carries its repository context (repositoryId, branchName, baseBranchName). Old sessions without `repositories` default to `[]` on deserialization. ([CYPACK-914](https://linear.app/ceedar/issue/CYPACK-914), [#960](https://github.com/ceedaragents/cyrus/pull/960))
- Consolidated `AgentSessionManager` from a per-repository `Map<string, AgentSessionManager>` to a single instance in `EdgeWorker`. Activity sink resolution moved from constructor-level to per-session via `setActivitySink()`. Serialization format flattened from nested `{[repoId]: {[sessionId]: session}}` to `{[sessionId]: session}` with persistence version bumped 3.0 → 4.0 (backward-compatible migration). ([CYPACK-911](https://linear.app/ceedar/issue/CYPACK-911), [#955](https://github.com/ceedaragents/cyrus/pull/955))

## [0.2.31] - 2026-03-09

### Fixed
- Tests now use `mkdtempSync` for unique per-run temp directories (gemini-runner, cursor-runner, edge-worker), avoiding EACCES on shared `/tmp` and preventing simultaneous test runs from different worktrees from competing for the same folders.
- Added proper handling for `rate_limit_event` messages from Claude runners in `AgentSessionManager` with tiered logging (warn/info/debug by status), and silenced all unhandled informational message types (`rate_limit_event`, `stream_event`, `tool_progress`, `auth_status`, `tool_use_summary`, `prompt_suggestion`) in `ClaudeRunner.processMessage`. ([CYPACK-895](https://linear.app/ceedar/issue/CYPACK-895), [#946](https://github.com/ceedaragents/cyrus/pull/946))

## [0.2.30] - 2026-03-05

### Fixed
- Chat sessions now receive read-only repository path access and explicit `git pull` instructions in their system prompt, with generalized routing context for multi-workspace repositories. ([CYPACK-891](https://linear.app/ceedar/issue/CYPACK-891), [#942](https://github.com/ceedaragents/cyrus/pull/942))

## [0.2.29] - 2026-03-05

### Changed
- Replaced hardcoded runner instantiation in `ChatSessionHandler` with a `createRunner` factory in `ChatSessionHandlerDeps`. Consolidated all runner instantiation in `EdgeWorker` into a single `createRunnerForType` method with exhaustive switch. Resolves model/runner-type mismatch on config hot-reload by moving model resolution into the factory closure. Added `logger` field to `AgentRunnerConfig` to formalize existing usage.
- Extracted `RunnerType` type alias from the Zod `runnerTypeEnum` in `config-schemas.ts` and replaced all hardcoded `"claude" | "gemini" | "codex" | "cursor"` literal unions across `EdgeWorker`, `RunnerSelectionService`, `ProcedureAnalyzer`, and tests.

### Fixed
- `SlackChatAdapter.fetchThreadContext()` no longer filters out the bot's own replies. Follow-up sessions (especially after a runner type change) now retain full conversation history, with the agent's own messages labeled as `"assistant (you)"`.

## [0.2.28] - 2026-03-04

### Added
- Added `resolveVerification()` to `SlackEventTransport` and `GitHubEventTransport` that checks `SLACK_SIGNING_SECRET`/`GITHUB_WEBHOOK_SECRET` env vars (plus `CYRUS_HOST_EXTERNAL`) at request time instead of only at initialization. When started in proxy mode and the relevant env vars are added at runtime, the transport dynamically switches to direct/signature HMAC-SHA256 verification. Both transports now use the same dual-gate (`secret` + `CYRUS_HOST_EXTERNAL`) pattern. Follows the CYPACK-842 pattern of resolving from `process.env` at usage time. Handler methods (`handleDirectWebhook`, `handleProxyWebhook`, `handleSignatureWebhook`) now accept a `secret` parameter from the resolved config. Updated `EdgeWorker.registerGitHubEventTransport()` startup logic to also require `CYRUS_HOST_EXTERNAL` for consistency with Slack. Added "runtime mode switching" test suites to both transport packages. ([CYPACK-884](https://linear.app/ceedar/issue/CYPACK-884), [#934](https://github.com/ceedaragents/cyrus/pull/934))

## [0.2.27] - 2026-03-04

### Added
- Added `getSlackBotToken()` helper to `SlackChatAdapter` that falls back to `process.env.SLACK_BOT_TOKEN` when the event's `slackBotToken` is undefined. Applied across all 4 token-consuming methods (`fetchThreadContext`, `postReply`, `acknowledgeReceipt`, `notifyBusy`). Added explanatory comment in `SlackEventTransport.processAndEmitEvent()` noting the downstream fallback. ([CYPACK-842](https://linear.app/ceedar/issue/CYPACK-842), [#896](https://github.com/ceedaragents/cyrus/pull/896))
- Added `pull_request_review` event type support to `cyrus-github-event-transport`: new `GitHubReview` and `GitHubPullRequestReviewPayload` types, `isPullRequestReviewPayload` type guard, updated `isPullRequestReviewCommentPayload` to disambiguate via `!("review" in payload)`, extended all extractor functions (`extractCommentBody`, `extractCommentAuthor`, `extractCommentId`, `extractCommentUrl`, `extractPRBranchRef`, `extractPRNumber`, `extractPRTitle`, `isCommentOnPullRequest`), and added `translatePullRequestReview`/`translatePullRequestReviewAsUserPrompt` to `GitHubMessageTranslator`. Extended `GitHubEventType` union and `GitHubWebhookEvent.payload` union. Updated `GitHubSessionStartPlatformData` and `GitHubUserPromptPlatformData` `eventType` fields in `cyrus-core`. Added `buildGitHubChangeRequestSystemPrompt` to EdgeWorker with two branches: non-empty review body shows reviewer feedback, empty review body instructs agent to use `gh api` to read PR review comments. Added acknowledgement comment posting via `postIssueComment` before starting agent session. Added defensive `changes_requested` state check. ([CYPACK-842](https://linear.app/ceedar/issue/CYPACK-842), [#896](https://github.com/ceedaragents/cyrus/pull/896))

## [0.2.25] - 2026-02-27

### Fixed
- `RunnerSelectionService` held a stale config reference after `configChanged` hot-reload events. Added `setConfig()` method to `RunnerSelectionService` and wired it into the EdgeWorker's `configChanged` handler alongside `ConfigManager.setConfig()`. Additionally, `ConfigManager.handleConfigChange()` returned early when only global config fields changed (no repository diffs), so `configChanged` was never emitted for changes like `defaultRunner` edits. Added `detectGlobalConfigChanges()` to compare key global fields and emit `configChanged` even when repositories are unchanged. ([#907](https://github.com/ceedaragents/cyrus/pull/907))
- `ProcedureAnalyzer` is now reconstructed when `defaultRunner` changes via hot-reload, since its internal `SimpleRunner` is baked in at construction time. Added debug logging to `resolveDefaultSimpleRunnerType()`. ([#907](https://github.com/ceedaragents/cyrus/pull/907))
- `getDefaultReasoningEffortForModel()` regex `/gpt-5[a-z0-9.-]*codex$/i` only matched `gpt-5.3-codex` etc., not plain `gpt-5` used by ProcedureAnalyzer. Codex CLI defaulted to `xhigh` reasoning effort which `gpt-5` rejects (`unsupported_value`), causing `NoResponseError` during classification. Fixed regex to `/^gpt-5/i`. ([#907](https://github.com/ceedaragents/cyrus/pull/907))
- Added `outputSchema` support to `CodexRunnerConfig` and `CodexRunner.runTurn()`, threaded through to `thread.runStreamed()`. `SimpleCodexRunner` now passes a JSON Schema constraining classification to valid enum values, and `extractResponse()` parses the structured JSON (`{"classification":"code"}`) before falling back to plain text cleaning. ([#907](https://github.com/ceedaragents/cyrus/pull/907))

## [0.2.24] - 2026-02-26

### Fixed
- Added fallback recovery to 4 EdgeWorker webhook handlers (`handleUserPromptedAgentActivity` Branch 3, `handleStopSignal`, `handleIssueUnassignedWebhook`, `handleIssueContentUpdate`) that previously returned silently when `issueRepositoryCache` or session mappings were missing after restart/migration. Prompted webhook now performs 3-tier fallback: search all managers → re-route via `RepositoryRouter.determineRepositoryForWebhook` → post error activity. Stop signal now posts acknowledgment activity via any available manager. Unassignment and issue update handlers now search all `agentSessionManagers` for sessions matching the issue. Warnings downgraded to `info` for expected recovery cases, `warn` reserved for true failures. Added 8 tests in `EdgeWorker.missing-session-recovery.test.ts`. ([CYPACK-852](https://linear.app/ceedar/issue/CYPACK-852), [#905](https://github.com/ceedaragents/cyrus/pull/905))

## [0.2.23] - 2026-02-25

### Fixed
- `WorkerService.ts` was not passing `defaultRunner`, `linearWorkspaceSlug`, `issueUpdateTrigger`, or `promptDefaults` from `edgeConfig` to the `EdgeWorkerConfig` object, causing `EdgeWorker` and `RunnerSelectionService` to always see `undefined` for these fields. Also added `defaultRunner` and `promptDefaults` to `ConfigManager.loadConfigSafely()` merge so config file changes are reflected on hot-reload. Added `CYRUS_DEFAULT_RUNNER` env var support. Added 4 integration tests for `defaultRunner` config in runner selection. ([CYPACK-838](https://linear.app/ceedar/issue/CYPACK-838), [#892](https://github.com/ceedaragents/cyrus/pull/892))

### Added
- Added `gitHubUserId` and `url` to the `User` Pick type in `packages/core/src/issue-tracker/types.ts`, enabling access to Linear users' linked GitHub accounts and profile URLs. Added `resolveGitHubUsername()` method to `PromptBuilder` that resolves numeric GitHub user IDs to usernames via the public GitHub REST API (`GET /user/{id}`). Integrated GitHub username resolution into both `buildLabelBasedPrompt()` and `buildIssueContextPrompt()` flows. Updated `standard-issue-assigned-user-prompt.md` and `label-prompt-template.md` templates to include `<assignee>` context with `<linear_display_name>`, `<linear_profile_url>`, `<github_username>`, `<github_user_id>`, and `<github_noreply_email>` fields—tag names clarify metadata source (Linear vs GitHub). Updated `gh-pr.md` subroutine to instruct agents to add "Assignee: @username" at the top of PR descriptions (GitHub notification), with a fallback to "Assignee: [Display Name](linear_profile_url)" for users without linked GitHub accounts (audit trail). Added `assigneeGitHubUsername` field to `PromptAssemblyInput` type. ([CYPACK-843](https://linear.app/ceedar/issue/CYPACK-843), [#895](https://github.com/ceedaragents/cyrus/pull/895))
- Updated `gh-pr.md` subroutine with optional "Deploy Preview" section at the tail end, referencing any available skill whose "use me when" description refers to creating deploy previews for a branch. This allows agents to optionally set up preview environments to test PRs before merging, using generic language for flexibility and robustness to skill availability changes. ([CYPACK-846](https://linear.app/ceedar/issue/CYPACK-846), [#898](https://github.com/ceedaragents/cyrus/pull/898))

## [0.2.22] - 2026-02-20

### Added
- Added `slack-mcp-server` as a conditional default MCP server in `EdgeWorker.buildMcpConfig()`, gated on the `SLACK_BOT_TOKEN` environment variable. When present, the server is configured via stdio transport (`npx slack-mcp-server@latest --transport stdio`) with the token passed as `SLACK_MCP_XOXB_TOKEN`. `RunnerSelectionService.buildAllowedTools()` conditionally includes `mcp__slack` in the default MCP tools list. Slack MCP is excluded from GitHub sessions via `excludeSlackMcp` option in `buildMcpConfig`/`buildAgentRunnerConfig` and filtered from allowed tools in `handleGitHubWebhook`. ([CYPACK-832](https://linear.app/ceedar/issue/CYPACK-832), [#884](https://github.com/ceedaragents/cyrus/pull/884))
- Added `SimpleCodexRunner` and `SimpleCursorRunner` implementations for constrained-response queries (ProcedureAnalyzer classification). Both follow the same `SimpleAgentRunner<T>` abstract pattern as Claude and Gemini. Added `defaultRunner` field to `EdgeConfigSchema` (flows through to config update endpoint automatically). `RunnerSelectionService.getDefaultRunner()` implements priority: explicit config > single-API-key auto-detect > "claude" fallback. `ProcedureAnalyzer` now supports all 4 runner types with runner-specific default models. Pinned zod to 4.3.6 via pnpm overrides to eliminate dual-version type incompatibility that blocked cross-package type resolution. Deleted obsolete `codex-runner-shim.d.ts`. Changed `SDKMessage` imports in `simple-agent-runner` from `@anthropic-ai/claude-agent-sdk` to `cyrus-core` to avoid cross-package type conflicts. ([CYPACK-826](https://linear.app/ceedar/issue/CYPACK-826), [#878](https://github.com/ceedaragents/cyrus/pull/878))

### Changed
- Moved GPT Image and Sora video generation tools from `cyrus-claude-runner` to `cyrus-mcp-tools`, integrating them into the `cyrus-tools` MCP server via `registerImageTools()`/`registerSoraTools()`. Converted from `@anthropic-ai/claude-agent-sdk` `tool()`/`createSdkMcpServer()` pattern to `@modelcontextprotocol/sdk` `server.registerTool()` pattern. API key now sourced from `process.env.OPENAI_API_KEY` instead of `repository.openaiApiKey` config. Removed `openaiApiKey` and `openaiOutputDirectory` from `RepositoryConfigSchema`. Removed `openai` dependency from `cyrus-claude-runner`, added to `cyrus-mcp-tools`. Removed separate `image-tools` and `sora-tools` MCP server creation from EdgeWorker's `buildMcpConfig()`. ([CYPACK-831](https://linear.app/ceedar/issue/CYPACK-831), [#883](https://github.com/ceedaragents/cyrus/pull/883))
- Updated `@anthropic-ai/claude-agent-sdk` to v0.2.47 and `@anthropic-ai/sdk` to v0.77.0. Added `speed` field to `BetaUsage` objects in codex-runner and gemini-runner, added type annotations for `ContentBlock` filters in claude-runner to resolve TypeScript inference issues with updated SDK types. ([CYPACK-827](https://linear.app/ceedar/issue/CYPACK-827), [#880](https://github.com/ceedaragents/cyrus/pull/880))
- `SlackEventTransport.getSlackBotToken()` now reads `SLACK_BOT_TOKEN` exclusively from `process.env` with no header fallback. The `X-Slack-Bot-Token` request header is no longer used. ([CYPACK-824](https://linear.app/ceedar/issue/CYPACK-824), [#876](https://github.com/ceedaragents/cyrus/pull/876))
- Refactored `EdgeWorker.ts` by extracting 5 service modules: `ActivityPoster` (Linear activity posting), `AttachmentService` (attachment download/manifests), `ConfigManager` (config file watching/reload/change detection), `PromptBuilder` (prompt assembly/system prompts/issue context), and `RunnerSelectionService` (runner/model selection/tool configuration). Reduced EdgeWorker from 7,687 to 5,466 lines (29% reduction) while maintaining full test coverage (522 tests). ([CYPACK-822](https://linear.app/ceedar/issue/CYPACK-822), [#874](https://github.com/ceedaragents/cyrus/pull/874))
- Merged `main` into `cypack-807` branch, resolving 7 merge conflicts and fixing auto-merge issues across AgentSessionManager, EdgeWorker, GitService, ProcedureAnalyzer, gemini-runner, and changelogs. Updated 2 test files from `IIssueTrackerService` to `IActivitySink` interface. ([CYPACK-821](https://linear.app/ceedar/issue/CYPACK-821), [#873](https://github.com/ceedaragents/cyrus/pull/873))
- Decoupled Slack webhook handler from `RepositoryConfig`: introduced `NoopActivitySink` for non-repository sessions, dedicated `slackSessionManager` on `EdgeWorker`, and `slackThreadSessions` map for thread-based session reuse. `createSlackWorkspace` now creates plain directories under `~/.cyrus/slack-workspaces/` instead of git worktrees. Runner config is built inline (bypassing `buildAgentRunnerConfig` which requires a repository). Added `SlackReactionService` to `cyrus-slack-event-transport` package. ([CYPACK-815](https://linear.app/ceedar/issue/CYPACK-815), [#868](https://github.com/ceedaragents/cyrus/pull/868))
- Refactored logging across all packages to use a dedicated `ILogger` interface and `Logger` implementation in `packages/core/src/logging/`. Replaced direct `console.log`/`console.error` calls in EdgeWorker, AgentSessionManager, ClaudeRunner, GitService, RepositoryRouter, SharedApplicationServer, SharedWebhookServer, WorktreeIncludeService, ProcedureAnalyzer, AskUserQuestionHandler, LinearEventTransport, and LinearIssueTrackerService with structured logger calls. Log level is configurable via the `CYRUS_LOG_LEVEL` environment variable (DEBUG, INFO, WARN, ERROR, SILENT).
- Added source context (session ID, platform, issue identifier, repository) to log messages via `logger.withContext()`, enabling easier debugging and log filtering across concurrent sessions
- Updated `CyrusAgentSession` schema to v3.0: renamed `linearAgentActivitySessionId` to `id`, added optional `externalSessionId` for tracker-specific IDs, added optional `issueContext` object for issue metadata, made `issue` and `issueId` optional to support standalone sessions ([CYPACK-728](https://linear.app/ceedar/issue/CYPACK-728), [#770](https://github.com/ceedaragents/cyrus/pull/770))
- Updated `PersistenceManager` to v3.0 format with automatic migration from v2.0, preserving all existing session data during migration ([CYPACK-728](https://linear.app/ceedar/issue/CYPACK-728), [#770](https://github.com/ceedaragents/cyrus/pull/770))
- GitHub webhook handling now uses forwarded installation tokens: `GitHubEventTransport` extracts `X-GitHub-Installation-Token` header from CYHOST webhooks and includes it in emitted events, `EdgeWorker.postGitHubReply()` and `EdgeWorker.fetchPRBranchRef()` prefer the forwarded token over `process.env.GITHUB_TOKEN`, enabling self-hosted Cyrus instances to post PR comment replies and fetch PR branch details using short-lived (1-hour) GitHub App installation tokens ([CYPACK-773](https://linear.app/ceedar/issue/CYPACK-773), [#821](https://github.com/ceedaragents/cyrus/pull/821), [CYPACK-774](https://linear.app/ceedar/issue/CYPACK-774), [#822](https://github.com/ceedaragents/cyrus/pull/822))

### Added
- New `cyrus-slack-event-transport` package: EventEmitter-based transport for receiving and verifying forwarded Slack webhooks from CYHOST, with proxy (Bearer token) verification mode. Includes `SlackMessageTranslator` for translating `app_mention` events into unified `SessionStartMessage` and `UserPromptMessage` types, thread-aware session key generation (`channel:thread_ts`), `@mention` stripping, and Slack Bot token forwarding via `X-Slack-Bot-Token` header. Added `SlackSessionStartPlatformData`, `SlackUserPromptPlatformData`, and corresponding type guards to `cyrus-core`. ([CYPACK-807](https://linear.app/ceedar/issue/CYPACK-807), [#861](https://github.com/ceedaragents/cyrus/pull/861))
- New `cyrus-github-event-transport` package: EventEmitter-based transport for receiving and verifying forwarded GitHub webhooks, with proxy (Bearer token) and signature (HMAC-SHA256) verification modes, a `GitHubCommentService` for posting replies via GitHub REST API, and utility functions for extracting webhook payload data. ([CYPACK-772](https://linear.app/ceedar/issue/CYPACK-772), [#820](https://github.com/ceedaragents/cyrus/pull/820))
- EdgeWorker GitHub webhook integration: `/github-webhook` endpoint, session creation flow for PR comments, git worktree checkout for PR branches, and reply posting via GitHub API. ([CYPACK-772](https://linear.app/ceedar/issue/CYPACK-772), [#820](https://github.com/ceedaragents/cyrus/pull/820))
- Subroutine result text is now stored in procedure history when advancing between subroutines. On error results (e.g. `error_max_turns` from single-turn subroutines), `AgentSessionManager` recovers by using the last completed subroutine's result via `ProcedureAnalyzer.getLastSubroutineResult()`, allowing the procedure to continue to completion instead of failing
- Created `GlobalSessionRegistry` class for centralized session storage across all repositories, enabling cross-repository session lookups in orchestrator workflows ([CYPACK-725](https://linear.app/ceedar/issue/CYPACK-725), [#766](https://github.com/ceedaragents/cyrus/pull/766))
- Extracted `IActivitySink` interface and `LinearActivitySink` implementation to decouple activity posting from `IIssueTrackerService`, enabling multiple activity sinks to receive session activities ([CYPACK-726](https://linear.app/ceedar/issue/CYPACK-726), [#767](https://github.com/ceedaragents/cyrus/pull/767))
- Integrated `GlobalSessionRegistry` with `EdgeWorker`, making it the single source of truth for parent-child session mappings and cross-repository session lookups ([CYPACK-727](https://linear.app/ceedar/issue/CYPACK-727), [#769](https://github.com/ceedaragents/cyrus/pull/769))
- Added Cursor harness `[agent=cursor]`, including offline F1 drives for stop/tool activity, resume continuation, and permission synchronization behavior. Also added project-level Cursor CLI permissions mapping from Cyrus tool permissions (including subroutine-time updates), pre-run MCP server enablement (`agent mcp list` + `agent mcp enable <server>`), switched the default Codex runner model to `gpt-5.3-codex`, and aligned edge-worker Vitest module resolution to use local `cyrus-claude-runner` sources during tests. ([CYPACK-804](https://linear.app/ceedar/issue/CYPACK-804), [#858](https://github.com/ceedaragents/cyrus/pull/858))
- Added Fastify MCP transport for `cyrus-tools` on the shared application server endpoint, replacing inline SDK-only wiring with HTTP MCP configuration and per-session context headers, and now enforcing `Authorization: Bearer <CYRUS_API_KEY>` on `/mcp/cyrus-tools` requests. Also fixed Codex MCP server config mapping so `headers` are translated to Codex `http_headers` (while preserving `http_headers`, `env_http_headers`, and `bearer_token_env_var`) for authenticated HTTP MCP initialization. Includes F1 validation covering `initialize` and `tools/list` on `/mcp/cyrus-tools`. ([CYPACK-817](https://linear.app/ceedar/issue/CYPACK-817), [#870](https://github.com/ceedaragents/cyrus/pull/870))

### Fixed
- Updated orchestrator system prompts to explicitly require `state: "To Do"` when creating issues via `mcp__linear__create_issue`, preventing issues from being created in "Triage" status. ([CYPACK-761](https://linear.app/ceedar/issue/CYPACK-761), [#815](https://github.com/ceedaragents/cyrus/pull/815))

## [0.2.21] - 2026-02-09

### Changed
- Refactored formatting strategy from TodoWrite to Task tools (TaskCreate, TaskUpdate, TaskList, TaskGet). Added `formatTaskParameter()` method to IMessageFormatter interface and updated AgentSessionManager to handle Task tools as thought activities. ([CYPACK-788](https://linear.app/ceedar/issue/CYPACK-788), [#837](https://github.com/ceedaragents/cyrus/pull/837))
- Redesigned TaskCreate formatting for parallel execution (concise `⏳ **subject**` checklist items), improved TaskUpdate/TaskGet to show subject names with status emojis, added ToolSearch formatting (`🔍 Loading`/`🔍 Searching tools`) rendered as non-ephemeral thought in AgentSessionManager, and added TaskOutput formatting (`📤 Waiting for`/`📤 Checking`). Updated both ClaudeMessageFormatter and GeminiMessageFormatter with matching logic. ([CYPACK-795](https://linear.app/ceedar/issue/CYPACK-795), [#846](https://github.com/ceedaragents/cyrus/pull/846))
- Deferred TaskUpdate/TaskGet activity posting from tool_use time to tool_result time to enrich with task subject. Added `taskSubjectsByToolUseId` and `taskSubjectsById` caches to AgentSessionManager for subject resolution from TaskCreate results and TaskGet result parsing. ([CYPACK-797](https://linear.app/ceedar/issue/CYPACK-797), [#847](https://github.com/ceedaragents/cyrus/pull/847))

### Added
- Subroutine result text is now stored in procedure history when advancing between subroutines. On error results (e.g. `error_max_turns` from single-turn subroutines), `AgentSessionManager` recovers by using the last completed subroutine's result via `ProcedureAnalyzer.getLastSubroutineResult()`, allowing the procedure to continue to completion instead of failing. Added `disallowAllTools` parameter to `buildAgentRunnerConfig` and `tools` config pass-through to `ClaudeRunner` for properly disabling built-in tools. ([CYPACK-792](https://linear.app/ceedar/issue/CYPACK-792), [#843](https://github.com/ceedaragents/cyrus/pull/843))

## [0.2.20] - 2026-02-05

(No internal changes in this release)

## [0.2.19] - 2026-01-24

### Fixed
- Fixed labelPrompts schema to accept both simple array form (`{ debugger: ["Bug"] }`) and complex object form (`{ debugger: { labels: ["Bug"], allowedTools?: ... } }`). This resolves type mismatches when cyrus-hosted sends simplified configurations. ([#802](https://github.com/ceedaragents/cyrus/pull/802))

## [0.2.18] - 2026-01-23

### Changed
- Replaced manual TypeScript interfaces with Zod schemas as the source of truth for `EdgeConfig`, `RepositoryConfig`, and related configuration types. This ensures type safety at both compile-time and runtime, and fixes type drift where `CyrusConfigPayload` was missing fields like `issueUpdateTrigger`. ([#800](https://github.com/ceedaragents/cyrus/pull/800))

## [0.2.17] - 2026-01-23

(No internal changes in this release)

## [0.2.16] - 2026-01-23

(No internal changes in this release)

## [0.2.15] - 2026-01-16

(No internal changes in this release)

## [0.2.14] - 2026-01-16

(No internal changes in this release)

## [0.2.13] - 2026-01-15

(No internal changes in this release)

## [0.2.12] - 2026-01-09

(No internal changes in this release)

## [0.2.11] - 2026-01-07

(No internal changes in this release)

## [0.2.10] - 2026-01-06

(No internal changes in this release)

## [0.2.9] - 2025-12-30

(No internal changes in this release)

## [0.2.8] - 2025-12-28

(No internal changes in this release)

## [0.2.7] - 2025-12-28

### Changed
- Moved publishing docs from CLAUDE.md to `/release` skill for cleaner documentation and easier invocation ([CYPACK-667](https://linear.app/ceedar/issue/CYPACK-667), [#705](https://github.com/ceedaragents/cyrus/pull/705))

## [0.2.6] - 2025-12-22

### Fixed
- Fixed the CLI issue tracker's `labels()` method to return actual label data instead of an empty array, enabling correct runner selection (Codex/Gemini) in F1 tests ([CYPACK-547](https://linear.app/ceedar/issue/CYPACK-547), [#624](https://github.com/ceedaragents/cyrus/pull/624))
