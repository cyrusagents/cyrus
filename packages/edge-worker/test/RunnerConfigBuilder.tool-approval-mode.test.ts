import type {
	CyrusAgentSession,
	ILogger,
	RepositoryConfig,
	RunnerType,
	ToolApprovalMode,
} from "cyrus-core";
import { describe, expect, it } from "vitest";
import { RunnerConfigBuilder } from "../src/RunnerConfigBuilder.js";
import { ToolPermissionResolver } from "../src/ToolPermissionResolver.js";

const logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

const repository = {
	id: "repo-a",
	name: "Repo A",
	repositoryPath: "/repos/repo-a",
} as unknown as RepositoryConfig;

function build(
	runnerType: RunnerType,
	toolApprovalMode?: ToolApprovalMode,
	extra: Record<string, unknown> = {},
) {
	const builder = new RunnerConfigBuilder(
		{ buildChatAllowedTools: () => ["Read(**)"] },
		{ buildMcpConfig: () => ({}), buildMergedMcpConfigPath: () => undefined },
		{
			determineRunnerSelection: () => ({ runnerType }),
			getDefaultModelForRunner: () => "model",
			getDefaultFallbackModelForRunner: () => "fallback",
		},
	);
	return builder.buildIssueConfig({
		session: {
			issueId: "issue-1",
			workspace: { path: "/ws/root", isGitWorktree: true },
		} as unknown as CyrusAgentSession,
		repository,
		sessionId: "sess-1",
		systemPrompt: undefined,
		allowedTools: ["Read", "Edit", "mcp__linear"],
		allowedDirectories: [],
		disallowedTools: ["Bash(rm:*)"],
		cyrusHome: "/tmp/cyrus-home",
		linearWorkspaceId: "ws-1",
		logger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws-1",
		...(toolApprovalMode ? { toolApprovalMode } : {}),
		...extra,
	}).config as Record<string, any>;
}

describe("RunnerConfigBuilder toolApprovalMode", () => {
	it.each([
		"claude",
		"codex",
	] as const)("passes auto to %s while keeping tool lists for scope and denials", (runner) => {
		const config = build(runner, "auto");
		expect(config.toolApprovalMode).toBe("auto");
		// The runner decides what to pre-approve; lists stay intact so MCP
		// scope (Codex) and explicit denials keep working.
		expect(config.allowedTools).toEqual(["Read", "Edit", "mcp__linear"]);
		expect(config.disallowedTools).toEqual(["Bash(rm:*)"]);
	});

	it.each([
		"gemini",
		"cursor",
		"opencode",
	] as const)("keeps allowlists for %s", (runner) => {
		expect(build(runner, "auto").toolApprovalMode).toBeUndefined();
	});

	it("omits the field by default and for allowlist", () => {
		expect(build("claude").toolApprovalMode).toBeUndefined();
		expect(build("codex", "allowlist").toolApprovalMode).toBeUndefined();
	});

	it("does not apply auto to chat sessions", () => {
		const builder = new RunnerConfigBuilder(
			{ buildChatAllowedTools: () => ["Read(**)"] },
			{ buildMcpConfig: () => ({}), buildMergedMcpConfigPath: () => undefined },
			{
				determineRunnerSelection: () => ({ runnerType: "claude" }),
				getDefaultModelForRunner: () => "model",
				getDefaultFallbackModelForRunner: () => "fallback",
				getDefaultRunner: () => "claude",
			} as never,
		);
		const config = builder.buildChatConfig({
			workspacePath: "/ws/chat",
			workspaceName: "chat",
			cyrusHome: "/tmp/cyrus-home",
			platformName: "slack",
			logger,
			onMessage: () => {},
			onError: () => {},
		} as never);
		expect(config).not.toHaveProperty("toolApprovalMode");
	});
});

describe("ToolPermissionResolver.hasPromptScopedToolPolicy", () => {
	it("flags label-prompt and promptDefaults tool policies as restricted", () => {
		const resolver = new ToolPermissionResolver(
			{
				repositories: [],
				promptDefaults: { scoper: { allowedTools: "readOnly" } },
			} as never,
			logger,
		);
		const labelled = {
			...repository,
			labelPrompts: {
				debugger: { labels: ["bug"], disallowedTools: ["Write"] },
			},
		} as unknown as RepositoryConfig;
		expect(resolver.hasPromptScopedToolPolicy(repository, "scoper")).toBe(true);
		expect(resolver.hasPromptScopedToolPolicy(labelled, "debugger")).toBe(true);
		expect(resolver.hasPromptScopedToolPolicy(repository, "builder")).toBe(
			false,
		);
		expect(resolver.hasPromptScopedToolPolicy(repository, undefined)).toBe(
			false,
		);
	});
});
