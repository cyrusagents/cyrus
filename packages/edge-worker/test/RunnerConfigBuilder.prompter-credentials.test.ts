import type {
	CyrusAgentSession,
	ILogger,
	RepositoryConfig,
	ResolvedPrompterCredentials,
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
		getDefaultModelForRunner: () => "opus",
		getDefaultFallbackModelForRunner: () => "sonnet",
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

// Placeholder values shaped like tokens; not real credentials.
const ADA: ResolvedPrompterCredentials = {
	linearUserId: "lin-ada",
	displayName: "Ada",
	claudeCredentialKind: "oauthToken",
	github: { login: "ada", gitAuthorName: "Ada", gitAuthorEmail: "ada@x.io" },
	env: {
		CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-ada-placeholder",
		GH_TOKEN: "github_pat_ada_placeholder",
		CYRUS_PROMPTER_GITHUB_TOKEN: "github_pat_ada_placeholder",
		GIT_AUTHOR_NAME: "Ada",
		GIT_CONFIG_COUNT: "2",
	},
	omitEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
	fingerprints: { claude: "aaaaaaaa", github: "bbbbbbbb" },
};

function build(
	runnerType: RunnerType,
	extra: {
		prompterCredentials?: ResolvedPrompterCredentials;
		omitEnv?: string[];
		egressCaCertPath?: string;
		sandboxSettings?: Record<string, unknown>;
	} = {},
) {
	return makeBuilder(runnerType).buildIssueConfig({
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
		...extra,
	});
}

describe("RunnerConfigBuilder per-prompter credentials", () => {
	it("leaves the config untouched when no prompter credentials are supplied", () => {
		const { config } = build("claude") as { config: Record<string, unknown> };
		expect(config.additionalEnv).toBeUndefined();
		expect(config.omitEnv).toBeUndefined();
	});

	it("injects the user's env and omits host Claude credentials for the Claude runner", () => {
		const { config } = build("claude", { prompterCredentials: ADA }) as {
			config: { additionalEnv?: Record<string, string>; omitEnv?: string[] };
		};
		expect(config.additionalEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBe(
			"sk-ant-oat01-ada-placeholder",
		);
		expect(config.additionalEnv?.GH_TOKEN).toBe("github_pat_ada_placeholder");
		expect(config.omitEnv).toEqual([
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_AUTH_TOKEN",
		]);
	});

	it("keeps sandbox CA-cert env alongside the prompter env", () => {
		const { config } = build("claude", {
			prompterCredentials: ADA,
			sandboxSettings: { enabled: true },
			egressCaCertPath: "/tmp/ca.pem",
		}) as { config: { additionalEnv?: Record<string, string> } };
		expect(config.additionalEnv?.GIT_SSL_CAINFO).toBe("/tmp/ca.pem");
		expect(config.additionalEnv?.GH_TOKEN).toBe("github_pat_ada_placeholder");
	});

	it("strips other users' env-referenced secrets from host-credential Claude sessions", () => {
		const { config } = build("claude", {
			omitEnv: ["BOB_GH_TOKEN", "BOB_CLAUDE_TOKEN"],
		}) as { config: { additionalEnv?: unknown; omitEnv?: string[] } };
		expect(config.additionalEnv).toBeUndefined();
		expect(config.omitEnv).toEqual(["BOB_GH_TOKEN", "BOB_CLAUDE_TOKEN"]);
	});

	it.each([
		"opencode",
		"codex",
		"cursor",
		"gemini",
	] as const)("applies personal GitHub identity and env filtering to %s without changing model auth", (runnerType) => {
		const { CLAUDE_CODE_OAUTH_TOKEN: _unused, ...env } = ADA.env;
		const credentials = {
			...ADA,
			env,
			claudeCredentialKind: undefined,
			omitEnv: ["OTHER_USER_TOKEN"],
		};
		const { config } = build(runnerType, { prompterCredentials: credentials });
		expect(config.additionalEnv?.GH_TOKEN).toBe("github_pat_ada_placeholder");
		expect(config.additionalEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
		expect(config.omitEnv).toContain("OTHER_USER_TOKEN");
		expect(
			build(runnerType, { omitEnv: ["OTHER_USER_TOKEN"] }).config.omitEnv,
		).toEqual(["OTHER_USER_TOKEN"]);
		expect(() => build(runnerType)).not.toThrow();
	});
});
