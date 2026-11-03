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

function makeBuilder(runnerType: "claude" | "codex"): RunnerConfigBuilder {
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: () => ["Read(**)"],
	};
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => ({}),
		buildMergedMcpConfigPath: () => undefined,
	};
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => ({ runnerType }),
		getDefaultModelForRunner: () => "model",
		getDefaultFallbackModelForRunner: () => "fallback",
	};
	return new RunnerConfigBuilder(
		chatToolResolver,
		mcpConfigProvider,
		runnerSelector,
	);
}

function build(opts: {
	runnerType: "claude" | "codex";
	allowedTools: string[];
	sandboxEnabled: boolean;
}) {
	const { config } = makeBuilder(opts.runnerType).buildIssueConfig({
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
		allowedTools: opts.allowedTools,
		allowedDirectories: ["/repos/repo-a"],
		disallowedTools: [],
		cyrusHome: "/tmp/cyrus-home",
		linearWorkspaceId: "ws-1",
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws-1",
		sandboxWritablePaths: ["/home/me/.supabase"],
		...(opts.sandboxEnabled ? { sandboxSettings: { enabled: true } } : {}),
	});
	return config as Record<string, any>;
}

describe("RunnerConfigBuilder sandbox writable paths", () => {
	it("Claude + sandbox: OS sandbox and tool permissions both allow the paths", () => {
		const config = build({
			runnerType: "claude",
			allowedTools: ["Read(**)", "Edit(**)", "Write(**)"],
			sandboxEnabled: true,
		});

		expect(config.sandbox.filesystem).toEqual({
			allowRead: [".", "/repos/repo-a", "/home/me/.supabase"],
			denyRead: ["~/"],
			allowWrite: ["/ws/root", "/home/me/.supabase"],
		});
		expect(config.allowedDirectories).toEqual([
			"/repos/repo-a",
			"/home/me/.supabase",
		]);
		expect(config.allowedTools).toEqual([
			"Read(**)",
			"Edit(**)",
			"Write(**)",
			"Edit(//home/me/.supabase/**)",
			"Write(//home/me/.supabase/**)",
		]);
	});

	it("Claude + sandbox with read-only tools: no Edit/Write grants are added", () => {
		const config = build({
			runnerType: "claude",
			allowedTools: ["Read(**)", "Glob"],
			sandboxEnabled: true,
		});
		expect(config.allowedTools).toEqual(["Read(**)", "Glob"]);
	});

	it("Claude without sandbox: paths are not applied", () => {
		const config = build({
			runnerType: "claude",
			allowedTools: ["Edit(**)"],
			sandboxEnabled: false,
		});
		expect(config.sandbox).toBeUndefined();
		expect(config.allowedDirectories).toEqual(["/repos/repo-a"]);
		expect(config.allowedTools).toEqual(["Edit(**)"]);
	});

	it("Codex: paths become writable roots regardless of sandbox", () => {
		const config = build({
			runnerType: "codex",
			allowedTools: ["Read(**)"],
			sandboxEnabled: false,
		});
		expect(config.writableRoots).toEqual(["/home/me/.supabase"]);
	});
});
