# F1 Testing Framework for Miko

A complete end-to-end testing framework for the Miko agent system. F1 provides both a server (EdgeWorker in CLI mode) and a beautiful command-line interface for managing issues, sessions, and agent activities without external dependencies.

## Features

- ✨ **Beautiful colored output** using ANSI escape codes
- 🚀 **Zero external dependencies** for output formatting
- 📝 **Comprehensive help** for each command
- 🔍 **Debug-friendly** with RPC URL displayed on every command
- 🎯 **Type-safe** with absolutely zero `any` types
- ⚡ **Fast** using Bun runtime
- 🎨 **Professional error messages** with helpful suggestions

## Installation

```bash
# Install dependencies (from monorepo root)
pnpm install

# Build all packages
pnpm build
```

## Quick Start

### 1. Start the F1 Server

The F1 server runs an EdgeWorker in CLI platform mode, providing an in-memory issue tracker and agent session management.

```bash
# Start server with default settings
cd apps/f1
pnpm run server

# Or with custom configuration
MIKO_PORT=3600 MIKO_REPO_PATH=/path/to/your/repo pnpm run server

# Development mode with auto-reload
pnpm run server:dev
```

**Server Features:**
- 🏎️ **Fast startup** using Bun runtime
- 🎨 **Beautiful connection info** with ANSI colors
- 🔧 **Environment-based config** (MIKO_PORT, MIKO_REPO_PATH)
- 🛑 **Graceful shutdown** on SIGINT/SIGTERM
- 📁 **Automatic directory setup** for worktrees and state
- 🚫 **No external dependencies** (no Cloudflare tunnel, no Linear API)

**Environment Variables:**
- `MIKO_PORT` - Server port (default: 3600)
- `MIKO_REPO_PATH` - Path to repository to test (default: current directory)

Once started, the server displays:
```
────────────────────────────────────────────────────────────
  🏎️  F1 Testing Framework Server
────────────────────────────────────────────────────────────
✓ Server started successfully

  Server:    http://localhost:3600
  RPC:       http://localhost:3600/cli/rpc
  Platform:  cli
  Miko Home: /tmp/miko-f1-1234567890
  Repository: /path/to/your/repo

  Press Ctrl+C to stop the server
────────────────────────────────────────────────────────────
```

### 2. Use the CLI

With the server running, open a new terminal and use the F1 CLI:

## CLI Usage

The F1 CLI provides the following commands:

### Health & Status Commands

```bash
# Health check
./f1 ping

# Server status
./f1 status

# Version information
./f1 version
```

### Issue Management Commands

```bash
# Create a new issue
./f1 create-issue --title "Fix authentication bug" --description "Users cannot log in"

# Assign issue to a user
./f1 assign-issue --issue-id "issue-123" --assignee-id "user-456"

# Create a comment on an issue
./f1 create-comment --issue-id "issue-123" --body "Working on this now"

# Create a comment with agent mention
./f1 create-comment --issue-id "issue-123" --body "Need help" --mention-agent
```

### Session Management Commands

```bash
# Start an agent session on an issue
./f1 start-session --issue-id "issue-123"

# View session details
./f1 view-session --session-id "session-456"

# View session with pagination
./f1 view-session --session-id "session-456" --limit 20 --offset 10

# Search activities in a session
./f1 view-session --session-id "session-456" --search "error"

# Send a message to active session
./f1 prompt-session --session-id "session-456" --message "Please continue"

# Stop an active session
./f1 stop-session --session-id "session-456"
```

## Server Architecture

The F1 server provides a complete testing environment:

```
F1 Server (server.ts)
         ↓
    EdgeWorker (platform: "cli")
         ↓
    CLIIssueTrackerService (in-memory)
         ↓
    CLIRPCServer (Fastify /cli/rpc)
         ↓
    F1 CLI Commands
```

**Key Components:**
- **EdgeWorker** - Orchestrates agent sessions and worktree management
- **CLIIssueTrackerService** - In-memory issue tracker (simulates Linear)
- **CLIRPCServer** - JSON-RPC endpoint for CLI communication
- **SharedApplicationServer** - Fastify-based HTTP server

## Configuration

The CLI connects to the F1 server via JSON-RPC over HTTP:

```
http://localhost:${MIKO_PORT}/cli/rpc
```

The RPC endpoint URL is displayed at the start of every command for easy debugging.

**Server Configuration:**
- Platform: `"cli"` (disables Cloudflare tunnel, uses in-memory issue tracker)
- Default model: Sonnet
- Fallback model: Haiku
- Temporary directories: `/tmp/miko-f1-*`

## Development

```bash
# Install dependencies
pnpm install

# Build TypeScript
pnpm build

# Type checking
pnpm typecheck

# Run tests
pnpm test:run

# Watch mode
pnpm dev
```

## Architecture

The F1 CLI is built with:

- **Commander.js** for CLI parsing and command management
- **TypeScript** for type safety
- **Bun** runtime for fast execution
- **Custom utilities** for RPC calls and formatting (zero external dependencies)

### Project Structure

```
apps/f1/
├── f1                      # CLI bash script entry point
├── server.ts               # Server startup script
├── src/
│   ├── cli.ts             # Main CLI entry point
│   ├── commands/          # Command implementations
│   │   ├── ping.ts
│   │   ├── status.ts
│   │   ├── version.ts
│   │   ├── createIssue.ts
│   │   ├── assignIssue.ts
│   │   ├── createComment.ts
│   │   ├── startSession.ts
│   │   ├── viewSession.ts
│   │   ├── promptSession.ts
│   │   └── stopSession.ts
│   └── utils/             # Shared utilities
│       ├── colors.ts      # ANSI color helpers
│       ├── rpc.ts         # JSON-RPC client
│       └── output.ts      # Output formatting
├── test-drives/           # Test drive logs and findings
├── CLAUDE.md              # Developer documentation
├── README.md              # This file
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Type Safety

The F1 CLI has **absolutely zero `any` types**. All code is fully typed with TypeScript strict mode enabled.

## Error Handling

All commands provide professional error messages with helpful suggestions:

```
✗ Failed to create issue: RPC Error (404): Issue not found
  Please check that:
    - The F1 server is running
    - The issue ID is correct
```

## Colors

The CLI uses ANSI escape codes for beautiful colored output:

- 🟢 Green - Success messages
- 🔴 Red - Error messages
- 🟡 Yellow - Warning messages
- 🔵 Cyan - Informational messages
- ⚪ Gray - Debug/metadata

## End-to-End Testing Example

```bash
# Terminal 1: Start the server
cd apps/f1
pnpm run server

# Terminal 2: Run test commands
cd apps/f1

# 1. Health check
./f1 ping

# 2. Create an issue
./f1 create-issue --title "Implement feature X" --description "Add feature X to the system"

# 3. Start agent session (note the issue ID from step 2)
./f1 start-session --issue-id <issue-id>

# 4. View session activities (note the session ID from step 3)
./f1 view-session --session-id <session-id>

# 5. Send additional prompts
./f1 prompt-session --session-id <session-id> --message "Continue working on this"

# 6. Stop session when done
./f1 stop-session --session-id <session-id>
```

## Documentation

- **CLAUDE.md** - Developer documentation for working with F1
- **spec/f1/ARCHITECTURE.md** - Complete architecture documentation
- **packages/core/src/issue-tracker/adapters/** - CLIIssueTrackerService and CLIRPCServer implementations

## License

Part of the Miko project.
