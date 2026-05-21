import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FailureModesHttpClient } from "../../../src/tools/cyrus-tools/log-failure-mode.js";
import { registerLogFailureModeTool } from "../../../src/tools/cyrus-tools/log-failure-mode.js";

function getHandler(server: McpServer, name: string) {
	const tools = (
		server as unknown as {
			_registeredTools?: Record<
				string,
				{ handler: (args: any) => Promise<any> }
			>;
		}
	)._registeredTools;
	const t = tools?.[name];
	if (!t) throw new Error(`tool ${name} not registered`);
	return t.handler;
}

describe("log_failure_mode tool", () => {
	let httpClient: FailureModesHttpClient;
	let resolveSessionFromCwd: (cwd: string) => string | null;
	let server: McpServer;

	beforeEach(() => {
		httpClient = {
			postFailureMode: vi.fn(async () => ({
				ok: true,
				reportId: 7,
				action: "created" as const,
				linearIssueUrl: "https://linear.app/ceedar/issue/CYPACK-9999",
			})),
		};
		resolveSessionFromCwd = vi.fn((cwd: string) =>
			cwd === "/work/CYPACK-1" ? "session-abc" : null,
		);
		server = new McpServer({ name: "test", version: "0.0.0" });
		registerLogFailureModeTool(server, {
			resolveSessionFromCwd,
			httpClient,
		});
	});

	it("resolves cwd → sessionId and POSTs the full payload", async () => {
		const handler = getHandler(server, "log_failure_mode");
		const result = await handler({
			cwd: "/work/CYPACK-1",
			category: "screenshots-not-returned",
			recap: "User asked for PR screenshots and none were posted.",
			user_quote_snippet: "where are the screenshots?",
			agent_failure_snippet: "PR opened: https://github.com/x/y/pull/1",
		});

		expect(httpClient.postFailureMode).toHaveBeenCalledWith({
			sessionId: "session-abc",
			sessionSource: "linear",
			category: "screenshots-not-returned",
			recap: "User asked for PR screenshots and none were posted.",
			userQuoteSnippet: "where are the screenshots?",
			agentFailureSnippet: "PR opened: https://github.com/x/y/pull/1",
			sessionLogsUrl: undefined,
		});

		const payload = JSON.parse(result.content[0].text);
		expect(payload.success).toBe(true);
		expect(payload.reportId).toBe(7);
		expect(payload.action).toBe("created");
		expect(payload.linearIssueUrl).toMatch(/CYPACK-9999/);
		expect(payload.sessionId).toBe("session-abc");
	});

	it("infers sessionSource from a `github-` prefix", async () => {
		(resolveSessionFromCwd as ReturnType<typeof vi.fn>).mockImplementation(
			() => "github-abc-123",
		);
		server = new McpServer({ name: "test", version: "0.0.0" });
		registerLogFailureModeTool(server, {
			resolveSessionFromCwd,
			httpClient,
		});
		const handler = getHandler(server, "log_failure_mode");
		await handler({
			cwd: "/work/anywhere",
			category: "x",
			recap: "y",
			user_quote_snippet: "z",
			agent_failure_snippet: "q",
		});
		const callArg = (httpClient.postFailureMode as any).mock.calls[0][0];
		expect(callArg.sessionSource).toBe("github");
	});

	it("infers sessionSource from a `slack-` prefix", async () => {
		(resolveSessionFromCwd as ReturnType<typeof vi.fn>).mockImplementation(
			() => "slack-T123-C456",
		);
		server = new McpServer({ name: "test", version: "0.0.0" });
		registerLogFailureModeTool(server, {
			resolveSessionFromCwd,
			httpClient,
		});
		const handler = getHandler(server, "log_failure_mode");
		await handler({
			cwd: "/x",
			category: "x",
			recap: "y",
			user_quote_snippet: "z",
			agent_failure_snippet: "q",
		});
		const callArg = (httpClient.postFailureMode as any).mock.calls[0][0];
		expect(callArg.sessionSource).toBe("slack");
	});

	it("falls back to fallbackSessionId when cwd doesn't resolve", async () => {
		server = new McpServer({ name: "test", version: "0.0.0" });
		registerLogFailureModeTool(server, {
			resolveSessionFromCwd: () => null,
			httpClient,
			fallbackSessionId: "fallback-session",
		});
		const handler = getHandler(server, "log_failure_mode");
		const result = await handler({
			cwd: "/elsewhere",
			category: "port-conflict",
			recap: "Asked for port 3001 but agent stayed on 3000.",
			user_quote_snippet: "please use port 3001",
			agent_failure_snippet: "Starting dev server on :3000",
		});

		expect(httpClient.postFailureMode).toHaveBeenCalled();
		const callArg = (httpClient.postFailureMode as any).mock.calls[0][0];
		expect(callArg.sessionId).toBe("fallback-session");
		const payload = JSON.parse(result.content[0].text);
		expect(payload.success).toBe(true);
	});

	it("returns an error result when sessionId cannot be resolved", async () => {
		server = new McpServer({ name: "test", version: "0.0.0" });
		registerLogFailureModeTool(server, {
			resolveSessionFromCwd: () => null,
			httpClient,
		});
		const handler = getHandler(server, "log_failure_mode");
		const result = await handler({
			cwd: "/unknown",
			category: "x",
			recap: "y",
			user_quote_snippet: "z",
			agent_failure_snippet: "q",
		});
		const payload = JSON.parse(result.content[0].text);
		expect(payload.success).toBe(false);
		expect(payload.error).toMatch(/Could not resolve a session id/);
		expect(httpClient.postFailureMode).not.toHaveBeenCalled();
	});

	it("surfaces HTTP failure as a tool error result", async () => {
		(httpClient.postFailureMode as any).mockResolvedValueOnce({
			ok: false,
			status: 401,
			error: "Invalid API key",
		});
		const handler = getHandler(server, "log_failure_mode");
		const result = await handler({
			cwd: "/work/CYPACK-1",
			category: "x",
			recap: "y",
			user_quote_snippet: "z",
			agent_failure_snippet: "q",
		});
		const payload = JSON.parse(result.content[0].text);
		expect(payload.success).toBe(false);
		expect(payload.error).toMatch(/401/);
		expect(payload.error).toMatch(/Invalid API key/);
	});
});
