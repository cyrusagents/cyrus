/**
 * CLI RPC Server - Fastify-based JSON-RPC handler for F1 testing framework
 *
 * This server exposes HTTP endpoints that bridge the F1 CLI binary with the
 * CLIIssueTrackerService and EdgeWorker, enabling command routing, pagination,
 * and session management.
 *
 * @module issue-tracker/adapters/CLIRPCServer
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
	AgentSessionCreateOnIssueInput,
	Comment,
	CommentCreateInput,
	Issue,
	IssueUpdateInput,
} from "../types.js";
import type { CLIIssueTrackerService } from "./CLIIssueTrackerService.js";

/**
 * RPC command type union for all supported commands
 */
export type RPCCommand =
	| "ping"
	| "status"
	| "version"
	| "createIssue"
	| "assignIssue"
	| "createComment"
	| "startSession"
	| "viewSession"
	| "promptSession"
	| "stopSession"
	| "listAgentSessions"
	| "terminateIssue";

/**
 * JSON-RPC 2.0 request ID type
 */
export type RPCRequestId = number | string | null;

/**
 * Generic RPC request structure (JSON-RPC 2.0 compliant)
 */
export interface RPCRequest<TParams = unknown> {
	jsonrpc: "2.0";
	method: RPCCommand;
	params?: TParams;
	id: RPCRequestId;
}

/**
 * JSON-RPC 2.0 error object
 */
export interface RPCError {
	code: number;
	message: string;
	data?: unknown;
}

/**
 * Generic RPC response structure (JSON-RPC 2.0 compliant)
 */
export interface RPCResponse<TResult = unknown> {
	jsonrpc: "2.0";
	result?: TResult;
	error?: RPCError;
	id: RPCRequestId;
}

/**
 * Standard JSON-RPC 2.0 error codes
 */
export const RPCErrorCodes = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
	SERVER_ERROR: -32000, // Generic server error
} as const;

/**
 * Ping command parameters (no params needed)
 */
export type PingParams = Record<string, never>;

/**
 * Ping command response data
 */
export interface PingData {
	message: string;
	timestamp: number;
}

/**
 * Status command parameters (no params needed)
 */
export type StatusParams = Record<string, never>;

/**
 * Status command response data
 */
export interface StatusData {
	uptime: number;
	status: "ready";
	server: string;
}

/**
 * Version command parameters (no params needed)
 */
export type VersionParams = Record<string, never>;

/**
 * Version command response data
 */
export interface VersionData {
	version: string;
	platform: string;
}

/**
 * Create issue command parameters
 */
export interface CreateIssueParams {
	teamId: string;
	title: string;
	description?: string;
	priority?: number;
	stateId?: string;
	/**
	 * Label names (not IDs) - labels will be created if they don't exist
	 */
	labels?: string[];
}

/**
 * Create issue command response data
 */
export interface CreateIssueData {
	issue: Issue;
}

/**
 * Assign issue command parameters
 */
export interface AssignIssueParams {
	issueId: string;
	userId: string;
}

/**
 * Assign issue command response data
 */
export interface AssignIssueData {
	issue: Issue;
}

/**
 * Create comment command parameters
 */
export interface CreateCommentParams {
	issueId: string;
	body: string;
}

/**
 * Create comment command response data
 */
export interface CreateCommentData {
	comment: Comment;
}

/**
 * Start session command parameters
 */
export interface StartSessionParams {
	issueId: string;
	externalLink?: string;
}

/**
 * Agent session data returned from start/view commands
 */
export interface AgentSessionData {
	sessionId: string;
	issueId: string;
	status: string;
	createdAt: number;
	updatedAt: number;
}

/**
 * Start session command response data
 */
export interface StartSessionData {
	session: AgentSessionData;
}

/**
 * View session command parameters
 */
export interface ViewSessionParams {
	sessionId: string;
	limit?: number;
	offset?: number;
	search?: string;
}

/**
 * Agent activity data for view session response
 */
export interface AgentActivityData {
	id: string;
	type: string;
	content: string;
	createdAt: number;
}

/**
 * View session command response data
 */
export interface ViewSessionData {
	session: AgentSessionData;
	activities: AgentActivityData[];
	totalCount: number;
	hasMore: boolean;
}

/**
 * Prompt session command parameters
 */
export interface PromptSessionParams {
	sessionId: string;
	message: string;
}

/**
 * Prompt session command response data
 */
export interface PromptSessionData {
	success: boolean;
	message: string;
}

/**
 * Stop session command parameters
 */
export interface StopSessionParams {
	sessionId: string;
}

/**
 * Stop session command response data
 */
export interface StopSessionData {
	success: boolean;
	message: string;
}

/**
 * Terminate-issue command parameters.
 *
 * Moves the issue to a terminal state and emits an `IssueStateChangeMessage`
 * on the unified message bus. Used by F1 to exercise EdgeWorker's terminal-
 * state cleanup (worktree removal, `cyrus-teardown.sh`).
 */
export interface TerminateIssueParams {
	issueId: string;
	action: "completed" | "canceled" | "deleted";
}

/**
 * Terminate-issue command response data.
 */
export interface TerminateIssueData {
	success: boolean;
	issueId: string;
	identifier: string;
	action: "completed" | "canceled" | "deleted";
}

/**
 * List agent sessions command parameters
 */
export interface ListAgentSessionsParams {
	issueId?: string;
	limit?: number;
	offset?: number;
}

/**
 * List agent sessions command response data
 */
export interface ListAgentSessionsData {
	sessions: AgentSessionData[];
	totalCount: number;
	hasMore: boolean;
}

/**
 * CLI RPC Server configuration
 */
export interface CLIRPCServerConfig {
	/**
	 * Fastify instance to register routes on
	 */
	fastifyServer: FastifyInstance;

	/**
	 * CLIIssueTrackerService instance to delegate to
	 */
	issueTracker: CLIIssueTrackerService;

	/**
	 * Version string to return for version command
	 */
	version?: string;
}

/**
 * CLI RPC Server
 *
 * Exposes HTTP JSON-RPC endpoints for CLI commands, delegating to
 * CLIIssueTrackerService for all operations.
 *
 * @example
 * ```typescript
 * const server = new CLIRPCServer({
 *   fastifyServer: app,
 *   issueTracker: cliIssueTracker,
 *   version: "1.0.0"
 * });
 *
 * server.register();
 * ```
 */
export class CLIRPCServer {
	private config: CLIRPCServerConfig;
	private startTime: number;

	constructor(config: CLIRPCServerConfig) {
		this.config = config;
		this.startTime = Date.now();
	}

	/**
	 * Register the /cli/rpc endpoint with Fastify
	 */
	register(): void {
		this.config.fastifyServer.post(
			"/cli/rpc",
			async (
				request: FastifyRequest<{ Body: RPCRequest }>,
				reply: FastifyReply,
			) => {
				const requestId = request.body?.id ?? null;

				try {
					const { method, params } = request.body;

					// Route to appropriate handler
					const response = await this.handleCommand(method, params, requestId);

					reply.send(response);
				} catch (error) {
					const errorMessage =
						error instanceof Error ? error.message : "Unknown error";

					reply.send({
						jsonrpc: "2.0",
						error: {
							code: RPCErrorCodes.INTERNAL_ERROR,
							message: errorMessage,
						},
						id: requestId,
					} satisfies RPCResponse);
				}
			},
		);
	}

	/**
	 * Route commands to appropriate handlers
	 */
	private async handleCommand(
		method: RPCCommand,
		params: unknown,
		requestId: RPCRequestId,
	): Promise<RPCResponse> {
		switch (method) {
			case "ping":
				return this.handlePing(params as PingParams, requestId);

			case "status":
				return this.handleStatus(params as StatusParams, requestId);

			case "version":
				return this.handleVersion(params as VersionParams, requestId);

			case "createIssue":
				return this.handleCreateIssue(params as CreateIssueParams, requestId);

			case "assignIssue":
				return this.handleAssignIssue(params as AssignIssueParams, requestId);

			case "createComment":
				return this.handleCreateComment(
					params as CreateCommentParams,
					requestId,
				);

			case "startSession":
				return this.handleStartSession(params as StartSessionParams, requestId);

			case "viewSession":
				return this.handleViewSession(params as ViewSessionParams, requestId);

			case "promptSession":
				return this.handlePromptSession(
					params as PromptSessionParams,
					requestId,
				);

			case "stopSession":
				return this.handleStopSession(params as StopSessionParams, requestId);

			case "listAgentSessions":
				return this.handleListAgentSessions(
					params as ListAgentSessionsParams,
					requestId,
				);

			case "terminateIssue":
				return this.handleTerminateIssue(
					params as TerminateIssueParams,
					requestId,
				);

			default:
				return {
					jsonrpc: "2.0",
					error: {
						code: RPCErrorCodes.METHOD_NOT_FOUND,
						message: `Unknown command: ${method}`,
					},
					id: requestId,
				};
		}
	}

	/**
	 * Handle ping command - health check
	 */
	private async handlePing(
		_params: PingParams,
		requestId: RPCRequestId,
	): Promise<RPCResponse<PingData>> {
		return {
			jsonrpc: "2.0",
			result: {
				message: "pong",
				timestamp: Date.now(),
			},
			id: requestId,
		};
	}

	/**
	 * Handle status command - server status with uptime
	 */
	private async handleStatus(
		_params: StatusParams,
		requestId: RPCRequestId,
	): Promise<RPCResponse<StatusData>> {
		return {
			jsonrpc: "2.0",
			result: {
				uptime: Date.now() - this.startTime,
				status: "ready",
				server: "CLIRPCServer",
			},
			id: requestId,
		};
	}

	/**
	 * Handle version command - version info
	 */
	private async handleVersion(
		_params: VersionParams,
		requestId: RPCRequestId,
	): Promise<RPCResponse<VersionData>> {
		return {
			jsonrpc: "2.0",
			result: {
				version: this.config.version ?? "unknown",
				platform: "cli",
			},
			id: requestId,
		};
	}

	/**
	 * Handle createIssue command - create new issue
	 */
	private async handleCreateIssue(
		params: CreateIssueParams,
		requestId: RPCRequestId,
	): Promise<RPCResponse<CreateIssueData>> {
		const { teamId, title, description, priority, stateId, labels } = params;

		if (!teamId || !title) {
			return {
				jsonrpc: "2.0",
				error: {
					code: RPCErrorCodes.INVALID_PARAMS,
					message: "Missing required parameters: teamId and title are required",
				},
				id: requestId,
			};
		}

		try {
			// Resolve label names to IDs (creating labels if they don't exist)
			let labelIds: string[] | undefined;
			if (labels && labels.length > 0) {
				labelIds = await Promise.all(
					labels.map((labelName) =>
						this.config.issueTracker.findOrCreateLabel(labelName),
					),
				);
			}

			const issue = await this.config.issueTracker.createIssue({
				teamId,
				title,
				description,
				priority,
				stateId,
				labelIds,
			});

			return {
				jsonrpc: "2.0",
				result: {
					issue,
				},
				id: requestId,
			};
		} catch (error) {
			return {
				jsonrpc: "2.0",
				error: {
					code: RPCErrorCodes.SERVER_ERROR,
					message:
						error instanceof Error ? error.message : "Failed to create issue",
				},
				id: requestId,
			};
		}
	}

	/**
	 * Handle assignIssue command - assign issue to user
	 */
	private async handleAssignIssue(
		params: AssignIssueParams,
		requestId: RPCRequestId,
	): Promise<RPCResponse<AssignIssueData>> {
		const { issueId, userId } = params;

		if (!issueId || !userId) {
			return {
				jsonrpc: "2.0",
				error: {
					code: RPCErrorCodes.INVALID_PARAMS,
					message:
						"Missing required parameters: issueId and userId are required",
				},
				id: requestId,
			};
		}

		try {
			const updates: IssueUpdateInput = {
				assigneeId: userId,
			};

			const issue = await this.config.issueTracker.updateIssue(
				issueId,
				updates,
			);

			return {
				jsonrpc: "2.0",
				result: {
					issue,
				},
				id: requestId,
			};
		} catch (error) {
			return {
				jsonrpc: "2.0",
				error: {
					code: RPCErrorCodes.SERVER_ERROR,
					message:
						error instanceof Error ? error.message : "Failed to assign issue",
				},
				id: requestId,
			};
		}
	}

	/**
	 * Handle createComment command - add comment to issue
	 */
	private async handleCreateComment(
		params: CreateCommentParams,
		requestId: RPCRequestId,
	): Promise<RPCResponse<CreateCommentData>> {
		const { issueId, body } = params;

		if (!issueId || !body) {
			return {
				jsonrpc: "2.0",
				error: {
					code: RPCErrorCodes.INVALID_PARAMS,
					message: "Missing required parameters: issueId and body are required",
				},
				id: requestId,
			};
		}

		try {
			const input: CommentCreateInput = {
				body,
			};

			const comment = await this.config.issueTracker.createComment(
				issueId,
				input,
			);

			return {
				jsonrpc: "2.0",
				result: {
					comment,
				},
				id: requestId,
			};
		} catch (error) {
			return {
				jsonrpc: "2.0",
				error: {
					code: RPCErrorCodes.SERVER_ERROR,
					message:
						error instanceof Error ? error.message : "Failed to create comment",
				},
				id: requestId,
			};
		}
	}

	/**
	 * Handle startSession command - start agent session on issue
	 */
	private async handleStartSession(
		params: StartSessionParams,
		requestId: RPCRequestId,
	): Promise<RPCResponse<StartSessionData>> {
		const { issueId, externalLink } = params;

		if (!issueId) {
			return {
				jsonrpc: "2.0",
				error: {
					code: RPCErrorCodes.INVALID_PARAMS,
					message: "Missing required parameter: issueId is required",
				},
				id: requestId,
			};
		}

		try {
			const input: AgentSessionCreateOnIssueInput = {
				issueId,
				...(externalLink && { externalLink }),
			};

			const result =
				await this.config.issueTracker.createAgentSessionOnIssue(input);

			// Extract session from LinearFetch result
			const agentSessionPayload = await result;

			// Access agentSession property safely
			const agentSession = await agentSessionPayload.agentSession;

			if (!agentSession) {
				throw new Error("Failed to create agent session - no session returned");
			}

			return {
				jsonrpc: "2.0",
				result: {
					session: {
						sessionId: agentSession.id,
						issueId,
						status: agentSession.status ?? "unknown",
						createdAt: Date.now(),
						updatedAt: Date.now(),
					},
				},
				id: requestId,
			};
		} catch (error) {
			return {
				jsonrpc: "2.0",
				error: {
					code: RPCErrorCodes.SERVER_ERROR,
					message:
						error instanceof Error ? error.message : "Failed to start session",
				},
				id: requestId,
			};
		}
	}

	/**
	 * Handle viewSession command - view session with activity pagination
	 */
	private async handleViewSession(
		params: ViewSessionParams,
		requestId: RPCRequestId,
	): Promise<RPCResponse<ViewSessionData>> {
		const { sessionId, limit = 50, offset = 0, search } = params;

		if (!sessionId) {
			return {
				jsonrpc: "2.0",
				error: {
					code: RPCErrorCodes.INVALID_PARAMS,
					message: "Missing required parameter: sessionId is required",
				},
				id: requestId,
			};
		}

		try {
			// Fetch session
			const agentSession =
				await this.config.issueTracker.fetchAgentSession(sessionId);

			// Fetch ALL activities from the issue tracker (no limit yet)
			const activityDataList =
				this.config.issueTracker.listAgentActivities(sessionId);

			// Filter out ephemeral activities that have been replaced by subsequent activities
			// An ephemeral activity is replaced if there's ANY activity that comes after it
			const visibleActivities = activityDataList.filter((activity, index) => {
				// If this activity is not ephemeral, it's always visible
				if (activity.ephemeral !== true) {
					return true;
				}

				// If this is an ephemeral activity, check if there's any activity after it (by index)
				// If there is, this ephemeral activity should be hidden (replaced)
				// We use index comparison because activities may have the same timestamp
				const hasSubsequentActivity = activityDataList.some(
					(_otherActivity, otherIndex) => otherIndex > index,
				);

				// Show ephemeral activity only if there's no subsequent activity
				return !hasSubsequentActivity;
			});

			// Filter by search if provided
			let filteredActivities = visibleActivities;
			if (search) {
				const searchLower = search.toLowerCase();
				filteredActivities = visibleActivities.filter((a) =>
					a.content.toLowerCase().includes(searchLower),
				);
			}

			// Apply pagination after filtering
			const paginatedActivityData = filteredActivities.slice(
				offset,
				offset + limit,
			);

			// Check if there are more activities
			const hasMore = filteredActivities.length > offset + limit;

			// Transform to AgentActivityData format
			const activities: AgentActivityData[] = paginatedActivityData.map(
				(activityData) => ({
					id: activityData.id,
					type: activityData.type,
					content: activityData.content,
					createdAt: activityData.createdAt.getTime(),
				}),
			);

			// Total count is based on filtered activities
			const totalCount = filteredActivities.length;

			return {
				jsonrpc: "2.0",
				result: {
					session: {
						sessionId: agentSession.id,
						issueId: agentSession.issueId ?? "unknown",
						status: agentSession.status ?? "unknown",
						createdAt: agentSession.createdAt.getTime(),
						updatedAt: agentSession.updatedAt.getTime(),
					},
					activities,
					totalCount,
					hasMore,
				},
				id: requestId,
			};
		} catch (error) {
			return {
				jsonrpc: "2.0",
				error: {
					code: RPCErrorCodes.SERVER_ERROR,
					message:
						error instanceof Error ? error.message : "Failed to view session",
				},
				id: requestId,
			};
		}
	}

	/**
	 * Handle promptSession command - send message to session
	 */
	private async handlePromptSession(
		params: PromptSessionParams,
		requestId: RPCRequestId,
	): Promise<RPCResponse<PromptSessionData>> {
		const { sessionId, message } = params;

		if (!sessionId || !message) {
			return {
				jsonrpc: "2.0",
				error: {
					code: RPCErrorCodes.INVALID_PARAMS,
					message:
						"Missing required parameters: sessionId and message are required",
				},
				id: requestId,
			};
		}

		try {
			// Prompt the session - this creates a comment and emits a prompted event
			await this.config.issueTracker.promptAgentSession(sessionId, message);

			return {
				jsonrpc: "2.0",
				result: {
					success: true,
					message: "Session prompted successfully",
				},
				id: requestId,
			};
		} catch (error) {
			return {
				jsonrpc: "2.0",
				error: {
					code: RPCErrorCodes.SERVER_ERROR,
					message:
						error instanceof Error ? error.message : "Failed to prompt session",
				},
				id: requestId,
			};
		}
	}

	/**
	 * Handle stopSession command - stop agent session
	 */
	private async handleStopSession(
		params: StopSessionParams,
		requestId: RPCRequestId,
	): Promise<RPCResponse<StopSessionData>> {
		const { sessionId } = params;

		if (!sessionId) {
			return {
				jsonrpc: "2.0",
				error: {
					code: RPCErrorCodes.INVALID_PARAMS,
					message: "Missing required parameter: sessionId is required",
				},
				id: requestId,
			};
		}

		try {
			// Import AgentSessionStatus for the update
			const { AgentSessionStatus } = await import("../types.js");

			// Update the session status to complete
			await this.config.issueTracker.updateAgentSessionStatus(
				sessionId,
				AgentSessionStatus.Complete,
			);

			// Emit stop signal event for EdgeWorker to handle
			await this.config.issueTracker.emitStopSignalEvent(sessionId);

			return {
				jsonrpc: "2.0",
				result: {
					success: true,
					message: "Session stopped successfully",
				},
				id: requestId,
			};
		} catch (error) {
			return {
				jsonrpc: "2.0",
				error: {
					code: RPCErrorCodes.SERVER_ERROR,
					message:
						error instanceof Error ? error.message : "Failed to stop session",
				},
				id: requestId,
			};
		}
	}

	/**
	 * Handle listAgentSessions command - list all sessions (optional)
	 */
	private async handleListAgentSessions(
		params: ListAgentSessionsParams,
		requestId: RPCRequestId,
	): Promise<RPCResponse<ListAgentSessionsData>> {
		const { issueId, limit = 50, offset = 0 } = params;

		try {
			// Get sessions from the issue tracker
			const sessionDataList = this.config.issueTracker.listAgentSessions({
				issueId,
				limit: limit + 1, // Fetch one extra to check hasMore
				offset,
			});

			// Check if there are more sessions
			const hasMore = sessionDataList.length > limit;
			const paginatedSessionData = hasMore
				? sessionDataList.slice(0, limit)
				: sessionDataList;

			// Transform to AgentSessionData format
			const sessions: AgentSessionData[] = paginatedSessionData.map(
				(sessionData) => ({
					sessionId: sessionData.id,
					issueId: sessionData.issueId ?? "unknown",
					status: sessionData.status ?? "unknown",
					createdAt: sessionData.createdAt.getTime(),
					updatedAt: sessionData.updatedAt.getTime(),
				}),
			);

			// Get total count (approximate - would need separate count query for accuracy)
			const allSessions = this.config.issueTracker.listAgentSessions({
				issueId,
			});
			const totalCount = allSessions.length;

			return {
				jsonrpc: "2.0",
				result: {
					sessions,
					totalCount,
					hasMore,
				},
				id: requestId,
			};
		} catch (error) {
			return {
				jsonrpc: "2.0",
				error: {
					code: RPCErrorCodes.SERVER_ERROR,
					message:
						error instanceof Error
							? error.message
							: "Failed to list agent sessions",
				},
				id: requestId,
			};
		}
	}

	/**
	 * Handle terminateIssue command — move an issue to a terminal state and
	 * emit an `IssueStateChangeMessage` so EdgeWorker runs its terminal-state
	 * cleanup (stops sessions, runs `cyrus-teardown.sh`, removes worktrees).
	 */
	private async handleTerminateIssue(
		params: TerminateIssueParams,
		requestId: RPCRequestId,
	): Promise<RPCResponse<TerminateIssueData>> {
		const { issueId, action } = params ?? ({} as TerminateIssueParams);

		if (!issueId) {
			return {
				jsonrpc: "2.0",
				error: {
					code: RPCErrorCodes.INVALID_PARAMS,
					message: "Missing required parameter: issueId is required",
				},
				id: requestId,
			};
		}

		if (
			action !== "completed" &&
			action !== "canceled" &&
			action !== "deleted"
		) {
			return {
				jsonrpc: "2.0",
				error: {
					code: RPCErrorCodes.INVALID_PARAMS,
					message:
						"Invalid action: must be one of 'completed', 'canceled', 'deleted'",
				},
				id: requestId,
			};
		}

		try {
			const identifier = await this.config.issueTracker.terminateIssue(
				issueId,
				action,
			);

			return {
				jsonrpc: "2.0",
				result: {
					success: true,
					issueId,
					identifier,
					action,
				},
				id: requestId,
			};
		} catch (error) {
			return {
				jsonrpc: "2.0",
				error: {
					code: RPCErrorCodes.SERVER_ERROR,
					message:
						error instanceof Error
							? error.message
							: "Failed to terminate issue",
				},
				id: requestId,
			};
		}
	}
}
