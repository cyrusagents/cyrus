# Development gotchas

Hard-won rules that cause silent breakage when skipped. Load when touching
config schema, sandbox/permissions, MCP tools, SDK upgrades, or routing prompts.

## Sandbox egress proxy and CA certificates

When sandbox is enabled, the egress proxy generates a CA cert at
`~/.cyrus/certs/cyrus-egress-ca.pem` for TLS interception. Per-session env vars
are set in `RunnerConfigBuilder.buildSandboxConfig()`:

- `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`, `SSL_CERT_FILE`,
  `REQUESTS_CA_BUNDLE` / `PIP_CERT`, `CURL_CA_BUNDLE`, `CARGO_HTTP_CAINFO`,
  `AWS_CA_BUNDLE`, `DENO_CERT`

**`systemWideCert` config flag:** When `sandbox.systemWideCert: true` is set in
`config.json`, those per-session CA env vars are skipped — the OS cert store
handles trust. Trust the CA system-wide first:

- macOS: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/.cyrus/certs/cyrus-egress-ca.pem`
- Linux: `sudo cp ~/.cyrus/certs/cyrus-egress-ca.pem /usr/local/share/ca-certificates/cyrus-egress-ca.crt && sudo update-ca-certificates`

**Tools that ignore env vars** (need system keychain trust regardless of
`systemWideCert`): Bun, .NET/nuget, curl on macOS (SecureTransport).

**Parent process env gotcha:** If `GIT_SSL_CAINFO`, `SSL_CERT_FILE`, or
`CURL_CA_BUNDLE` are set in the Cyrus parent process env, they can break git
push/fetch from Cyrus itself (parent does not route through the egress proxy).
Do not set these in `~/.cyrus/.env`.

Pre-existing host `NODE_EXTRA_CA_CERTS` are merged via
`EgressProxy.buildCACertBundle()`.

## Two permission systems: tool vs sandbox

Claude Code security has two independent layers; both must be correct.

### A. Tool permissions (`allowedTools` / `disallowedTools`)

- Enforced by Claude Code's permission layer — **not** OS-level.
- `Read(~/**)` does **not** work as a `disallowedTools` pattern — `~` is never
  expanded, so the pattern matches nothing.
- `disallowedTools` is an instant deny that takes precedence over
  `allowedTools`.
- Absolute paths in tool patterns need a **double leading slash**:
  `Read(//Users/alice/.ssh/**)`. Implemented as `/${fullPath}` where `fullPath`
  is already absolute.
- Solution: `buildHomeDirectoryDisallowedTools(cwd, allowedDirectories)` in
  `packages/claude-runner/src/home-directory-restrictions.ts` enumerates home
  siblings with double-slash absolute paths and excludes `allowedDirectories`.

### B. Sandbox filesystem permissions

- Enforced at the **OS level** (bubblewrap / macOS sandbox).
- Deny+whitelist works: `denyRead: ["~/"]` + `allowRead: ["."]` (`.` = session
  cwd). Configured in `buildSandboxConfig()` in
  `packages/edge-worker/src/RunnerConfigBuilder.ts`.

**Invariant:** With sandbox enabled, both systems should restrict home directory
reads. With sandbox disabled, only tool permissions apply (and they need the
explicit enumeration above).

## Updating `@anthropic-ai/claude-agent-sdk`

After bumping the SDK (bundles a specific Claude Code version), refresh tool
allowance lists:

```bash
./scripts/extract-claude-tools.sh
```

Compare output to `availableTools` in `packages/claude-runner/src/config.ts`.
Also review `readOnlyTools`, `writeTools`, and helpers. Skipping this can cause
sessions to silently miss new tools or reference removed ones.

## Routing behavior and self-describing prompts

When changing repository routing (description-tag syntax, label routing, base
branch overrides, multi-repo), also update the system prompts that describe
routing to Cyrus itself:

- `packages/edge-worker/src/PromptBuilder.ts` — `<repository_routing_context>`
- `packages/edge-worker/src/ActivityPoster.ts` — routing activity display names

(If a chat adapter or other surface documents routing syntax, update it in the
same PR.)

## Adding a new top-level `EdgeWorkerConfig` field

**Current (schema-driven `ConfigManager.reconcile`):** Adding a property to
`EdgeConfigSchema` in `packages/core/src/config-schemas.ts` is enough for
merge + change detection — `reconcile()` walks every schema key and emits
`changedKeys` from a generic diff. No separate merge whitelist / `globalKeys`
array.

Still required:

1. Add the Zod field (and regenerate JSON schemas if this repo exports them).
2. If the field is a **path** (string or path list), register it on
   `pathRegistry` in the same schema so `normalizeConfigPaths` expands `~/`.
3. Wire consumers that should react to the field (builders, runners, etc.).

**The field must also survive the CLI's config→worker hop.**
`WorkerService.startEdgeWorker` (`apps/cli`) builds the `EdgeWorkerConfig` that
`composeEdgeWorker` receives. It spreads `...edgeConfig` and overrides only the
runtime-owned keys — keep it that way. `apps/cli/src/services/WorkerService.test.ts`
enforces it: the fixture must enumerate every `EdgeConfigSchema.shape` key, so a
new field fails the suite until you decide whether the CLI forwards it.

**Historical note:** Pre-reconcile, a hardcoded `loadConfigSafely` whitelist and
`globalKeys` array silently dropped new fields on reload (CYHOST-967). Do not
reintroduce per-field merge lists. It recurred anyway: `WorkerService`'s
hand-written literal left `claudeAutoCompactWindow`, `claudeSessionKeepAliveMinutes`
and `claudeMaxWarmIdleSessions` inert in the shipped CLI, while `apps/f1` set them
directly on its own `EdgeWorkerConfig` and so kept "verifying" a path production
never takes (DEV-139).

## Changing `cyrus-tools` MCP exposed tools

When adding/removing a tool from the inline `cyrus-tools` MCP server
(`cyrus-mcp-tools`, wired in `McpConfigService.buildMcpConfig`):

- Update platform defaults in `packages/core/src/allowed-tools-defaults.ts` if
  the tool should be on by default.
- If the hosted product keeps a UI catalog (`KNOWN_MCP_TOOLS` / 
  `"mcp__cyrus-tools"`), update that catalog in the same change set so
  operators can see and toggle the tool. (Hosted app may live outside this
  monorepo.)

**Symptom:** Tool works at runtime but never appears in hosted settings.

## Adding a path-bearing field to `EdgeWorkerConfig`

cyrus-hosted emits self-host paths with literal `~/` prefixes. Node's
`fs.readFileSync` does **not** expand `~`.

**Current:** Path fields are normalized by `normalizeConfigPaths()` in
`cyrus-core`, driven by a Zod-4 `pathRegistry`. Tag the field at definition
time:

```ts
z.string().register(pathRegistry, { path: true })
// or path-list meta when applicable
```

`ConfigManager.reconcile` and the EdgeWorker constructor both run that walker.
A path field that is **not** registered will keep the literal `~/...` and crash
self-host with `ENOENT`.

## Navigating GitHub source when auth blocks

Use `uuithub.com` instead of `github.com` for unauthenticated source browsing:

```
https://uuithub.com/org/repo/blob/main/src/file.ts
```

## Working with package SDKs

```bash
pnpm install
```

Then inspect the package under `node_modules` for types and implementation.

## Testing Linear MCP (claude-runner)

```bash
cd packages/claude-runner
echo "LINEAR_API_TOKEN=..." > .env
pnpm build
node test-scripts/simple-claude-runner-test.js
```

EdgeWorker configures the official Linear HTTP MCP server per repository using
its Linear token in real sessions.
