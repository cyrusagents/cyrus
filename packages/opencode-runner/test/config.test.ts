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

	it("builds inline config and isolates OpenCode state under Cyrus home", () => {
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
		expect(env.OPENCODE_CONFIG_DIR).toBe(
			"/tmp/cyrus/opencode-state/repo/opencode-config",
		);
		expect(env.XDG_DATA_HOME).toBeUndefined();
		expect(env.XDG_STATE_HOME).toBe("/tmp/cyrus/opencode-state/repo/state");
		expect(env.XDG_CACHE_HOME).toBe("/tmp/cyrus/opencode-state/repo/cache");
		expect(env.XDG_CONFIG_HOME).toBe("/tmp/cyrus/opencode-state/repo/config");
	});
});
