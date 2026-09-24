import type { ILogger, MikoAgentSession, RepositoryConfig } from "miko-core";
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
		githubUrl: "https://github.com/myorg/repo-a",
		allowedTools: [],
	} as unknown as RepositoryConfig;
}

function makeSession(): MikoAgentSession {
	return {
		issueId: "issue-1",
		issue: { identifier: "ABC-1" },
		workspace: { path: "/ws/repo-a-worktree", isGitWorktree: true },
	} as unknown as MikoAgentSession;
}

function buildIssueConfig(extra: Partial<IssueRunnerConfigInput> = {}) {
	return makeBuilder().buildIssueConfig({
		session: makeSession(),
		repository: makeRepository(),
		sessionId: "sess-1",
		systemPrompt: "test",
		allowedTools: ["Read(**)"],
		allowedDirectories: ["/repos/repo-a"],
		disallowedTools: [],
		mikoHome: "/tmp/miko-home",
		linearWorkspaceId: "ws-1",
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws-1",
		...extra,
	});
}

describe("RunnerConfigBuilder GitHub token session env (CYHOST-913)", () => {
	it("exposes ONLY MIKO_GH_TOKEN when a githubToken is provided", () => {
		const { config } = buildIssueConfig({ githubToken: "ghs_org_token" });

		// Never GH_TOKEN: customers set their own GH_TOKEN (e.g. private npm
		// registries on GitHub Packages) and Miko must not clobber it. The
		// droplet's gh wrapper maps MIKO_GH_TOKEN to GH_TOKEN for gh only.
		expect(config.additionalEnv).toEqual({
			MIKO_GH_TOKEN: "ghs_org_token",
		});
	});

	it("sets no additionalEnv when githubToken is absent (zero behavior change)", () => {
		const { config } = buildIssueConfig();

		expect(config.additionalEnv).toBeUndefined();
	});

	it("merges the token on top of sandbox CA cert env vars", () => {
		const { config } = buildIssueConfig({
			githubToken: "ghs_org_token",
			sandboxSettings: { enabled: true },
			egressCaCertPath: "/tmp/ca.pem",
		});

		const env = config.additionalEnv as Record<string, string>;
		expect(env.GH_TOKEN).toBeUndefined();
		expect(env.MIKO_GH_TOKEN).toBe("ghs_org_token");
		// Sandbox CA cert env vars survive the merge
		expect(env.NODE_EXTRA_CA_CERTS).toBe("/tmp/ca.pem");
		expect(env.GIT_SSL_CAINFO).toBe("/tmp/ca.pem");
	});

	it("sets GIT_AUTHOR/COMMITTER from gitAuthor for the App bot path", () => {
		const { config } = buildIssueConfig({
			githubToken: "ghs_org_token",
			gitAuthor: {
				name: "whatever-slug[bot]",
				email: "99+whatever-slug[bot]@users.noreply.github.com",
			},
		});

		expect(config.additionalEnv).toEqual({
			MIKO_GH_TOKEN: "ghs_org_token",
			GIT_AUTHOR_NAME: "whatever-slug[bot]",
			GIT_AUTHOR_EMAIL: "99+whatever-slug[bot]@users.noreply.github.com",
			GIT_COMMITTER_NAME: "whatever-slug[bot]",
			GIT_COMMITTER_EMAIL: "99+whatever-slug[bot]@users.noreply.github.com",
		});
	});

	it("does not hard-code miko-agent in git author env", () => {
		const { config } = buildIssueConfig({
			githubToken: "ghs_x",
			gitAuthor: {
				name: "ops-bot[bot]",
				email: "1+ops-bot[bot]@users.noreply.github.com",
			},
		});
		const env = config.additionalEnv as Record<string, string>;
		expect(env.GIT_AUTHOR_NAME).toBe("ops-bot[bot]");
		expect(JSON.stringify(env)).not.toContain("miko-agent");
	});
});
