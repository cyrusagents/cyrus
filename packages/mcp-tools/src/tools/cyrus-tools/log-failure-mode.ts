import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Resolver that maps a working directory (CWD) to a session id. Owned by
 * the harness (EdgeWorker), which is the only component with access to the
 * live session registry. The MCP tool depends on the abstract function
 * rather than EdgeWorker directly to keep the package free of harness
 * dependencies (DIP).
 */
export type ResolveSessionFromCwd = (cwd: string) => string | null;

/**
 * HTTP client interface for posting to cyrus-hosted. Tests can substitute
 * a mock without standing up a real fetch.
 */
export interface FailureModesHttpClient {
	postFailureMode(input: {
		sessionId: string;
		category: string;
		recap: string;
		userQuoteSnippet: string;
		agentFailureSnippet: string;
		sessionLogsUrl?: string;
	}): Promise<
		| { ok: true; action: "created" | "commented"; linearIssueUrl: string }
		| { ok: false; status: number; error: string }
	>;
}

export interface LogFailureModeOptions {
	resolveSessionFromCwd: ResolveSessionFromCwd;
	httpClient: FailureModesHttpClient;
	/**
	 * Fallback session id used when `resolveSessionFromCwd(cwd)` returns
	 * null but the harness already knows which session is hosting this MCP
	 * server (e.g. parentSessionId passed to `createCyrusToolsServer`).
	 */
	fallbackSessionId?: string;
}

export function registerLogFailureModeTool(
	server: McpServer,
	options: LogFailureModeOptions,
): void {
	server.registerTool(
		"log_failure_mode",
		{
			description:
				'Log a customer-facing failure mode to the Cyrus internal failure-modes Linear project. Call this when (a) the user expresses dissatisfaction (e.g. "that\'s not what I asked", "still broken", correcting the same point a 2nd time), or (b) you recognize you\'ve made 3+ attempts at the same unresolved problem in this session. The recap should describe what the user asked for vs. what failed in their POV; the user_quote_snippet must be a verbatim quote; the agent_failure_snippet must paste your actual failing output/action.',
			inputSchema: {
				cwd: z
					.string()
					.describe(
						"The current working directory of this agent session. Used to resolve the session id internally.",
					),
				category: z
					.string()
					.min(1)
					.describe(
						"Short free-form category name (e.g. 'screenshots-not-returned', 'port-conflict', 'wrong-file-edited'). Pick something concise and reusable — patterns will emerge over time.",
					),
				recap: z
					.string()
					.min(1)
					.describe(
						"What the user asked for vs. what failed, in their POV. 1-3 sentences.",
					),
				user_quote_snippet: z
					.string()
					.min(1)
					.describe("Verbatim quote of the user's ask or dissatisfaction."),
				agent_failure_snippet: z
					.string()
					.min(1)
					.describe(
						"Direct snippet of the agent's failing output, action, or response.",
					),
				session_logs_url: z
					.string()
					.url()
					.optional()
					.describe("Optional URL to session logs if available."),
			},
		},
		async ({
			cwd,
			category,
			recap,
			user_quote_snippet,
			agent_failure_snippet,
			session_logs_url,
		}) => {
			const resolved = options.resolveSessionFromCwd(cwd);
			const sessionId = resolved ?? options.fallbackSessionId ?? null;

			if (!sessionId) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: `Could not resolve a session id from cwd=${cwd}. The failure-mode report was NOT sent. Verify the cwd argument matches the agent's actual working directory.`,
							}),
						},
					],
				};
			}

			const result = await options.httpClient.postFailureMode({
				sessionId,
				category,
				recap,
				userQuoteSnippet: user_quote_snippet,
				agentFailureSnippet: agent_failure_snippet,
				sessionLogsUrl: session_logs_url,
			});

			if (!result.ok) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: `cyrus-hosted POST /api/failure-modes failed: ${result.status} ${result.error}`,
							}),
						},
					],
				};
			}

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							success: true,
							action: result.action,
							linearIssueUrl: result.linearIssueUrl,
							sessionId,
						}),
					},
				],
			};
		},
	);
}
