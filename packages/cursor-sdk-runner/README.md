# @cyrus-ai/cursor-runner

A thin CLI wrapper around [`@cursor/sdk`](https://www.npmjs.com/package/@cursor/sdk).
Spawns a Cursor agent, runs one prompt, and emits each `SDKMessage` the SDK
produces as a JSONL line on stdout.

The point: **type-safe streaming across a process boundary**. Every line on
stdout is an `SDKMessage` from `@cursor/sdk`, so the consumer can import the
same SDK types and narrow `JSON.parse(line)` with zero drift risk. Compare
to invoking `cursor-agent --output-format stream-json` directly — that
CLI's JSONL schema is different from the SDK's union and is not
version-pinned to anything you can `import` against.

This package exists primarily to be spawned by
[`cyrus-agent-runtime`](https://www.npmjs.com/package/cyrus-agent-runtime)'s
cursor harness, but it's a perfectly usable standalone tool if you want
typed Cursor streaming from any process.

## Install

```sh
npm install -g @cyrus-ai/cursor-runner
```

## Use

```sh
export CURSOR_API_KEY=cursor_…   # required

cursor-runner \
  --prompt "Patch the bug in src/utils.ts" \
  --model composer-2 \
  --cwd /path/to/repo
```

### Options

| Flag | Required | Description |
|---|---|---|
| `--prompt <text>` | yes | The user prompt sent to the agent. |
| `--model <id>` | no | Model ID. Run `Cursor.models.list()` for valid IDs (`composer-2`, `gpt-5`, etc.). |
| `--cwd <dir>` | no | Working directory the local agent operates against. Defaults to `process.cwd()`. |
| `--system-prompt <text>` | no | Prepended to `--prompt`. Cursor's local-agent surface doesn't have a separate system-instructions field at this layer. |
| `--agent-id <id>` | no | Resume an existing agent (cross-turn continuation). |
| `--agent-id-file <path>` | no | After `Agent.create()`, writes the new agentId to this file so a follow-up turn can pass it back via `--agent-id`. |

### Exit codes

- `0` — completed successfully
- `1` — runtime error (stream failure, agent error)
- `2` — misuse (missing `--prompt`, missing `CURSOR_API_KEY`, etc.)

### Wire format

Each line on stdout is a JSON-serialized `SDKMessage` from `@cursor/sdk`.
The union includes (variant of `type`):

- `system` — `subtype: "init"`, agent + model info
- `user` — your prompt as the SDK saw it
- `assistant` — streamed assistant content blocks
- `tool_call` — `status: "running" | "completed" | "error"` lifecycle
- `thinking` — extended-thinking blocks
- `status` — agent state changes (`RUNNING`, `FINISHED`, etc.)
- `request`, `task` — other lifecycle signals

Consumers should import the SDK type and narrow:

```ts
import type { SDKMessage } from "@cursor/sdk";

for await (const line of readlines(child.stdout)) {
  const msg = JSON.parse(line) as SDKMessage;
  switch (msg.type) {
    case "assistant": /* msg.message.content is BetaContentBlock[] */ break;
    case "tool_call": /* msg.status, msg.name, msg.args, msg.result */ break;
    // …
  }
}
```

## Why a separate package?

`@cursor/sdk` is a TypeScript library; using it from another process requires
either bundling it into every consumer or hosting it behind a stable
CLI. This is that CLI. Keeping it small and dedicated means consumers don't
need a heavyweight runtime to get typed Cursor streaming.

## License

MIT
