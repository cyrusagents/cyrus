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

function makeBuilder(runnerType: "codex" | "claude"): RunnerConfigBuilder {
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: () => ["Read(**)"],
	};
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => ({}),
		buildMergedMcpConfigPath: () => undefined,
	};
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => ({ runnerType }),
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

function buildConfig(
	runnerType: "codex" | "claude",
	codexConnectorWrites?: "enabled" | "disabled",
) {
	const { config } = makeBuilder(runnerType).buildIssueConfig({
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
		allowedDirectories: ["/ws/root"],
		disallowedTools: [],
		cyrusHome: "/tmp/cyrus-home",
		linearWorkspaceId: "ws-1",
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws-1",
		...(codexConnectorWrites ? { codexConnectorWrites } : {}),
	});
	return config as { connectorWrites?: string };
}

describe("RunnerConfigBuilder Codex connector-writes plumbing", () => {
	it("passes the resolved policy through to the Codex runner config", () => {
		expect(buildConfig("codex", "disabled").connectorWrites).toBe("disabled");
		expect(buildConfig("codex", "enabled").connectorWrites).toBe("enabled");
	});

	it("leaves the policy unset when not configured", () => {
		expect(buildConfig("codex").connectorWrites).toBeUndefined();
	});

	it("does not attach the Codex-specific policy to other runners", () => {
		expect(buildConfig("claude", "disabled").connectorWrites).toBeUndefined();
	});
});
