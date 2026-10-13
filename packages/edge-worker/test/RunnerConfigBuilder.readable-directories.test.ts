import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
	CyrusAgentSession,
	ILogger,
	RepositoryConfig,
	RunnerType,
} from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import {
	type IChatToolResolver,
	type IMcpConfigProvider,
	type IRunnerSelector,
	RunnerConfigBuilder,
	resolveAdditionalReadableDirectories,
} from "../src/RunnerConfigBuilder.js";

function makeLogger(): ILogger {
	return {
		debug: () => {},
		info: () => {},
		warn: vi.fn(),
		error: () => {},
	} as unknown as ILogger;
}

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
		getDefaultRunner: () => runnerType,
		getDefaultModelForRunner: () => "",
		getDefaultFallbackModelForRunner: () => "",
	};
	return new RunnerConfigBuilder(
		chatToolResolver,
		mcpConfigProvider,
		runnerSelector,
	);
}

function buildIssueConfig(
	runnerType: RunnerType,
	additionalReadableDirectories?: string[],
	sandboxSettings?: Record<string, unknown>,
	logger: ILogger = makeLogger(),
) {
	const { config } = makeBuilder(runnerType).buildIssueConfig({
		session: {
			issueId: "issue-1",
			issue: { identifier: "ABC-1" },
			workspace: { path: "/ws/root", isGitWorktree: true },
		} as unknown as CyrusAgentSession,
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
		disallowedTools: [],
		cyrusHome: "/tmp/cyrus-home",
		linearWorkspaceId: "ws-1",
		logger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws-1",
		additionalReadableDirectories,
		...(sandboxSettings ? { sandboxSettings } : {}),
	});
	return config as {
		allowedDirectories?: string[];
		sandbox?: {
			filesystem?: { allowRead?: string[]; allowWrite?: string[] };
		};
		sandboxSettings?: { allowRead?: string[]; allowWrite?: string[] };
	};
}

function buildChatConfig(
	runnerType: RunnerType,
	additionalReadableDirectories?: string[],
) {
	return makeBuilder(runnerType).buildChatConfig({
		workspacePath: "/ws/chat",
		workspaceName: "chat",
		systemPrompt: "test",
		sessionId: "chat-1",
		cyrusHome: "/tmp/cyrus-home",
		platformName: "slack",
		logger: makeLogger(),
		additionalReadableDirectories,
		onMessage: () => {},
		onError: () => {},
	});
}

const toolState = join(homedir(), ".tool-state");

describe("resolveAdditionalReadableDirectories", () => {
	it("resolves ~, relative, and absolute entries and deduplicates them", () => {
		expect(
			resolveAdditionalReadableDirectories(
				["~/.tool-state", "tool-cache", "/srv/shared", toolState],
				makeLogger(),
			),
		).toEqual([toolState, resolve("tool-cache"), "/srv/shared"]);
	});

	it("drops entries that cover the entire home directory", () => {
		const log = makeLogger();
		expect(
			resolveAdditionalReadableDirectories(
				["~", "~/", homedir(), dirname(homedir()), "/", "~/.tool-state"],
				log,
			),
		).toEqual([toolState]);
		expect(log.warn).toHaveBeenCalledTimes(5);
	});

	it("drops ~/.. and keeps siblings that only share a name prefix with home", () => {
		const log = makeLogger();
		expect(
			resolveAdditionalReadableDirectories(
				["~/..", `${homedir()}-shared`],
				log,
			),
		).toEqual([`${homedir()}-shared`]);
		expect(log.warn).toHaveBeenCalledTimes(1);
	});

	it("drops a symlink that points at the home directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "cyrus-readable-"));
		try {
			const link = join(dir, "home-link");
			symlinkSync(homedir(), link);
			const log = makeLogger();
			expect(resolveAdditionalReadableDirectories([link], log)).toEqual([]);
			expect(log.warn).toHaveBeenCalledTimes(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("drops entries that cover the Cyrus home but keeps paths inside it", () => {
		const cyrusHome = join(homedir(), ".cyrus");
		const log = makeLogger();
		expect(
			resolveAdditionalReadableDirectories(
				["~/.cyrus", "~/.cyrus/skills"],
				log,
				cyrusHome,
			),
		).toEqual([join(cyrusHome, "skills")]);
		expect(log.warn).toHaveBeenCalledTimes(1);
	});
});

describe("RunnerConfigBuilder additional readable directories", () => {
	it("grants Claude issue sessions read access via allowedDirectories", () => {
		expect(
			buildIssueConfig("claude", ["~/.tool-state", "/repos/repo-a"])
				.allowedDirectories,
		).toEqual(["/ws/root", "/repos/repo-a", toolState]);
	});

	it("adds readable directories to the Claude sandbox read list only", () => {
		const filesystem = buildIssueConfig("claude", ["~/.tool-state"], {
			enabled: true,
		}).sandbox?.filesystem;
		expect(filesystem?.allowRead).toEqual([
			".",
			"/ws/root",
			"/repos/repo-a",
			toolState,
		]);
		expect(filesystem?.allowWrite).toEqual(["/ws/root"]);
	});

	it("adds readable directories to the Codex sandbox read list only", () => {
		expect(
			buildIssueConfig("codex", ["~/.tool-state"], { enabled: true })
				.sandboxSettings,
		).toEqual({
			allowWrite: ["/ws/root"],
			allowRead: ["/ws/root", "/ws/root", "/repos/repo-a", toolState],
		});
	});

	it.each([
		"codex",
		"cursor",
		"opencode",
		"gemini",
	] as const)("keeps readable directories out of %s read-write roots", (runnerType) => {
		expect(
			buildIssueConfig(runnerType, ["~/.tool-state"]).allowedDirectories,
		).toEqual(["/ws/root", "/repos/repo-a"]);
	});

	it.each([
		"cursor",
		"opencode",
		"gemini",
	] as const)("does not resolve or warn about entries for %s sessions", (runnerType) => {
		const log = makeLogger();
		buildIssueConfig(runnerType, ["~"], undefined, log);
		expect(log.warn).not.toHaveBeenCalled();
	});

	it("does not change allowedDirectories when the setting is absent", () => {
		expect(buildIssueConfig("claude").allowedDirectories).toEqual([
			"/ws/root",
			"/repos/repo-a",
		]);
	});

	it("grants Claude chat sessions read access", () => {
		expect(
			buildChatConfig("claude", ["~/.tool-state"]).allowedDirectories,
		).toEqual(["/ws/chat", "/tmp/cyrus-home/slack-memory", toolState]);
	});

	it("keeps readable directories out of non-Claude chat sessions", () => {
		expect(
			buildChatConfig("codex", ["~/.tool-state"]).allowedDirectories,
		).toEqual(["/ws/chat", "/tmp/cyrus-home/slack-memory"]);
	});
});
