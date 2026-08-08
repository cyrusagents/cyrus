import type { CyrusAgentSession, ILogger, RepositoryConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	type IChatToolResolver,
	type IMcpConfigProvider,
	type IRunnerSelector,
	type IssueRunnerConfigInput,
	RunnerConfigBuilder,
} from "../src/RunnerConfigBuilder.js";

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

function makeBuilder(
	runnerType: "claude" | "codex" | "gemini" | "cursor" = "claude",
): RunnerConfigBuilder {
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: () => ["Read(**)"],
	};
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => ({}),
		buildMergedMcpConfigPath: () => undefined,
	};
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => ({ runnerType }),
		getDefaultModelForRunner: () => "",
		getDefaultFallbackModelForRunner: () => "",
	};
	return new RunnerConfigBuilder(
		chatToolResolver,
		mcpConfigProvider,
		runnerSelector,
	);
}

function makeRepository(
	overrides: Partial<RepositoryConfig> = {},
): RepositoryConfig {
	return {
		id: "repo-1",
		name: "repo-1",
		repositoryPath: "/tmp/repo",
		baseBranch: "main",
		workspaceBaseDir: "/tmp/repo/.worktrees",
		linearWorkspaceId: "ws-1",
		...overrides,
	} as RepositoryConfig;
}

function makeSession(): CyrusAgentSession {
	return {
		id: "session-1",
		issueId: "issue-1",
		workspace: { path: "/tmp/repo/.worktrees/issue-1" },
		issue: { identifier: "TST-1" },
	} as unknown as CyrusAgentSession;
}

function makeInput(
	overrides: Partial<IssueRunnerConfigInput> = {},
): IssueRunnerConfigInput {
	return {
		session: makeSession(),
		repository: makeRepository(),
		sessionId: "session-1",
		systemPrompt: "",
		allowedTools: [],
		allowedDirectories: [],
		disallowedTools: [],
		cyrusHome: "/tmp/cyrus-home-test",
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws-1",
		...overrides,
	} as IssueRunnerConfigInput;
}

describe("RunnerConfigBuilder.buildIssueConfig — custom runner-binary paths", () => {
	describe("pathToClaudeCodeExecutable (claude runner)", () => {
		it("forwards repository.pathToClaudeCodeExecutable into the claude runner config when set", () => {
			const builder = makeBuilder("claude");
			const wrapperPath = "/usr/local/bin/claude-docker.sh";

			const { config, runnerType } = builder.buildIssueConfig(
				makeInput({
					repository: makeRepository({
						pathToClaudeCodeExecutable: wrapperPath,
					}),
				}),
			);

			expect(runnerType).toBe("claude");
			expect(
				(config as { pathToClaudeCodeExecutable?: string })
					.pathToClaudeCodeExecutable,
			).toBe(wrapperPath);
		});

		it("omits pathToClaudeCodeExecutable from the config when the repository field is unset", () => {
			const builder = makeBuilder("claude");

			const { config, runnerType } = builder.buildIssueConfig(makeInput());

			expect(runnerType).toBe("claude");
			expect(config).not.toHaveProperty("pathToClaudeCodeExecutable");
		});

		it("ignores repository.pathToClaudeCodeExecutable for non-claude runner types", () => {
			const builder = makeBuilder("codex");

			const { config, runnerType } = builder.buildIssueConfig(
				makeInput({
					repository: makeRepository({
						pathToClaudeCodeExecutable: "/usr/local/bin/claude-docker.sh",
					}),
				}),
			);

			expect(runnerType).toBe("codex");
			expect(config).not.toHaveProperty("pathToClaudeCodeExecutable");
		});
	});

	describe("codexPath (codex runner)", () => {
		it("forwards repository.codexPath into the codex runner config when set", () => {
			const builder = makeBuilder("codex");
			const wrapperPath = "/usr/local/bin/codex-docker.sh";

			const { config, runnerType } = builder.buildIssueConfig(
				makeInput({
					repository: makeRepository({ codexPath: wrapperPath }),
				}),
			);

			expect(runnerType).toBe("codex");
			expect((config as { codexPath?: string }).codexPath).toBe(wrapperPath);
		});

		it("omits codexPath from the config when the repository field is unset", () => {
			const builder = makeBuilder("codex");

			const { config, runnerType } = builder.buildIssueConfig(makeInput());

			expect(runnerType).toBe("codex");
			expect(config).not.toHaveProperty("codexPath");
		});

		it("ignores repository.codexPath for non-codex runner types", () => {
			const builder = makeBuilder("claude");

			const { config, runnerType } = builder.buildIssueConfig(
				makeInput({
					repository: makeRepository({
						codexPath: "/usr/local/bin/codex-docker.sh",
					}),
				}),
			);

			expect(runnerType).toBe("claude");
			expect(config).not.toHaveProperty("codexPath");
		});
	});

	describe("geminiPath (gemini runner)", () => {
		it("forwards repository.geminiPath into the gemini runner config when set", () => {
			const builder = makeBuilder("gemini");
			const wrapperPath = "/usr/local/bin/gemini-docker.sh";

			const { config, runnerType } = builder.buildIssueConfig(
				makeInput({
					repository: makeRepository({ geminiPath: wrapperPath }),
				}),
			);

			expect(runnerType).toBe("gemini");
			expect((config as { geminiPath?: string }).geminiPath).toBe(wrapperPath);
		});

		it("omits geminiPath from the config when the repository field is unset", () => {
			const builder = makeBuilder("gemini");

			const { config, runnerType } = builder.buildIssueConfig(makeInput());

			expect(runnerType).toBe("gemini");
			expect(config).not.toHaveProperty("geminiPath");
		});

		it("ignores repository.geminiPath for non-gemini runner types", () => {
			const builder = makeBuilder("claude");

			const { config, runnerType } = builder.buildIssueConfig(
				makeInput({
					repository: makeRepository({
						geminiPath: "/usr/local/bin/gemini-docker.sh",
					}),
				}),
			);

			expect(runnerType).toBe("claude");
			expect(config).not.toHaveProperty("geminiPath");
		});
	});
});
