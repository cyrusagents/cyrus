import { describe, expect, it } from "vitest";
import {
	buildHarnessInvocation,
	getHarnessAdapter,
	harnessAdapters,
} from "../src/harnesses/index.js";
import type { NormalizedAgentSessionConfig } from "../src/types.js";

const baseConfig: NormalizedAgentSessionConfig = {
	sessionId: "session-1",
	harness: { kind: "claude" },
	env: {},
	secrets: {},
	sandbox: {
		provider: "local",
		workingDirectory: "/tmp/worktree",
	},
};

describe("harness adapters", () => {
	it("registers every supported harness kind", () => {
		expect(Object.keys(harnessAdapters).sort()).toEqual([
			"claude",
			"codex",
			"cursor",
			"gemini",
			"opencode",
		]);
	});

	it("builds a Claude stream-json command", () => {
		const command = buildHarnessInvocation(
			{
				...baseConfig,
				model: "claude-sonnet-4-5",
				systemPrompt: "Be concise",
				permissions: {
					mode: "ask",
					allowedTools: ["Read(**)", "Edit(**)"],
					disallowedTools: ["Bash"],
				},
			},
			{ userPrompt: "Fix the failing test" },
		);

		expect(command.command).toBe("claude");
		expect(command.args).toEqual([
			"-p",
			"Fix the failing test",
			"--output-format",
			"stream-json",
			"--verbose",
			"--model",
			"claude-sonnet-4-5",
			"--append-system-prompt",
			"Be concise",
			// "ask" maps to Claude's "default" — Claude's CLI does not
			// accept "ask" verbatim.
			"--permission-mode",
			"default",
			"--allowedTools",
			"Read(**),Edit(**)",
			"--disallowedTools",
			"Bash",
		]);
	});

	it("maps Cyrus's PermissionMode 'bypass' to Claude's 'bypassPermissions'", () => {
		const command = buildHarnessInvocation(
			{
				...baseConfig,
				permissions: { mode: "bypass" },
			},
			{ userPrompt: "do it" },
		);
		expect(command.args).toContain("--permission-mode");
		const idx = command.args.indexOf("--permission-mode");
		expect(command.args[idx + 1]).toBe("bypassPermissions");
	});

	it("appends --resume when resumeHarnessSessionId is set", () => {
		const command = buildHarnessInvocation(
			{
				...baseConfig,
				resumeHarnessSessionId: "abc-uuid",
			},
			{ userPrompt: "next turn" },
		);
		expect(command.args).toContain("--resume");
		const resumeAt = command.args.indexOf("--resume");
		expect(command.args[resumeAt + 1]).toBe("abc-uuid");
	});

	it("extracts the harness-native session id from Claude's init event", () => {
		const adapter = getHarnessAdapter("claude");
		const sessionId = adapter.extractSessionId?.([
			{
				sessionId: "cy-1",
				harness: "claude",
				timestamp: new Date().toISOString(),
				kind: "system",
				raw: {
					type: "system",
					subtype: "init",
					session_id: "claude-uuid-42",
				},
			},
		]);
		expect(sessionId).toBe("claude-uuid-42");
	});

	it("returns undefined when no event carries a session id", () => {
		const adapter = getHarnessAdapter("claude");
		const sessionId = adapter.extractSessionId?.([
			{
				sessionId: "cy-1",
				harness: "claude",
				timestamp: new Date().toISOString(),
				kind: "text",
				raw: "no session id here",
			},
		]);
		expect(sessionId).toBeUndefined();
	});

	it("builds a Codex JSON command", () => {
		const command = buildHarnessInvocation(
			{
				...baseConfig,
				harness: { kind: "codex" },
				model: "gpt-5.3-codex",
				systemPrompt: "Use the repo style",
				permissions: { mode: "auto" },
			},
			{ userPrompt: "Implement the feature" },
		);

		expect(command.command).toBe("codex");
		expect(command.args).toEqual([
			"exec",
			"--json",
			"--skip-git-repo-check",
			"--model",
			"gpt-5.3-codex",
			"-c",
			'developer_instructions="Use the repo style"',
			"-c",
			'approval_policy="auto"',
			"Implement the feature",
		]);
	});

	it("builds a Cursor command via the host-resolved @cyrus-ai/cursor-runner when harness.command is unset", () => {
		const command = buildHarnessInvocation(
			{
				...baseConfig,
				harness: { kind: "cursor" },
				model: "composer-2",
				permissions: { mode: "ask" },
			},
			{ userPrompt: "Patch the bug" },
		);

		// Local-provider path: no `harness.command` override, so the
		// adapter resolves `@cyrus-ai/cursor-runner` from the host's
		// node_modules and spawns `node <resolved-path>`. The exact
		// filesystem location depends on pnpm/npm linking, so we
		// assert the entry filename instead of pinning the whole path.
		expect(command.command).toBe("node");
		const runnerPath = command.args[0]!;
		expect(runnerPath).toMatch(/cursor-(sdk-)?runner[/\\]dist[/\\]index\.js$/);
		expect(command.args.slice(1)).toEqual([
			"--prompt",
			"Patch the bug",
			"--model",
			"composer-2",
			"--cwd",
			"/tmp/worktree",
		]);
	});

	it("uses harness.command directly as the cursor-runner binary when supplied (Daytona-snapshot mode)", () => {
		const command = buildHarnessInvocation(
			{
				...baseConfig,
				harness: { kind: "cursor", command: "cursor-runner" },
				model: "composer-2",
				permissions: { mode: "ask" },
			},
			{ userPrompt: "Patch the bug" },
		);

		// Snapshot path: caller supplies `harness.command`, the adapter
		// spawns it directly (the runner's `#!/usr/bin/env node` shebang
		// makes it executable). The command is whatever the caller
		// passed — `"cursor-runner"` for PATH resolution inside the
		// sandbox, or an absolute path to pin a specific copy.
		expect(command.command).toBe("cursor-runner");
		expect(command.args).toEqual([
			"--prompt",
			"Patch the bug",
			"--model",
			"composer-2",
			"--cwd",
			"/tmp/worktree",
		]);
	});

	it("threads resumeHarnessSessionId into the cursor runner as --agent-id", () => {
		const command = buildHarnessInvocation(
			{
				...baseConfig,
				harness: { kind: "cursor", command: "cursor-runner" },
				resumeHarnessSessionId: "agent-74f4af34",
			},
			{ userPrompt: "carry on" },
		);

		// Spawning shape is unchanged — the resume flag is just
		// appended to args. The runner reads it and calls
		// Agent.resume(agent-74f4af34) instead of Agent.create().
		expect(command.command).toBe("cursor-runner");
		expect(command.args).toContain("--agent-id");
		const idx = command.args.indexOf("--agent-id");
		expect(command.args[idx + 1]).toBe("agent-74f4af34");
	});

	it("omits --agent-id when resumeHarnessSessionId is not set", () => {
		const command = buildHarnessInvocation(
			{
				...baseConfig,
				harness: { kind: "cursor", command: "cursor-runner" },
			},
			{ userPrompt: "fresh start" },
		);
		expect(command.args).not.toContain("--agent-id");
	});

	it("extracts the harness-native agent id from the first cursor SDKMessage", () => {
		const adapter = getHarnessAdapter("cursor");
		// Cursor's first stream event is typically a `status` message
		// with `agent_id` set — every SDKMessage variant carries it,
		// so any of them work. Use the realistic shape from a captured
		// run.
		const sessionId = adapter.extractSessionId?.([
			{
				sessionId: "cy-1",
				harness: "cursor",
				timestamp: new Date().toISOString(),
				kind: "status",
				raw: {
					type: "status",
					agent_id: "agent-74f4af34-9d01-4b98-b271-21ea87c68ca6",
					run_id: "run-dc52f12e-1269-49d1-907a-b6c399501c8d",
					status: "RUNNING",
				},
			},
			{
				sessionId: "cy-1",
				harness: "cursor",
				timestamp: new Date().toISOString(),
				kind: "assistant",
				raw: {
					type: "assistant",
					agent_id: "agent-74f4af34-9d01-4b98-b271-21ea87c68ca6",
					run_id: "run-dc52f12e-1269-49d1-907a-b6c399501c8d",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "hi" }],
					},
				},
			},
		]);
		expect(sessionId).toBe("agent-74f4af34-9d01-4b98-b271-21ea87c68ca6");
	});

	it("returns undefined when no cursor event carries an agent_id", () => {
		const adapter = getHarnessAdapter("cursor");
		const sessionId = adapter.extractSessionId?.([
			{
				sessionId: "cy-1",
				harness: "cursor",
				timestamp: new Date().toISOString(),
				kind: "text",
				raw: "no agent_id in a plain string event",
			},
		]);
		expect(sessionId).toBeUndefined();
	});

	it("builds a Gemini command with env-backed system prompt", () => {
		const command = buildHarnessInvocation(
			{
				...baseConfig,
				harness: { kind: "gemini" },
				systemPrompt: "System text",
				permissions: { mode: "bypass" },
			},
			{ userPrompt: "Analyze this" },
		);

		expect(command.command).toBe("gemini");
		expect(command.args).toEqual([
			"--output-format",
			"stream-json",
			"--model",
			"gemini-2.5-pro",
			"--yolo",
			"--approval-mode",
			"bypass",
			"-p",
			"Analyze this",
		]);
		expect(command.env?.GEMINI_SYSTEM_MD).toBe("System text");
	});

	it("supports harness command and arg overrides", () => {
		const command = buildHarnessInvocation(
			{
				...baseConfig,
				harness: {
					kind: "codex",
					command: "/opt/bin/codex-dev",
					args: ["--config", "profile=dev"],
				},
			},
			{ userPrompt: "Run it" },
		);

		expect(command.command).toBe("/opt/bin/codex-dev");
		expect(command.args.slice(0, 2)).toEqual(["--config", "profile=dev"]);
		expect(command.args.slice(2)).toEqual([
			"exec",
			"--json",
			"--skip-git-repo-check",
			"Run it",
		]);
	});

	it("parses JSON stdout transcript lines", () => {
		const adapter = getHarnessAdapter("gemini");
		const event = adapter.parseStdoutLine(
			JSON.stringify({
				type: "tool_use",
				tool_name: "read_file",
				parameters: { path: "src/index.ts" },
			}),
			{
				sessionId: "session-1",
				harness: "gemini",
				now: () => new Date("2026-05-14T12:00:00.000Z"),
			},
		);

		expect(event).toMatchObject({
			sessionId: "session-1",
			harness: "gemini",
			timestamp: "2026-05-14T12:00:00.000Z",
			kind: "tool_use",
			normalized: {
				type: "tool_use",
				toolName: "read_file",
			},
		});
	});

	it("claude.buildStateEnv joins .claude under the mount path", () => {
		const adapter = getHarnessAdapter("claude");
		// `applyPersistentState` always passes the runtime-internal mount
		// point — adapters are expected to namespace under a fixed subdir
		// so two harnesses can share one binding without colliding.
		expect(adapter.buildStateEnv?.("/var/cyrus/harness-state")).toEqual({
			CLAUDE_CONFIG_DIR: "/var/cyrus/harness-state/.claude",
		});
	});

	it("cursor.buildStateEnv joins .cursor under the mount path", () => {
		const adapter = getHarnessAdapter("cursor");
		expect(adapter.buildStateEnv?.("/var/cyrus/harness-state")).toEqual({
			CURSOR_DATA_DIR: "/var/cyrus/harness-state/.cursor",
		});
	});

	it("codex.buildStateEnv sets CODEX_HOME to mount/.codex", () => {
		// Verified against `codex-rs/utils/home-dir/src/lib.rs::find_codex_home`
		// in openai/codex — `CODEX_HOME` is the only env var that
		// redirects the dir, no XDG fallback.
		const adapter = getHarnessAdapter("codex");
		expect(adapter.buildStateEnv?.("/var/cyrus/harness-state")).toEqual({
			CODEX_HOME: "/var/cyrus/harness-state/.codex",
		});
	});

	it("gemini.buildStateEnv sets GEMINI_CLI_HOME to the mount path itself", () => {
		// Verified against `@google/gemini-cli-core` →
		// `dist/src/utils/paths.js::homedir`: the env var replaces the
		// homedir, and `.gemini` is appended by the CLI itself. So we
		// hand it the mount path, not `mount/.gemini`.
		const adapter = getHarnessAdapter("gemini");
		expect(adapter.buildStateEnv?.("/var/cyrus/harness-state")).toEqual({
			GEMINI_CLI_HOME: "/var/cyrus/harness-state",
		});
	});

	it("opencode.buildStateEnv sets all four XDG dirs under .opencode-xdg", () => {
		// opencode has no single state-dir env var — it derives all four
		// storage roots from `xdg-basedir` and appends `/opencode` to each
		// (see `Global.make()` in sst/opencode). We scope under
		// `.opencode-xdg/` so we don't claim the XDG hierarchy for
		// unrelated tools that happen to run in the sandbox.
		const adapter = getHarnessAdapter("opencode");
		expect(adapter.buildStateEnv?.("/var/cyrus/harness-state")).toEqual({
			XDG_CONFIG_HOME: "/var/cyrus/harness-state/.opencode-xdg/config",
			XDG_DATA_HOME: "/var/cyrus/harness-state/.opencode-xdg/data",
			XDG_STATE_HOME: "/var/cyrus/harness-state/.opencode-xdg/state",
			XDG_CACHE_HOME: "/var/cyrus/harness-state/.opencode-xdg/cache",
		});
	});

	it("parses non-JSON stdout as text events and ignores blank lines", () => {
		const adapter = getHarnessAdapter("claude");

		expect(
			adapter.parseStdoutLine("   ", {
				sessionId: "session-1",
				harness: "claude",
			}),
		).toBeUndefined();
		expect(
			adapter.parseStdoutLine("plain output", {
				sessionId: "session-1",
				harness: "claude",
			}),
		).toMatchObject({
			sessionId: "session-1",
			harness: "claude",
			kind: "text",
			raw: "plain output",
		});
	});
});
