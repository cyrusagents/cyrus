# F1 Testing Framework Architecture

## Overview

The F1 testing framework provides an end-to-end observable testing platform for the Atmiko agent system. It enables automated "test drives" of the product by implementing a CLI-based issue tracker that simulates Linear's functionality without requiring external dependencies.

## High-Level Flow

```
Issue-tracker service (CLIIssueTrackerService)
         ↓
    EdgeWorker (platform: "cli")
         ↓
    Renderer (CLI RPC Server)
```

## Components

### 1. CLIIssueTrackerService

**Location:** `packages/core/src/issue-tracker/adapters/CLIIssueTrackerService.ts`

In-memory implementation of `IIssueTrackerService` that:
- Stores issues, comments, teams, labels, workflow states, users, and agent sessions in memory
- Provides synchronous property access (unlike Linear's async properties)
- Emits events for state changes
- Supports all 23 methods from the interface

### 2. CLIRPCServer

**Location:** `packages/core/src/issue-tracker/adapters/CLIRPCServer.ts`

Fastify-based RPC server that:
- Exposes HTTP endpoints for CLI commands
- Routes JSON-RPC requests to CLIIssueTrackerService
- Handles session management commands
- Supports pagination and search for activities

### 3. CLI Platform Support in EdgeWorker

**Changes to:** `packages/core/src/config-types.ts` and `packages/edge-worker/src/EdgeWorker.ts`

- Add `platform: "cli"` option to EdgeWorkerConfig
- Create CLIIssueTrackerService when platform is "cli"
- Skip Cloudflare tunnel in CLI mode
- Register CLI RPC routes with SharedApplicationServer

### 4. F1 CLI Binary

**Location:** `apps/f1/f1`

Commander.js-based CLI that:
- Sends JSON-RPC requests to the server
- Provides beautiful colored output
- Includes per-command help
- Supports pagination for session activities

### 5. F1 Server

**Location:** `apps/f1/server.ts`

Startup script that:
- Configures EdgeWorker with `platform: "cli"`
- Creates temporary directories for worktrees
- Starts the server and displays connection info

## Sub-Issue Decomposition

### Stack Order (dependencies flow downward):

1. **Core Types & Interfaces** - Add CLI platform type to config-types.ts
2. **CLIIssueTrackerService** - Implement in-memory issue tracker
3. **CLIRPCServer** - Implement RPC endpoint handler
4. **EdgeWorker CLI Platform** - Integrate CLI platform into EdgeWorker
5. **F1 CLI Binary** - Create the Commander.js CLI tool
6. **F1 Server & App** - Create the apps/f1 folder structure

Each sub-issue builds on the previous, creating a clean Graphite stack.

## File Structure

```
apps/f1/
├── f1                    # CLI binary (bash script calling bun)
├── server.ts             # Server startup script
├── CLAUDE.md             # Development documentation
├── README.md             # User documentation
└── test-drives/          # Test drive logs and findings

packages/core/src/issue-tracker/adapters/
├── CLIIssueTrackerService.ts  # In-memory issue tracker
├── CLIRPCServer.ts            # RPC endpoint handler
└── index.ts                   # Exports

spec/f1/
├── ARCHITECTURE.md       # This file
└── [sub-issue outputs]   # Context from each sub-agent
```

## Key Design Decisions

1. **In-Memory Storage**: Uses Maps for O(1) lookups of issues, sessions, etc.
2. **Synchronous Properties**: Unlike Linear, all properties are synchronous for simpler testing
3. **Event Emitter**: CLIIssueTrackerService extends EventEmitter for state change notifications
4. **No External Dependencies**: CLI mode requires no Linear API, no Cloudflare tunnel
5. **Bun Runtime**: Uses Bun for faster startup and execution
6. **Commander.js**: Uses Commander for professional CLI experience
7. **Zero `any` Types**: Strict TypeScript throughout
8. **DRY Code**: Shared utilities between CLI and server components

## Verification Points

### Issue-Tracker Verification
- Issues created via CLI appear in memory store
- Comments properly associated with issues
- Agent sessions created correctly
- Activities logged to sessions

### EdgeWorker Verification
- Git worktree created for issue
- Agent session started in worktree
- Session outputs available via RPC

### Renderer Verification
- CLI can fetch session activities
- Output properly formatted
- Pagination works correctly
