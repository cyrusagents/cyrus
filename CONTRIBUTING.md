# Contributing to Atmiko

We love your input! We want to make contributing to Atmiko as easy and transparent as possible, whether it's:

- Reporting a bug
- Discussing the current state of the code
- Submitting a fix
- Proposing new features

## Prerequisites

- **Node.js** >= 22
- **pnpm** >= 10 (this is a pnpm monorepo — do not use npm or yarn)

## Development Process

We use GitHub for issue tracking, code hosting and pull requests. We also track issues on an internal Linear workspace.

### Getting Started

1. Fork the repo and create your branch from `main`
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Build all packages:
   ```bash
   pnpm build
   ```
4. Run the tests:
   ```bash
   pnpm test:packages:run
   ```
5. Start development mode (watch all packages):
   ```bash
   pnpm dev
   ```

### Project Structure

Atmiko is a pnpm monorepo with the following layout:

```
atmiko/
├── apps/
│   ├── cli/        # Main CLI application (the `atmiko` npm package)
│   └── f1/         # F1 testing framework for end-to-end test drives
└── packages/
    ├── core/                     # Shared types and session management
    ├── edge-worker/              # Edge worker implementation
    ├── claude-runner/            # Claude CLI execution wrapper
    ├── codex-runner/             # Codex CLI execution wrapper
    ├── cursor-runner/            # Cursor CLI execution wrapper
    ├── gemini-runner/            # Gemini CLI execution wrapper
    ├── simple-agent-runner/      # Simple agent runner
    ├── config-updater/           # Configuration update utilities
    ├── cloudflare-tunnel-client/ # Cloudflare tunnel management
    ├── mcp-tools/                # MCP tool definitions
    ├── linear-event-transport/   # Linear webhook event handling
    ├── github-event-transport/   # GitHub event handling
    └── slack-event-transport/    # Slack event handling
```

## Pull Requests

1. Create your branch from `main`
2. Write and run tests for any new code
3. Run the verification suite before submitting:
   ```bash
   pnpm test:packages:run   # Run all package tests
   pnpm typecheck            # TypeScript type checking
   pnpm lint                 # Biome lint check
   ```
4. Update `CHANGELOG.md` under the `## [Unreleased]` section with your changes:
   - Use subsections: `### Added`, `### Changed`, `### Fixed`, `### Removed`
   - Include the PR number/link and Linear issue identifier (e.g., `CYPACK-123`)
   - Focus on end-user impact, not implementation details
   - For internal-only changes, update `CHANGELOG.internal.md` instead
5. Issue your pull request

## Testing

We use [Vitest](https://vitest.dev/) for all packages.

```bash
# Run all package tests (once)
pnpm test:packages:run

# Run all tests in watch mode
pnpm test

# Run tests for a specific package
cd packages/edge-worker
pnpm test:run

# Run a specific test file
cd packages/edge-worker
pnpm test:run -- path/to/test.ts
```

## Code Style

- **TypeScript** for all packages — no plain JavaScript
- **Biome** for linting and formatting (configured in the repo root)
- **Husky** + **lint-staged** run automatically on commit to enforce formatting
- Follow the existing code structure and organization
- Format code before committing:
  ```bash
  pnpm format
  ```

## Common Commands

```bash
pnpm install              # Install all dependencies
pnpm build                # Build all packages
pnpm dev                  # Development mode (watch all packages)
pnpm test                 # Run tests across all packages (watch mode)
pnpm test:packages:run    # Run package tests once (recommended for CI)
pnpm typecheck            # TypeScript type checking
pnpm lint                 # Biome lint check
pnpm format               # Auto-format with Biome
```

## License

By contributing, you agree that your contributions will be licensed under the project's [Apache License 2.0](./LICENSE).
