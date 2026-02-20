import { describe, expect, it } from "vitest";
import { CodexRunner } from "../src/CodexRunner.js";

describe("CodexRunner MCP config mapping", () => {
	it("maps generic headers to Codex http_headers for HTTP MCP servers", () => {
		const runner = new CodexRunner({
			workingDirectory: process.cwd(),
			mcpConfig: {
				linear: {
					type: "http",
					url: "https://mcp.linear.app/mcp",
					headers: {
						Authorization: "Bearer linear-token",
					},
				},
				"cyrus-tools": {
					type: "http",
					url: "http://127.0.0.1:4444/mcp/cyrus-tools",
					headers: {
						Authorization: "Bearer cyrus-api-key",
						"x-cyrus-mcp-context-id": "repo-1:session-1",
					},
				},
			},
		});

		const mcpServers = (runner as any).buildCodexMcpServersConfig();
		expect(mcpServers.linear.http_headers).toEqual({
			Authorization: "Bearer linear-token",
		});
		expect(mcpServers["cyrus-tools"].http_headers).toEqual({
			Authorization: "Bearer cyrus-api-key",
			"x-cyrus-mcp-context-id": "repo-1:session-1",
		});
	});

	it("preserves codex-native header fields when provided", () => {
		const runner = new CodexRunner({
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

		const mcpServers = (runner as any).buildCodexMcpServersConfig();
		expect(mcpServers.linear.http_headers).toEqual({
			"x-test-header": "value",
		});
		expect(mcpServers.linear.env_http_headers).toEqual({
			Authorization: "LINEAR_API_TOKEN",
		});
		expect(mcpServers.linear.bearer_token_env_var).toBe("LINEAR_API_TOKEN");
	});
});
