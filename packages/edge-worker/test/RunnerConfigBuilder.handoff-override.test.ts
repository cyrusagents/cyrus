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
	// Normal selection always returns claude — so a codex result can only come
	// from the override path.
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

function baseInput(session: Partial<CyrusAgentSession>) {
	return {
		session: session as CyrusAgentSession,
		repository: {
			id: "repo-a",
			name: "Repo A",
			repositoryPath: "/repos/repo-a",
			allowedTools: [],
		} as unknown as RepositoryConfig,
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
	};
}

describe("RunnerConfigBuilder runnerTypeOverride", () => {
	it("forces the override runner even when the session is sticky to claude", () => {
		const input = {
			...baseInput({
				issueId: "issue-1",
				issue: { identifier: "ABC-1" },
				workspace: { path: "/ws/root" },
				claudeSessionId: "claude-abc",
			} as unknown as Partial<CyrusAgentSession>),
			labels: ["claude"],
			runnerTypeOverride: "codex" as const,
		};

		const { runnerType } = makeBuilder().buildIssueConfig(input as any);

		expect(runnerType).toBe("codex");
	});

	it("falls back to normal selection when no override is given", () => {
		const input = baseInput({
			issueId: "issue-1",
			issue: { identifier: "ABC-1" },
			workspace: { path: "/ws/root" },
			claudeSessionId: "claude-abc",
		} as unknown as Partial<CyrusAgentSession>);

		const { runnerType } = makeBuilder().buildIssueConfig(input as any);

		expect(runnerType).toBe("claude");
	});
});
