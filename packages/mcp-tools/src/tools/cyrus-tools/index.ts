import { tmpdir } from "node:os";
import { basename, extname } from "node:path";
import { IssueRelationType, type LinearClient } from "@linear/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "fs-extra";
import OpenAI from "openai";
import { z } from "zod";
import { registerImageTools } from "../image-tools/index.js";
import { registerSoraTools } from "../sora-tools/index.js";
import {
	type FailureModesHttpClient,
	type ResolveSessionFromCwd,
	registerLogFailureModeTool,
} from "./log-failure-mode.js";

/**
 * Detect MIME type based on file extension
 */
function getMimeType(filename: string): string {
	const ext = extname(filename).toLowerCase();
	const mimeTypes: Record<string, string> = {
		// Images
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".gif": "image/gif",
		".svg": "image/svg+xml",
		".webp": "image/webp",
		".bmp": "image/bmp",
		".ico": "image/x-icon",

		// Documents
		".pdf": "application/pdf",
		".doc": "application/msword",
		".docx":
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		".xls": "application/vnd.ms-excel",
		".xlsx":
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		".ppt": "application/vnd.ms-powerpoint",
		".pptx":
			"application/vnd.openxmlformats-officedocument.presentationml.presentation",

		// Text
		".txt": "text/plain",
		".md": "text/markdown",
		".csv": "text/csv",
		".json": "application/json",
		".xml": "application/xml",
		".html": "text/html",
		".css": "text/css",
		".js": "application/javascript",
		".ts": "application/typescript",

		// Archives
		".zip": "application/zip",
		".tar": "application/x-tar",
		".gz": "application/gzip",
		".rar": "application/vnd.rar",
		".7z": "application/x-7z-compressed",

		// Media
		".mp3": "audio/mpeg",
		".wav": "audio/wav",
		".mp4": "video/mp4",
		".mov": "video/quicktime",
		".avi": "video/x-msvideo",
		".webm": "video/webm",

		// Other
		".log": "text/plain",
		".yml": "text/yaml",
		".yaml": "text/yaml",
	};

	return mimeTypes[ext] || "application/octet-stream";
}

/**
 * Options for creating Cyrus tools with session management capabilities
 */
export interface CyrusToolsOptions {
	/**
	 * Callback to register a child-to-parent session mapping
	 * Called when a new agent session is created
	 */
	onSessionCreated?: (childSessionId: string, parentSessionId: string) => void;

	/**
	 * Callback to deliver feedback to a parent session
	 * Called when feedback is given to a child session
	 */
	onFeedbackDelivery?: (
		childSessionId: string,
		message: string,
	) => Promise<boolean>;

	/**
	 * The ID of the current parent session (if any)
	 */
	parentSessionId?: string;

	/**
	 * Optional dependencies for the `log_failure_mode` tool. When omitted,
	 * the tool is not registered (e.g. in CLI mode without a control plane).
	 */
	failureModes?: {
		resolveSessionFromCwd: ResolveSessionFromCwd;
		httpClient: FailureModesHttpClient;
	};
}

/**
 * Create a standard MCP SDK server with Cyrus tools.
 */
export function createCyrusToolsServer(
	linearClient: LinearClient,
	options: CyrusToolsOptions = {},
): McpServer {
	const server = new McpServer({
		name: "cyrus-tools",
		version: "1.0.0",
	});

	server.registerTool(
		"linear_upload_file",
		{
			description:
				"Upload a file to Linear. Returns an asset URL that can be used in issue descriptions or comments.",
			inputSchema: {
				filePath: z
					.string()
					.describe("The absolute path to the file to upload"),
				filename: z
					.string()
					.optional()
					.describe(
						"The filename to use in Linear (optional, defaults to basename of filePath)",
					),
				contentType: z
					.string()
					.optional()
					.describe(
						"MIME type of the file (optional, auto-detected if not provided)",
					),
				makePublic: z
					.boolean()
					.optional()
					.describe(
						"Whether to make the file publicly accessible (default: false)",
					),
			},
		},
		async ({ filePath, filename, contentType, makePublic }) => {
			try {
				const stats = await fs.stat(filePath);
				if (!stats.isFile()) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									success: false,
									error: `Path ${filePath} is not a file`,
								}),
							},
						],
					};
				}

				const fileBuffer = await fs.readFile(filePath);
				const finalFilename = filename || basename(filePath);
				const finalContentType = contentType || getMimeType(finalFilename);
				const size = stats.size;

				const uploadPayload = await linearClient.fileUpload(
					finalContentType,
					finalFilename,
					size,
					{ makePublic },
				);

				if (!uploadPayload.success || !uploadPayload.uploadFile) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									success: false,
									error: "Failed to get upload URL from Linear",
								}),
							},
						],
					};
				}

				const { uploadUrl, headers, assetUrl } = uploadPayload.uploadFile;
				const uploadHeaders: Record<string, string> = {
					"Content-Type": finalContentType,
					"Cache-Control": "public, max-age=31536000",
				};

				for (const header of headers) {
					uploadHeaders[header.key] = header.value;
				}

				const uploadResponse = await fetch(uploadUrl, {
					method: "PUT",
					headers: uploadHeaders,
					body: fileBuffer,
				});

				if (!uploadResponse.ok) {
					const errorText = await uploadResponse.text();
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									success: false,
									error: `Failed to upload file: ${uploadResponse.status} ${uploadResponse.statusText} - ${errorText}`,
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
								assetUrl,
								filename: finalFilename,
								size,
								contentType: finalContentType,
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
				};
			}
		},
	);

	server.registerTool(
		"linear_agent_session_create",
		{
			description:
				"Create an agent session on a Linear issue to track AI/bot activity.",
			inputSchema: {
				issueId: z
					.string()
					.describe(
						'The ID or identifier of the Linear issue (e.g., "ABC-123" or UUID)',
					),
				externalLink: z
					.string()
					.optional()
					.describe(
						"Optional URL of an external agent-hosted page associated with this session",
					),
			},
		},
		async ({ issueId, externalLink }) => {
			try {
				const graphQLClient = (linearClient as any).client;

				const mutation = `
					mutation AgentSessionCreateOnIssue($input: AgentSessionCreateOnIssue!) {
						agentSessionCreateOnIssue(input: $input) {
							success
							lastSyncId
							agentSession {
								id
							}
						}
					}
				`;

				const variables = {
					input: {
						issueId,
						...(externalLink && { externalLink }),
					},
				};

				const response = await graphQLClient.rawRequest(mutation, variables);
				const result = response.data.agentSessionCreateOnIssue;

				if (!result.success) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									success: false,
									error: "Failed to create agent session",
								}),
							},
						],
					};
				}

				const agentSessionId = result.agentSession.id;
				if (options.parentSessionId && options.onSessionCreated) {
					options.onSessionCreated(agentSessionId, options.parentSessionId);
				}

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: result.success,
								agentSessionId,
								lastSyncId: result.lastSyncId,
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
				};
			}
		},
	);

	server.registerTool(
		"linear_agent_session_create_on_comment",
		{
			description:
				"Create an agent session on a Linear root comment (not a reply) to trigger a sub-agent for processing child issues or tasks. See Linear API docs: https://studio.apollographql.com/public/Linear-API/variant/current/schema/reference/inputs/AgentSessionCreateOnComment",
			inputSchema: {
				commentId: z
					.string()
					.describe(
						"The ID of the Linear root comment (not a reply) to create the session on",
					),
				externalLink: z
					.string()
					.optional()
					.describe(
						"Optional URL of an external agent-hosted page associated with this session",
					),
			},
		},
		async ({ commentId, externalLink }) => {
			try {
				const graphQLClient = (linearClient as any).client;

				const mutation = `
					mutation AgentSessionCreateOnComment($input: AgentSessionCreateOnComment!) {
						agentSessionCreateOnComment(input: $input) {
							success
							lastSyncId
							agentSession {
								id
							}
						}
					}
				`;

				const variables = {
					input: {
						commentId,
						...(externalLink && { externalLink }),
					},
				};

				const response = await graphQLClient.rawRequest(mutation, variables);
				const result = response.data.agentSessionCreateOnComment;

				if (!result.success) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									success: false,
									error: "Failed to create agent session on comment",
								}),
							},
						],
					};
				}

				const agentSessionId = result.agentSession.id;
				if (options.parentSessionId && options.onSessionCreated) {
					options.onSessionCreated(agentSessionId, options.parentSessionId);
				}

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: result.success,
								agentSessionId,
								lastSyncId: result.lastSyncId,
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
				};
			}
		},
	);

	server.registerTool(
		"linear_agent_give_feedback",
		{
			description:
				"Provide feedback to a child agent session to continue its processing.",
			inputSchema: {
				agentSessionId: z
					.string()
					.describe("The ID of the child agent session to provide feedback to"),
				message: z
					.string()
					.describe("The feedback message to send to the child agent session"),
			},
		},
		async ({ agentSessionId, message }) => {
			if (!agentSessionId) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: "agentSessionId is required",
							}),
						},
					],
				};
			}

			if (!message) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: "message is required",
							}),
						},
					],
				};
			}

			if (options.onFeedbackDelivery) {
				try {
					await options.onFeedbackDelivery(agentSessionId, message);
				} catch (error) {
					console.error("[CyrusTools] Failed to deliver feedback:", error);
				}
			}

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							success: true,
						}),
					},
				],
			};
		},
	);

	server.registerTool(
		"linear_set_issue_relation",
		{
			description:
				"Create a relationship between two Linear issues. Use this to set 'blocks', 'related', or 'duplicate' relationships. For Graphite stacking workflows, use 'blocks' type where the blocking issue is the one that must be completed first.",
			inputSchema: {
				issueId: z
					.string()
					.describe(
						"The BLOCKING issue (the one that must complete first). For 'blocks' type: this issue blocks relatedIssueId. Example: 'PROJ-123' or UUID",
					),
				relatedIssueId: z
					.string()
					.describe(
						"The BLOCKED issue (the one that depends on issueId). For 'blocks' type: this issue is blocked by issueId. Example: 'PROJ-124' or UUID",
					),
				type: z
					.enum(["blocks", "related", "duplicate"])
					.describe(
						"The type of relation: 'blocks' (issueId blocks relatedIssueId - use for Graphite stacking), 'related' (issues are related), 'duplicate' (issueId is a duplicate of relatedIssue)",
					),
			},
		},
		async ({ issueId, relatedIssueId, type }) => {
			try {
				const issue = await linearClient.issue(issueId);
				const relatedIssue = await linearClient.issue(relatedIssueId);

				if (!issue) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									success: false,
									error: `Issue ${issueId} not found`,
								}),
							},
						],
					};
				}

				if (!relatedIssue) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									success: false,
									error: `Related issue ${relatedIssueId} not found`,
								}),
							},
						],
					};
				}

				const relationTypeMap: Record<
					"blocks" | "related" | "duplicate",
					IssueRelationType
				> = {
					blocks: IssueRelationType.Blocks,
					related: IssueRelationType.Related,
					duplicate: IssueRelationType.Duplicate,
				};
				const relationType = relationTypeMap[type];

				const result = await linearClient.createIssueRelation({
					issueId: issue.id,
					relatedIssueId: relatedIssue.id,
					type: relationType,
				});

				const relation = await result.issueRelation;

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: true,
								relationId: relation?.id,
								message: `Successfully created '${type}' relation: ${issue.identifier} ${type} ${relatedIssue.identifier}`,
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
				};
			}
		},
	);

	server.registerTool(
		"linear_get_child_issues",
		{
			description:
				"Get all child issues (sub-issues) for a given Linear issue. Takes an issue identifier like 'CYHOST-91' and returns a list of child issue ids and their titles.",
			inputSchema: {
				issueId: z
					.string()
					.describe(
						"The ID or identifier of the parent issue (e.g., 'CYHOST-91' or UUID)",
					),
				limit: z
					.number()
					.optional()
					.describe(
						"Maximum number of child issues to return (default: 50, max: 250)",
					),
				includeCompleted: z
					.boolean()
					.optional()
					.describe(
						"Whether to include completed child issues (default: true)",
					),
				includeArchived: z
					.boolean()
					.optional()
					.describe(
						"Whether to include archived child issues (default: false)",
					),
			},
		},
		async ({
			issueId,
			limit = 50,
			includeCompleted = true,
			includeArchived = false,
		}) => {
			try {
				const finalLimit = Math.min(Math.max(1, limit), 250);
				const issue = await linearClient.issue(issueId);

				if (!issue) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									success: false,
									error: `Issue ${issueId} not found`,
								}),
							},
						],
					};
				}

				const filter: any = {};
				if (!includeCompleted) {
					filter.state = { type: { neq: "completed" } };
				}
				if (!includeArchived) {
					filter.archivedAt = { null: true };
				}

				const childrenConnection = await issue.children({
					first: finalLimit,
					...(Object.keys(filter).length > 0 && { filter }),
				});
				const children = await childrenConnection.nodes;

				const childrenData = await Promise.all(
					children.map(async (child) => {
						const [state, assignee] = await Promise.all([
							child.state,
							child.assignee,
						]);

						return {
							id: child.id,
							identifier: child.identifier,
							title: child.title,
							state: state?.name || "Unknown",
							stateType: state?.type || null,
							assignee: assignee?.name || null,
							assigneeId: assignee?.id || null,
							priority: child.priority,
							priorityLabel: child.priorityLabel,
							createdAt: child.createdAt.toISOString(),
							updatedAt: child.updatedAt.toISOString(),
							url: child.url,
							archivedAt: child.archivedAt?.toISOString() || null,
						};
					}),
				);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									success: true,
									parentIssue: {
										id: issue.id,
										identifier: issue.identifier,
										title: issue.title,
										url: issue.url,
									},
									childCount: childrenData.length,
									children: childrenData,
								},
								null,
								2,
							),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
				};
			}
		},
	);

	server.registerTool(
		"linear_get_agent_sessions",
		{
			description:
				"Get all agent sessions. Returns a paginated list of agent sessions with their details including status, timestamps, and associated issues.",
			inputSchema: {
				first: z
					.number()
					.optional()
					.describe(
						"Number of items to fetch from the beginning (default: 50, max: 250)",
					),
				after: z
					.string()
					.optional()
					.describe("Cursor to start fetching items after"),
				before: z
					.string()
					.optional()
					.describe("Cursor to start fetching items before"),
				last: z
					.number()
					.optional()
					.describe("Number of items to fetch from the end"),
				includeArchived: z
					.boolean()
					.optional()
					.describe(
						"Whether to include archived agent sessions (default: false)",
					),
				orderBy: z
					.enum(["createdAt", "updatedAt"])
					.optional()
					.describe(
						"Field to order results by (default: updatedAt). Can be 'createdAt' or 'updatedAt'",
					),
			},
		},
		async ({
			first = 50,
			after,
			before,
			last,
			includeArchived = false,
			orderBy,
		}) => {
			try {
				const finalFirst = first
					? Math.min(Math.max(1, first), 250)
					: undefined;
				const finalLast = last ? Math.min(Math.max(1, last), 250) : undefined;

				const variables: any = {};
				if (finalFirst !== undefined) variables.first = finalFirst;
				if (after) variables.after = after;
				if (before) variables.before = before;
				if (finalLast !== undefined) variables.last = finalLast;
				if (includeArchived !== undefined)
					variables.includeArchived = includeArchived;
				if (orderBy) variables.orderBy = orderBy;

				const sessionsConnection = await linearClient.agentSessions(variables);
				const sessions = await sessionsConnection.nodes;

				const sessionsData = sessions.map((session) => ({
					id: session.id,
					createdAt: session.createdAt.toISOString(),
					updatedAt: session.updatedAt.toISOString(),
					startedAt: session.startedAt?.toISOString() || null,
					endedAt: session.endedAt?.toISOString() || null,
					dismissedAt: session.dismissedAt?.toISOString() || null,
					archivedAt: session.archivedAt?.toISOString() || null,
					externalLink: session.externalLink || null,
					summary: session.summary || null,
					plan: session.plan || null,
					sourceMetadata: session.sourceMetadata || null,
				}));

				const pageInfo = await sessionsConnection.pageInfo;

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									success: true,
									count: sessionsData.length,
									sessions: sessionsData,
									pageInfo: {
										hasNextPage: pageInfo.hasNextPage,
										hasPreviousPage: pageInfo.hasPreviousPage,
										startCursor: pageInfo.startCursor,
										endCursor: pageInfo.endCursor,
									},
								},
								null,
								2,
							),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
				};
			}
		},
	);

	server.registerTool(
		"linear_get_agent_session",
		{
			description:
				"Get a single agent session by ID. Returns detailed information about the agent session including its status, timestamps, associated issue, and metadata.",
			inputSchema: {
				sessionId: z
					.string()
					.describe("The ID of the agent session to retrieve (UUID)"),
			},
		},
		async ({ sessionId }) => {
			try {
				const session = await linearClient.agentSession(sessionId);

				if (!session) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									success: false,
									error: `Agent session ${sessionId} not found`,
								}),
							},
						],
					};
				}

				const [issue, creator, appUser, comment, sourceComment, dismissedBy] =
					await Promise.all([
						session.issue,
						session.creator,
						session.appUser,
						session.comment,
						session.sourceComment,
						session.dismissedBy,
					]);

				const sessionData = {
					id: session.id,
					createdAt: session.createdAt.toISOString(),
					updatedAt: session.updatedAt.toISOString(),
					startedAt: session.startedAt?.toISOString() || null,
					endedAt: session.endedAt?.toISOString() || null,
					dismissedAt: session.dismissedAt?.toISOString() || null,
					archivedAt: session.archivedAt?.toISOString() || null,
					externalLink: session.externalLink || null,
					summary: session.summary || null,
					plan: session.plan || null,
					sourceMetadata: session.sourceMetadata || null,
					issue: issue
						? {
								id: issue.id,
								identifier: issue.identifier,
								title: issue.title,
								url: issue.url,
								description: issue.description,
								priority: issue.priority,
								priorityLabel: issue.priorityLabel,
							}
						: null,
					creator: creator
						? {
								id: creator.id,
								name: creator.name,
								email: creator.email,
								displayName: creator.displayName,
							}
						: null,
					appUser: appUser
						? {
								id: appUser.id,
								name: appUser.name,
							}
						: null,
					comment: comment
						? {
								id: comment.id,
								body: comment.body,
								createdAt: comment.createdAt.toISOString(),
							}
						: null,
					sourceComment: sourceComment
						? {
								id: sourceComment.id,
								body: sourceComment.body,
								createdAt: sourceComment.createdAt.toISOString(),
							}
						: null,
					dismissedBy: dismissedBy
						? {
								id: dismissedBy.id,
								name: dismissedBy.name,
								email: dismissedBy.email,
							}
						: null,
				};

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									success: true,
									session: sessionData,
								},
								null,
								2,
							),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
				};
			}
		},
	);

	// Register the log_failure_mode tool whenever the harness wires it up
	// (EdgeWorker provides the cwd→session resolver and an HTTP client to
	// cyrus-hosted). Omitted in CLI mode where there is no control plane.
	if (options.failureModes) {
		registerLogFailureModeTool(server, {
			resolveSessionFromCwd: options.failureModes.resolveSessionFromCwd,
			httpClient: options.failureModes.httpClient,
			fallbackSessionId: options.parentSessionId,
		});
	}

	// Register OpenAI-based tools if OPENAI_API_KEY is available
	const openaiApiKey = process.env.OPENAI_API_KEY;
	if (openaiApiKey) {
		const openaiClient = new OpenAI({
			apiKey: openaiApiKey,
			timeout: 600 * 1000, // 10 minutes
		});
		const outputDirectory = tmpdir();

		registerImageTools(server, openaiClient, outputDirectory);
		registerSoraTools(server, openaiClient, outputDirectory);
	}

	return server;
}
