/**
 * CLI/in-memory implementation of IIssueTrackerService.
 *
 * This adapter provides an in-memory mock of Linear's issue tracking platform
 * for testing purposes. It implements all methods from IIssueTrackerService
 * while storing data in memory using Maps for O(1) lookups.
 *
 * Unlike Linear's async properties, this implementation uses synchronous properties
 * for immediate access to related entities.
 *
 * @module issue-tracker/adapters/CLIIssueTrackerService
 */

import { EventEmitter } from "node:events";
import type { AgentEvent } from "../AgentEvent.js";
import type {
	AgentEventTransportConfig,
	IAgentEventTransport,
} from "../IAgentEventTransport.js";
import type { IIssueTrackerService } from "../IIssueTrackerService.js";
import {
	type AgentActivityCreateInput,
	type AgentActivityPayload,
	AgentActivityType,
	type AgentSessionCreateOnCommentInput,
	type AgentSessionCreateOnIssueInput,
	AgentSessionStatus,
	AgentSessionType,
	type AttachmentCreateRequest,
	type AttachmentCreateResponse,
	type Comment,
	type CommentCreateInput,
	type CommentWithAttachments,
	type Connection,
	type FetchChildrenOptions,
	type FileUploadRequest,
	type FileUploadResponse,
	type Issue,
	type IssueCreateInput,
	type IssueTrackerAgentSession,
	type IssueTrackerAgentSessionPayload,
	type IssueUpdateInput,
	type IssueWithChildren,
	type Label,
	type PaginationOptions,
	type Team,
	type User,
	type WorkflowState,
} from "../types.js";
import { CLIEventTransport } from "./CLIEventTransport.js";
import {
	type CLIAgentActivityData,
	type CLIAgentSessionData,
	type CLICommentData,
	type CLIIssueData,
	type CLILabelData,
	type CLITeamData,
	type CLIUserData,
	type CLIWorkflowStateData,
	createCLIAgentSession,
	createCLIComment,
	createCLIIssue,
	createCLILabel,
	createCLITeam,
	createCLIUser,
	createCLIWorkflowState,
} from "./CLITypes.js";

/**
 * In-memory state for the CLI issue tracker.
 */
export interface CLIIssueTrackerState {
	issues: Map<string, CLIIssueData>;
	comments: Map<string, CLICommentData>;
	teams: Map<string, CLITeamData>;
	labels: Map<string, CLILabelData>;
	workflowStates: Map<string, CLIWorkflowStateData>;
	users: Map<string, CLIUserData>;
	agentSessions: Map<string, CLIAgentSessionData>;
	agentActivities: Map<string, CLIAgentActivityData>;
	currentUserId: string;
	issueCounter: number;
	commentCounter: number;
	sessionCounter: number;
	activityCounter: number;
}

/**
 * CLI implementation of IIssueTrackerService.
 *
 * This class provides an in-memory implementation of the issue tracker service
 * for testing purposes. All data is stored in Maps with synchronous property access.
 *
 * @example
 * ```typescript
 * const service = new CLIIssueTrackerService();
 *
 * // Fetch an issue
 * const issue = await service.fetchIssue('issue-1');
 *
 * // Create a comment
 * const comment = await service.createComment(issue.id, {
 *   body: 'This is a comment'
 * });
 * ```
 */
export class CLIIssueTrackerService
	extends EventEmitter
	implements IIssueTrackerService
{
	private state: CLIIssueTrackerState;
	private eventTransport: CLIEventTransport | null = null;

	/**
	 * Create a new CLIIssueTrackerService.
	 *
	 * @param initialState - Optional initial state (useful for testing)
	 */
	constructor(initialState?: Partial<CLIIssueTrackerState>) {
		super();
		this.state = {
			issues: initialState?.issues ?? new Map(),
			comments: initialState?.comments ?? new Map(),
			teams: initialState?.teams ?? new Map(),
			labels: initialState?.labels ?? new Map(),
			workflowStates: initialState?.workflowStates ?? new Map(),
			users: initialState?.users ?? new Map(),
			agentSessions: initialState?.agentSessions ?? new Map(),
			agentActivities: initialState?.agentActivities ?? new Map(),
			currentUserId: initialState?.currentUserId ?? "user-default",
			issueCounter: initialState?.issueCounter ?? 1,
			commentCounter: initialState?.commentCounter ?? 1,
			sessionCounter: initialState?.sessionCounter ?? 1,
			activityCounter: initialState?.activityCounter ?? 1,
		};
	}

	// ========================================================================
	// ISSUE OPERATIONS
	// ========================================================================

	/**
	 * Fetch a single issue by ID or identifier.
	 */
	async fetchIssue(idOrIdentifier: string): Promise<Issue> {
		// Try to find by ID first
		let issueData = this.state.issues.get(idOrIdentifier);

		// If not found, try to find by identifier
		if (!issueData) {
			for (const [, candidateIssue] of this.state.issues) {
				if (candidateIssue.identifier === idOrIdentifier) {
					issueData = candidateIssue;
					break;
				}
			}
		}

		if (!issueData) {
			throw new Error(`Issue ${idOrIdentifier} not found`);
		}

		// Resolve label data
		const resolvedLabels = issueData.labelIds
			.map((id) => this.state.labels.get(id))
			.filter((l): l is CLILabelData => l !== undefined);

		return createCLIIssue(issueData, resolvedLabels);
	}

	/**
	 * Create a new issue in a team.
	 *
	 * @param input - Issue creation parameters
	 * @returns Promise resolving to the created issue
	 */
	async createIssue(input: IssueCreateInput): Promise<Issue> {
		// Validate team exists
		const team = await this.fetchTeam(input.teamId);

		// Validate state if provided
		if (input.stateId) {
			const state = this.state.workflowStates.get(input.stateId);
			if (!state) {
				throw new Error(`Workflow state ${input.stateId} not found`);
			}
			if (state.teamId !== team.id) {
				throw new Error(
					`Workflow state ${input.stateId} does not belong to team ${team.id}`,
				);
			}
		}

		// Validate assignee if provided
		if (input.assigneeId) {
			const assignee = this.state.users.get(input.assigneeId);
			if (!assignee) {
				throw new Error(`User ${input.assigneeId} not found`);
			}
		}

		// Validate parent if provided
		if (input.parentId) {
			await this.fetchIssue(input.parentId);
		}

		// Validate labels if provided
		if (input.labelIds && input.labelIds.length > 0) {
			for (const labelId of input.labelIds) {
				const label = this.state.labels.get(labelId);
				if (!label) {
					throw new Error(`Label ${labelId} not found`);
				}
			}
		}

		// Generate issue number and ID
		const issueNumber = this.state.issueCounter++;
		const issueId = `issue-${issueNumber}`;
		const identifier = `${team.key}-${issueNumber}`;

		// Create the issue data
		const issueData: CLIIssueData = {
			id: issueId,
			identifier,
			title: input.title,
			description: input.description,
			number: issueNumber,
			url: `https://linear.app/test/issue/${identifier}`,
			branchName: `${team.key.toLowerCase()}-${issueNumber}-${input.title.toLowerCase().replace(/\s+/g, "-").slice(0, 30)}`,
			priority: input.priority ?? 0,
			priorityLabel: this.getPriorityLabel(input.priority ?? 0),
			boardOrder: 0,
			sortOrder: 0,
			prioritySortOrder: 0,
			labelIds: input.labelIds ?? [],
			previousIdentifiers: [],
			customerTicketCount: 0,
			createdAt: new Date(),
			updatedAt: new Date(),
			teamId: team.id,
			stateId: input.stateId,
			assigneeId: input.assigneeId,
			parentId: input.parentId,
		};

		// Save to state
		this.state.issues.set(issueId, issueData);

		// Resolve label data
		const resolvedLabels = issueData.labelIds
			.map((id) => this.state.labels.get(id))
			.filter((l): l is CLILabelData => l !== undefined);

		// Create and return the issue
		const issue = createCLIIssue(issueData, resolvedLabels);

		// Emit state change event
		this.emit("issue:created", { issue });

		return issue;
	}

	/**
	 * Get priority label from priority number.
	 */
	private getPriorityLabel(priority: number): string {
		switch (priority) {
			case 1:
				return "Urgent";
			case 2:
				return "High";
			case 3:
				return "Normal";
			case 4:
				return "Low";
			default:
				return "No priority";
		}
	}

	/**
	 * Fetch child issues (sub-issues) for a parent issue.
	 */
	async fetchIssueChildren(
		issueId: string,
		options?: FetchChildrenOptions,
	): Promise<IssueWithChildren> {
		const parentIssue = await this.fetchIssue(issueId);

		// Find all child issues
		const allChildren: Issue[] = [];
		for (const [, issueData] of this.state.issues) {
			if (issueData.parentId === parentIssue.id) {
				const resolvedLabels = issueData.labelIds
					.map((id) => this.state.labels.get(id))
					.filter((l): l is CLILabelData => l !== undefined);
				allChildren.push(createCLIIssue(issueData, resolvedLabels));
			}
		}

		// Apply filters
		let filteredChildren = allChildren;

		if (options?.includeCompleted === false) {
			filteredChildren = filteredChildren.filter((child) => {
				const childStateId = child.stateId;
				if (!childStateId) return true;
				const state = this.state.workflowStates.get(childStateId);
				return state?.type !== "completed";
			});
		}

		if (options?.includeArchived === false) {
			filteredChildren = filteredChildren.filter((child) => !child.archivedAt);
		}

		// Apply limit (must be positive)
		if (options?.limit && options.limit > 0) {
			filteredChildren = filteredChildren.slice(0, options.limit);
		}

		// Create IssueWithChildren by extending the parent issue
		const issueWithChildren: IssueWithChildren = Object.assign(
			Object.create(Object.getPrototypeOf(parentIssue)),
			parentIssue,
			{
				children: filteredChildren,
				childCount: filteredChildren.length,
			},
		);

		return issueWithChildren;
	}

	/**
	 * Update an issue's properties.
	 */
	async updateIssue(
		issueId: string,
		updates: IssueUpdateInput,
	): Promise<Issue> {
		const issueData = this.state.issues.get(issueId);
		if (!issueData) {
			throw new Error(`Issue ${issueId} not found`);
		}

		// Update the issue data directly
		if (updates.stateId !== undefined) {
			const state = this.state.workflowStates.get(updates.stateId);
			if (!state) {
				throw new Error(`Workflow state ${updates.stateId} not found`);
			}
			// Validate state belongs to issue's team
			if (state.teamId !== issueData.teamId) {
				throw new Error(
					`Workflow state ${updates.stateId} does not belong to team ${issueData.teamId}`,
				);
			}
			issueData.stateId = updates.stateId;
		}

		if (updates.assigneeId !== undefined) {
			if (updates.assigneeId !== null && updates.assigneeId !== "") {
				const assignee = this.state.users.get(updates.assigneeId);
				if (!assignee) {
					throw new Error(`User ${updates.assigneeId} not found`);
				}
				issueData.assigneeId = updates.assigneeId;
			} else {
				// Clear assignee
				issueData.assigneeId = undefined;
			}
		}

		if (updates.title !== undefined) {
			issueData.title = updates.title;
		}

		if (updates.description !== undefined) {
			issueData.description = updates.description;
		}

		if (updates.priority !== undefined) {
			issueData.priority = updates.priority;
		}

		if (updates.parentId !== undefined) {
			if (updates.parentId !== null && updates.parentId !== "") {
				await this.fetchIssue(updates.parentId); // Validate parent exists
				// Check for circular reference
				if (updates.parentId === issueId) {
					throw new Error("Issue cannot be its own parent");
				}
				issueData.parentId = updates.parentId;
			} else {
				// Clear parent
				issueData.parentId = undefined;
			}
		}

		if (updates.labelIds !== undefined) {
			// Validate all labels exist (if any provided)
			if (updates.labelIds.length > 0) {
				for (const labelId of updates.labelIds) {
					const label = this.state.labels.get(labelId);
					if (!label) {
						throw new Error(`Label ${labelId} not found`);
					}
				}
			}
			issueData.labelIds = updates.labelIds;
		}

		// Update timestamp
		issueData.updatedAt = new Date();

		// Emit state change event
		const resolvedLabels = issueData.labelIds
			.map((id) => this.state.labels.get(id))
			.filter((l): l is CLILabelData => l !== undefined);
		const issue = createCLIIssue(issueData, resolvedLabels);
		this.emit("issue:updated", { issue });

		return issue;
	}

	/**
	 * Fetch attachments for an issue.
	 */
	async fetchIssueAttachments(
		issueId: string,
	): Promise<Array<{ title: string; url: string }>> {
		const issue = await this.fetchIssue(issueId);

		// Get attachments from the issue
		const attachmentsConnection = await issue.attachments();
		return attachmentsConnection.nodes.map(() => ({
			title: "Untitled attachment",
			url: "",
		}));
	}

	// ========================================================================
	// COMMENT OPERATIONS
	// ========================================================================

	/**
	 * Fetch comments for an issue with optional pagination.
	 */
	async fetchComments(
		issueId: string,
		options?: PaginationOptions,
	): Promise<Connection<Comment>> {
		const issue = await this.fetchIssue(issueId);

		// Find all comments for this issue
		const allComments: Comment[] = [];
		for (const [, commentData] of this.state.comments) {
			if (commentData.issueId === issue.id) {
				allComments.push(createCLIComment(commentData));
			}
		}

		// Sort by creation date
		allComments.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

		// Apply pagination
		const first = options?.first ?? 50;
		const paginatedComments = allComments.slice(0, first);

		return {
			nodes: paginatedComments,
			pageInfo: {
				hasNextPage: allComments.length > first,
				hasPreviousPage: false,
				startCursor: paginatedComments[0]?.id,
				endCursor: paginatedComments[paginatedComments.length - 1]?.id,
			},
		};
	}

	/**
	 * Fetch a single comment by ID.
	 */
	async fetchComment(commentId: string): Promise<Comment> {
		const commentData = this.state.comments.get(commentId);
		if (!commentData) {
			throw new Error(`Comment ${commentId} not found`);
		}
		return createCLIComment(commentData);
	}

	/**
	 * Fetch a comment with attachments.
	 */
	async fetchCommentWithAttachments(
		commentId: string,
	): Promise<CommentWithAttachments> {
		const comment = await this.fetchComment(commentId);

		// Create comment with attachments
		const commentWithAttachments: CommentWithAttachments = Object.assign(
			Object.create(Object.getPrototypeOf(comment)),
			comment,
			{
				attachments: [],
			},
		);

		return commentWithAttachments;
	}

	/**
	 * Create a comment on an issue.
	 */
	async createComment(
		issueId: string,
		input: CommentCreateInput,
	): Promise<Comment> {
		const issue = await this.fetchIssue(issueId);
		const currentUser = await this.fetchCurrentUser();

		// Build the comment body with attachments if provided
		let finalBody = input.body;
		if (input.attachmentUrls && input.attachmentUrls.length > 0) {
			const attachmentMarkdown = input.attachmentUrls
				.map((url) => {
					const isImage = /\.(png|jpg|jpeg|gif|svg|webp|bmp)(\?|#|$)/i.test(
						url,
					);
					if (isImage) {
						return `![attachment](${url})`;
					}
					return `[attachment](${url})`;
				})
				.join("\n");

			finalBody = input.body
				? `${input.body}\n\n${attachmentMarkdown}`
				: attachmentMarkdown;
		}

		// Generate comment ID
		const commentId = `comment-${this.state.commentCounter++}`;

		// Create the comment data
		const commentData: CLICommentData = {
			id: commentId,
			body: finalBody,
			url: `https://linear.app/test/issue/${issue.identifier}#comment-${commentId}`,
			createdAt: new Date(),
			updatedAt: new Date(),
			userId: currentUser.id,
			issueId: issue.id,
			parentId: input.parentId,
		};

		// Save to state
		this.state.comments.set(commentId, commentData);

		// Create and return the comment
		const comment = createCLIComment(commentData);

		// Emit state change event
		this.emit("comment:created", { comment });

		return comment;
	}

	// ========================================================================
	// TEAM OPERATIONS
	// ========================================================================

	/**
	 * Fetch all teams in the workspace/organization.
	 */
	async fetchTeams(options?: PaginationOptions): Promise<Connection<Team>> {
		const allTeams = Array.from(this.state.teams.values()).map((data) =>
			createCLITeam(data),
		);

		// Apply pagination
		const first = options?.first ?? 50;
		const paginatedTeams = allTeams.slice(0, first);

		return {
			nodes: paginatedTeams,
			pageInfo: {
				hasNextPage: allTeams.length > first,
				hasPreviousPage: false,
				startCursor: paginatedTeams[0]?.id,
				endCursor: paginatedTeams[paginatedTeams.length - 1]?.id,
			},
		};
	}

	/**
	 * Fetch a single team by ID or key.
	 */
	async fetchTeam(idOrKey: string): Promise<Team> {
		// Try to find by ID first
		let teamData = this.state.teams.get(idOrKey);

		// If not found, try to find by key
		if (!teamData) {
			for (const [, candidateTeam] of this.state.teams) {
				if (candidateTeam.key === idOrKey) {
					teamData = candidateTeam;
					break;
				}
			}
		}

		if (!teamData) {
			throw new Error(`Team ${idOrKey} not found`);
		}

		return createCLITeam(teamData);
	}

	// ========================================================================
	// LABEL OPERATIONS
	// ========================================================================

	/**
	 * Fetch all issue labels in the workspace/organization.
	 */
	async fetchLabels(options?: PaginationOptions): Promise<Connection<Label>> {
		const allLabels = Array.from(this.state.labels.values()).map((data) =>
			createCLILabel(data),
		);

		// Apply pagination
		const first = options?.first ?? 50;
		const paginatedLabels = allLabels.slice(0, first);

		return {
			nodes: paginatedLabels,
			pageInfo: {
				hasNextPage: allLabels.length > first,
				hasPreviousPage: false,
				startCursor: paginatedLabels[0]?.id,
				endCursor: paginatedLabels[paginatedLabels.length - 1]?.id,
			},
		};
	}

	/**
	 * Fetch a single label by ID or name.
	 */
	async fetchLabel(idOrName: string): Promise<Label> {
		// Try to find by ID first
		let labelData = this.state.labels.get(idOrName);

		// If not found, try to find by name
		if (!labelData) {
			for (const [, candidateLabel] of this.state.labels) {
				if (candidateLabel.name === idOrName) {
					labelData = candidateLabel;
					break;
				}
			}
		}

		if (!labelData) {
			throw new Error(`Label ${idOrName} not found`);
		}

		return createCLILabel(labelData);
	}

	/**
	 * Fetch label names for a specific issue.
	 */
	async getIssueLabels(issueId: string): Promise<string[]> {
		const issue = await this.fetchIssue(issueId);

		// Get label names from the issue's labelIds
		const labelNames: string[] = [];
		for (const labelId of issue.labelIds) {
			const labelData = this.state.labels.get(labelId);
			if (labelData) {
				labelNames.push(labelData.name);
			}
		}

		return labelNames;
	}

	/**
	 * Find a label by name or create it if it doesn't exist.
	 * This enables dynamic label creation on first use.
	 *
	 * @param name - The label name to find or create
	 * @returns The label ID
	 */
	async findOrCreateLabel(name: string): Promise<string> {
		// First, try to find existing label by name
		for (const [, labelData] of this.state.labels) {
			if (labelData.name === name) {
				return labelData.id;
			}
		}

		// Label doesn't exist, create it
		const labelId = `label-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const now = new Date();

		const labelData: CLILabelData = {
			id: labelId,
			name,
			description: undefined,
			color: this.generateLabelColor(name),
			isGroup: false,
			createdAt: now,
			updatedAt: now,
			teamId: undefined, // Workspace-level label
			creatorId: this.state.currentUserId,
			parentId: undefined,
		};

		this.state.labels.set(labelId, labelData);

		// Emit label created event
		this.emit("label:created", { label: createCLILabel(labelData) });

		return labelId;
	}

	/**
	 * Generate a consistent color for a label based on its name.
	 * Uses a simple hash to pick from a palette of colors.
	 */
	private generateLabelColor(name: string): string {
		const colors = [
			"#ef4444", // red
			"#f97316", // orange
			"#eab308", // yellow
			"#22c55e", // green
			"#14b8a6", // teal
			"#3b82f6", // blue
			"#8b5cf6", // violet
			"#ec4899", // pink
			"#6366f1", // indigo
			"#06b6d4", // cyan
		];

		// Simple hash based on character codes
		let hash = 0;
		for (const char of name) {
			hash = (hash << 5) - hash + char.charCodeAt(0);
			hash = hash & hash; // Convert to 32-bit integer
		}

		const index = Math.abs(hash) % colors.length;
		return colors[index] ?? "#3b82f6"; // Fallback to blue if undefined
	}

	// ========================================================================
	// WORKFLOW STATE OPERATIONS
	// ========================================================================

	/**
	 * Fetch workflow states for a team.
	 */
	async fetchWorkflowStates(
		teamId: string,
		options?: PaginationOptions,
	): Promise<Connection<WorkflowState>> {
		const team = await this.fetchTeam(teamId);

		// Find all workflow states for this team
		const allStates: WorkflowState[] = [];
		for (const [, stateData] of this.state.workflowStates) {
			if (stateData.teamId === team.id) {
				allStates.push(createCLIWorkflowState(stateData));
			}
		}

		// Apply pagination
		const first = options?.first ?? 50;
		const paginatedStates = allStates.slice(0, first);

		return {
			nodes: paginatedStates,
			pageInfo: {
				hasNextPage: allStates.length > first,
				hasPreviousPage: false,
				startCursor: paginatedStates[0]?.id,
				endCursor: paginatedStates[paginatedStates.length - 1]?.id,
			},
		};
	}

	/**
	 * Fetch a single workflow state by ID.
	 */
	async fetchWorkflowState(stateId: string): Promise<WorkflowState> {
		const stateData = this.state.workflowStates.get(stateId);
		if (!stateData) {
			throw new Error(`Workflow state ${stateId} not found`);
		}
		return createCLIWorkflowState(stateData);
	}

	// ========================================================================
	// USER OPERATIONS
	// ========================================================================

	/**
	 * Fetch a user by ID.
	 */
	async fetchUser(userId: string): Promise<User> {
		const userData = this.state.users.get(userId);
		if (!userData) {
			throw new Error(`User ${userId} not found`);
		}
		return createCLIUser(userData);
	}

	/**
	 * Fetch the current authenticated user.
	 */
	async fetchCurrentUser(): Promise<User> {
		return await this.fetchUser(this.state.currentUserId);
	}

	// ========================================================================
	// AGENT SESSION OPERATIONS
	// ========================================================================

	/**
	 * Create an agent session on an issue.
	 */
	createAgentSessionOnIssue(
		input: AgentSessionCreateOnIssueInput,
	): Promise<IssueTrackerAgentSessionPayload> {
		return this.createAgentSessionInternal(input.issueId, undefined, input);
	}

	/**
	 * Create an agent session on a comment thread.
	 */
	createAgentSessionOnComment(
		input: AgentSessionCreateOnCommentInput,
	): Promise<IssueTrackerAgentSessionPayload> {
		return this.createAgentSessionInternal(undefined, input.commentId, input);
	}

	/**
	 * Internal helper to create agent sessions.
	 */
	private async createAgentSessionInternal(
		issueId: string | undefined,
		commentId: string | undefined,
		input: AgentSessionCreateOnIssueInput | AgentSessionCreateOnCommentInput,
	): Promise<IssueTrackerAgentSessionPayload> {
		// Validate input and fetch issue/comment
		let issue: Issue | undefined;
		let comment: Comment | undefined;

		if (issueId) {
			issue = await this.fetchIssue(issueId);
		}
		if (commentId) {
			comment = await this.fetchComment(commentId);
			// If comment provided but no issue, get issue from comment
			if (!issue && comment) {
				const commentData = this.state.comments.get(commentId);
				if (commentData?.issueId) {
					issue = await this.fetchIssue(commentData.issueId);
				}
			}
		}

		// Generate session ID
		const sessionId = `session-${this.state.sessionCounter++}`;
		const lastSyncId = Date.now();

		// Create agent session data
		const sessionData: CLIAgentSessionData = {
			id: sessionId,
			externalLink: input.externalLink,
			status: AgentSessionStatus.Active,
			type: AgentSessionType.CommentThread,
			createdAt: new Date(),
			updatedAt: new Date(),
			issueId: issue?.id,
			commentId,
		};

		// Save to state
		this.state.agentSessions.set(sessionId, sessionData);

		// Create the session object
		const agentSession = createCLIAgentSession(sessionData);

		// Emit state change event
		this.emit("agentSession:created", { agentSession });

		// Emit AgentSessionCreated webhook event if transport is available
		if (this.eventTransport && issue) {
			// Get team and state info for the issue
			const issueData = this.state.issues.get(issue.id);
			const team = issueData?.teamId
				? await this.fetchTeam(issueData.teamId)
				: undefined;

			// Construct a webhook-like event that matches Linear's structure
			const now = new Date();
			const nowIso = now.toISOString();
			const webhookEvent: AgentEvent = {
				type: "AgentSessionEvent",
				action: "created",
				organizationId: "cli-workspace",
				oauthClientId: "cli-oauth-client",
				appUserId: "cli-app-user",
				createdAt: now,
				agentSession: {
					id: sessionId,
					appUserId: "cli-app-user",
					organizationId: "cli-workspace",
					createdAt: nowIso,
					updatedAt: nowIso,
					status: "active",
					type: "issue",
					issue: {
						id: issue.id,
						identifier: issue.identifier,
						title: issue.title,
						url: `cli://issues/${issue.identifier}`,
						teamId: team?.id ?? "default-team",
						team: team
							? {
									id: team.id,
									key: team.key,
									name: team.name,
								}
							: {
									id: "default-team",
									key: "DEF",
									name: "Default Team",
								},
					},
					comment: comment
						? {
								id: comment.id,
								body: comment.body,
							}
						: undefined,
				},
				guidance: [], // Empty array for CLI mode
			};

			// Emit the event through the transport
			this.eventTransport.emitEvent(webhookEvent);
		}

		// Return payload with session wrapped in Promise
		const payload: IssueTrackerAgentSessionPayload = {
			success: true,
			lastSyncId,
			agentSession: Promise.resolve(agentSession),
		};

		return payload;
	}

	/**
	 * Fetch an agent session by ID.
	 */
	fetchAgentSession(sessionId: string): Promise<IssueTrackerAgentSession> {
		return (async () => {
			const sessionData = this.state.agentSessions.get(sessionId);
			if (!sessionData) {
				throw new Error(`Agent session ${sessionId} not found`);
			}
			return createCLIAgentSession(sessionData);
		})();
	}

	/**
	 * List agent sessions with optional filtering.
	 *
	 * @param options - Filtering options (issueId, limit, offset)
	 * @returns Array of agent session data
	 */
	listAgentSessions(options?: {
		issueId?: string;
		limit?: number;
		offset?: number;
	}): CLIAgentSessionData[] {
		const { issueId, limit = 50, offset = 0 } = options ?? {};

		let sessions = Array.from(this.state.agentSessions.values());

		// Filter by issueId if provided
		if (issueId) {
			sessions = sessions.filter((s) => s.issueId === issueId);
		}

		// Sort by creation date descending (most recent first)
		sessions.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

		// Apply pagination
		return sessions.slice(offset, offset + limit);
	}

	/**
	 * Update an agent session's status.
	 *
	 * @param sessionId - The session ID to update
	 * @param status - The new status
	 * @returns The updated session
	 */
	async updateAgentSessionStatus(
		sessionId: string,
		status: AgentSessionStatus,
	): Promise<IssueTrackerAgentSession> {
		const sessionData = this.state.agentSessions.get(sessionId);
		if (!sessionData) {
			throw new Error(`Agent session ${sessionId} not found`);
		}

		// Update the status
		sessionData.status = status;
		sessionData.updatedAt = new Date();

		// Set endedAt if session is being stopped
		const isStopping =
			status === AgentSessionStatus.Complete ||
			status === AgentSessionStatus.Error;
		if (isStopping) {
			sessionData.endedAt = new Date();
		}

		// Emit state change event
		const agentSession = createCLIAgentSession(sessionData);
		this.emit("agentSession:updated", { agentSession });

		return agentSession;
	}

	/**
	 * Emit a stop signal webhook event for the EdgeWorker to handle.
	 * Should be called by the caller after stopping a session (e.g., CLIRPCServer.handleStopSession).
	 */
	async emitStopSignalEvent(sessionId: string): Promise<void> {
		const sessionData = this.state.agentSessions.get(sessionId);
		if (!this.eventTransport || !sessionData?.issueId) {
			return;
		}

		const issue = await this.fetchIssue(sessionData.issueId);
		if (!issue) {
			return;
		}

		const issueData = this.state.issues.get(issue.id);
		const team = issueData?.teamId
			? await this.fetchTeam(issueData.teamId)
			: undefined;

		const now = new Date();
		const nowIso = now.toISOString();
		const webhookEvent: AgentEvent = {
			type: "AgentSessionEvent",
			action: "prompted",
			organizationId: "cli-workspace",
			oauthClientId: "cli-oauth-client",
			appUserId: "cli-app-user",
			createdAt: now,
			agentSession: {
				id: sessionId,
				appUserId: "cli-app-user",
				organizationId: "cli-workspace",
				createdAt: sessionData.createdAt.toISOString(),
				updatedAt: nowIso,
				status: sessionData.status,
				type: "issue",
				issue: {
					id: issue.id,
					identifier: issue.identifier,
					title: issue.title,
					url: `cli://issues/${issue.identifier}`,
					teamId: team?.id ?? "default-team",
					team: team
						? {
								id: team.id,
								key: team.key,
								name: team.name,
							}
						: {
								id: "default-team",
								key: "DEF",
								name: "Default Team",
							},
				},
			},
			agentActivity: {
				id: `activity-stop-${Date.now()}`,
				agentSessionId: sessionId,
				content: { type: "prompt", body: "Stop session" },
				createdAt: nowIso,
				updatedAt: nowIso,
				signal: "stop",
			},
			guidance: [],
		};

		this.eventTransport.emitEvent(webhookEvent);
	}

	/**
	 * Prompt an agent session with a user message.
	 * This creates a comment on the associated issue and emits a prompted event.
	 *
	 * @param sessionId - The session ID to prompt
	 * @param message - The user's prompt message
	 * @returns The created comment
	 */
	async promptAgentSession(
		sessionId: string,
		message: string,
	): Promise<Comment> {
		const sessionData = this.state.agentSessions.get(sessionId);
		if (!sessionData) {
			throw new Error(`Agent session ${sessionId} not found`);
		}

		if (!sessionData.issueId) {
			throw new Error(
				`Agent session ${sessionId} is not associated with an issue`,
			);
		}

		// Check if the session is stopped/completed
		if (sessionData.status === AgentSessionStatus.Complete) {
			throw new Error(`Cannot prompt completed session ${sessionId}`);
		}

		// Create a comment on the issue
		const comment = await this.createComment(sessionData.issueId, {
			body: message,
		});

		// Update session status to awaiting processing
		sessionData.updatedAt = new Date();

		// Create an activity record for the prompt
		await this.createAgentActivity({
			agentSessionId: sessionId,
			content: {
				type: AgentActivityType.Prompt,
				body: message,
			},
		});

		// Emit prompted event
		this.emit("agentSession:prompted", {
			sessionId,
			message,
			comment,
			issueId: sessionData.issueId,
		});

		// Emit AgentSessionEvent webhook for prompted action if transport is available
		if (this.eventTransport) {
			const issue = await this.fetchIssue(sessionData.issueId);
			if (issue) {
				const issueData = this.state.issues.get(issue.id);
				const team = issueData?.teamId
					? await this.fetchTeam(issueData.teamId)
					: undefined;

				const now = new Date();
				const nowIso = now.toISOString();
				const webhookEvent: AgentEvent = {
					type: "AgentSessionEvent",
					action: "prompted",
					organizationId: "cli-workspace",
					oauthClientId: "cli-oauth-client",
					appUserId: "cli-app-user",
					createdAt: now,
					agentSession: {
						id: sessionId,
						appUserId: "cli-app-user",
						organizationId: "cli-workspace",
						createdAt: sessionData.createdAt.toISOString(),
						updatedAt: nowIso,
						status: sessionData.status,
						type: "issue",
						issue: {
							id: issue.id,
							identifier: issue.identifier,
							title: issue.title,
							url: `cli://issues/${issue.identifier}`,
							teamId: team?.id ?? "default-team",
							team: team
								? {
										id: team.id,
										key: team.key,
										name: team.name,
									}
								: {
										id: "default-team",
										key: "DEF",
										name: "Default Team",
									},
						},
					},
					agentActivity: {
						id: `activity-prompt-${Date.now()}`,
						agentSessionId: sessionId,
						content: { type: "prompt", body: message },
						createdAt: nowIso,
						updatedAt: nowIso,
						sourceCommentId: comment.id,
					},
					guidance: [],
				};

				this.eventTransport.emitEvent(webhookEvent);
			}
		}

		return comment;
	}

	// ========================================================================
	// AGENT ACTIVITY OPERATIONS
	// ========================================================================

	/**
	 * Post an agent activity to an agent session.
	 */
	async createAgentActivity(
		input: AgentActivityCreateInput,
	): Promise<AgentActivityPayload> {
		// Validate session exists
		await this.fetchAgentSession(input.agentSessionId);

		// Generate activity ID
		const activityId = `activity-${this.state.activityCounter++}`;

		// Store the activity
		const activityData: CLIAgentActivityData = {
			id: activityId,
			agentSessionId: input.agentSessionId,
			type: input.content.type,
			content:
				"body" in input.content
					? typeof input.content.body === "string"
						? input.content.body
						: JSON.stringify(input.content.body)
					: JSON.stringify(input.content),
			createdAt: new Date(),
			ephemeral: input.ephemeral ?? undefined,
			signal: input.signal ?? undefined,
		};

		this.state.agentActivities.set(activityId, activityData);

		// Emit state change event
		this.emit("agentActivity:created", { input, activityId });

		// Return success payload with agentActivity that can be awaited
		// AgentSessionManager expects result.agentActivity to be promise-like
		return {
			agentActivity: Promise.resolve({ id: activityId }),
			success: true,
			lastSyncId: Date.now(),
		} as AgentActivityPayload;
	}

	/**
	 * List agent activities for a session.
	 *
	 * @param sessionId - The session ID to get activities for
	 * @param options - Pagination options
	 * @returns Array of agent activity data
	 */
	listAgentActivities(
		sessionId: string,
		options?: { limit?: number; offset?: number },
	): CLIAgentActivityData[] {
		const { limit = 50, offset = 0 } = options ?? {};

		// Get all activities for this session
		const activities = Array.from(this.state.agentActivities.values()).filter(
			(a) => a.agentSessionId === sessionId,
		);

		// Sort by creation date ascending
		activities.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

		// Apply pagination
		return activities.slice(offset, offset + limit);
	}

	// ========================================================================
	// FILE OPERATIONS
	// ========================================================================

	/**
	 * Request a file upload URL from the platform.
	 */
	async requestFileUpload(
		request: FileUploadRequest,
	): Promise<FileUploadResponse> {
		// Generate mock upload URLs
		const uploadUrl = `https://mock-upload.linear.app/${Date.now()}/${request.filename}`;
		const assetUrl = `https://mock-assets.linear.app/${Date.now()}/${request.filename}`;

		return {
			uploadUrl,
			headers: {
				"Content-Type": request.contentType,
				"x-amz-acl": request.makePublic ? "public-read" : "private",
			},
			assetUrl,
		};
	}

	/**
	 * Create an attachment on an issue (mock — CLI mode has no real Linear).
	 */
	async createAttachment(
		_request: AttachmentCreateRequest,
	): Promise<AttachmentCreateResponse> {
		return {
			success: true,
			attachmentId: `mock-attachment-${Date.now()}`,
		};
	}

	// ========================================================================
	// PLATFORM METADATA
	// ========================================================================

	/**
	 * Get the platform type identifier.
	 */
	getPlatformType(): string {
		return "cli";
	}

	/**
	 * Get the platform's API version or other metadata.
	 */
	getPlatformMetadata(): Record<string, unknown> {
		return {
			platform: "cli",
			implementation: "in-memory",
			version: "1.0.0",
		};
	}

	// ========================================================================
	// EVENT TRANSPORT
	// ========================================================================

	/**
	 * Create an event transport for receiving webhook events.
	 *
	 * @param config - Transport configuration
	 * @returns CLI event transport implementation
	 */
	createEventTransport(
		config: AgentEventTransportConfig,
	): IAgentEventTransport {
		// Type narrow to CLI config
		if (config.platform !== "cli") {
			throw new Error(
				`Invalid platform "${config.platform}" for CLIIssueTrackerService. Expected "cli".`,
			);
		}

		// Store the event transport so we can emit events
		this.eventTransport = new CLIEventTransport(config);
		return this.eventTransport;
	}

	// ========================================================================
	// TESTING/DEBUGGING UTILITIES
	// ========================================================================

	/**
	 * Seed default teams and workflow states for testing.
	 * Creates a "default" team with standard workflow states.
	 */
	seedDefaultData(): void {
		// Create default user
		const defaultUser: CLIUserData = {
			id: "user-default",
			name: "Test User",
			displayName: "Test User",
			email: "test@example.com",
			url: "https://linear.app/test/user/test-user",
			active: true,
			admin: false,
			app: false,
			guest: false,
			isMe: true,
			isAssignable: true,
			isMentionable: true,
			avatarBackgroundColor: "#3b82f6",
			initials: "TU",
			createdIssueCount: 0,
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		this.state.users.set(defaultUser.id, defaultUser);

		// Create default team
		const defaultTeam: CLITeamData = {
			id: "team-default",
			key: "DEF",
			name: "Default Team",
			displayName: "Default Team",
			description: "Default team for F1 CLI testing",
			private: false,
			issueCount: 0,
			inviteHash: "default-invite",
			cyclesEnabled: false,
			cycleDuration: 1,
			cycleCooldownTime: 0,
			cycleStartDay: 0,
			cycleLockToActive: false,
			cycleIssueAutoAssignStarted: false,
			cycleIssueAutoAssignCompleted: false,
			defaultIssueEstimate: 0,
			issueEstimationType: "notUsed",
			issueEstimationAllowZero: true,
			issueEstimationExtended: false,
			autoArchivePeriod: 0,
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		this.state.teams.set(defaultTeam.id, defaultTeam);

		// Create workflow states for the default team
		const workflowStates: CLIWorkflowStateData[] = [
			{
				id: "state-todo",
				name: "Todo",
				description: "Work that has not been started",
				color: "#e2e2e2",
				type: "unstarted",
				position: 0,
				teamId: defaultTeam.id,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			{
				id: "state-in-progress",
				name: "In Progress",
				description: "Work that is actively being worked on",
				color: "#f2c94c",
				type: "started",
				position: 1,
				teamId: defaultTeam.id,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			{
				id: "state-done",
				name: "Done",
				description: "Work that has been completed",
				color: "#5e6ad2",
				type: "completed",
				position: 2,
				teamId: defaultTeam.id,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		];

		for (const state of workflowStates) {
			this.state.workflowStates.set(state.id, state);
		}
	}

	/**
	 * Get the current in-memory state (for testing/debugging).
	 */
	getState(): CLIIssueTrackerState {
		return this.state;
	}
}
