import type { SDKMessage, SDKRateLimitEvent } from "cyrus-claude-runner";
import {
	type AgentRunnerConfig,
	AgentSessionStatus,
	type EdgeWorkerConfig,
	type IAgentRunner,
} from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { RunnerFallbackController } from "../src/RunnerFallbackController.js";
import type { IActivitySink } from "../src/sinks/IActivitySink.js";

class FakeRunner {
	readonly supportsStreamingInput = true;
	readonly startStreaming = vi.fn(async () => ({
		sessionId: "codex-session",
		startedAt: new Date(),
		isRunning: false,
	}));
	readonly start = vi.fn();
	readonly stop = vi.fn();
	readonly isAvailable = vi.fn(async () => true);
	getFormatter = vi.fn();
}

const rejectedRateLimit = {
	type: "rate_limit_event",
	session_id: "claude-session",
	uuid: "rate-limit-1",
	rate_limit_info: {
		status: "rejected",
		rateLimitType: "five_hour",
		resetsAt: 1_800_000_000,
	},
} as SDKRateLimitEvent;

describe("RunnerFallbackController", () => {
	let manager: AgentSessionManager;
	let sink: IActivitySink;
	let oldRunner: FakeRunner;
	let codexRunner: FakeRunner;
	let config: EdgeWorkerConfig;
	let createRunner: ReturnType<typeof vi.fn>;
	const sessionId = "linear-session";

	beforeEach(() => {
		config = {
			repositories: [],
			runnerFallbacks: {
				claude: {
					runners: ["codex"],
					rateLimitTypes: ["five_hour"],
				},
			},
		} as unknown as EdgeWorkerConfig;
		manager = new AgentSessionManager();
		sink = {
			id: "linear",
			postActivity: vi.fn().mockResolvedValue({ activityId: "activity-id" }),
			createAgentSession: vi.fn(),
		};
		manager.createCyrusAgentSession(
			sessionId,
			"issue-1",
			{ id: "issue-1", identifier: "MEL-187", title: "Fallback" },
			{ path: "/tmp/worktree", isGitWorktree: true },
		);
		manager.setActivitySink(sessionId, sink);
		oldRunner = new FakeRunner();
		codexRunner = new FakeRunner();
		Object.defineProperty(codexRunner, "constructor", {
			value: { name: "CodexRunner" },
		});
		manager.addAgentRunner(sessionId, oldRunner as unknown as IAgentRunner);
		manager.getSession(sessionId)!.claudeSessionId = "claude-session";
		createRunner = vi.fn(() => codexRunner as unknown as IAgentRunner);
	});

	function register(selectionWasExplicit = false): RunnerFallbackController {
		const controller = new RunnerFallbackController({
			getConfig: () => config,
			sessionManager: manager,
			createRunner,
		});
		controller.registerTurn({
			sessionId,
			runnerType: "claude",
			selectionWasExplicit,
			prompt: "original prompt with attachments",
			buildConfig: vi.fn(
				async () =>
					({
						workingDirectory: "/tmp/worktree",
						allowedTools: ["Bash"],
						mcpConfig: { linear: { type: "sdk", name: "linear" } },
					}) as unknown as AgentRunnerConfig,
			),
		});
		manager.setRateLimitFallbackHandler((id, event) =>
			controller.handleRateLimit(id, event),
		);
		return controller;
	}

	it("switches an implicit Claude turn to Codex and suppresses Claude completion", async () => {
		register();

		await manager.handleClaudeMessage(sessionId, rejectedRateLimit);
		await manager.handleClaudeMessage(sessionId, {
			type: "result",
			subtype: "success",
			session_id: "claude-session",
			is_error: false,
			result: "misleading Claude success",
			total_cost_usd: 0,
			usage: {},
		} as unknown as SDKMessage);
		await manager.handleClaudeMessage(sessionId, {
			type: "assistant",
			session_id: "codex-session",
			message: {
				content: [{ type: "text", text: "Codex finished the work" }],
			},
		} as unknown as SDKMessage);
		await manager.handleClaudeMessage(sessionId, {
			type: "result",
			subtype: "success",
			session_id: "codex-session",
			is_error: false,
			result: "Codex finished the work",
			total_cost_usd: 0,
			usage: {},
		} as unknown as SDKMessage);

		expect(oldRunner.stop).toHaveBeenCalledOnce();
		expect(codexRunner.startStreaming).toHaveBeenCalledWith(
			"original prompt with attachments",
		);
		expect(createRunner).toHaveBeenCalledWith(
			"codex",
			expect.objectContaining({
				workingDirectory: "/tmp/worktree",
				allowedTools: ["Bash"],
				mcpConfig: expect.objectContaining({ linear: expect.any(Object) }),
			}),
		);
		expect(manager.getSession(sessionId)?.agentRunner).toBe(codexRunner);
		expect(manager.getSession(sessionId)?.claudeSessionId).toBeUndefined();
		expect(sink.postActivity).toHaveBeenCalledTimes(2);
		expect(sink.postActivity).toHaveBeenCalledWith(
			sessionId,
			expect.objectContaining({
				type: "thought",
				body: expect.stringMatching(/Claude quota.*continuing with Codex/i),
			}),
			{},
		);
		expect(vi.mocked(sink.postActivity).mock.calls[1]?.[1]).toEqual({
			type: "response",
			body: "Codex finished the work",
		});
		expect(
			vi
				.mocked(sink.postActivity)
				.mock.calls.some((call) =>
					JSON.stringify(call).includes("misleading Claude success"),
				),
		).toBe(false);
	});

	it("preserves an explicit Claude selector by default", async () => {
		register(true);

		await manager.handleClaudeMessage(sessionId, rejectedRateLimit);

		expect(createRunner).not.toHaveBeenCalled();
		expect(oldRunner.stop).not.toHaveBeenCalled();
	});

	it("allows explicit selectors when the policy opts in", async () => {
		config.runnerFallbacks!.claude!.overrideExplicitSelectors = true;
		register(true);

		await manager.handleClaudeMessage(sessionId, rejectedRateLimit);

		expect(createRunner).toHaveBeenCalledWith("codex", expect.any(Object));
	});

	it("does not fall back for warnings or unconfigured quota categories", async () => {
		register();

		await manager.handleClaudeMessage(sessionId, {
			...rejectedRateLimit,
			rate_limit_info: {
				...rejectedRateLimit.rate_limit_info,
				status: "allowed_warning",
			},
		} as SDKRateLimitEvent);
		await manager.handleClaudeMessage(sessionId, {
			...rejectedRateLimit,
			rate_limit_info: {
				...rejectedRateLimit.rate_limit_info,
				rateLimitType: "seven_day",
			},
		} as SDKRateLimitEvent);

		expect(createRunner).not.toHaveBeenCalled();
	});

	it("does not fall back for authentication or ordinary provider errors", async () => {
		register();

		await manager.handleClaudeMessage(sessionId, {
			type: "assistant",
			session_id: "claude-session",
			error: "authentication_failed",
			message: { content: [{ type: "text", text: "Please sign in" }] },
		} as unknown as SDKMessage);
		await manager.handleClaudeMessage(sessionId, {
			type: "result",
			subtype: "error_during_execution",
			session_id: "claude-session",
			is_error: true,
			errors: ["ordinary provider failure"],
			total_cost_usd: 0,
			usage: {},
		} as unknown as SDKMessage);

		expect(createRunner).not.toHaveBeenCalled();
	});

	it("keeps an actionable quota error when Codex is unavailable", async () => {
		codexRunner.isAvailable.mockResolvedValue(false);
		register();

		await manager.handleClaudeMessage(sessionId, rejectedRateLimit);

		expect(codexRunner.startStreaming).not.toHaveBeenCalled();
		expect(manager.getSession(sessionId)?.agentRunner).toBe(oldRunner);
		expect(manager.getSession(sessionId)?.status).toBe(
			AgentSessionStatus.Error,
		);
		expect(sink.postActivity).toHaveBeenCalledWith(
			sessionId,
			expect.objectContaining({
				type: "error",
				body: expect.stringMatching(/quota.*unavailable or unauthenticated/i),
			}),
			{},
		);
	});

	it("attempts each provider at most once", async () => {
		config.runnerFallbacks!.claude!.runners = ["codex", "claude"];
		codexRunner.isAvailable.mockResolvedValue(false);
		register();

		await manager.handleClaudeMessage(sessionId, rejectedRateLimit);

		expect(createRunner).toHaveBeenCalledTimes(1);
		expect(createRunner).toHaveBeenCalledWith("codex", expect.any(Object));
	});

	it("stores the Codex session id so later prompts continue with Codex", async () => {
		register();
		await manager.handleClaudeMessage(sessionId, rejectedRateLimit);

		await manager.handleClaudeMessage(sessionId, {
			type: "system",
			subtype: "init",
			session_id: "codex-session",
			model: "gpt-5.5",
			tools: ["Bash"],
			permissionMode: "never",
			apiKeySource: "chatgpt",
		} as unknown as SDKMessage);

		expect(manager.getSession(sessionId)?.claudeSessionId).toBeUndefined();
		expect(manager.getSession(sessionId)?.codexSessionId).toBe("codex-session");
	});
});
