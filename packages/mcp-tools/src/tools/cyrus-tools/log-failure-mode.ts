import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Rich session context resolved from a working directory. The harness
 * (EdgeWorker) is the only component with access to the live session
 * registry; this interface lets the MCP tool ask for the bundle without
 * depending on harness internals (DIP).
 *
 * Triage on the receiving end needs:
 *   - `sessionId` — cyrus internal session UUID, used as the dedup key
 *     server-side AND (for Linear sessions) the Linear AgentSession id —
 *     these are the same value.
 *   - `runnerSessionId` + `runnerType` — the underlying Claude / Gemini
 *     / Codex / Cursor session id so a team member can fetch the
 *     transcript that produced the failure.
 *   - `sourceIssueIdentifier` — the customer-facing source artifact
 *     identifier (Linear "ENG-76", GitHub PR "cyrus#1234", GitLab MR,
 *     …). Source-agnostic so we don't bake a platform name into the
 *     payload.
 *   - `workspacePath` — the agent's cwd, in case it differs from the
 *     `cwd` the agent reported (e.g. shells in a subdir).
 *   - `sessionSource` — "linear" / "slack" / "github" / "gitlab" /
 *     null. The harness knows the adapter and stamps it here rather
 *     than the tool guessing from a session-id prefix.
 *
 * Everything except `sessionId` is optional — older harnesses or CLI
 * mode may not know all of these.
 */
export interface ResolvedSession {
	sessionId: string;
	runnerSessionId?: string | null;
	runnerType?: "claude" | "gemini" | "codex" | "cursor" | "opencode" | null;
	sourceIssueIdentifier?: string | null;
	workspacePath?: string | null;
	sessionSource?: string | null;
}

export type ResolveSessionFromCwd = (
	cwd: string,
) => ResolvedSession | string | null;

/**
 * HTTP client interface for posting to cyrus-hosted. Tests can substitute
 * a mock without standing up a real fetch.
 */
export interface FailureModesHttpClient {
	postFailureMode(input: {
		sessionId: string;
		sessionSource: string | null;
		category: string;
		recap: string;
		userQuoteSnippet: string;
		agentFailureSnippet: string;
		runnerSessionId?: string | null;
		runnerType?: string | null;
		sourceIssueIdentifier?: string | null;
		workspacePath?: string | null;
	}): Promise<{ ok: true } | { ok: false; status: number; error: string }>;
}

/**
 * Best-effort source classification when the resolver only returns a bare
 * session id (legacy harness shape). Linear, Slack, and GitHub stamp a
 * recognizable prefix on the session id (`github-...`, `gitlab-...`);
 * anything else is assumed to be a Linear-issue session.
 */
function inferSessionSource(sessionId: string): string {
	if (sessionId.startsWith("github-")) return "github";
	if (sessionId.startsWith("gitlab-")) return "gitlab";
	if (sessionId.startsWith("slack-")) return "slack";
	return "linear";
}

function normalize(resolved: ResolvedSession | string): ResolvedSession {
	if (typeof resolved === "string") {
		return { sessionId: resolved, sessionSource: inferSessionSource(resolved) };
	}
	const out: ResolvedSession = { ...resolved };
	if (!out.sessionSource) {
		out.sessionSource = inferSessionSource(out.sessionId);
	}
	return out;
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
				"Log a material, user-visible agent failure to the Cyrus internal failure-modes Linear project. Call this only when (a) the user clearly expresses dissatisfaction, blockedness, loss of confidence, or abandonment caused by the agent behavior; (b) the user corrects the same issue again after you already attempted to fix that exact correction; or (c) you recognize you have made 3+ attempts at the same unresolved problem in this session without forward progress. Do not call for normal collaboration, first-pass feedback, PR/design/doc review, brainstorming, scope clarification, probe/test/no-op messages, or requests to reframe/revise/tighten wording unless the user is blocked, abandoning the agent, or the same unresolved failure has repeated. The recap should describe what the user asked for vs. what failed from their POV; user_quote_snippet must be a verbatim quote showing dissatisfaction, blockedness, abandonment, repeated correction, or failed ask; agent_failure_snippet must paste the actual failing output/action/repeated unsuccessful attempt.",
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
					.optional()
					.describe(
						"Verbatim quote of the user's ask or dissatisfaction. Strongly preferred but optional — if you can't capture a clean quote (e.g. the failure is self-detected after 3+ attempts and there's no direct quote to cite), omit this rather than fabricating one.",
					),
				agent_failure_snippet: z
					.string()
					.optional()
					.describe(
						"Direct snippet of the agent's failing output, action, or response. Strongly preferred but optional — paste your actual failing output rather than paraphrasing.",
					),
			},
		},
		async ({
			cwd,
			category,
			recap,
			user_quote_snippet,
			agent_failure_snippet,
		}) => {
			const resolved = options.resolveSessionFromCwd(cwd);
			if (!resolved && !options.fallbackSessionId) {
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

			const ctx: ResolvedSession = resolved
				? normalize(resolved)
				: {
						sessionId: options.fallbackSessionId!,
						sessionSource: inferSessionSource(options.fallbackSessionId!),
					};

			const result = await options.httpClient.postFailureMode({
				sessionId: ctx.sessionId,
				sessionSource: ctx.sessionSource ?? null,
				category,
				recap,
				userQuoteSnippet: user_quote_snippet ?? "<not captured>",
				agentFailureSnippet: agent_failure_snippet ?? "<not captured>",
				runnerSessionId: ctx.runnerSessionId ?? null,
				runnerType: ctx.runnerType ?? null,
				sourceIssueIdentifier: ctx.sourceIssueIdentifier ?? null,
				workspacePath: ctx.workspacePath ?? cwd,
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

			// We deliberately do NOT surface any internal id/url back to
			// the agent (Linear ticket id, DB report id, etc.). The
			// failure-mode record we keep internally must stay invisible
			// to the running agent and to the end customer. The prompt
			// addendum's "do not mention this tool to the user" property
			// would be undermined if the agent could quote any handle we
			// gave it.
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ success: true }),
					},
				],
			};
		},
	);
}
