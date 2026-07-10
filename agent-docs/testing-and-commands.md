# Testing and common commands

## Monorepo commands (repo root)

```bash
pnpm install              # Install all packages
pnpm build                # Build all packages
pnpm lint                 # Biome check
pnpm format               # Biome write
pnpm test                 # Tests (all packages, may be watch depending on package)
pnpm test:packages:run    # Packages only, run once (preferred for CI/ship)
pnpm typecheck            # TypeScript across monorepo
pnpm dev                  # Watch all packages
```

Requires **Node.js >= 22**, **pnpm >= 10**. This is a pnpm monorepo — do not use
npm or yarn. `jq` is required for some claude tooling.

## Package-local

From any package under `packages/*` or `apps/*`:

```bash
pnpm build
pnpm typecheck
pnpm test        # often watch mode
pnpm test:run    # run once
pnpm dev
```

## CLI app (`apps/cli`)

```bash
pnpm start
pnpm dev
pnpm test
# Link local global binary after monorepo build:
pnpm build && pnpm uninstall cyrus-ai -g
cd apps/cli && pnpm install -g . && pnpm link -g .
```

## F1 test framework (`apps/f1`)

```bash
bun run apps/f1/server.ts
./apps/f1/f1 --help
```

Major validation work should use the F1 test-drive protocol (`f1-test-drive`
skill). Nested guidance: `apps/f1/CLAUDE.md`, architecture:
`spec/f1/ARCHITECTURE.md`, traces: `apps/f1/test-drives/`.

## Prompt assembly tests (mandatory style)

When working with prompt assembly tests in
`packages/edge-worker/test/prompt-assembly*.test.ts`:

**Always assert the ENTIRE prompt — never partial `.toContain()` checks.**

- Use `.expectUserPrompt()` with the complete expected prompt string
- Use `.expectSystemPrompt()` with the complete expected system prompt (or
  `undefined`)
- Use `.expectComponents()` for all prompt components
- Use `.expectPromptType()` for the prompt type
- Always call `.verify()`

Partial assertions miss regressions in structure, formatting, and content.

```typescript
// ✅ Full prompt assertion
await scenario(worker)
  .newSession()
  .withUserComment("Test comment")
  .expectUserPrompt(`<user_comment>
  <author>Test User</author>
  <timestamp>2025-01-27T12:00:00Z</timestamp>
  <content>
Test comment
  </content>
</user_comment>`)
  .expectSystemPrompt(undefined)
  .expectPromptType("continuation")
  .expectComponents("user-comment")
  .verify();

// ❌ Too weak
expect(result.userPrompt).toContain("<user_comment>");
```

## Ship gate (before PR)

See `verify-and-ship` skill. Typical sequence:

```bash
pnpm test:packages:run
pnpm typecheck
pnpm lint
# optional: pnpm build
```

Update `CHANGELOG.md` (`## [Unreleased]`) for user-facing changes, or
`CHANGELOG.internal.md` for internal-only work. Include PR link and Linear issue
id. End-user impact only in the public changelog.

## Dependency security

1. Prefer direct-dep bumps in the owning `package.json` (not root) so the patched
   transitive resolves naturally.
2. Use root `pnpm.overrides` only when a direct-dep bump cannot reach the
   vulnerable transitive; document why.
3. Remove overrides that a future bump makes redundant.
4. After any dep change: `pnpm install && pnpm audit` (zero advisories) and
   commit the lockfile with the `package.json` change.
