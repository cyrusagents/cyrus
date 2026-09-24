# Miko Packages

This directory contains the core packages that make up the Miko monorepo. Each package has a specific scope of concerns and well-defined responsibilities.

## Package Overview

### @miko/core
**Scope**: Core domain models and business logic entities

**Responsibilities**:
- Define core business entities (Session, Issue, Workspace, Comment)
- Manage session lifecycle and state
- Provide shared TypeScript types and interfaces
- Handle session persistence and retrieval

**Key Exports**:
- `Session` - Represents a Claude coding session
- `SessionManager` - Manages multiple active sessions
- `Issue` - Linear issue model
- `Workspace` - Working directory model
- `Comment` - Issue comment model

### @miko/claude-parser
**Scope**: Parse and interpret Claude's stdout/stderr output

**Responsibilities**:
- Parse Claude's JSON-formatted stdout messages
- Handle streaming JSON parsing (incomplete messages)
- Emit typed events for different message types
- Extract content from assistant responses
- Parse tool use events and errors

**Key Exports**:
- `StdoutParser` - Main parser class
- `StreamProcessor` - Handles streaming data
- `ClaudeEvent` - TypeScript types for all Claude events
- Message type definitions

### @miko/claude-runner
**Scope**: Manage Claude CLI process lifecycle

**Responsibilities**:
- Spawn and manage Claude CLI processes
- Handle process arguments and environment setup
- Send prompts and input to Claude
- Kill/restart processes as needed
- Configure allowed tools and working directory
- Handle --continue flag for session continuation

**Key Exports**:
- `ClaudeRunner` - Main process manager
- `getAllTools()` - List available Claude tools
- Process configuration types

### @miko/ndjson-client
**Scope**: NDJSON streaming communication with edge proxy

**Responsibilities**:
- Establish persistent HTTP connections for NDJSON streaming
- Handle authentication with OAuth tokens
- Parse incoming NDJSON events (webhooks, heartbeats)
- Send status updates back to proxy
- Manage reconnection and error handling
- Emit events for webhook data

**Key Exports**:
- `NdjsonClient` - Main client class
- `WebhookEvent` - Webhook event types
- `StatusUpdate` - Status update types
- Configuration interfaces

### @miko/edge-worker
**Scope**: Orchestrate Linear webhooks, Claude processing, and API responses

**Responsibilities**:
- Connect to edge proxy via NDJSON streaming
- Process Linear webhook events (issue assignment, comments)
- Manage Claude sessions for each issue
- Post responses back to Linear via API
- Handle multiple repository/workspace configurations
- Coordinate between all other packages

**Key Exports**:
- `EdgeWorker` - Main orchestrator class
- `RepositoryConfig` - Repository configuration
- `EdgeWorkerConfig` - Full configuration interface
- Event types and handlers

## Package Dependencies

```
@miko/edge-worker
  ├── @miko/core (Session, SessionManager)
  ├── @miko/claude-parser (ClaudeEvent types)
  ├── @miko/claude-runner (ClaudeRunner)
  ├── @miko/ndjson-client (NdjsonClient)
  └── @linear/sdk (Linear API)

@miko/claude-runner
  └── @miko/claude-parser (for event types)

@miko/ndjson-client
  └── (no internal dependencies)

@miko/claude-parser
  └── (no internal dependencies)

@miko/core
  └── (no internal dependencies)
```

## Design Principles

1. **Single Responsibility**: Each package has one clear purpose
2. **Minimal Dependencies**: Packages depend only on what they need
3. **Type Safety**: All packages export TypeScript types
4. **Event-Driven**: Packages communicate via events where appropriate
5. **Testable**: Each package can be tested in isolation
6. **Reusable**: Packages can be used independently in different contexts

## Usage in Apps

- **CLI App**: Uses all packages to provide a command-line interface
- **Electron App**: Uses edge-worker package for the main functionality
- **Future Apps**: Can pick and choose packages based on needs