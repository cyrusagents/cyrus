import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildOpenCodeConfig, buildOpenCodeRuntimeEnv } from "../src/config.js";

describe("OpenCode config translation", () => {
	it("maps Cyrus MCP config into OpenCode MCP shape", () => {
		const result = buildOpenCodeConfig({
			workingDirectory: "/work/repo",
			cyrusHome: "/tmp/cyrus",
			mcpConfig: {
				linear: {
					type: "http",
					url: "https://mcp.linear.app/mcp",
					headers: { Authorization: "Bearer token" },
				} as any,
				slack: {
					command: "npx",
					args: ["-y", "slack-mcp-server@latest", "--transport", "stdio"],
					env: { SLACK_MCP_XOXB_TOKEN: "xoxb-token" },
				},
				"legacy-sse": {
					transport: "sse",
					url: "https://example.com/sse",
				},
			},
		});

		expect(result.config.mcp).toEqual({
			linear: {
				type: "remote",
				url: "https://mcp.linear.app/mcp",
				headers: { Authorization: "Bearer token" },
				enabled: true,
			},
			slack: {
				type: "local",
				command: [
					"npx",
					"-y",
					"slack-mcp-server@latest",
					"--transport",
					"stdio",
				],
				environment: { SLACK_MCP_XOXB_TOKEN: "xoxb-token" },
				enabled: true,
			},
		});
		expect(result.unsupported).toContain(
			"mcp:legacy-sse: OpenCode runner supports stdio and streamable HTTP MCP servers, not sse",
		);
	});

	it("preserves OAuth metadata for remote MCP servers", () => {
		const configDir = mkdtempSync(join(tmpdir(), "opencode-mcp-oauth-"));
		const mcpConfigPath = join(configDir, "mcp.json");
		writeFileSync(
			mcpConfigPath,
			JSON.stringify({
				mcpServers: {
					sentry: {
						type: "http",
						url: "https://mcp.sentry.dev/mcp",
						oauth: {},
					},
				},
			}),
		);

		const result = buildOpenCodeConfig({
			workingDirectory: "/work/repo",
			cyrusHome: "/tmp/cyrus",
			mcpConfigPath,
			mcpConfig: {
				atlassian: {
					type: "http",
					url: "https://mcp.atlassian.com/v1/sse",
					oauth: { scopes: ["read:jira-work"] },
				} as any,
			},
		});

		expect(result.config.mcp?.sentry).toEqual({
			type: "remote",
			url: "https://mcp.sentry.dev/mcp",
			oauth: {},
			enabled: true,
		});
		expect(result.config.mcp?.atlassian).toEqual({
			type: "remote",
			url: "https://mcp.atlassian.com/v1/sse",
			oauth: { scopes: ["read:jira-work"] },
			enabled: true,
		});
	});

	it("allows configured OpenCode MCP servers through default-deny permissions", () => {
		const result = buildOpenCodeConfig({
			workingDirectory: "/work/repo",
			cyrusHome: "/tmp/cyrus",
			opencodeGlobalConfig: {
				mcp: {
					atlassian: {
						type: "remote",
						url: "https://mcp.atlassian.com/v1/mcp/authv2",
						enabled: true,
					},
					"disabled-mcp": {
						type: "remote",
						url: "https://disabled.example/mcp",
						enabled: false,
					},
				},
			},
			mcpConfig: {
				linear: {
					type: "http",
					url: "https://mcp.linear.app/mcp",
					headers: { Authorization: "Bearer token" },
				} as any,
			},
			disallowedTools: ["mcp__atlassian__delete_issue"],
		});

		expect(result.config.permission).toMatchObject({
			"*": "deny",
			"atlassian_*": "allow",
			atlassian_delete_issue: "deny",
			"linear_*": "allow",
		});
		expect(result.config.permission?.["disabled-mcp_*"]).toBeUndefined();
	});

	it("maps Cyrus tool permissions with default-deny OpenCode behavior", () => {
		const result = buildOpenCodeConfig({
			workingDirectory: "/work/repo",
			cyrusHome: "/tmp/cyrus",
			allowedDirectories: ["/work/repo", "/tmp/cyrus/attachments"],
			allowedTools: [
				"Read(**)",
				"Edit(src/**)",
				"Bash(git status:*)",
				"WebFetch",
				"TaskCreate",
				"mcp__linear__get_issue",
				"mcp__cyrus-tools",
			],
			disallowedTools: [
				"Read(.env)",
				"Bash(rm:*)",
				"mcp__linear__delete_comment",
				"UnknownTool(foo)",
			],
		});

		expect(result.config.permission).toEqual({
			"*": "deny",
			read: {
				"*": "deny",
				"**": "allow",
				".env": "deny",
				"*.env": "deny",
				"*.env.*": "deny",
				"*.env.example": "allow",
			},
			edit: {
				"*": "deny",
				"src/**": "allow",
			},
			bash: {
				"*": "deny",
				"git status *": "allow",
				"rm *": "deny",
			},
			webfetch: "allow",
			task: "allow",
			linear_get_issue: "allow",
			"cyrus-tools_*": "allow",
			linear_delete_comment: "deny",
			external_directory: {
				"*": "deny",
				"/tmp/cyrus/attachments/**": "allow",
			},
		});
		expect(result.unsupported).toContain(
			"permission:UnknownTool(foo): Unsupported Cyrus tool pattern for OpenCode",
		);
	});

	it("allows standard issue-session Bash and file tools through default-deny permissions", () => {
		const result = buildOpenCodeConfig({
			workingDirectory: "/work/repo",
			cyrusHome: "/tmp/cyrus",
			allowedTools: ["Read(**)", "Edit(**)", "Write(**)", "Bash"],
		});

		expect(result.config.permission).toMatchObject({
			"*": "deny",
			read: {
				"*": "deny",
				"**": "allow",
			},
			edit: {
				"*": "deny",
				"**": "allow",
			},
			bash: {
				"*": "allow",
			},
		});
	});

	it("builds inline config and inherits terminal state by default", () => {
		const env = buildOpenCodeRuntimeEnv({
			workingDirectory: "/work/repo",
			cyrusHome: "/tmp/cyrus",
			allowedTools: ["Read(**)"],
		});

		expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT || "{}")).toMatchObject({
			permission: {
				"*": "deny",
				read: {
					"*": "deny",
					"**": "allow",
				},
			},
		});
		expect(env.OPENCODE_CONFIG_DIR).toBeUndefined();
		expect(env.XDG_DATA_HOME).toBeUndefined();
		expect(env.XDG_STATE_HOME).toBeUndefined();
		expect(env.XDG_CACHE_HOME).toBeUndefined();
		expect(env.XDG_CONFIG_HOME).toBeUndefined();
	});

	it("can use shared Cyrus OpenCode state across sessions", () => {
		const env = buildOpenCodeRuntimeEnv({
			workingDirectory: "/work/repo",
			cyrusHome: "/tmp/cyrus",
			opencodeStateScope: "shared",
			allowedTools: ["Read(**)"],
		});

		expect(env.OPENCODE_CONFIG_DIR).toBe(
			"/tmp/cyrus/opencode-state/shared/opencode-config",
		);
		expect(env.XDG_DATA_HOME).toBeUndefined();
		expect(env.XDG_STATE_HOME).toBe("/tmp/cyrus/opencode-state/shared/state");
		expect(env.XDG_CACHE_HOME).toBe("/tmp/cyrus/opencode-state/shared/cache");
		expect(env.XDG_CONFIG_HOME).toBe("/tmp/cyrus/opencode-state/shared/config");
	});

	it("can use repository-scoped Cyrus OpenCode state across issues", () => {
		const env = buildOpenCodeRuntimeEnv({
			workingDirectory: "/work/repo",
			cyrusHome: "/tmp/cyrus",
			opencodeStateScope: "repository",
			opencodeStateKey: "main-app",
			workspaceName: "NG-71",
			allowedTools: ["Read(**)"],
		});

		expect(env.OPENCODE_CONFIG_DIR).toBe(
			"/tmp/cyrus/opencode-state/repositories/main-app/opencode-config",
		);
		expect(env.XDG_DATA_HOME).toBeUndefined();
		expect(env.XDG_STATE_HOME).toBe(
			"/tmp/cyrus/opencode-state/repositories/main-app/state",
		);
		expect(env.XDG_CACHE_HOME).toBe(
			"/tmp/cyrus/opencode-state/repositories/main-app/cache",
		);
		expect(env.XDG_CONFIG_HOME).toBe(
			"/tmp/cyrus/opencode-state/repositories/main-app/config",
		);
	});

	it("merges global and repository OpenCode config before Cyrus-generated config", () => {
		const result = buildOpenCodeConfig({
			workingDirectory: "/work/repo",
			cyrusHome: "/tmp/cyrus",
			opencodeGlobalConfig: {
				plugin: ["global-plugin"],
				permission: {
					"*": "allow",
					skill: { "global-*": "allow" },
				},
				mcp: {
					linear: { type: "remote", url: "https://user.example/mcp" },
				},
				instructions: ["GLOBAL.md"],
			},
			opencodeRepositoryConfig: {
				plugin: ["repo-plugin"],
				permission: {
					skill: { "repo-*": "allow" },
				},
				mcp: {
					"repo-tool": {
						type: "local",
						command: ["node", "./tools/mcp.js"],
						enabled: true,
					},
				},
				instructions: ["REPO.md"],
			},
			allowedTools: ["Read(**)", "mcp__linear__get_issue"],
			mcpConfig: {
				linear: {
					type: "http",
					url: "https://mcp.linear.app/mcp",
					headers: { Authorization: "Bearer token" },
				} as any,
			},
		});

		expect(result.config).toMatchObject({
			plugin: ["repo-plugin"],
			instructions: ["REPO.md"],
			mcp: {
				linear: {
					type: "remote",
					url: "https://mcp.linear.app/mcp",
					headers: { Authorization: "Bearer token" },
					enabled: true,
				},
				"repo-tool": {
					type: "local",
					command: ["node", "./tools/mcp.js"],
					enabled: true,
				},
			},
			permission: {
				"*": "deny",
				read: {
					"*": "deny",
					"**": "allow",
				},
				linear_get_issue: "allow",
			},
		});
		expect(
			(result.config.permission as Record<string, unknown>).skill,
		).toBeUndefined();
	});

	it("passes arbitrary JSON-compatible OpenCode fields through", () => {
		const result = buildOpenCodeConfig({
			workingDirectory: "/work/repo",
			cyrusHome: "/tmp/cyrus",
			opencodeGlobalConfig: {
				share: "disabled",
				formatter: true,
				provider: {
					anthropic: {
						options: {
							timeout: 600000,
							setCacheKey: true,
						},
					},
				},
			},
		});

		expect(result.config).toMatchObject({
			share: "disabled",
			formatter: true,
			provider: {
				anthropic: {
					options: {
						timeout: 600000,
						setCacheKey: true,
					},
				},
			},
		});
	});

	it("replaces arrays instead of concatenating them", () => {
		const result = buildOpenCodeConfig({
			workingDirectory: "/work/repo",
			cyrusHome: "/tmp/cyrus",
			opencodeGlobalConfig: {
				plugin: ["global-plugin", "shared-plugin"],
			},
			opencodeRepositoryConfig: {
				plugin: ["repo-plugin"],
			},
		});

		expect(result.config.plugin).toEqual(["repo-plugin"]);
	});

	it("keeps Cyrus-generated MCP and permission authoritative over overrides", () => {
		const result = buildOpenCodeConfig({
			workingDirectory: "/work/repo",
			cyrusHome: "/tmp/cyrus",
			opencodeGlobalConfig: {
				mcp: {
					linear: { type: "remote", url: "https://global.example/mcp" },
				},
				permission: {
					"*": "allow",
					read: { "**": "deny" },
				},
			},
			opencodeRepositoryConfig: {
				mcp: {
					linear: { type: "remote", url: "https://repo.example/mcp" },
				},
				permission: {
					"*": "allow",
					read: { "**": "deny" },
				},
			},
			allowedTools: ["Read(**)"],
			mcpConfig: {
				linear: {
					type: "http",
					url: "https://mcp.linear.app/mcp",
					headers: { Authorization: "Bearer token" },
				} as any,
			},
		});

		expect(result.config.mcp?.linear).toEqual({
			type: "remote",
			url: "https://mcp.linear.app/mcp",
			headers: { Authorization: "Bearer token" },
			enabled: true,
		});
		expect(result.config.permission).toMatchObject({
			"*": "deny",
			read: {
				"*": "deny",
				"**": "allow",
			},
		});
	});
});
