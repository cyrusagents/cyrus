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

function makeBuilder(): RunnerConfigBuilder {
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: () => ["Read(**)"],
	};
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => ({}),
		buildMergedMcpConfigPath: () => undefined,
	};
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => ({ runnerType: "claude" as const }),
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

function makeSession(
	workspace: CyrusAgentSession["workspace"],
): CyrusAgentSession {
	return {
		issueId: "issue-1",
		issue: { identifier: "ABC-1" },
		workspace,
	} as unknown as CyrusAgentSession;
}

function buildIssueConfig(session: CyrusAgentSession) {
	return makeBuilder().buildIssueConfig({
		session,
		repository: makeRepository(),
		sessionId: "sess-1",
		systemPrompt: "test",
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

describe("RunnerConfigBuilder additionalDirectories (multi-repo skill discovery)", () => {
	it("registers each multi-repo sub-worktree as an additional directory", () => {
		const session = makeSession({
			path: "/ws/root",
			isGitWorktree: true,
			repoPaths: {
				"repo-a": "/ws/root/repo-a",
				"repo-b": "/ws/root/repo-b",
			},
		} as unknown as CyrusAgentSession["workspace"]);

		const { config } = buildIssueConfig(session);

		expect(config.workingDirectory).toBe("/ws/root");
		expect(config.additionalDirectories).toEqual([
			"/ws/root/repo-a",
			"/ws/root/repo-b",
		]);
	});

	it("omits additionalDirectories for single-repo sessions (cwd is the worktree)", () => {
		const session = makeSession({
			path: "/ws/repo-a-worktree",
			isGitWorktree: true,
		} as unknown as CyrusAgentSession["workspace"]);

		const { config } = buildIssueConfig(session);

		expect(config.workingDirectory).toBe("/ws/repo-a-worktree");
		expect(config.additionalDirectories).toBeUndefined();
	});

	it("excludes the cwd itself from additionalDirectories", () => {
		// A repoPaths entry equal to the workspace root must not be re-added as
		// an --add-dir (it is already the cwd).
		const session = makeSession({
			path: "/ws/root",
			isGitWorktree: true,
			repoPaths: {
				"repo-a": "/ws/root",
				"repo-b": "/ws/root/repo-b",
			},
		} as unknown as CyrusAgentSession["workspace"]);

		const { config } = buildIssueConfig(session);

		expect(config.additionalDirectories).toEqual(["/ws/root/repo-b"]);
	});
});
