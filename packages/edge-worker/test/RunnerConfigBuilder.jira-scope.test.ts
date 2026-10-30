import type { CyrusAgentSession, ILogger, RepositoryConfig } from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import {
	type IMcpConfigProvider,
	RunnerConfigBuilder,
} from "../src/RunnerConfigBuilder.js";

// Jira remote-agent tasks build through the same issue config path as
// Linear/GitHub sessions, but with mcpScope "none": no native Linear /
// cyrus-tools / Slack servers and no repository or platform .mcp.json files.

const silentLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

function makeBuilder(provider: IMcpConfigProvider) {
	return new RunnerConfigBuilder(
		{ buildChatAllowedTools: () => [] },
		provider,
		{
			getDefaultRunner: () => "claude",
			determineRunnerSelection: () => ({ runnerType: "claude" as const }),
			getDefaultModelForRunner: () => "configured-model",
			getDefaultFallbackModelForRunner: () => "configured-fallback",
		},
	);
}

const repository = {
	id: "repo-a",
	name: "Repo A",
	repositoryPath: "/repos/repo-a",
	// A repo-level allowedTools override would normally select repo.mcpConfigPath.
	allowedTools: ["Read", "mcp__linear__get_issue"],
	mcpConfigPath: "/repos/repo-a/.mcp.json",
	model: "repo-model",
} as unknown as RepositoryConfig;

const session = {
	id: "jira-task",
	issue: { identifier: "QA-1" },
	workspace: { path: "/ws/jira-ctx", isGitWorktree: true },
	repositories: [],
} as unknown as CyrusAgentSession;

function build(extra: Record<string, unknown> = {}) {
	const provider: IMcpConfigProvider = {
		buildMcpConfig: vi.fn(() => {
			throw new Error("native MCP must not be built for Jira tasks");
		}),
		buildMergedMcpConfigPath: vi.fn(() => "/should/not/be/used.json"),
	};
	const requireLinearWorkspaceId = vi.fn(() => {
		throw new Error("Linear workspace must not be required");
	});
	const askFactory = vi.fn();
	const result = makeBuilder(provider).buildIssueConfig({
		session,
		repository,
		sessionId: "jira-task",
		systemPrompt: "jira",
		allowedTools: ["Read", "Edit", "Bash"],
		allowedDirectories: ["/ws/jira-ctx"],
		disallowedTools: [],
		cyrusHome: "/tmp/cyrus-home",
		mcpScope: "none",
		autoMemoryDirectory: "/tmp/cyrus-home/jira-agent/memory/ctx",
		strictMcpConfig: false,
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId,
		createAskUserQuestionCallback: askFactory,
		...extra,
	});
	return { ...result, provider, requireLinearWorkspaceId, askFactory };
}

describe("RunnerConfigBuilder mcpScope none (Jira tasks)", () => {
	it("builds no MCP servers, no config paths, strict MCP, no Linear workspace", () => {
		const { config, provider, requireLinearWorkspaceId, askFactory } = build();
		expect(config.mcpConfig).toEqual({});
		expect(config.mcpConfigPath).toBeUndefined();
		expect(config.strictMcpConfig).toBe(true);
		expect(provider.buildMcpConfig).not.toHaveBeenCalled();
		expect(provider.buildMergedMcpConfigPath).not.toHaveBeenCalled();
		expect(requireLinearWorkspaceId).not.toHaveBeenCalled();
		expect(askFactory).not.toHaveBeenCalled();
		expect(config.onAskUserQuestion).toBeUndefined();
	});

	it("keeps worktree scope, model selection and a context-scoped memory dir", () => {
		const { config } = build();
		expect(config.workingDirectory).toBe("/ws/jira-ctx");
		expect(config.allowedDirectories).toEqual(["/ws/jira-ctx"]);
		expect(config.allowedTools).toEqual(["Read", "Edit", "Bash"]);
		expect(config.model).toBe("repo-model");
		expect(config.autoMemoryDirectory).toBe(
			"/tmp/cyrus-home/jira-agent/memory/ctx",
		);
	});

	it("preserves the egress sandbox and CA settings", () => {
		const { config } = build({
			sandboxSettings: { enabled: true, network: { httpProxyPort: 9 } },
			egressCaCertPath: "/tmp/ca.pem",
		});
		const sandbox = (config as Record<string, any>).sandbox;
		expect(sandbox.allowUnsandboxedCommands).toBe(false);
		expect(sandbox.filesystem.denyRead).toEqual(["~/"]);
		expect(sandbox.filesystem.allowWrite).toEqual(["/ws/jira-ctx"]);
		expect(config.additionalEnv?.NODE_EXTRA_CA_CERTS).toBe("/tmp/ca.pem");
	});

	it("default scope still builds native MCP (unchanged behaviour)", () => {
		const provider: IMcpConfigProvider = {
			buildMcpConfig: vi.fn(() => ({ linear: { type: "http" } as any })),
			buildMergedMcpConfigPath: vi.fn(() => undefined),
		};
		const { config } = makeBuilder(provider).buildIssueConfig({
			session,
			repository,
			sessionId: "s",
			systemPrompt: "x",
			allowedTools: [],
			allowedDirectories: [],
			disallowedTools: [],
			cyrusHome: "/tmp",
			linearWorkspaceId: "ws",
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
			requireLinearWorkspaceId: () => "ws",
		});
		expect(provider.buildMcpConfig).toHaveBeenCalled();
		expect(Object.keys(config.mcpConfig ?? {})).toEqual(["linear"]);
	});
});
