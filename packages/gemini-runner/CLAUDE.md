# gemini-runner Package Guide

This package provides a provider-agnostic wrapper around the Gemini CLI that implements the `IAgentRunner` interface from `atmiko-core`.

## Overview

**GeminiRunner** translates between Gemini CLI's streaming JSON format and the Claude SDK message types, enabling seamless integration of Google's Gemini models into the Atmiko agent framework.

## Key Features

### 1. Result Message Coercion

Unlike Claude's CLI which includes final assistant content in result messages, Gemini's result messages contain only metadata (status, stats, duration). GeminiRunner solves this by:

- **Tracking** the last assistant message emitted during execution
- **Extracting** text content from the tracked message
- **Injecting** actual response content into result messages

**Implementation:**
- `GeminiRunner.lastAssistantMessage` - Private field tracking most recent assistant message
- `GeminiRunner.getLastAssistantMessage()` - Public accessor for external use
- `geminiEventToSDKMessage()` - Accepts optional `lastAssistantMessage` parameter to coerce result content

**Why this matters:**
Without coercion, result messages would always say "Session completed successfully" instead of containing the actual final output. This breaks EdgeWorker's expectation that result messages contain summary content from final subroutines.

### 2. Single-Turn Mode Support

Summary subroutines (like `concise-summary`, `question-answer`) need to run in single-turn mode to prevent unnecessary back-and-forth. GeminiRunner enables this through:

**Auto-Generated Settings:**
- On first spawn, creates `~/.gemini/settings.json` if missing
- Generates `-shortone` aliases for all main Gemini models:
  - `gemini-3-pro-preview-shortone`
  - `gemini-2.5-pro-shortone`
  - `gemini-2.5-flash-shortone`
  - `gemini-2.5-flash-lite-shortone`
- Each alias configured with `maxSessionTurns: 1`
- Enables `previewFeatures: true` for latest Gemini capabilities

**EdgeWorker Integration:**
- When `subroutine.singleTurn === true`, EdgeWorker appends `-shortone` to model name
- Example: `gemini-2.5-flash` → `gemini-2.5-flash-shortone`
- This ensures Gemini CLI enforces single-turn constraint

**Reference:**
- Gemini CLI Configuration: https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/configuration.md

### 3. Streaming Stdin Support

GeminiRunner supports both string and streaming prompt modes:

**String Mode:**
```typescript
await runner.start("Analyze this codebase");
```

**Streaming Mode:**
```typescript
await runner.startStreaming("Initial task");
runner.addStreamMessage("Additional context");
runner.addStreamMessage("More details");
runner.completeStream(); // Closes stdin to trigger processing
```

**Critical Implementation Details:**
- Initial prompt written to stdin **immediately** after spawn (line 253)
- Stdin remains **open** for `addStreamMessage()` calls
- Stdin closed only in `completeStream()` (line 118)
- Prevents gemini CLI's 500ms timeout from firing prematurely

**How Gemini CLI stdin works:**
1. 500ms timeout starts when process spawns
2. If **no data** arrives within 500ms → assumes no piped input, continues
3. Once **data arrives** → cancels timeout, waits for stdin close (`end` event)
4. Continues reading chunks until stdin closes

**Test Coverage:** `test-scripts/test-stdin-direct.ts` proves multiple stdin writes work correctly.

## Testing

### Comprehensive Integration Test

The package includes one comprehensive end-to-end integration test in `test-scripts/test-gemini-runner.ts` that verifies all GeminiRunner features:

#### test-gemini-runner.ts
**Purpose:** Complete end-to-end verification of all GeminiRunner functionality

**What it tests:**

1. **Settings.json Auto-Generation**
   - `~/.gemini/settings.json` created if missing
   - All 4 `-shortone` model aliases present
   - Each alias has `maxSessionTurns: 1`

2. **Stdin Streaming (Multiple Writes)**
   - Multiple messages written to stdin
   - Process accepts all messages before stdin closes
   - Gemini processes all input correctly

3. **Result Message Coercion**
   - Result message contains actual assistant response
   - NOT generic "Session completed successfully"
   - Content matches last assistant message exactly

4. **Single-Turn Mode (All 4 Models)**
   - Tests all 4 main Gemini models with `-shortone` aliases:
     - `gemini-3-pro-preview-shortone`
     - `gemini-2.5-pro-shortone`
     - `gemini-2.5-flash-shortone`
     - `gemini-2.5-flash-lite-shortone`
   - Each completes in ≤1 turns
   - maxSessionTurns constraint enforced

5. **getLastAssistantMessage() Public API**
   - Returns null before session starts
   - Captures last assistant message after session
   - Content accessible via public method

**Usage:**
```bash
cd packages/gemini-runner
export GEMINI_API_KEY='your-key-here'
pnpm build
bun test-scripts/test-gemini-runner.ts
```

**Expected output:**
```
============================================================
🧪 GeminiRunner End-to-End Integration Tests
============================================================

Prerequisites:
   ✅ GEMINI_API_KEY environment variable set
   ✅ Test directory: /Users/user/.atmiko-test-gemini

📁 Test 1: Settings.json Auto-Generation
   ✅ settings.json has modelConfigs.aliases
   ✅ Alias 'gemini-3-pro-preview-shortone' exists
   ... (8 assertions)

🔄 Test 2: Stdin Streaming (Multiple Writes)
   ✅ Received 3 messages from GeminiRunner
   ... (3 assertions)

📝 Test 3: Result Message Coercion
   ✅ Result is NOT generic 'Session completed successfully'
   ... (3 assertions)

🎯 Test 4: Single-Turn Mode (All 4 Models)
   ✅ gemini-2.5-flash-shortone: Completed in ≤1 turns
   ... (12 assertions)

🔍 Test 5: getLastAssistantMessage() Public API
   ✅ Returns message after session
   ... (2 assertions)

============================================================
📊 Test Summary
============================================================
   Total Tests:  28
   Passed:       28
   Duration:     XX.XXs

✅ All Tests Passed!
============================================================
```

### Prerequisites

**Required:**
- GEMINI_API_KEY environment variable
- Gemini CLI: `npm install -g @google/gemini-cli@0.17.0`
- Bun runtime (for test execution)

**Optional:**
- `~/.gemini/settings.json` (auto-generated if missing)

### Running Tests

```bash
# Install Gemini CLI (one-time setup)
npm install -g @google/gemini-cli@0.17.0

# Set API key
export GEMINI_API_KEY='your-gemini-api-key'

# Build the package first
cd packages/gemini-runner
pnpm build

# Run comprehensive integration test (covers all features)
bun test-scripts/test-gemini-runner.ts
```

## Architecture

### Message Flow

```
Gemini CLI Process
       ↓ (stdout: NDJSON stream)
handleGeminiEvent()
       ↓
geminiEventToSDKMessage(event, sessionId, lastAssistantMessage)
       ↓
Track if type === "assistant" → this.lastAssistantMessage
       ↓
emitMessage() → onMessage callback
       ↓
EdgeWorker → AgentSessionManager → Linear
```

### Key Files

- **GeminiRunner.ts** (lines 70-71) - Track last assistant message field
- **GeminiRunner.ts** (line 234) - Call `ensureGeminiSettings()` before spawn
- **GeminiRunner.ts** (lines 397-399) - Capture assistant messages
- **GeminiRunner.ts** (line 253) - Write initial prompt to stdin immediately
- **adapters.ts** (lines 172-183) - Extract content for result coercion
- **settingsGenerator.ts** - Auto-generate `~/.gemini/settings.json`

### Integration Points

**EdgeWorker Coordination:**
- EdgeWorker checks `subroutine.singleTurn` flag
- If true: appends `-shortone` to model name
- Passes `maxTurns: 1` to runner config
- GeminiRunner uses model alias from settings.json

**Result Message Usage:**
- AgentSessionManager relies on `result.result` containing final content
- Without coercion, would post generic message to Linear
- With coercion, posts actual assistant summary

## Common Issues

### Issue: "Gemini process hangs"
**Cause:** Stdin not written immediately after spawn
**Solution:** Initial prompt written at line 253 before any other operations

### Issue: "Result says 'Session completed successfully'"
**Cause:** Result coercion not working
**Debug:** Check that `lastAssistantMessage` is being captured
**Verify:** Run `test-result-and-singleturn.ts` to confirm coercion

### Issue: "Single-turn mode not working"
**Cause:** Missing `-shortone` aliases in settings.json
**Solution:** Delete `~/.gemini/settings.json` and restart (auto-regenerates)
**Verify:** Check settings.json has `maxSessionTurns: 1` for aliases

### Issue: "Multiple stdin writes fail"
**Cause:** Stdin closed prematurely
**Solution:** Only close stdin in `completeStream()`, not after initial write
**Verify:** Run `test-stdin-direct.ts` to confirm streaming works

## Gemini CLI Type Reference

The runner keeps local Zod schemas for Gemini CLI stream events and links to the upstream Gemini CLI sources for reference. We don't import official types at runtime, and we don't keep `@google/gemini-cli-core` installed only for reference because that adds a large unused dependency graph to the workspace.

### Why We Don't Use Official Types Directly

The official types use generic `Record<string, unknown>` for tool parameters. Our custom Zod schemas in `src/schemas.ts` provide:

1. **Runtime validation** - Official types are TypeScript-only
2. **Detailed tool typing** - Per-tool parameter schemas (e.g., `ReadFileParameters.file_path`)
3. **Type guards** - Functions like `isReadFileTool()`, `isWriteTodosTool()`
4. **Parsing utilities** - `parseAsReadFileTool()`, `safeParseGeminiStreamEvent()`

### Reference Links

- **Official type definitions**: https://github.com/google-gemini/gemini-cli/blob/v0.17.0/packages/core/src/output/types.ts
- **NPM package**: https://www.npmjs.com/package/@google/gemini-cli-core/v/0.17.0
- **Headless mode docs**: https://github.com/google-gemini/gemini-cli/blob/v0.17.0/docs/cli/headless.md

### Verifying Type Compatibility

To verify our schemas match the official types, compare:
- `src/schemas.ts` - Our Zod schemas
- The upstream Gemini CLI type definitions linked above

The event structure (`init`, `message`, `tool_use`, `tool_result`, `error`, `result`) should match exactly.

## TypeScript Coding Principles

When writing TypeScript code in this package:

1. **Avoid type assertions (`as`) - use explicit type declarations instead:**

   ❌ **Bad:** Type assertions bypass type safety
   ```typescript
   this.message = {
     type: "user",
     message: { role: "user", content: text }
   } as SDKUserMessage;
   ```

   ✅ **Good:** Explicit type declarations provide compile-time safety
   ```typescript
   const message: SDKUserMessage = {
     type: "user",
     message: { role: "user", content: text }
   };
   this.message = message;
   ```

2. **Why this matters:**
   - Type assertions tell TypeScript "trust me", which defeats type checking
   - Explicit types catch errors at compile time, not runtime
   - Makes refactoring safer when changing types
   - Improves IDE autocomplete and error detection

3. **Exceptions:**
   - Type assertions may be acceptable for third-party library types
   - Unknown/any casting should be avoided entirely

## Contributing

When modifying GeminiRunner:

1. **Run tests** before committing:
   ```bash
   pnpm build
   bun test-scripts/test-gemini-runner.ts
   ```

2. **Preserve critical behaviors:**
   - Stdin written immediately after spawn
   - Stdin kept open for streaming
   - Last assistant message tracked before result events
   - Settings.json auto-generation
   - Delta message accumulation using Claude SDK format (array of content blocks)

3. **Update tests** if changing:
   - Result message structure
   - Single-turn mode behavior
   - Stdin handling logic
   - Message accumulation format

4. **Document** any new edge cases or Gemini CLI quirks discovered
