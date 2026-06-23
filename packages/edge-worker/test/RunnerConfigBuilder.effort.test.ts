import type {
	CyrusAgentSession,
	ILogger,
	RepositoryConfig,
	RunnerType,
} from "cyrus-core";
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

function makeBuilder(runnerType: RunnerType): RunnerConfigBuilder {
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: () => ["Read(**)"],
	};
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => ({}),
		buildMergedMcpConfigPath: () => undefined,
	};
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => ({ runnerType }),
		getDefaultModelForRunner: () => "opus",
		getDefaultFallbackModelForRunner: () => "sonnet",
	};
	return new RunnerConfigBuilder(
		chatToolResolver,
		mcpConfigProvider,
		runnerSelector,
	);
}

function makeRepository(): RepositoryConfig {
	return {
		id: "repo-a",
		name: "Repo A",
		repositoryPath: "/repos/repo-a",
		allowedTools: [],
	} as unknown as RepositoryConfig;
}

function makeSession(): CyrusAgentSession {
	return {
		issueId: "issue-1",
		issue: { identifier: "ABC-1" },
		workspace: { path: "/ws/repo-a-worktree", isGitWorktree: true },
	} as unknown as CyrusAgentSession;
}

function buildIssueConfig(runnerType: RunnerType, issueDescription?: string) {
	return makeBuilder(runnerType).buildIssueConfig({
		session: makeSession(),
		repository: makeRepository(),
		sessionId: "sess-1",
		systemPrompt: "test",
		issueDescription,
		allowedTools: ["Read(**)"],
		allowedDirectories: ["/repos/repo-a"],
		disallowedTools: [],
		cyrusHome: "/tmp/cyrus-home",
		linearWorkspaceId: "ws-1",
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws-1",
	});
}

describe("RunnerConfigBuilder session-start effort directive", () => {
	it("sets effort from an `Effort:` directive for the Claude runner", () => {
		const { config } = buildIssueConfig(
			"claude",
			"Fix the auth bug.\nEffort: high",
		);
		expect(config.effort).toBe("high");
		expect(config.ultracode).toBeUndefined();
	});

	it("passes max through at session start (full range)", () => {
		const { config } = buildIssueConfig("claude", "Effort: max");
		expect(config.effort).toBe("max");
	});

	it("maps the ultra directive to xhigh + ultracode", () => {
		const { config } = buildIssueConfig("claude", "Effort: ultra");
		expect(config.effort).toBe("xhigh");
		expect(config.ultracode).toBe(true);
	});

	it("leaves effort unset when no directive is present", () => {
		const { config } = buildIssueConfig("claude", "Just fix the bug.");
		expect(config.effort).toBeUndefined();
		expect(config.ultracode).toBeUndefined();
	});

	it("ignores the directive for non-Claude runners", () => {
		const { config } = buildIssueConfig("codex", "Effort: max");
		expect(config.effort).toBeUndefined();
		expect(config.ultracode).toBeUndefined();
	});
});
