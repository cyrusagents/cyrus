import type { ILogger } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BROWSER_USE_PROMPT_ADDENDUM } from "../src/prompts/browserUsePromptAddendum.js";
import { FAILURE_MODE_PROMPT_ADDENDUM } from "../src/prompts/failureModePromptAddendum.js";
import { GITHUB_CLI_MEDIA_PROMPT_ADDENDUM } from "../src/prompts/githubCliMediaPromptAddendum.js";
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
		getDefaultRunner: () => "claude",
		getDefaultModelForRunner: () => "",
		getDefaultFallbackModelForRunner: () => "",
	};
	return new RunnerConfigBuilder(
		chatToolResolver,
		mcpConfigProvider,
		runnerSelector,
	);
}

function buildChatPrompt(builder: RunnerConfigBuilder): string | undefined {
	return builder.buildChatConfig({
		workspacePath: "/tmp/chat-workspace",
		workspaceName: "chat-thread",
		systemPrompt: "Base prompt.",
		sessionId: "chat-session",
		cyrusHome: "/tmp/cyrus",
		platformName: "slack",
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
	}).appendSystemPrompt;
}

function buildIssuePrompt(builder: RunnerConfigBuilder): string | undefined {
	return builder.buildIssueConfig({
		session: {
			issueId: "issue-1",
			workspace: { path: "/tmp/worktree" },
			issue: { identifier: "CYPACK-1490" },
		} as any,
		repository: { id: "repo-1", path: "/tmp/repo" } as any,
		sessionId: "issue-session",
		systemPrompt: "Base prompt.",
		allowedTools: ["Read(**)"],
		allowedDirectories: ["/tmp/worktree"],
		disallowedTools: [],
		labels: [],
		cyrusHome: "/tmp/cyrus",
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "workspace-1",
	}).config.appendSystemPrompt;
}

describe("RunnerConfigBuilder prompt addenda", () => {
	const originalBrowserUse = process.env.CYRUS_BROWSER_USE_ENABLED;
	const originalCloudRuntime = process.env.CYRUS_CLOUD_RUNTIME;

	beforeEach(() => {
		delete process.env.CYRUS_BROWSER_USE_ENABLED;
		delete process.env.CYRUS_CLOUD_RUNTIME;
	});

	afterEach(() => {
		if (originalBrowserUse === undefined)
			delete process.env.CYRUS_BROWSER_USE_ENABLED;
		else process.env.CYRUS_BROWSER_USE_ENABLED = originalBrowserUse;
		if (originalCloudRuntime === undefined)
			delete process.env.CYRUS_CLOUD_RUNTIME;
		else process.env.CYRUS_CLOUD_RUNTIME = originalCloudRuntime;
	});

	it("always adds GitHub media guidance to chat prompts while browser use remains disabled", () => {
		expect(buildChatPrompt(makeBuilder())).toBe(
			`Base prompt.\n\n${FAILURE_MODE_PROMPT_ADDENDUM}\n\n${GITHUB_CLI_MEDIA_PROMPT_ADDENDUM}`,
		);
	});

	it("always adds GitHub media guidance to issue prompts while browser use remains disabled", () => {
		expect(buildIssuePrompt(makeBuilder())).toBe(
			`Base prompt.\n\n${FAILURE_MODE_PROMPT_ADDENDUM}\n\n${GITHUB_CLI_MEDIA_PROMPT_ADDENDUM}`,
		);
	});

	it("adds browser guidance separately when its environment flag is enabled", () => {
		process.env.CYRUS_BROWSER_USE_ENABLED = "true";

		expect(buildChatPrompt(makeBuilder())).toBe(
			`Base prompt.\n\n${FAILURE_MODE_PROMPT_ADDENDUM}\n\n${BROWSER_USE_PROMPT_ADDENDUM}\n\n${GITHUB_CLI_MEDIA_PROMPT_ADDENDUM}`,
		);
	});
});
