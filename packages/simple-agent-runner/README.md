# atmiko-simple-agent-runner

A simple, type-safe abstraction for agent interactions that return enumerated responses.

## Overview

`simple-agent-runner` provides a clean API for running agent queries where you need the agent to select from a predefined set of responses (e.g., "yes"/"no", "approve"/"reject"/"abstain"). It handles:

- **Type-safe response validation** - Generic types ensure compile-time checking
- **Comprehensive error handling** - Structured errors with codes and context
- **Progress tracking** - Optional callbacks for observability
- **Multiple backends** - Extensible architecture supports different agent SDKs

## Installation

```bash
pnpm add atmiko-simple-agent-runner
```

## Quick Start

```typescript
import { SimpleClaudeRunner } from "atmiko-simple-agent-runner";

// Define valid responses as a const array for type safety
const VALID_RESPONSES = ["yes", "no"] as const;
type YesNoResponse = typeof VALID_RESPONSES[number]; // "yes" | "no"

// Create runner
const runner = new SimpleClaudeRunner<YesNoResponse>({
  validResponses: VALID_RESPONSES,
  atmikoHome: "/Users/me/.atmiko",
  maxTurns: 3,
  timeoutMs: 30000, // 30 seconds
});

// Execute query
const result = await runner.query(
  "Is TypeScript better than JavaScript for large projects?"
);

console.log(result.response); // "yes" or "no" (type-safe!)
console.log(result.durationMs); // Execution time
console.log(result.costUSD); // Cost (if available)
```

## API Reference

### `SimpleClaudeRunner<T>`

The concrete implementation using Claude Agent SDK.

#### Constructor Options

```typescript
interface SimpleAgentRunnerConfig<T extends string> {
  // Required
  validResponses: readonly T[];  // Valid response options
  atmikoHome: string;              // Atmiko home directory

  // Optional
  systemPrompt?: string;          // Custom system prompt
  maxTurns?: number;              // Max turns before timeout
  timeoutMs?: number;             // Overall timeout in ms
  model?: string;                 // Model to use
  fallbackModel?: string;         // Fallback model
  workingDirectory?: string;      // Working directory
  onProgress?: (event) => void;   // Progress callback
}
```

#### Methods

##### `query(prompt: string, options?: SimpleAgentQueryOptions): Promise<SimpleAgentResult<T>>`

Execute a query and return a validated response.

**Options:**
```typescript
interface SimpleAgentQueryOptions {
  context?: string;                  // Additional context
  allowFileReading?: boolean;        // Allow file operations
  allowedDirectories?: string[];     // Allowed file paths
}
```

**Returns:**
```typescript
interface SimpleAgentResult<T extends string> {
  response: T;                    // Validated response
  messages: SDKMessage[];         // All SDK messages
  sessionId: string | null;       // Session ID
  durationMs: number;             // Execution time
  costUSD?: number;               // Cost (if available)
}
```

## Error Handling

All errors extend `SimpleAgentError` and include error codes:

```typescript
import {
  InvalidResponseError,
  TimeoutError,
  NoResponseError,
  MaxTurnsExceededError,
  SessionError,
  SimpleAgentErrorCode,
} from "atmiko-simple-agent-runner";

try {
  const result = await runner.query("Should we deploy to production?");
} catch (error) {
  if (error instanceof InvalidResponseError) {
    console.error("Agent returned:", error.receivedResponse);
    console.error("Valid options:", error.validResponses);
  } else if (error instanceof TimeoutError) {
    console.error("Timeout after:", error.timeoutMs);
  } else if (error instanceof NoResponseError) {
    console.error("No response produced");
  } else if (error instanceof MaxTurnsExceededError) {
    console.error("Max turns exceeded:", error.maxTurns);
  } else if (error instanceof SessionError) {
    console.error("Session error:", error.cause);
  }
}
```

### Error Codes

```typescript
enum SimpleAgentErrorCode {
  INVALID_RESPONSE = "INVALID_RESPONSE",
  TIMEOUT = "TIMEOUT",
  NO_RESPONSE = "NO_RESPONSE",
  SESSION_ERROR = "SESSION_ERROR",
  INVALID_CONFIG = "INVALID_CONFIG",
  ABORTED = "ABORTED",
  MAX_TURNS_EXCEEDED = "MAX_TURNS_EXCEEDED",
}
```

## Examples

### Yes/No Questions

```typescript
const VALID_RESPONSES = ["yes", "no"] as const;
type YesNo = typeof VALID_RESPONSES[number];

const runner = new SimpleClaudeRunner<YesNo>({
  validResponses: VALID_RESPONSES,
  atmikoHome: process.env.ATMIKO_HOME!,
  systemPrompt: "You are a helpful assistant. Answer questions concisely.",
});

const result = await runner.query(
  "Does this code follow best practices?"
);

if (result.response === "yes") {
  console.log("✅ Code looks good!");
} else {
  console.log("❌ Code needs improvements");
}
```

### Approval Workflow

```typescript
const APPROVAL_OPTIONS = ["approve", "reject", "abstain"] as const;
type ApprovalDecision = typeof APPROVAL_OPTIONS[number];

const approvalRunner = new SimpleClaudeRunner<ApprovalDecision>({
  validResponses: APPROVAL_OPTIONS,
  atmikoHome: process.env.ATMIKO_HOME!,
  systemPrompt: "You are a code reviewer. Review PRs carefully.",
  maxTurns: 5,
});

const result = await approvalRunner.query(
  "Review this pull request and decide: approve, reject, or abstain",
  { context: prDiff, allowFileReading: true }
);

switch (result.response) {
  case "approve":
    await mergePR();
    break;
  case "reject":
    await requestChanges();
    break;
  case "abstain":
    await requestHumanReview();
    break;
}
```

### With Progress Tracking

```typescript
const runner = new SimpleClaudeRunner({
  validResponses: ["high", "medium", "low"] as const,
  atmikoHome: process.env.ATMIKO_HOME!,
  onProgress: (event) => {
    switch (event.type) {
      case "started":
        console.log("Session started:", event.sessionId);
        break;
      case "thinking":
        console.log("Agent:", event.text);
        break;
      case "tool-use":
        console.log("Using tool:", event.toolName);
        break;
      case "response-detected":
        console.log("Candidate response:", event.candidateResponse);
        break;
      case "validating":
        console.log("Validating response...");
        break;
    }
  },
});

const result = await runner.query(
  "Rate the priority of this bug: high, medium, or low"
);
```

### Custom System Prompt

```typescript
const runner = new SimpleClaudeRunner({
  validResponses: ["safe", "unsafe"] as const,
  atmikoHome: process.env.ATMIKO_HOME!,
  systemPrompt: `You are a security analyzer.
  Analyze code for security vulnerabilities.
  Consider: injection attacks, authentication issues, data exposure.
  Be conservative - mark as "unsafe" if you have any concerns.`,
});

const result = await runner.query(
  "Analyze this function for security issues",
  { context: functionCode, allowFileReading: false }
);
```

## Extending for Other Agent SDKs

To create implementations for other agent SDKs (e.g., OpenAI, Anthropic Direct API):

```typescript
import { SimpleAgentRunner } from "atmiko-simple-agent-runner";

export class SimpleGPTRunner<T extends string> extends SimpleAgentRunner<T> {
  protected async executeAgent(
    prompt: string,
    options?: SimpleAgentQueryOptions
  ): Promise<SDKMessage[]> {
    // Your GPT implementation here
  }

  protected extractResponse(messages: SDKMessage[]): string {
    // Your response extraction logic
  }
}
```

## Architecture

The package has two layers:

1. **`SimpleAgentRunner`** (abstract base class)
   - Handles configuration validation
   - Manages response validation
   - Provides timeout handling
   - Emits progress events
   - Defines the contract for implementations

2. **`SimpleClaudeRunner`** (concrete implementation)
   - Uses `atmiko-claude-runner` for execution
   - Handles message parsing
   - Cleans and normalizes responses
   - Manages tool restrictions

## Best Practices

1. **Use const arrays for valid responses:**
   ```typescript
   const VALID = ["a", "b"] as const;
   type Response = typeof VALID[number];
   ```

2. **Set reasonable timeouts:**
   ```typescript
   { timeoutMs: 30000, maxTurns: 5 }
   ```

3. **Handle all error types:**
   ```typescript
   catch (error) {
     if (error instanceof InvalidResponseError) { /* ... */ }
     else if (error instanceof TimeoutError) { /* ... */ }
     // ... handle all types
   }
   ```

4. **Use progress callbacks for observability:**
   ```typescript
   { onProgress: (e) => logger.info(e) }
   ```

5. **Restrict tools for simple queries:**
   ```typescript
   { allowFileReading: false } // Default behavior
   ```

## License

MIT
