# @atmiko/gemini-runner

A TypeScript wrapper around the Gemini CLI that provides a provider-agnostic interface for running Gemini AI sessions. This package mirrors the architecture of `@atmiko/claude-runner` while adapting to Gemini CLI's streaming format and session management.

## Overview

The `gemini-runner` package provides two main classes:

- **GeminiRunner**: Full-featured wrapper around Gemini CLI with streaming support, event handling, and message format conversion
- **SimpleGeminiRunner**: Simplified interface for enumerated response use cases (yes/no, multiple choice, etc.)

Both classes implement standard interfaces from `atmiko-core`, making them interchangeable with other AI runner implementations like `ClaudeRunner`.

## Installation

```bash
pnpm add @atmiko/gemini-runner
```

### Prerequisites

1. **Gemini CLI**: Install the Gemini CLI and ensure it's in your PATH:
   ```bash
   # Installation instructions depend on your platform
   # Verify installation:
   gemini --version
   ```

2. **Gemini API Credentials**: Configure your Gemini API credentials according to the Gemini CLI documentation.

## Quick Start

### Basic Usage with GeminiRunner

```typescript
import { GeminiRunner } from '@atmiko/gemini-runner';

const runner = new GeminiRunner({
  atmikoHome: '/path/to/.atmiko',
  workingDirectory: '/path/to/project',
  model: 'gemini-2.5-flash',
  autoApprove: true  // Enable --yolo flag
});

// Listen for events
runner.on('message', (message) => {
  console.log('New message:', message);
});

runner.on('complete', (messages) => {
  console.log('Session complete! Total messages:', messages.length);
});

// Start a session
await runner.start("Analyze this codebase and suggest improvements");

// Get all messages
const messages = runner.getMessages();
```

### Simple Enumerated Responses with SimpleGeminiRunner

```typescript
import { SimpleGeminiRunner } from '@atmiko/gemini-runner';

const runner = new SimpleGeminiRunner({
  validResponses: ['yes', 'no', 'maybe'],
  atmikoHome: '/path/to/.atmiko',
  workingDirectory: '/path/to/project',
  model: 'gemini-2.5-flash',
  maxTurns: 5,
  onProgress: (event) => {
    console.log(`Progress: ${event.type}`);
  }
});

const result = await runner.query('Is this code correct?');
console.log(`Response: ${result.response}`); // Guaranteed to be 'yes', 'no', or 'maybe'
console.log(`Cost: $${result.cost.toFixed(4)}`);
```

## Core Concepts

### GeminiRunner

`GeminiRunner` is the primary class for interacting with the Gemini CLI. It:

- Spawns the Gemini CLI process in headless mode (`--output-format stream-json`)
- Translates between Gemini CLI's JSON streaming format and Claude SDK message types
- Manages session lifecycle (start, stop, status)
- Provides event-based communication
- Creates detailed logs in both NDJSON and human-readable formats
- Supports both string prompts and streaming prompts

**Key Features**:
- **Provider-agnostic interface**: Implements `IAgentRunner` for compatibility with other runners
- **Event system**: Subscribe to `message`, `error`, `complete`, and `streamEvent` events
- **Streaming support**: Add messages incrementally with `addStreamMessage()`
- **Session management**: Track session state with `isRunning()` and `getMessages()`
- **MCP server support**: Configure Model Context Protocol servers (inherited from `IAgentRunner`)

### SimpleGeminiRunner

`SimpleGeminiRunner` extends `SimpleAgentRunner` to provide a streamlined interface for enumerated response scenarios:

- Validates responses against a predefined set of valid answers
- Handles timeout management automatically
- Cleans responses (removes markdown, code blocks, quotes)
- Emits progress events (thinking, tool-use, validating)
- Builds system prompts with valid response constraints
- Extracts cost information from result messages

**Use Cases**:
- Yes/No questions
- Multiple choice selection
- Status confirmations
- Classification tasks

## API Reference

### GeminiRunner

#### Constructor Options

```typescript
interface GeminiRunnerConfig extends IAgentRunnerConfig {
  // Gemini-specific options
  geminiPath?: string;        // Path to gemini CLI (default: 'gemini')
  autoApprove?: boolean;      // Enable --yolo flag (default: false)
  approvalMode?: 'auto_edit' | 'auto' | 'manual';  // Approval mode
  debug?: boolean;            // Enable debug output

  // Inherited from IAgentRunnerConfig
  model?: string;             // Model to use (e.g., 'gemini-2.5-flash')
  atmikoHome: string;          // Home directory for logs
  workingDirectory: string;   // Working directory for Gemini
  systemPrompt?: string;      // System prompt for session
  mcpServers?: MCPServerConfig[];  // MCP server configurations
  env?: Record<string, string>;    // Environment variables
}
```

#### Methods

**start(prompt: string): Promise<void>**
- Start a new session with a string prompt
- Throws if a session is already running

**startStreaming(initialPrompt?: string): Promise<void>**
- Start a new session with streaming input capability
- Optionally provide an initial prompt
- Use `addStreamMessage()` to add more messages
- Call `completeStream()` when done

**addStreamMessage(content: string): void**
- Add a message to an active streaming session
- Must be called after `startStreaming()`

**completeStream(): void**
- Signal the end of streaming input
- Session will continue processing

**stop(): Promise<void>**
- Terminate the current session
- Kills the Gemini CLI process

**getMessages(): SDKMessage[]**
- Retrieve all messages from the current session
- Returns both user and assistant messages

**isRunning(): boolean**
- Check if a session is currently active

#### Events

**'message'**: `(message: SDKMessage) => void`
- Emitted when a new message is received from Gemini

**'error'**: `(error: Error) => void`
- Emitted when an error occurs

**'complete'**: `(messages: SDKMessage[]) => void`
- Emitted when the session completes successfully

**'streamEvent'**: `(event: GeminiStreamEvent) => void`
- Emitted for raw Gemini CLI events (for debugging)

### SimpleGeminiRunner

#### Constructor Options

```typescript
interface SimpleGeminiRunnerConfig {
  validResponses: string[];   // REQUIRED: Valid response options
  atmikoHome: string;          // REQUIRED: Home directory for logs
  workingDirectory?: string;  // Working directory (default: cwd)
  model?: string;             // Model to use (default: 'gemini-2.5-flash')
  systemPrompt?: string;      // Additional system prompt
  maxTurns?: number;          // Max conversation turns (default: 10)
  timeout?: number;           // Timeout in ms (default: 300000)
  onProgress?: (event: SimpleAgentProgressEvent) => void;
  mcpServers?: MCPServerConfig[];
  env?: Record<string, string>;
}
```

#### Methods

**query(prompt: string, options?: SimpleAgentQueryOptions): Promise<SimpleAgentResult>**
- Execute a query and get a validated response
- Returns an object with `response`, `cost`, and `messages`

```typescript
interface SimpleAgentResult {
  response: string;           // Validated response (one of validResponses)
  cost: number;               // Total cost in dollars
  messages: SDKMessage[];     // All messages from session
}
```

## Adapter Pattern

The package uses an adapter pattern to translate between Gemini CLI's JSON streaming format and Claude SDK message types. This allows the runner to integrate seamlessly with other parts of the Atmiko ecosystem.

### Message Format Conversion

**Gemini Stream Events → SDK Messages**:
- `GeminiInitEvent` → Session ID extraction
- `GeminiMessageEvent` (user) → `SDKUserMessage`
- `GeminiMessageEvent` (assistant) → `SDKAssistantMessage`
- `GeminiToolUseEvent` → `SDKAssistantMessage` with `tool_use` content block
- `GeminiToolResultEvent` → `SDKUserMessage` with `tool_result` content block
- `GeminiResultEvent` (success) → `SDKAssistantMessage` with final response

**Key Differences from Claude**:
- Gemini uses simple `{type, role, content}` for messages
- SDK uses `{type, message: {role, content}, session_id, ...}` structure
- Tool use IDs are generated client-side for Gemini (`${tool_name}_${timestamp}`)
- Session ID is "pending" until init event is received from Gemini CLI

## Differences from ClaudeRunner

While `GeminiRunner` mirrors the architecture of `ClaudeRunner`, there are some key differences:

| Aspect | ClaudeRunner | GeminiRunner |
|--------|--------------|--------------|
| CLI Command | `claude --output-format ndjson` | `gemini --output-format stream-json` |
| Session ID | Generated client-side or via `--continue` | Assigned by CLI in init event |
| Stream Format | NDJSON with SDK-compatible messages | Custom JSON format requiring adapter |
| Tool Use IDs | Native SDK format | Generated client-side |
| Auto-Approval | Approval callbacks or flags | `--yolo` flag and `--approval-mode` |
| System Prompts | Native CLI support | Accepted in config (CLI handling TBD) |

## Supported Models

The package supports Gemini 2.5 and later models. Common model identifiers:

- `gemini-2.5-flash` - Fast, cost-effective model
- `gemini-2.5-pro` - Advanced reasoning and complex tasks
- Additional models as supported by the Gemini CLI

Specify the model in the configuration:

```typescript
const runner = new GeminiRunner({
  model: 'gemini-2.5-flash',
  // ... other options
});
```

## Configuration

### Environment Variables

The package respects standard Gemini CLI environment variables for API credentials. Refer to the Gemini CLI documentation for setup instructions.

### Log Files

Both runners create detailed logs in the `atmikoHome` directory:

- `{atmikoHome}/logs/{workspaceName}/{sessionId}.ndjson` - NDJSON event log
- `{atmikoHome}/logs/{workspaceName}/{sessionId}.log` - Human-readable log

### MCP Server Configuration

Configure Model Context Protocol servers for enhanced capabilities:

```typescript
const runner = new GeminiRunner({
  atmikoHome: '/path/to/.atmiko',
  workingDirectory: '/path/to/project',
  mcpServers: [
    {
      name: 'linear',
      type: 'http',
      url: 'https://mcp.linear.app',
      headers: {
        'Authorization': 'Bearer YOUR_TOKEN'
      }
    }
  ]
});
```

## Examples

See the `examples/` directory for complete working examples:

- `basic-usage.ts` - Basic GeminiRunner usage with event handling
- `simple-agent-example.ts` - SimpleGeminiRunner for enumerated responses

To run the examples:

```bash
cd packages/gemini-runner
pnpm build
node examples/basic-usage.js  # Or .ts with ts-node
```

## Troubleshooting

### Common Issues

**"gemini: command not found"**
- Ensure the Gemini CLI is installed and in your PATH
- Or specify the full path in the config: `geminiPath: '/path/to/gemini'`

**"Session already running"**
- You can only have one active session per GeminiRunner instance
- Call `stop()` before starting a new session, or create a new instance

**"Invalid response from Gemini"**
- Check that your validResponses match the expected output format
- Use the `onProgress` callback to see raw responses during validation
- Verify the system prompt is being respected by the model

**Empty messages array**
- The session may have errored before producing any messages
- Check the `error` event for details
- Review the log files in `{atmikoHome}/logs/`

**Response validation fails with SimpleGeminiRunner**
- Increase `maxTurns` to allow more attempts
- Simplify your `validResponses` list
- Check if the model is producing markdown or code blocks (automatically cleaned)
- Use `onProgress` to debug what responses are being received

**Timeout errors**
- Increase the `timeout` option (default: 300000ms / 5 minutes)
- Check if the Gemini CLI is hanging on approval prompts (use `autoApprove: true`)
- Verify your working directory is accessible and doesn't have permission issues

### Debug Mode

Enable debug mode for detailed logging:

```typescript
const runner = new GeminiRunner({
  debug: true,
  // ... other options
});
```

### Log Analysis

Check the NDJSON log files for detailed event information:

```bash
cat ~/.atmiko/logs/my-workspace/{session-id}.ndjson | jq .
```

Or the human-readable log:

```bash
cat ~/.atmiko/logs/my-workspace/{session-id}.log
```

## Development

### Building

```bash
pnpm build
```

### Running Tests

```bash
pnpm test        # Watch mode
pnpm test:run    # Run once
```

### Type Checking

```bash
pnpm typecheck
```

## Related Packages

- `@atmiko/core` - Core types and interfaces
- `@atmiko/claude-runner` - Claude CLI wrapper (similar architecture)
- `@atmiko/simple-agent-runner` - Abstract base for simple enumerated responses

## License

MIT

## Support

For issues and feature requests, please use the project's issue tracker.
