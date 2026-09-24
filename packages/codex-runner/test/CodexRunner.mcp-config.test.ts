import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodexMcpServersConfig } from "../src/config/mcpConfigTranslator.js";

describe("CodexRunner MCP config mapping", () => {
	it("maps generic headers to Codex http_headers for HTTP MCP servers", () => {
		const mcpServers = buildCodexMcpServersConfig({
			workingDirectory: process.cwd(),
			mcpConfig: {
				linear: {
					type: "http",
					url: "https://mcp.linear.app/mcp",
					headers: {
						Authorization: "Bearer linear-token",
					},
				},
				"miko-tools": {
					type: "http",
					url: "http://127.0.0.1:4444/mcp/miko-tools",
					headers: {
						Authorization: "Bearer miko-api-key",
						"x-miko-mcp-context-id": "repo-1:session-1",
					},
				},
			},
		});

		expect(mcpServers.linear.http_headers).toEqual({
			Authorization: "Bearer linear-token",
		});
		expect(mcpServers["miko-tools"].http_headers).toEqual({
			Authorization: "Bearer miko-api-key",
			"x-miko-mcp-context-id": "repo-1:session-1",
		});
	});

	it("preserves codex-native header fields when provided", () => {
		const mcpServers = buildCodexMcpServersConfig({
			workingDirectory: process.cwd(),
			mcpConfig: {
				linear: {
					type: "http",
					url: "https://mcp.linear.app/mcp",
					http_headers: {
						"x-test-header": "value",
					},
					env_http_headers: {
						Authorization: "LINEAR_API_TOKEN",
					},
					bearer_token_env_var: "LINEAR_API_TOKEN",
				} as any,
			},
		});

		expect(mcpServers.linear.http_headers).toEqual({
			"x-test-header": "value",
		});
		expect(mcpServers.linear.env_http_headers).toEqual({
			Authorization: "LINEAR_API_TOKEN",
		});
		expect(mcpServers.linear.bearer_token_env_var).toBe("LINEAR_API_TOKEN");
	});

	it("translates per-tool Miko MCP allowedTools to Codex enabled_tools", () => {
		const mcpServers = buildCodexMcpServersConfig({
			workingDirectory: process.cwd(),
			allowedTools: [
				"Read",
				"mcp__linear__list_issues",
				"mcp__linear__create_issue",
				"mcp__linear__list_issues",
				"mcp__miko-tools__linear_agent_session_create_on_comment",
			],
			mcpConfig: {
				linear: {
					type: "http",
					url: "https://mcp.linear.app/mcp",
				},
				"miko-tools": {
					type: "http",
					url: "http://127.0.0.1:4444/mcp/miko-tools",
				},
			},
		});

		expect(mcpServers.linear.enabled_tools).toEqual([
			"list_issues",
			"create_issue",
		]);
		expect(mcpServers.linear.default_tools_approval_mode).toBe("approve");
		expect(mcpServers.linear.tools).toBeUndefined();
		expect(mcpServers["miko-tools"].enabled_tools).toEqual([
			"linear_agent_session_create_on_comment",
		]);
		expect(mcpServers["miko-tools"].default_tools_approval_mode).toBe(
			"approve",
		);
		expect(mcpServers["miko-tools"].tools).toBeUndefined();
	});

	it("leaves Codex MCP servers unrestricted for server-wide Miko MCP allowedTools", () => {
		const mcpServers = buildCodexMcpServersConfig({
			workingDirectory: process.cwd(),
			allowedTools: ["mcp__linear", "mcp__linear__list_issues"],
			mcpConfig: {
				linear: {
					type: "http",
					url: "https://mcp.linear.app/mcp",
				},
			},
		});

		expect(mcpServers.linear.enabled_tools).toBeUndefined();
		expect(mcpServers.linear.disabled_tools).toBeUndefined();
		expect(mcpServers.linear.default_tools_approval_mode).toBe("approve");
	});

	it("matches underscore Miko MCP server names to hyphenated Codex MCP server names", () => {
		const mcpServers = buildCodexMcpServersConfig({
			workingDirectory: process.cwd(),
			allowedTools: [
				"mcp__slack_fixed__conversations_replies",
				"mcp__slack_fixed__attachment_get_data",
			],
			mcpConfig: {
				"slack-fixed": {
					type: "http",
					url: "https://example.com/slack-fixed/mcp",
				},
			},
		});

		expect(mcpServers["slack-fixed"].enabled_tools).toEqual([
			"conversations_replies",
			"attachment_get_data",
		]);
		expect(mcpServers["slack-fixed"].default_tools_approval_mode).toBe(
			"approve",
		);
		expect(mcpServers["slack-fixed"].tools).toBeUndefined();
	});

	it("keeps Codex-native MCP tool filters ahead of Miko allowedTools translation", () => {
		const mcpServers = buildCodexMcpServersConfig({
			workingDirectory: process.cwd(),
			allowedTools: [
				"mcp__linear__create_issue",
				"mcp__github__create_pull_request",
			],
			mcpConfig: {
				linear: {
					type: "http",
					url: "https://mcp.linear.app/mcp",
					enabled_tools: ["list_issues"],
				} as any,
				github: {
					type: "http",
					url: "https://example.com/github/mcp",
					disabled_tools: ["delete_repository"],
				} as any,
			},
		});

		expect(mcpServers.linear.enabled_tools).toEqual(["list_issues"]);
		expect(mcpServers.linear.default_tools_approval_mode).toBe("approve");
		expect(mcpServers.linear.tools).toBeUndefined();
		expect(mcpServers.github.enabled_tools).toBeUndefined();
		expect(mcpServers.github.disabled_tools).toEqual(["delete_repository"]);
		expect(mcpServers.github.default_tools_approval_mode).toBe("approve");
		expect(mcpServers.github.tools).toBeUndefined();
	});

	it("loads hosted file-based MCP configs and preserves Codex MCP options", () => {
		const tmp = mkdtempSync(join(tmpdir(), "miko-codex-mcp-"));
		try {
			const mcpConfigPath = join(tmp, "mcp-hosted.json");
			writeFileSync(
				mcpConfigPath,
				JSON.stringify({
					mcpServers: {
						hosted: {
							command: "node",
							args: ["server.js"],
							env: { HOSTED_TOKEN: "secret" },
							env_vars: [
								"LOCAL_TOKEN",
								{ name: "REMOTE_TOKEN", source: "remote" },
							],
							cwd: "/tmp/hosted",
							experimental_environment: "remote",
							startup_timeout_sec: 20,
							tool_timeout_sec: 45,
							enabled: true,
							required: true,
							enabled_tools: ["search"],
							disabled_tools: ["delete"],
							default_tools_approval_mode: "prompt",
							tools: {
								search: {
									approval_mode: "approve",
								},
							},
						},
						remote: {
							url: "https://example.com/mcp",
							bearer_token_env_var: "REMOTE_MCP_TOKEN",
							http_headers: { "X-Region": "us-east-1" },
							env_http_headers: { Authorization: "AUTH_HEADER" },
						},
					},
				}),
				"utf8",
			);

			const mcpServers = buildCodexMcpServersConfig({
				workingDirectory: process.cwd(),
				mcpConfigPath,
			});

			expect(mcpServers.hosted).toMatchObject({
				command: "node",
				args: ["server.js"],
				env: { HOSTED_TOKEN: "secret" },
				env_vars: ["LOCAL_TOKEN", { name: "REMOTE_TOKEN", source: "remote" }],
				cwd: "/tmp/hosted",
				experimental_environment: "remote",
				startup_timeout_sec: 20,
				tool_timeout_sec: 45,
				enabled: true,
				required: true,
				enabled_tools: ["search"],
				disabled_tools: ["delete"],
				default_tools_approval_mode: "prompt",
				tools: {
					search: {
						approval_mode: "approve",
					},
				},
			});
			expect(mcpServers.remote).toMatchObject({
				url: "https://example.com/mcp",
				bearer_token_env_var: "REMOTE_MCP_TOKEN",
				http_headers: { "X-Region": "us-east-1" },
				env_http_headers: { Authorization: "AUTH_HEADER" },
			});
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
