import { homedir } from "node:os";
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
	withContext: () => silentLogger,
} as unknown as ILogger;

function makeBuilder(): RunnerConfigBuilder {
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: () => [],
	};
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => ({}),
		buildMergedMcpConfigPath: () => undefined,
	};
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => ({ runnerType: "claude" as const }),
		getDefaultModelForRunner: () => "claude-sonnet",
		getDefaultFallbackModelForRunner: () => "claude-haiku",
	};
	return new RunnerConfigBuilder(
		chatToolResolver,
		mcpConfigProvider,
		runnerSelector,
	);
}

function makeRepository(path: string, id = "repo-1"): RepositoryConfig {
	return {
		id,
		name: id,
		repositoryPath: path,
		workspaceBaseDir: path,
		baseBranch: "main",
		linearWorkspaceId: "ws-1",
		linearToken: "tok",
	} as unknown as RepositoryConfig;
}

function makeSession(workspacePath: string): CyrusAgentSession {
	return {
		issueId: "ISSUE-1",
		issueContext: {
			trackerId: "linear",
			issueIdentifier: "ISSUE-1",
		},
		issue: { identifier: "ISSUE-1" },
		workspace: { path: workspacePath },
	} as unknown as CyrusAgentSession;
}

describe("RunnerConfigBuilder.buildIssueConfig — auto-memory directory allowlist (CYPACK-1253)", () => {
	const home = homedir();

	it("derives autoMemoryDirectory from workspace cwd and adds it to allowedDirectories", () => {
		const builder = makeBuilder();
		const workspacePath = "/tmp/cyrus/worktrees/ISSUE-1";
		const repoPath = "/tmp/cyrus/repos/my-repo";

		const { config } = builder.buildIssueConfig({
			session: makeSession(workspacePath),
			repository: makeRepository(repoPath),
			sessionId: "sess-1",
			systemPrompt: undefined,
			allowedTools: [],
			allowedDirectories: [repoPath],
			disallowedTools: [],
			cyrusHome: "/tmp/cyrus",
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
			requireLinearWorkspaceId: () => "ws-1",
		});

		const expectedPrimary = `${home}/.claude/projects/-tmp-cyrus-worktrees-ISSUE-1/memory`;
		expect(
			(config as { autoMemoryDirectory?: string }).autoMemoryDirectory,
		).toBe(expectedPrimary);
		expect(config.allowedDirectories).toContain(expectedPrimary);
	});

	it("allowlists one encoded memory dir per repository for multi-repo sessions", () => {
		const builder = makeBuilder();
		const workspacePath = "/tmp/cyrus/worktrees/ISSUE-1";
		const repoA = "/tmp/cyrus/repos/repo-a";
		const repoB = "/tmp/cyrus/repos/repo-b";

		const { config } = builder.buildIssueConfig({
			session: makeSession(workspacePath),
			repository: makeRepository(repoA, "repo-a"),
			sessionId: "sess-1",
			systemPrompt: undefined,
			allowedTools: [],
			allowedDirectories: [repoA, repoB],
			disallowedTools: [],
			repositoryPaths: [repoA, repoB],
			cyrusHome: "/tmp/cyrus",
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
			requireLinearWorkspaceId: () => "ws-1",
		});

		expect(config.allowedDirectories).toEqual(
			expect.arrayContaining([
				`${home}/.claude/projects/-tmp-cyrus-worktrees-ISSUE-1/memory`,
				`${home}/.claude/projects/-tmp-cyrus-repos-repo-a/memory`,
				`${home}/.claude/projects/-tmp-cyrus-repos-repo-b/memory`,
			]),
		);
	});

	it("does not duplicate entries when memory dir is already in allowedDirectories", () => {
		const builder = makeBuilder();
		const workspacePath = "/tmp/cyrus/worktrees/ISSUE-1";
		const repoPath = "/tmp/cyrus/repos/repo-a";
		const primaryMemoryDir = `${home}/.claude/projects/-tmp-cyrus-worktrees-ISSUE-1/memory`;

		const { config } = builder.buildIssueConfig({
			session: makeSession(workspacePath),
			repository: makeRepository(repoPath),
			sessionId: "sess-1",
			systemPrompt: undefined,
			allowedTools: [],
			allowedDirectories: [repoPath, primaryMemoryDir],
			disallowedTools: [],
			cyrusHome: "/tmp/cyrus",
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
			requireLinearWorkspaceId: () => "ws-1",
		});

		const occurrences = (config.allowedDirectories ?? []).filter(
			(d: string) => d === primaryMemoryDir,
		).length;
		expect(occurrences).toBe(1);
	});
});
