import type { CyrusAgentSession, ILogger, RepositoryConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	type IChatToolResolver,
	type IMcpConfigProvider,
	type IRunnerSelector,
	RunnerConfigBuilder,
} from "../src/RunnerConfigBuilder.js";

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

function makeCodexBuilder(): RunnerConfigBuilder {
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: () => ["Read(**)"],
	};
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => ({}),
		buildMergedMcpConfigPath: () => undefined,
	};
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => ({ runnerType: "codex" as const }),
		getDefaultModelForRunner: () => "gpt-5.5",
		getDefaultFallbackModelForRunner: () => "gpt-5.4",
	};
	return new RunnerConfigBuilder(
		chatToolResolver,
		mcpConfigProvider,
		runnerSelector,
	);
}

function makeSession(): CyrusAgentSession {
	return {
		issueId: "issue-1",
		issue: { identifier: "ABC-1" },
		workspace: { path: "/ws/root", isGitWorktree: true },
	} as unknown as CyrusAgentSession;
}

function buildCodexConfig(sandboxSettings?: Record<string, unknown>) {
	const { config } = makeCodexBuilder().buildIssueConfig({
		session: makeSession(),
		repository: {
			id: "repo-a",
			name: "Repo A",
			repositoryPath: "/repos/repo-a",
			allowedTools: [],
		} as unknown as RepositoryConfig,
		sessionId: "sess-1",
		systemPrompt: "test",
		allowedTools: ["Read(**)"],
		allowedDirectories: ["/ws/root", "/repos/repo-a"],
		disallowedTools: [],
		cyrusHome: "/tmp/cyrus-home",
		linearWorkspaceId: "ws-1",
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws-1",
		...(sandboxSettings ? { sandboxSettings } : {}),
	});
	return config as {
		sandboxSettings?: { allowWrite?: string[]; allowRead?: string[] };
	};
}

describe("RunnerConfigBuilder Codex sandbox plumbing", () => {
	it("forces Codex for fallback while preserving the Claude turn context", () => {
		const session = makeSession();
		session.claudeSessionId = "claude-session";
		const { config, runnerType } = makeCodexBuilder().buildIssueConfig({
			session,
			repository: {
				id: "repo-a",
				name: "Repo A",
				repositoryPath: "/repos/repo-a",
				allowedTools: [],
			} as unknown as RepositoryConfig,
			sessionId: "sess-1",
			systemPrompt: "same system prompt",
			allowedTools: ["Read(**)", "Bash(*)"],
			allowedDirectories: ["/ws/root/attachments", "/repos/repo-a"],
			disallowedTools: ["Bash(rm *)"],
			platformMcpConfigOverrides: ["/tmp/linear-mcp.json"],
			cyrusHome: "/tmp/cyrus-home",
			linearWorkspaceId: "ws-1",
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
			requireLinearWorkspaceId: () => "ws-1",
			sandboxSettings: { enabled: true },
			runnerTypeOverride: "codex",
		});

		expect(runnerType).toBe("codex");
		expect(config).toEqual(
			expect.objectContaining({
				workingDirectory: "/ws/root",
				allowedTools: ["Read(**)", "Bash(*)"],
				allowedDirectories: ["/ws/root/attachments", "/repos/repo-a"],
				disallowedTools: ["Bash(rm *)"],
				mcpConfigPath: "/tmp/linear-mcp.json",
				model: "gpt-5.5",
				fallbackModel: "gpt-5.4",
				sandboxSettings: {
					allowWrite: ["/ws/root"],
					allowRead: ["/ws/root", "/ws/root/attachments", "/repos/repo-a"],
				},
			}),
		);
		expect(config.resumeSessionId).toBeUndefined();
	});

	it("translates the egress sandbox into a Codex filesystem allow-list", () => {
		// Plumbs both write (worktree) and read (worktree + allowed dirs) roots;
		// the Codex runner turns these into a per-thread permission profile.
		const config = buildCodexConfig({ enabled: true });
		expect(config.sandboxSettings).toEqual({
			allowWrite: ["/ws/root"],
			allowRead: ["/ws/root", "/ws/root", "/repos/repo-a"],
		});
	});

	it("leaves Codex sandbox settings unset when the egress sandbox is disabled", () => {
		expect(buildCodexConfig(undefined).sandboxSettings).toBeUndefined();
	});
});
