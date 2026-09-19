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

function makeSession(): CyrusAgentSession {
	return {
		issueId: "issue-1",
		issue: { identifier: "ABC-1" },
		workspace: { path: "/ws/repo-a-worktree", isGitWorktree: true },
	} as unknown as CyrusAgentSession;
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
		cyrusHome: "/tmp/cyrus-home",
		linearWorkspaceId: "ws-1",
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws-1",
		...extra,
	});
}

describe("RunnerConfigBuilder GitHub token session env (CYHOST-913)", () => {
	it("exposes ONLY CYRUS_GH_TOKEN when a githubToken is provided", () => {
		const { config } = buildIssueConfig({ githubToken: "ghs_org_token" });

		// Never GH_TOKEN: customers set their own GH_TOKEN (e.g. private npm
		// registries on GitHub Packages) and Cyrus must not clobber it. The
		// droplet's gh wrapper maps CYRUS_GH_TOKEN to GH_TOKEN for gh only.
		expect(config.additionalEnv).toEqual({
			CYRUS_GH_TOKEN: "ghs_org_token",
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
		expect(env.CYRUS_GH_TOKEN).toBe("ghs_org_token");
		// Sandbox CA cert env vars survive the merge
		expect(env.NODE_EXTRA_CA_CERTS).toBe("/tmp/ca.pem");
		expect(env.GIT_SSL_CAINFO).toBe("/tmp/ca.pem");
	});

	it("exposes ONLY CYRUS_GITLAB_TOKEN when a gitlabToken is provided", () => {
		const { config } = buildIssueConfig({ gitlabToken: "glpat_repo_token" });

		expect(config.additionalEnv).toEqual({
			CYRUS_GITLAB_TOKEN: "glpat_repo_token",
		});
		expect(
			(config.additionalEnv as Record<string, string>).GITLAB_TOKEN,
		).toBeUndefined();
	});

	it("can expose GitHub and GitLab Cyrus-specific tokens together", () => {
		const { config } = buildIssueConfig({
			githubToken: "ghs_org_token",
			gitlabToken: "glpat_repo_token",
		});

		expect(config.additionalEnv).toEqual({
			CYRUS_GH_TOKEN: "ghs_org_token",
			CYRUS_GITLAB_TOKEN: "glpat_repo_token",
		});
	});
});
