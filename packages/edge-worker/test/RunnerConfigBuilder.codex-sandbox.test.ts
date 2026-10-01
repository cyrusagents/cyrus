import { homedir } from "node:os";
import { join, resolve } from "node:path";
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

function makeCodexBuilder(
	runnerType: RunnerType = "codex",
): RunnerConfigBuilder {
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: () => ["Read(**)"],
	};
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => ({}),
		buildMergedMcpConfigPath: () => undefined,
	};
	const runnerSelector: IRunnerSelector = {
		getDefaultRunner: () => runnerType,
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

function buildCodexConfig(
	sandboxSettings?: Record<string, unknown>,
	additionalWritableDirectories?: string[],
	runnerType: RunnerType = "codex",
) {
	const { config } = makeCodexBuilder(runnerType).buildIssueConfig({
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
		allowedDirectories: ["/ws/root", "/repos/repo-a"],
		additionalWritableDirectories,
		disallowedTools: [],
		cyrusHome: "/tmp/cyrus-home",
		linearWorkspaceId: "ws-1",
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws-1",
		...(sandboxSettings ? { sandboxSettings } : {}),
	});
	return config as {
		allowedDirectories: string[];
		sandbox?: { filesystem?: { allowWrite?: string[]; allowRead?: string[] } };
		sandboxSettings?: { allowWrite?: string[]; allowRead?: string[] };
	};
}

describe("RunnerConfigBuilder Codex sandbox plumbing", () => {
	it.each([
		"codex",
		"claude",
		"cursor",
	] as const)("resolves configured tool directories for %s issue sessions", (runnerType) => {
		const config = buildCodexConfig(
			undefined,
			["~/.tool-state", "tool-cache", "/repos/repo-a"],
			runnerType,
		);
		expect(config.allowedDirectories).toEqual([
			"/ws/root",
			"/repos/repo-a",
			join(homedir(), ".tool-state"),
			resolve("tool-cache"),
		]);
	});

	it.each([
		"codex",
		"claude",
	] as const)("includes configured tool directories in the %s filesystem sandbox", (runnerType) => {
		const config = buildCodexConfig(
			{ enabled: true },
			["~/.tool-state"],
			runnerType,
		);
		const filesystem =
			runnerType === "codex"
				? config.sandboxSettings
				: config.sandbox?.filesystem;
		expect(filesystem?.allowWrite).toEqual([
			"/ws/root",
			join(homedir(), ".tool-state"),
		]);
		expect(filesystem?.allowRead).toContain(join(homedir(), ".tool-state"));
	});

	it("does not grant extra directories when the setting is absent", () => {
		expect(buildCodexConfig().allowedDirectories).toEqual([
			"/ws/root",
			"/repos/repo-a",
		]);
	});

	it("includes configured tool directories in chat sessions", () => {
		const config = makeCodexBuilder().buildChatConfig({
			workspacePath: "/ws/chat",
			workspaceName: "chat",
			systemPrompt: "test",
			sessionId: "chat-1",
			cyrusHome: "/tmp/cyrus-home",
			platformName: "slack",
			logger: silentLogger,
			additionalWritableDirectories: ["~/.tool-state"],
			onMessage: () => {},
			onError: () => {},
		});
		expect(config.allowedDirectories).toEqual([
			"/ws/chat",
			"/tmp/cyrus-home/slack-memory",
			join(homedir(), ".tool-state"),
		]);
	});

	it("translates the egress sandbox into a Codex filesystem allow-list", () => {
		// Plumbs both write (worktree) and read (worktree + allowed dirs) roots;
		// the Codex runner turns these into a per-thread permission profile.
		const config = buildCodexConfig({ enabled: true });
		expect(config.sandboxSettings).toEqual({
			allowWrite: ["/ws/root"],
			allowRead: ["/ws/root", "/ws/root", "/repos/repo-a"],
		});
	});

	it("leaves Codex sandbox settings unset when the egress sandbox is disabled", () => {
		expect(buildCodexConfig(undefined).sandboxSettings).toBeUndefined();
	});
});
