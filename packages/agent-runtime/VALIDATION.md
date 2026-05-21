# Agent Runtime Validation

## Automated Checks

Run from the repository root:

```bash
pnpm --filter cyrus-agent-runtime typecheck
pnpm --filter cyrus-agent-runtime test:run
pnpm --filter cyrus-agent-runtime build
```

Current coverage:

- Harness command construction and transcript parsing for Claude, Codex, Cursor, Gemini, PI, and OpenCode.
- Local sandbox filesystem and command execution.
- ComputeSDK sandbox wrapper with fake provider.
- Session lifecycle, queued messages, setup commands, transcript events, and result extraction.

## Real Local Harness Smoke

This validates `AgentRuntime`, the local sandbox provider, real `codex exec --json`, transcript event parsing, and result extraction.

```bash
node --input-type=module -e "
  import { createAgentSession } from './packages/agent-runtime/dist/index.js';
  const session = await createAgentSession({
    sessionId: 'smoke-codex',
    harness: { kind: 'codex', model: 'gpt-5.2' },
    userPrompt: 'Reply exactly: runtime smoke ok',
    sandbox: { provider: 'local', workingDirectory: process.cwd() }
  });
  const result = await session.start();
  console.log(JSON.stringify({
    success: result.success,
    result: result.result,
    eventCount: result.events.length
  }));
"
```

Observed result:

```json
{"success":true,"result":"runtime smoke ok","eventCount":4}
```

## Real Daytona Harness Smoke

This validates the full remote path: `AgentRuntime`, real ComputeSDK Daytona provider, remote sandbox create/destroy, declarative setup commands inside the sandbox, remote Cursor Agent install, real `cursor-agent --print --output-format stream-json`, transcript events emitted by the agent session running inside Daytona, and result extraction.

Prerequisites:

- `DAYTONA_API_KEY` in the environment.
- `CURSOR_API_KEY` in the environment.
- The package has been built with `pnpm --filter cyrus-agent-runtime build`.

Run from `packages/agent-runtime`:

```bash
node --input-type=module - <<'JS'
import { daytona } from '@computesdk/daytona';
import { createAgentSession } from './dist/index.js';
import { createComputeSdkSandboxProvider } from './dist/sandbox/compute-sdk.js';

const provider = createComputeSdkSandboxProvider({
  compute: daytona({ apiKey: process.env.DAYTONA_API_KEY, timeout: 300000 }),
});
const transcriptKinds = [];
const transcriptRawTypes = [];
let sandboxToDestroy;
const trackingProvider = {
  provider: 'daytona',
  async create(config) {
    const sandbox = await provider.create(config);
    sandboxToDestroy = sandbox;
    return sandbox;
  },
};

try {
  const session = await createAgentSession(
    {
      sessionId: 'daytona-cursor-smoke',
      harness: {
        kind: 'cursor',
        command: '/home/daytona/.local/bin/cursor-agent',
      },
      userPrompt: 'Reply exactly: daytona cursor event smoke ok',
      env: {
        PATH: '/home/daytona/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      },
      secrets: {
        CURSOR_API_KEY: process.env.CURSOR_API_KEY,
      },
      packages: {
        commands: [
          'curl https://cursor.com/install -fsS | bash',
          '/home/daytona/.local/bin/cursor-agent --version',
        ],
      },
      sandbox: {
        provider: 'daytona',
        name: `agent-runtime-cursor-${Date.now()}`,
        workingDirectory: '/home/daytona',
        timeoutMs: 300000,
        metadata: { purpose: 'agent-runtime-cursor-event-smoke' },
      },
    },
    {
      sandboxProviders: { daytona: trackingProvider },
      callbacks: {
        onTranscriptEvent(event) {
          transcriptKinds.push(event.kind);
          if (event.raw && typeof event.raw === 'object' && 'type' in event.raw) {
            transcriptRawTypes.push(event.raw.type);
          }
        },
      },
    },
  );

  const result = await session.start();
  console.log(JSON.stringify({
    success: result.success,
    result: result.result,
    eventCount: result.events.length,
    transcriptKinds,
    transcriptRawTypes,
    sandboxId: sandboxToDestroy?.sandboxId,
  }));
} finally {
  if (sandboxToDestroy) {
    await sandboxToDestroy.destroy();
  }
}
JS
```

Observed result:

```json
{
  "success": true,
  "result": "daytona cursor event smoke ok",
  "eventCount": 8,
  "transcriptKinds": [
    "setup.started",
    "setup.completed",
    "setup.started",
    "setup.completed",
    "system",
    "user",
    "assistant",
    "result"
  ],
  "transcriptRawTypes": ["system", "user", "assistant", "result"]
}
```

## Real Daytona Codex Auth Probe

Codex was validated inside Daytona through runtime-managed sensitive file materialization:

- `~/.codex/auth.json` was written with `sensitive: true`, and transcript events redacted the content.
- `@openai/codex` installed successfully inside Daytona.
- `codex exec --json --skip-git-repo-check` emitted `thread.started` and `turn.started`.
- Passing only `OPENAI_API_KEY` from local Codex auth produced a remote 401.
- Using `~/.codex/auth.json` authenticated, but the turn hit the account usage limit before completion.

Observed authenticated-but-limited result:

```json
{
  "success": false,
  "exitCode": 1,
  "events": [
    {
      "kind": "error",
      "raw": {
        "type": "error",
        "message": "You've hit your usage limit..."
      }
    },
    {
      "kind": "turn.failed"
    }
  ]
}
```

## Real Daytona Claude Smoke

Claude Code was validated inside Daytona with an explicit portable Claude Code OAuth token provided as a secret environment variable:

- `@anthropic-ai/claude-code` installed successfully with a user-local npm prefix.
- `claude --version` returned `2.1.142 (Claude Code)`.
- `claude -p ... --output-format stream-json --verbose` emitted `system`, `assistant`, and `result` events inside Daytona.
- The remote Claude session completed successfully with the exact requested result.

Observed runtime result:

```json
{
  "success": true,
  "exitCode": 0,
  "result": "daytona claude event smoke ok",
  "eventCount": 9,
  "eventKinds": [
    "setup.started",
    "setup.completed",
    "setup.started",
    "setup.completed",
    "setup.started",
    "setup.completed",
    "system",
    "assistant",
    "result",
    "stop.requested"
  ],
  "transcriptKinds": ["system", "assistant", "result"]
}
```
