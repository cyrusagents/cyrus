import { createRequire } from "node:module";
import type { SDKMessage } from "@cursor/sdk";
import type {
	HarnessAdapter,
	HarnessRunOptions,
	NormalizedAgentSessionConfig,
} from "../types.js";
import { createCommand, parseJsonLine, resolveModel } from "./common.js";

/**
 * Host-side fallback path to the `@cyrus-ai/cursor-runner` CLI, resolved
 * once at module load via Node's standard module resolution.
 *
 * Used when the caller does NOT supply `harness.command` — i.e. for the
 * local provider, where `@cyrus-ai/cursor-runner` ships under the host's
 * `node_modules/` and `createRequire` finds it there.
 *
 * For the daytona provider, callers should supply `harness.command`
 * pointing at the runner inside the sandbox (typically `"cursor-runner"`
 * resolved via PATH, since snapshots ship the runner preinstalled
 * alongside the harness binaries — same model as `DAYTONA_CLAUDE_CLI_PATH`).
 *
 * Why a separately published package: `@cyrus-ai/cursor-runner` is a thin
 * SDK driver that wraps `@cursor/sdk` and emits `SDKMessage` events as
 * JSONL — exactly the wire format `parseJsonLine` parses below. Owning
 * the producer means the cursor stream IS the SDK union by construction
 * (no schema drift), and shipping it as a standalone CLI keeps the
 * Cursor `@cursor/sdk` runtime dependency out of agent-runtime's
 * surface (it's a devDep here, just for the `SDKMessage` type import).
 *
 * Resolved with `createRequire(import.meta.url)` rather than a relative
 * `import.meta.url` URL so the path follows wherever pnpm/npm linked
 * the package — right behavior for both workspace symlinks and
 * node_modules installs on the host.
 */
const HOST_CURSOR_RUNNER_PATH = createRequire(import.meta.url).resolve(
	"@cyrus-ai/cursor-runner",
);

export const cursorHarness: HarnessAdapter = {
	kind: "cursor",
	// Cursor's SDK does support agent resume via `Agent.resume(agentId)`,
	// but the agentId lives in our driver's process state, not in a
	// filesystem state directory — we persist it via `--agent-id-file`
	// (a sibling of the session's state backing). No HOME-relative
	// directory to declare here.
	stateDirectories: [],
	buildCommand(
		config: NormalizedAgentSessionConfig,
		options: HarnessRunOptions,
	) {
		// We invoke `@cyrus-ai/cursor-runner` instead of `cursor-agent` so the
		// wire format matches `@cursor/sdk`'s `SDKMessage` union by
		// construction. See `@cyrus-ai/cursor-runner`'s README for the why.
		//
		// Two invocation shapes:
		// - When `harness.command` is set (daytona snapshots), it's the
		//   path to (or name of) the `cursor-runner` bin inside the
		//   sandbox. The bin has a `#!/usr/bin/env node` shebang, so we
		//   spawn it directly. Caller-provided value flows through
		//   verbatim — `"cursor-runner"` to use PATH resolution,
		//   absolute path to pin a specific copy.
		// - When `harness.command` is unset (local provider), we fall
		//   back to spawning the host-resolved runner via `node <path>`.
		//   `node` rather than direct exec because the resolved path
		//   points at the package's `dist/index.js` inside pnpm's
		//   .pnpm store, which may not be marked executable.
		const command = config.harness.command ?? "node";
		const args =
			config.harness.command !== undefined
				? ["--prompt", options.userPrompt]
				: [HOST_CURSOR_RUNNER_PATH, "--prompt", options.userPrompt];

		const model = resolveModel(config);
		if (model) {
			args.push("--model", model);
		}

		// Working directory inside the sandbox — Cursor's local-agent
		// mode needs an explicit cwd so it knows where to walk file
		// contexts from.
		if (config.sandbox?.workingDirectory) {
			args.push("--cwd", config.sandbox.workingDirectory);
		}

		// systemPrompt is prepended to the user prompt by the driver
		// (Cursor doesn't expose a separate system-instructions field
		// at the local-agent layer the way Claude does).
		if (config.systemPrompt && !options.continueSession) {
			args.push("--system-prompt", config.systemPrompt);
		}

		// Cross-turn resume: caller persists the agentId returned in a
		// prior AgentSessionResult.harnessSessionId and hands it back as
		// `config.resumeHarnessSessionId`. The cursor-runner translates
		// it to `Agent.resume(<id>)` via its `--agent-id` flag, so the
		// run picks up the prior conversation. Driver-side
		// `--agent-id-file` still works for callers that want the runner
		// to record the agentId itself; we just don't need it from this
		// adapter because the runtime now surfaces the id via
		// extractSessionId below.
		if (config.resumeHarnessSessionId) {
			args.push("--agent-id", config.resumeHarnessSessionId);
		}

		return createCommand(config, command, args);
	},
	parseStdoutLine(line, context) {
		return parseJsonLine("cursor", line, context);
	},
	extractResult(events) {
		// Walk backwards for the last assistant text block. The driver
		// emits `SDKMessage` directly, so `event.raw.type === "assistant"`
		// narrows to `SDKAssistantMessage` with full content typing —
		// no manual guards.
		for (let i = events.length - 1; i >= 0; i -= 1) {
			const event = events[i];
			if (!event) continue;
			const raw = event.raw as SDKMessage | undefined;
			if (raw?.type !== "assistant") continue;
			for (const block of raw.message.content) {
				if (block.type === "text" && typeof block.text === "string") {
					return block.text;
				}
			}
		}
		return undefined;
	},
	buildStateEnv(mountPath) {
		// `@cursor/sdk`'s local mode persists agents to a sqlite db under
		// `$CURSOR_DATA_DIR` (default `~/.cursor/`). Joining `.cursor` under
		// the runtime's shared state mount keeps the layout identical to
		// a local install while leaving room for other harnesses to share
		// the same persistent-state binding.
		return { CURSOR_DATA_DIR: `${mountPath}/.cursor` };
	},
	extractSessionId(events) {
		// `@cursor/sdk` puts `agent_id` on every SDKMessage variant
		// (status, tool_call, assistant, user, thinking, request, task,
		// system). It's stable across the run — first event on the
		// stream carries the canonical id, and it doesn't change after.
		// Scan in arrival order and return the first non-empty value.
		//
		// `event.raw` is typed `SDKMessage` for `harness: "cursor"`, but
		// runtime lifecycle events (e.g. plain text from stderr) emit
		// strings or other shapes through the same stream. Guard with a
		// plain-object check before peeking at `agent_id`.
		for (const event of events) {
			const raw = event.raw;
			if (typeof raw !== "object" || raw === null) continue;
			const agentId = (raw as { agent_id?: unknown }).agent_id;
			if (typeof agentId === "string" && agentId.length > 0) {
				return agentId;
			}
		}
		return undefined;
	},
};
