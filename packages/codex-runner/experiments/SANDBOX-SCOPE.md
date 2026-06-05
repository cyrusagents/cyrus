# Per-thread Codex sandbox via app-server — Requirements & Plan

Status: **scoped + Phase 0 validated** (codex 0.125.0).

## Phase 0 finding (decisive — changes the chosen mechanism)

Validated against the real binary (`experiments/sandbox-permissionprofile.mjs`):
- The granular **`permissionProfile` (managed, restricted) is NOT usable**: with a
  minimal entries list it has **no platform-defaults escape hatch**, so it starves
  the shell of the system read paths it needs — *every* command failed (`exit=-1`),
  including writes to the explicitly-allowed root.
- The structured **`sandboxPolicy` (workspaceWrite) IS the right mechanism**: with
  `readOnlyAccess.includePlatformDefaults: true` the shell runs, writes to
  `writableRoots` succeed (`ALLOWED_EXIT=0`), and writes outside are blocked
  (`zsh: operation not permitted` / `OUTSIDE_EXIT=1`).

**Chosen mechanism:** structured `sandboxPolicy` on `turn/start` (it persists "for
this turn and subsequent turns", so applying it on each turn = per-thread). This is
the approach PR #1020 used; Phase 0 confirms it. `permissionProfile` is abandoned.
Reads are an allow-list (`readableRoots`), so Cyrus `denyRead` is honored *by
omission* (deny-broad/allow-narrow), which matches Cyrus's posture; sub-path
denies inside an allowed root are not expressible (acceptable).

Default case (no Cyrus sandbox settings) stays on the coarse `thread/start.sandbox`
mode (broad reads) so we don't silently tighten reads for existing sessions.

## 1. Goal

Apply a **specific sandbox policy per app-server thread** (i.e. per Cyrus session)
by mapping Cyrus's existing sandbox settings onto the Codex app-server's
per-thread sandbox controls. Today Codex ignores Cyrus's sandbox model entirely
and hardcodes `workspace-write` + `network_access:true` for every session.

## 2. App-server sandbox surface (verified, 0.125.0)

Per-thread, on `thread/start` (mutually-exclusive options):
- `sandbox`: coarse `SandboxMode` = `read-only | workspace-write | danger-full-access`.
- `config`: free-form overrides (e.g. `sandbox_workspace_write.{writable_roots, network_access}`).
- `permissionProfile`: **granular** override — *"Cannot be combined with `sandbox`."*
  - `{ type:"managed", fileSystem, network }`
  - `fileSystem`: `{ type:"restricted", entries: FileSystemSandboxEntry[], globScanMaxDepth? }` **or** `{ type:"unrestricted" }`
  - `FileSystemSandboxEntry` = `{ path, access }`
    - `access` ∈ `"read" | "write" | "none"`
    - `path` ∈ `{type:"path", path}` | `{type:"glob_pattern", pattern}` | `{type:"special", value}`
  - `network`: `{ enabled: boolean }`  ← **coarse on/off only**
  - (also `{type:"disabled"}` = no outer sandbox, `{type:"external"}`)

Per-turn override on `turn/start`: `sandboxPolicy` (structured `SandboxPolicy`) /
`permissionProfile`, persisting "for this turn and subsequent turns".

**Decision:** use `thread/start.permissionProfile: managed` for the granular
mapping; fall back to `thread/start.sandbox` (mode) for the default case (no
explicit Cyrus sandbox settings), so Codex keeps its sensible built-in defaults
(incl. macOS Seatbelt platform allowances) when we have nothing specific to say.

## 3. Cyrus sandbox model (what we map FROM)

Two distinct layers exist today (Claude/Cursor only):
1. **Filesystem** — `SandboxSettings.filesystem.{allowRead, denyRead, allowWrite}`
   (arrays of path/prefix patterns), assembled in
   `RunnerConfigBuilder.buildSandboxConfig()` and passed as `sandboxSettings`.
   OS-level (bubblewrap / macOS sandbox).
2. **Network** — domain-level `EdgeWorkerConfig.sandbox.networkPolicy` enforced by
   the **egress proxy** (per-session proxy ports + CA cert env vars in the child),
   NOT by the agent sandbox itself.

Codex consumes **neither** today (`CodexRunnerConfig.sandbox` is never set by
EdgeWorker → `CodexConfigBuilder` defaults to `workspace-write`).

## 4. Mapping design

### 4a. Filesystem → `permissionProfile.fileSystem.restricted.entries`
- `allowWrite[p]`  → `{ path: p, access: "write" }`
- `allowRead[p]`   → `{ path: p, access: "read" }`
- `denyRead[p]`    → `{ path: p, access: "none" }`
- Path strings: a glob (`**`, `*`) → `{type:"glob_pattern", pattern}`, otherwise
  `{type:"path", path}` (must be absolute; resolve `~`/`.` first via `resolvePath`
  and the session cwd).
- The cwd worktree + `additionalDirectories` (multi-repo sub-worktrees) get
  `write` entries so the existing writable-roots behavior is preserved.
- **Precedence is the key open question** (see §8): confirm whether `none` reliably
  overrides `read`/`write` and what ordering/specificity Codex applies, then order
  entries so denies win.

### 4b. Network → `permissionProfile.network.enabled` (+ egress proxy)
- `enabled` = "is any outbound network allowed for this session" (true unless the
  session is fully network-denied). The app-server profile cannot express
  domain-level rules.
- Domain-level filtering stays with Cyrus's **egress proxy**: route Codex's
  subprocess traffic through it by adding the proxy env vars + CA bundle to the
  Codex child env (mirrors Claude/Cursor). This is a **secondary** workstream —
  the primary ask is the per-thread *policy*, but network is only coarse without it.

## 5. Architecture (SOLID, consolidated)

Today sandbox logic is smeared across `CodexConfigBuilder.buildConfigOverrides`
(`sandbox_workspace_write.network_access`) and
`AppServerCodexBackend.buildThreadConfig` (`writable_roots`). Consolidate into one
owner.

- **New `CodexSandboxPolicyBuilder`** (single responsibility): given the resolved
  inputs (mode, `sandboxSettings`, cwd, writable roots, network intent), produce a
  transport-neutral discriminated union:
  ```ts
  type ResolvedCodexSandbox =
    | { kind: "mode"; mode: SandboxMode; writableRoots: string[]; networkAccess: boolean }
    | { kind: "profile"; fileSystemEntries: CodexFsEntry[]; networkEnabled: boolean };
  ```
  Returns `mode` when there are no explicit `sandboxSettings`; `profile` when there
  are (granular).
- **`ResolvedCodexConfig`** carries a single `sandbox: ResolvedCodexSandbox`
  (replacing today's `sandbox` string + the `sandbox_workspace_write` bits in
  `configOverrides` + the backend's `additionalDirectories`→`writable_roots`).
- **`AppServerCodexBackend`** just *applies* it to thread/start params — no
  sandbox decisions:
  - `mode` → `{ sandbox: mode, config.sandbox_workspace_write: { writable_roots, network_access } }`
  - `profile` → `{ permissionProfile: { type:"managed", fileSystem:{type:"restricted", entries}, network:{ enabled } } }`
    (and it must NOT also send `sandbox`).
- `CodexConfigBuilder` delegates sandbox resolution to
  `CodexSandboxPolicyBuilder`; its ad-hoc `sandbox_workspace_write` block is
  removed.

This keeps each unit single-purpose: builder decides, backend serializes.

## 6. Plumbing (EdgeWorker → Codex)

`RunnerConfigBuilder.buildSandboxConfig`/`buildIssueConfig` currently attach
`sandboxSettings` (and `egressCaCertPath`) for `runnerType === "claude"` (and
Cursor). Extend to `codex`:
- Add `sandboxSettings?` and `egressCaCertPath?` to `CodexRunnerConfig`.
- In `buildIssueConfig`, pass them through for codex (translate, don't hand the
  Claude-SDK shape to Codex — the `CodexSandboxPolicyBuilder` owns translation).
- Also pass a per-repo `sandbox` mode / `askForApproval` if/when we expose them
  (optional; `ResolvedCodexConfig` already supports mode).
- Chat path (`createRunner` closure) gets the same treatment so Slack/chat Codex
  sessions are sandboxed identically.

## 7. Default behavior (no behavior change unless configured)

- No `sandboxSettings` (today's norm) → `{ kind:"mode", mode:"workspace-write",
  writableRoots: additionalDirectories, networkAccess:true }` — **identical to
  current behavior**.
- `sandboxSettings` present → granular `permissionProfile`.

## 8. Risks / open questions (validate during impl, Phase 0)

1. **Entry precedence**: confirm `access:"none"` overrides `read`/`write` and the
   ordering/specificity rule for overlapping entries (does last win? most-specific?
   does a deny on `~/` + allow on cwd behave like Cyrus's bubblewrap model?).
   Validate against the real binary before trusting the mapping.
2. **`permissionProfile` honored on `thread/start`** at runtime in 0.125.0 (schema
   says yes; verify a thread actually enforces it).
3. **Restricting reads can break workflows** (global tool configs, language
   toolchains resolving outside the worktree). Cyrus's Claude model already deals
   with this via curated `allowRead` defaults — reuse those defaults, don't invent.
4. **macOS platform defaults**: with a fully managed profile, confirm whether
   Codex still applies Seatbelt platform allowances or whether we must include
   them explicitly (the `sandboxPolicy.readOnly` path had `includePlatformDefaults`;
   check the managed profile's equivalent).
5. **Network**: coarse `enabled` only; domain rules need the egress-proxy env
   wiring (separate, larger). Decide whether v1 ships network as on/off + proxy
   env, or defers proxy integration.
6. **`globScanMaxDepth`**: large glob roots can be expensive; set a sane cap.

## 9. Testing

- **Unit** (`CodexSandboxPolicyBuilder`): allow/deny/write → entries; glob vs path
  detection; cwd + additionalDirectories → write entries; mode fallback when no
  settings; mutual-exclusivity (never emit `sandbox` + `permissionProfile`).
- **Backend serialization**: `ResolvedCodexSandbox` → exact thread/start params
  (fake client assertions).
- **Real-binary integration**: a thread with a restrictive profile actually blocks
  a write/read outside the allowed roots (Phase 0 validates precedence).
- **F1**: a Codex session with sandbox settings completes and respects them.

## 10. Phasing

- **Phase 0** — validate precedence + `permissionProfile` enforcement against the
  real binary (small harness, like the other experiments).
- **Phase 1** — `CodexSandboxPolicyBuilder` + `ResolvedCodexSandbox` union +
  backend serialization + consolidate the scattered sandbox logic. Default path
  unchanged (mode), unit + replay tests.
- **Phase 2** — EdgeWorker/RunnerConfigBuilder plumbing of `sandboxSettings` to
  codex (issue + chat paths); granular profile active when settings present.
- **Phase 3** — egress-proxy env wiring for Codex (domain-level network), if in
  scope.
