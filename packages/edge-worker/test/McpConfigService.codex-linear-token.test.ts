import type { LinearClient } from "@linear/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { McpConfigService } from "../src/McpConfigService.js";

const ORIGINAL_CODEX_LINEAR_TOKEN = process.env.CYRUS_CODEX_LINEAR_OAUTH_TOKEN;

afterEach(() => {
	if (ORIGINAL_CODEX_LINEAR_TOKEN === undefined) {
		delete process.env.CYRUS_CODEX_LINEAR_OAUTH_TOKEN;
	} else {
		process.env.CYRUS_CODEX_LINEAR_OAUTH_TOKEN = ORIGINAL_CODEX_LINEAR_TOKEN;
	}
});

function makeService() {
	return new McpConfigService({
		getLinearTokenForWorkspace: () => "workspace-linear-token",
		getIssueTracker: () =>
			({
				getClient: () => ({}) as LinearClient,
			}) as any,
		getCyrusToolsMcpUrl: () => "http://localhost:3456/mcp/cyrus-tools",
		createCyrusToolsOptions: () => ({
			getAgentSession: async () => ({ ok: false, error: "not implemented" }),
			getChildIssues: async () => ({ ok: false, error: "not implemented" }),
			uploadFile: async () => ({ ok: false, error: "not implemented" }),
		}),
	});
}

describe("McpConfigService Codex Linear actor token", () => {
	it("uses the Codex token for the direct Linear MCP server when requested", () => {
		process.env.CYRUS_CODEX_LINEAR_OAUTH_TOKEN = "codex-linear-token";
		const service = makeService();

		const config = service.buildMcpConfig(
			"repo-1",
			"workspace-1",
			"session-1",
			{
				preferCodexLinearToken: true,
			},
		);

		expect(config.linear?.headers?.Authorization).toBe(
			"Bearer codex-linear-token",
		);
		expect(service.getContext("repo-1:session-1")?.linearToken).toBe(
			"workspace-linear-token",
		);
	});

	it("keeps the workspace token for non-Codex sessions", () => {
		process.env.CYRUS_CODEX_LINEAR_OAUTH_TOKEN = "codex-linear-token";
		const service = makeService();

		const config = service.buildMcpConfig("repo-1", "workspace-1", "session-1");

		expect(config.linear?.headers?.Authorization).toBe(
			"Bearer workspace-linear-token",
		);
	});

	it("falls back to the workspace token when the Codex token is unavailable", () => {
		delete process.env.CYRUS_CODEX_LINEAR_OAUTH_TOKEN;
		const service = makeService();

		const config = service.buildMcpConfig(
			"repo-1",
			"workspace-1",
			"session-1",
			{
				preferCodexLinearToken: true,
			},
		);

		expect(config.linear?.headers?.Authorization).toBe(
			"Bearer workspace-linear-token",
		);
	});
});
