import type { SDKMessage } from "cyrus-claude-runner";
import { AgentSessionStatus, type ILogger, LogLevel } from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";

function createLogger(): ILogger {
	const logger: ILogger = {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		event: vi.fn(),
		withContext: vi.fn(() => logger),
		getLevel: vi.fn(() => LogLevel.DEBUG),
		setLevel: vi.fn(),
	};
	return logger;
}

describe("AgentSessionManager SDK 0.3.323 lifecycle messages", () => {
	it("treats hook, tool, and authentication progress as non-durable signals", async () => {
		const logger = createLogger();
		const manager = new AgentSessionManager(undefined, undefined, logger);
		const session = manager.createCyrusAgentSession(
			"cyrus-session",
			"issue-1",
			{
				id: "issue-1",
				identifier: "TEST-1",
				title: "SDK lifecycle",
				description: "Verify progress handling",
				branchName: "test-1",
			},
			{ path: "/tmp/test-1", isGitWorktree: false },
		);

		const messages = [
			{
				type: "system",
				subtype: "hook_progress",
				hook_id: "hook-1",
				hook_name: "PreToolUse",
				hook_event: "PreToolUse",
				stdout: "still running",
				stderr: "",
				output: "still running",
				uuid: "uuid-1",
				session_id: "claude-session",
			},
			{
				type: "tool_progress",
				tool_use_id: "tool-1",
				tool_name: "Bash",
				parent_tool_use_id: null,
				elapsed_time_seconds: 30,
				heartbeat: true,
				uuid: "uuid-2",
				session_id: "claude-session",
			},
			{
				type: "auth_status",
				isAuthenticating: true,
				output: ["Waiting for MCP authentication"],
				uuid: "uuid-3",
				session_id: "claude-session",
			},
		] as SDKMessage[];

		for (const message of messages) {
			await manager.handleClaudeMessage("cyrus-session", message);
		}

		expect(session.status).toBe(AgentSessionStatus.Active);
		expect(logger.warn).not.toHaveBeenCalled();
		expect(logger.error).not.toHaveBeenCalled();
	});
});
