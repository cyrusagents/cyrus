import type {
	CyrusAgentSession,
	ILogger,
	RepositoryConfig,
	RunnerType,
} from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
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
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => ({}),
		buildMergedMcpConfigPath: () => undefined,
	};
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => ({ runnerType }),
		getDefaultModelForRunner: () => "opus",
		getDefaultFallbackModelForRunner: () => "sonnet",
	};
	return new RunnerConfigBuilder(mcpConfigProvider, runnerSelector);
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
		workspace: { path: "/ws/repo-a", isGitWorktree: true },
	} as unknown as CyrusAgentSession;
}

function buildIssueConfig(
	runnerType: RunnerType,
	autoCompactWindow: number | undefined,
) {
	return makeBuilder(runnerType).buildIssueConfig({
		session: makeSession(),
		repository: makeRepository(),
		sessionId: "sess-1",
		systemPrompt: "test",
		allowedTools: ["Read(**)"],
		allowedDirectories: ["/repos/repo-a"],
		disallowedTools: [],
		autoCompactWindow,
		cyrusHome: "/tmp/cyrus-home",
		linearWorkspaceId: "ws-1",
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws-1",
	});
}

describe("RunnerConfigBuilder autoCompactWindow passthrough", () => {
	it("forwards the window to the Claude runner config when set", () => {
		const { config } = buildIssueConfig("claude", 120000);
		expect((config as { autoCompactWindow?: number }).autoCompactWindow).toBe(
			120000,
		);
	});

	it("leaves the window unset on the Claude config when not provided", () => {
		const { config } = buildIssueConfig("claude", undefined);
		expect(
			(config as { autoCompactWindow?: number }).autoCompactWindow,
		).toBeUndefined();
	});

	it("does not set the window on the Cursor runner config (Cursor manages its own context)", () => {
		const { config, runnerType } = buildIssueConfig("cursor", 120000);
		expect(runnerType).toBe("cursor");
		expect(
			(config as { autoCompactWindow?: number }).autoCompactWindow,
		).toBeUndefined();
	});
});
