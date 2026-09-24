# F1 Testing Framework - Developer Documentation

This documentation provides guidance to Claude Code when working with the F1 testing framework.

## Project Overview

The F1 Testing Framework is an end-to-end observable testing platform for the Miko agent system. It provides a CLI-based issue tracker that simulates Linear's functionality without requiring external dependencies.

**Key Features:**
- In-memory issue tracking (CLIIssueTrackerService)
- CLI platform mode for EdgeWorker
- Beautiful CLI interface with ANSI colors
- RPC server for CLI-to-EdgeWorker communication
- Zero external dependencies for testing
- Zero `any` types throughout the codebase

## Architecture

The F1 framework follows this flow:

```
CLI Commands (f1 binary)
         ↓
   JSON-RPC over HTTP
         ↓
   CLIRPCServer (Fastify)
         ↓
   CLIIssueTrackerService (in-memory)
         ↓
   EdgeWorker (platform: "cli")
         ↓
   Claude Code Sessions
```

For detailed architecture information, see `/spec/f1/ARCHITECTURE.md`.

## File Structure

```
apps/f1/
├── f1                    # CLI binary (bash script calling bun)
├── server.ts             # Server startup script
├── src/
│   ├── cli.ts            # CLI entry point using Commander.js
│   ├── commands/         # CLI command implementations
│   │   ├── assignIssue.ts
│   │   ├── createComment.ts
│   │   ├── createIssue.ts
│   │   ├── initTestRepo.ts  # Scaffold test repository
│   │   ├── ping.ts
│   │   ├── promptSession.ts
│   │   ├── startSession.ts
│   │   ├── status.ts
│   │   ├── stopSession.ts
│   │   ├── version.ts
│   │   └── viewSession.ts
│   ├── templates/        # Test repository templates
│   │   └── index.ts      # Rate limiter library templates
│   └── utils/
│       ├── colors.ts     # ANSI color utilities (zero dependencies)
│       ├── output.ts     # Formatted output helpers
│       └── rpc.ts        # RPC client for CLI-server communication
├── test-drives/          # Test drive logs and findings
├── CLAUDE.md             # This file
└── README.md             # User-facing documentation
```

## Quick Start: Running a Test Drive

The F1 framework includes a test repository scaffold command that creates a realistic, partially-complete rate limiter library for agents to work on.

### Step 1: Create a Test Repository

```bash
cd apps/f1

# Scaffold the test repo at any location
./f1 init-test-repo --path /tmp/rate-limiter-test

# The generated repo contains:
# ✓ Token bucket algorithm (implemented)
# ✗ Sliding window algorithm (TODO)
# ✗ Fixed window algorithm (TODO)  
# ✗ Redis storage adapter (TODO)
# ✗ Unit tests (TODO)
```

### Step 2: Start the F1 Server

```bash
# Start server pointing to the test repo
MIKO_PORT=3458 MIKO_REPO_PATH=/tmp/rate-limiter-test bun run server.ts
```

### Step 3: Create a Test Issue

```bash
# In another terminal
cd apps/f1

# Create an issue based on the rate limiter TODOs
MIKO_PORT=3458 ./f1 create-issue \
  --title "Implement sliding window rate limiter algorithm" \
  --description "The rate limiter library currently only supports the token bucket algorithm. 

## Task
Implement the sliding window rate limiting algorithm in src/rate-limiter.ts.

## Acceptance Criteria
- [ ] Implement the SlidingWindowRateLimiter class
- [ ] Support configurable window size and max requests
- [ ] Add proper TypeScript types (no 'any' types)
- [ ] Ensure the implementation passes type checking

## Context
See src/types.ts for the RateLimiterConfig interface and src/rate-limiter.ts for the existing TokenBucketRateLimiter implementation to follow as a pattern."
```

### Step 4: Start an Agent Session

```bash
# Start a session on the issue (use the issue-id from create-issue output)
MIKO_PORT=3458 ./f1 start-session --issue-id issue-1

# Monitor the session
MIKO_PORT=3458 ./f1 view-session --session-id session-1

# Stop when done
MIKO_PORT=3458 ./f1 stop-session --session-id session-1
```

### Alternative Test Issues

Here are other realistic issues you can create based on the test repo:

**Implement Fixed Window Algorithm:**
```bash
MIKO_PORT=3458 ./f1 create-issue \
  --title "Implement fixed window rate limiter algorithm" \
  --description "Add a FixedWindowRateLimiter class that resets the counter at fixed time intervals. Should implement the RateLimiter interface from src/types.ts."
```

**Add Redis Storage Adapter:**
```bash
MIKO_PORT=3458 ./f1 create-issue \
  --title "Add Redis storage adapter for distributed rate limiting" \
  --description "Create a RedisStorageAdapter that implements a storage interface for the rate limiter, enabling distributed rate limiting across multiple instances. Define the storage interface and implement the Redis adapter."
```

**Add Unit Tests:**
```bash
MIKO_PORT=3458 ./f1 create-issue \
  --title "Add comprehensive unit tests for rate limiter" \
  --description "Add Vitest unit tests for the TokenBucketRateLimiter class. Test edge cases like:
- Requests within limit
- Requests exceeding limit  
- Token refill behavior
- Configuration validation"
```

## Running the F1 Server

The F1 server starts an EdgeWorker in CLI platform mode:

```bash
# Start with default settings
bun run server.ts

# Or use pnpm scripts
pnpm run server

# Custom configuration
MIKO_PORT=3600 MIKO_REPO_PATH=/path/to/repo bun run server.ts

# Development mode with auto-reload
pnpm run server:dev
```

**Environment Variables:**
- `MIKO_PORT` - Server port (default: 3600)
- `MIKO_REPO_PATH` - Repository path (default: current working directory)

The server automatically:
- Creates temporary directories in `/tmp/miko-f1-*`
- Configures EdgeWorker with `platform: "cli"`
- Starts Fastify server on the specified port
- Registers RPC endpoints at `/cli/rpc`
- Displays beautiful colored connection info

## Using the F1 CLI

Once the server is running, use the CLI to interact with it:

```bash
# Health check
./f1 ping

# Server status
./f1 status

# Create a test repository
./f1 init-test-repo --path /path/to/test-repo

# Create an issue
./f1 create-issue --title "Test Issue" --description "Test description"

# Assign issue to user
./f1 assign-issue --issue-id <id> --assignee-id <user-id>

# Start an agent session
./f1 start-session --issue-id <id>

# View session activities
./f1 view-session --session-id <id>

# Prompt session with user message
./f1 prompt-session --session-id <id> --message "Continue working"

# Stop session
./f1 stop-session --session-id <id>
```

**CLI Features:**
- Beautiful colored output using ANSI escape codes
- Comprehensive help for each command (`./f1 <command> --help`)
- Debug-friendly with RPC URL displayed on every command
- Professional error messages with suggestions
- Uses Bun for fast startup

## Configuration Details

### Server Configuration (server.ts)

The server creates an EdgeWorker with the following configuration:

```typescript
const config: EdgeWorkerConfig = {
  platform: "cli" as const,
  repositories: [repository],
  mikoHome: MIKO_HOME,
  serverPort: MIKO_PORT,
  serverHost: "localhost",
  defaultModel: "sonnet",
  defaultFallbackModel: "haiku",
};
```

**Key Points:**
- `platform: "cli"` - Enables CLI mode
- No Cloudflare tunnel in CLI mode
- No Linear API required
- Uses CLIIssueTrackerService instead of LinearIssueTrackerService
- CLIRPCServer registered at `/cli/rpc`

### CLI RPC Client (src/utils/rpc.ts)

The CLI communicates with the server using JSON-RPC over HTTP:

```typescript
interface RPCRequest<TParams> {
  method: RPCCommand;
  params: TParams;
}

interface RPCResponse<TData> {
  success: boolean;
  data?: TData;
  error?: string;
}
```

## Testing

```bash
# Run tests
pnpm test

# Type checking
pnpm typecheck

# Build
pnpm build
```

**Testing Best Practices:**
- Always write tests for new commands
- Use Vitest for all tests
- Ensure zero `any` types
- Test error handling paths
- Mock RPC responses for CLI tests

## Development Workflow

### Adding a New CLI Command

1. Create command file in `src/commands/`
2. Implement command with proper types
3. Add RPC method to CLIRPCServer (in core package)
4. Register command in `src/cli.ts`
5. Add tests
6. Update README.md with command documentation

### Modifying the Server

The server is designed to be minimal. Most logic lives in:
- EdgeWorker (packages/edge-worker)
- CLIIssueTrackerService (packages/core)
- CLIRPCServer (packages/core)

Only modify server.ts for:
- Configuration changes
- Environment variable handling
- Startup/shutdown logic
- Connection info display

## Color Usage Guidelines

The F1 framework uses consistent ANSI colors:

- **Green** - Success, completion
- **Red** - Errors, failures
- **Yellow** - Warnings, important info
- **Cyan** - Labels, metadata
- **Gray/Dim** - Secondary info, timestamps
- **Bold** - Important values, headings

Example:
```typescript
import { success, error, cyan, bold } from './utils/colors.js';

console.log(success('Operation completed'));
console.log(error('Operation failed'));
console.log(`${cyan('Status:')} ${bold('ready')}`);
```

## Common Issues

### Server won't start
- Check if port is already in use
- Verify MIKO_REPO_PATH exists
- Ensure all packages are built (`pnpm build` from root)

### CLI can't connect to server
- Verify server is running (`./f1 ping`)
- Check RPC_URL environment variable
- Default is `http://localhost:3600/cli/rpc`

### TypeScript errors
- Run `pnpm build` from root to build all packages
- Check tsconfig.json includes all necessary files
- Verify workspace dependencies are resolved

## Related Files

- `/spec/f1/ARCHITECTURE.md` - Complete architecture documentation
- `/packages/core/src/issue-tracker/adapters/CLIIssueTrackerService.ts` - In-memory issue tracker
- `/packages/core/src/issue-tracker/adapters/CLIRPCServer.ts` - RPC server implementation
- `/packages/edge-worker/src/EdgeWorker.ts` - EdgeWorker with CLI platform support

## Important Notes

1. **Zero Dependencies for Output**: The CLI uses raw ANSI escape codes, no chalk or other dependencies
2. **Type Safety**: Absolutely zero `any` types in the codebase
3. **Bun Runtime**: Both server and CLI use Bun for fast startup
4. **Temporary Directories**: Server creates temporary directories, no state persistence
5. **Single Repository Mode**: F1 currently supports one repository per server instance
6. **No Authentication**: CLI mode doesn't require Linear tokens or authentication

## Verification

To verify the F1 framework works end-to-end:

```bash
# 1. Build everything
pnpm install && pnpm build

# 2. Start F1 server in one terminal
cd apps/f1
pnpm run server

# 3. In another terminal, test CLI commands
cd apps/f1
./f1 ping                                    # Should return pong
./f1 status                                  # Should show server status
./f1 create-issue --title "Test"             # Should create issue
./f1 start-session --issue-id <id>           # Should start session
./f1 view-session --session-id <session-id>  # Should show activities
./f1 stop-session --session-id <session-id>  # Should stop session
```

All commands should complete successfully with beautiful colored output.

## F1 Test Drive Recommendations

When running a comprehensive test drive, follow this checklist:

### 1. Setup & Issue Creation
```bash
# Build and start
pnpm install && pnpm build
export MIKO_PORT=3600
node dist/server.js --port $MIKO_PORT

# Create test issue
./f1 issue create --title "Add multiply and divide methods to Calculator" --labels sonnet
```

### 2. Monitor Output Formatting

Watch for these key log patterns:

**Routing & Classification:**
```
[EdgeWorker] AI routing decision: Classification: code, Procedure: full-development
```

**GitService Activity:**
```
[GitService] Fetching latest changes from remote...
[GitService] Creating git worktree at .../worktrees/DEF-1 from origin/main
```

**Activity Creation:**
```
[AgentSessionManager] Created thought activity activity-6
[AgentSessionManager] Created action activity activity-7
```

### 3. Mid-Implementation Prompting

While Claude is actively working, inject a prompt:
```bash
./f1 comment add DEF-1 "Also please add a modulo (remainder) method while you're at it"
```

**Success indicator:**
```
[EdgeWorker] Adding prompt to existing stream for session-1 (prompted webhook (existing session))
```

### 4. Subroutine Progression

Watch for transitions through all 4 subroutines:
1. **coding-activity** (50-100 messages)
2. **verifications** (15-30 messages)
3. **git-gh** (20-35 messages)
4. **concise-summary** (3 messages, singleTurn)

### 5. Final Verification

After `All subroutines completed`:
```bash
cd /path/to/worktrees/DEF-1
git status           # Should be clean
git log --oneline -3 # Verify commit
cat src/calculator.ts # Check implementation
```

### What to Watch For

**Healthy indicators:**
- `[GitService]` logs show worktree creation
- Continuous activity creation during coding
- Mid-prompts show "Adding prompt to existing stream"
- All 4 subroutines complete in sequence
- Final commit in git log

**Warning signs:**
- Long pauses between activities
- Subroutine stuck without advancing
- No commit after git-gh subroutine
