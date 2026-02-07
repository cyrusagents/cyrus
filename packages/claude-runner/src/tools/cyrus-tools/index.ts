import { basename, extname } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { IssueRelationType, type LinearClient } from "@linear/sdk";
import fs from "fs-extra";
import { z } from "zod";

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
}

/**
 * Create an SDK MCP server with the inline Cyrus tools
 */
export function createCyrusToolsServer(
	linearClient: LinearClient,
	options: CyrusToolsOptions = {},
) {
	// Create tools with bound linear client
	const uploadTool = tool(
		"linear_upload_file",
		"Upload a file to Linear. Returns an asset URL that can be used in issue descriptions or comments.",
		{
			filePath: z.string().describe("The absolute path to the file to upload"),
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
		async ({ filePath, filename, contentType, makePublic }) => {
			try {
				// Read file and get stats
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

				// Step 1: Request upload URL from Linear
				console.log(
					`Requesting upload URL for ${finalFilename} (${size} bytes, ${finalContentType})`,
				);

				// Use LinearClient's fileUpload method directly
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

				// Step 2: Upload the file to the provided URL
				console.log(`Uploading file to Linear cloud storage...`);

				// Create headers following Linear's documentation exactly
				const uploadHeaders: Record<string, string> = {
					"Content-Type": finalContentType,
					"Cache-Control": "public, max-age=31536000",
				};

				// Then add the headers from Linear's response
				// These override any defaults we set above
				for (const header of headers) {
					uploadHeaders[header.key] = header.value;
				}

				console.log(`Headers being sent:`, uploadHeaders);

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

				console.log(`File uploaded successfully: ${assetUrl}`);

				// Return the asset URL and metadata
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

	const agentSessionTool = tool(
		"linear_agent_session_create",
		"Create an agent session on a Linear issue to track AI/bot activity.",
		{
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
		async ({ issueId, externalLink }) => {
			try {
				// Use raw GraphQL through the Linear client
				// Access the underlying GraphQL client
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

				console.log(`Creating agent session for issue ${issueId}`);

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
				console.log(`Agent session created successfully: ${agentSessionId}`);

				// Register the child-to-parent mapping if we have a parent session
				if (options.parentSessionId && options.onSessionCreated) {
					console.log(
						`[CyrusTools] Mapping child session ${agentSessionId} to parent ${options.parentSessionId}`,
					);
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

	const agentSessionOnCommentTool = tool(
		"linear_agent_session_create_on_comment",
		"Create an agent session on a Linear root comment (not a reply) to trigger a sub-agent for processing child issues or tasks. See Linear API docs: https://studio.apollographql.com/public/Linear-API/variant/current/schema/reference/inputs/AgentSessionCreateOnComment",
		{
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
		async ({ commentId, externalLink }) => {
			try {
				// Use raw GraphQL through the Linear client
				// Access the underlying GraphQL client
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

				console.log(`Creating agent session for comment ${commentId}`);

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
				console.log(
					`Agent session created successfully on comment: ${agentSessionId}`,
				);

				// Register the child-to-parent mapping if we have a parent session
				if (options.parentSessionId && options.onSessionCreated) {
					console.log(
						`[CyrusTools] Mapping child session ${agentSessionId} to parent ${options.parentSessionId}`,
					);
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

	const giveFeedbackTool = tool(
		"linear_agent_give_feedback",
		"Provide feedback to a child agent session to continue its processing.",
		{
			agentSessionId: z
				.string()
				.describe("The ID of the child agent session to provide feedback to"),
			message: z
				.string()
				.describe("The feedback message to send to the child agent session"),
		},
		async ({ agentSessionId, message }) => {
			// Validate parameters
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

			// Deliver the feedback through the callback if provided
			if (options.onFeedbackDelivery) {
				console.log(
					`[CyrusTools] Delivering feedback to child session ${agentSessionId}`,
				);
				try {
					const delivered = await options.onFeedbackDelivery(
						agentSessionId,
						message,
					);
					if (delivered) {
						console.log(
							`[CyrusTools] Feedback delivered successfully to parent session`,
						);
					} else {
						console.log(
							`[CyrusTools] No parent session found for child ${agentSessionId}`,
						);
					}
				} catch (error) {
					console.error(`[CyrusTools] Failed to deliver feedback:`, error);
				}
			}

			// Return success - feedback has been queued for delivery
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

	const setIssueRelationTool = tool(
		"linear_set_issue_relation",
		"Create a relationship between two Linear issues. Use this to set 'blocks', 'related', or 'duplicate' relationships. For Graphite stacking workflows, use 'blocks' type where the blocking issue is the one that must be completed first.",
		{
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
		async ({ issueId, relatedIssueId, type }) => {
			try {
				console.log(
					`Creating ${type} relation: ${issueId} -> ${relatedIssueId} (${issueId} blocks ${relatedIssueId})`,
				);

				// Resolve issue identifiers to UUIDs if needed
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

				// Map string type to IssueRelationType enum
				const relationTypeMap: Record<
					"blocks" | "related" | "duplicate",
					IssueRelationType
				> = {
					blocks: IssueRelationType.Blocks,
					related: IssueRelationType.Related,
					duplicate: IssueRelationType.Duplicate,
				};
				const relationType = relationTypeMap[type];

				// Create the issue relation
				const result = await linearClient.createIssueRelation({
					issueId: issue.id,
					relatedIssueId: relatedIssue.id,
					type: relationType,
				});

				const relation = await result.issueRelation;

				console.log(
					`Created ${type} relation: ${issue.identifier} ${type} ${relatedIssue.identifier}`,
				);

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
				console.error(`Error creating issue relation for ${issueId}:`, error);
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

	const getChildIssuesTool = tool(
		"linear_get_child_issues",
		"Get all child issues (sub-issues) for a given Linear issue. Takes an issue identifier like 'CYHOST-91' and returns a list of child issue ids and their titles.",
		{
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
				.describe("Whether to include completed child issues (default: true)"),
			includeArchived: z
				.boolean()
				.optional()
				.describe("Whether to include archived child issues (default: false)"),
		},
		async ({
			issueId,
			limit = 50,
			includeCompleted = true,
			includeArchived = false,
		}) => {
			try {
				// Validate and clamp limit
				const finalLimit = Math.min(Math.max(1, limit), 250);

				console.log(
					`Getting child issues for ${issueId} (limit: ${finalLimit})`,
				);

				// Fetch the parent issue first
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

				// Build the filter for child issues
				const filter: any = {};

				if (!includeCompleted) {
					filter.state = { type: { neq: "completed" } };
				}

				if (!includeArchived) {
					filter.archivedAt = { null: true };
				}

				// Get child issues using the children() method
				const childrenConnection = await issue.children({
					first: finalLimit,
					...(Object.keys(filter).length > 0 && { filter }),
				});

				// Extract the child issues from the connection
				const children = await childrenConnection.nodes;

				// Process each child to get detailed information
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

				console.log(`Found ${childrenData.length} child issues for ${issueId}`);

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
				console.error(`Error getting child issues for ${issueId}:`, error);
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

	const getAgentSessionsTool = tool(
		"linear_get_agent_sessions",
		"Get all agent sessions. Returns a paginated list of agent sessions with their details including status, timestamps, and associated issues.",
		{
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
		async ({
			first = 50,
			after,
			before,
			last,
			includeArchived = false,
			orderBy,
		}) => {
			try {
				// Validate and clamp first/last
				const finalFirst = first
					? Math.min(Math.max(1, first), 250)
					: undefined;
				const finalLast = last ? Math.min(Math.max(1, last), 250) : undefined;

				console.log("Fetching agent sessions with params:", {
					first: finalFirst,
					after,
					before,
					last: finalLast,
					includeArchived,
					orderBy,
				});

				// Build variables for the query
				const variables: any = {};
				if (finalFirst !== undefined) variables.first = finalFirst;
				if (after) variables.after = after;
				if (before) variables.before = before;
				if (finalLast !== undefined) variables.last = finalLast;
				if (includeArchived !== undefined)
					variables.includeArchived = includeArchived;
				if (orderBy) variables.orderBy = orderBy;

				// Fetch agent sessions using the Linear SDK
				const sessionsConnection = await linearClient.agentSessions(variables);
				const sessions = await sessionsConnection.nodes;

				// Process each session to get detailed information
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

				console.log(`Found ${sessionsData.length} agent sessions`);

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
				console.error("Error fetching agent sessions:", error);
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

	const getAgentSessionTool = tool(
		"linear_get_agent_session",
		"Get a single agent session by ID. Returns detailed information about the agent session including its status, timestamps, associated issue, and metadata.",
		{
			sessionId: z
				.string()
				.describe("The ID of the agent session to retrieve (UUID)"),
		},
		async ({ sessionId }) => {
			try {
				console.log(`Fetching agent session: ${sessionId}`);

				// Fetch the agent session using the Linear SDK
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

				// Get related entities
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

				console.log(`Successfully fetched agent session: ${sessionId}`);

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
				console.error(`Error fetching agent session ${sessionId}:`, error);
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

	return createSdkMcpServer({
		name: "cyrus-tools",
		version: "1.0.0",
		tools: [
			uploadTool,
			agentSessionTool,
			agentSessionOnCommentTool,
			giveFeedbackTool,
			setIssueRelationTool,
			getChildIssuesTool,
			getAgentSessionsTool,
			getAgentSessionTool,
		],
	});
}
