import type {
	CyrusAgentSession,
	EdgeWorkerConfig,
	ILogger,
	RepositoryConfig,
} from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	type IChatToolResolver,
	type IMcpConfigProvider,
	RunnerConfigBuilder,
} from "../src/RunnerConfigBuilder.js";
import { RunnerSelectionService } from "../src/RunnerSelectionService.js";

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

function makeBuilder(config: Partial<EdgeWorkerConfig>): RunnerConfigBuilder {
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: () => ["Read(**)"],
	};
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => ({}),
		buildMergedMcpConfigPath: () => undefined,
	};
	// Real selector, not a mock — these tests exercise selector + builder
	// end-to-end. `defaultRunner: "claude"` is set explicitly so the tests
	// are hermetic against env-based auto-detection (getDefaultRunner()
	// falls through to process.env.GEMINI_API_KEY / etc when unset).
	const runnerSelector = new RunnerSelectionService({
		defaultRunner: "claude",
		...config,
	} as EdgeWorkerConfig);
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
		id: "repo-a",
		name: "Repo A",
		repositoryPath: "/repos/repo-a",
		allowedTools: [],
		...overrides,
	} as unknown as RepositoryConfig;
}

function makeSession(
	overrides: Partial<CyrusAgentSession> = {},
): CyrusAgentSession {
	return {
		issueId: "issue-1",
		issue: { identifier: "ABC-1" },
		workspace: { path: "/ws/repo-a-worktree", isGitWorktree: true },
		...overrides,
	} as unknown as CyrusAgentSession;
}

function buildIssueConfig(
	builder: RunnerConfigBuilder,
	repository: RepositoryConfig,
	labels: string[] = [],
	issueDescription?: string,
	session: CyrusAgentSession = makeSession(),
) {
	return builder.buildIssueConfig({
		session,
		repository,
		sessionId: "sess-1",
		systemPrompt: "test",
		allowedTools: ["Read(**)"],
		allowedDirectories: ["/repos/repo-a"],
		disallowedTools: [],
		cyrusHome: "/tmp/cyrus-home",
		linearWorkspaceId: "ws-1",
		labels,
		issueDescription,
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws-1",
	});
}

describe("RunnerConfigBuilder model precedence (label/tag > repository.model > global default), end-to-end with the real RunnerSelectionService", () => {
	it("falls back to repository.model when no label or description tag requests a model", () => {
		const builder = makeBuilder({});
		const repository = makeRepository({ model: "claude-fable-5" });

		const { config } = buildIssueConfig(builder, repository);

		expect(config.model).toBe("claude-fable-5");
	});

	it("prefers an explicit model label over repository.model", () => {
		const builder = makeBuilder({});
		const repository = makeRepository({ model: "claude-fable-5" });

		const { config } = buildIssueConfig(builder, repository, ["sonnet"]);

		expect(config.model).toBe("sonnet");
	});

	it("falls back to the global default when neither a label/tag nor repository.model is set", () => {
		const builder = makeBuilder({});
		const repository = makeRepository();

		const { config } = buildIssueConfig(builder, repository);

		expect(config.model).toBe("opus");
	});

	it("infers the fallback model from the resolved primary model when no explicit override or repository.fallbackModel is set (regression guard for org-level claudeDefaultModel)", () => {
		const builder = makeBuilder({ claudeDefaultModel: "sonnet" });
		const repository = makeRepository();

		const { config } = buildIssueConfig(builder, repository);

		expect(config.model).toBe("sonnet");
		expect(config.fallbackModel).toBe("haiku");
	});

	describe("cross-runner repository.model compatibility gate (agent-only selection, no model tag)", () => {
		it("does not hand a foreign Claude-shaped repository.model to a codex-labeled session", () => {
			const builder = makeBuilder({});
			const repository = makeRepository({ model: "sonnet" });

			const { config } = buildIssueConfig(builder, repository, ["codex"]);

			expect(config.model).toBe("gpt-5.5");
			expect(config.fallbackModel).toBe("gpt-5.2-codex");
		});

		it("does not hand a foreign Claude-shaped repository.model to a gemini-labeled session", () => {
			const builder = makeBuilder({});
			const repository = makeRepository({ model: "sonnet" });

			const { config } = buildIssueConfig(builder, repository, ["gemini"]);

			expect(config.model).toBe("gemini-2.5-pro");
			expect(config.fallbackModel).toBe("gemini-2.5-flash");
		});

		it("does not hand a foreign Claude-shaped repository.model to a [agent=codex] description-tag session", () => {
			const builder = makeBuilder({});
			const repository = makeRepository({ model: "sonnet" });

			const { config } = buildIssueConfig(
				builder,
				repository,
				[],
				"[agent=codex]",
			);

			expect(config.model).toBe("gpt-5.5");
		});

		it("still applies repository.model when it's compatible with the resolved runner (claude)", () => {
			const builder = makeBuilder({});
			const repository = makeRepository({ model: "sonnet" });

			const { config } = buildIssueConfig(builder, repository, ["claude"]);

			expect(config.model).toBe("sonnet");
		});

		it("still applies an unrecognizable/custom repository.model regardless of runner (no evidence of incompatibility)", () => {
			const builder = makeBuilder({});
			const repository = makeRepository({ model: "my-custom-model" });

			const { config } = buildIssueConfig(builder, repository, ["codex"]);

			expect(config.model).toBe("my-custom-model");
		});

		it("applies a GPT-shaped repository.model to a cursor-labeled session (Cursor accepts GPT model ids directly)", () => {
			const builder = makeBuilder({});
			const repository = makeRepository({ model: "gpt-5.4" });

			const { config } = buildIssueConfig(builder, repository, ["cursor"]);

			expect(config.model).toBe("gpt-5.4");
		});
	});

	describe("cross-runner repository.model compatibility gate on resume-switch (label-changed session continuation)", () => {
		it("applies repository.model on a resume-switch when it's compatible with the runner the session is forced back to", () => {
			const builder = makeBuilder({ defaultRunner: "codex" });
			const repository = makeRepository({ model: "sonnet" });
			const session = makeSession({ claudeSessionId: "existing-claude-id" });

			// No labels -> selector resolves to the configured default ("codex"),
			// but the session already has a claudeSessionId, forcing a resume
			// back onto claude. repository.model ("sonnet") is compatible with
			// claude, so it should still apply.
			const { config } = buildIssueConfig(
				builder,
				repository,
				[],
				undefined,
				session,
			);

			expect(config.model).toBe("sonnet");
		});

		it("skips repository.model on a resume-switch when it's incompatible with the runner the session is forced back to", () => {
			const builder = makeBuilder({ defaultRunner: "codex" });
			const repository = makeRepository({ model: "gemini-2.5-pro" });
			const session = makeSession({ claudeSessionId: "existing-claude-id" });

			// Same resume-switch as above, but repository.model is Gemini-shaped
			// — incompatible with the claude runner the session is forced back
			// to, so the gate must block it and fall through to the claude
			// default instead.
			const { config } = buildIssueConfig(
				builder,
				repository,
				[],
				undefined,
				session,
			);

			expect(config.model).toBe("opus");
		});
	});
});
