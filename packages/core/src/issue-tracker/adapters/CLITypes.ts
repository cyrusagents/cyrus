/**
 * CLI-specific implementations of issue tracker types.
 *
 * These factory functions create plain objects that match our Pick-based type
 * aliases defined in types.ts. Since our type aliases use Pick to select only
 * the properties and methods we actually use from Linear SDK, these objects
 * are structurally compatible without needing any type casts.
 *
 * This approach eliminates the need for `as unknown as` casts while maintaining
 * full type safety and compatibility with Linear SDK.
 *
 * @module issue-tracker/adapters/CLITypes
 */

import type * as LinearSDK from "@linear/sdk";
import type { AgentSessionStatus, AgentSessionType } from "@linear/sdk";
import type {
	AgentSessionSDKType,
	Comment,
	Connection,
	Issue,
	IssuePayload,
	IssueRelation,
	Label,
	Team,
	User,
	WorkflowState,
} from "../types.js";

/**
 * Internal storage for a CLI Issue.
 * All relationships are stored as IDs, and getters return promises.
 */
export interface CLIIssueData {
	id: string;
	identifier: string;
	title: string;
	description?: string;
	number: number;
	url: string;
	branchName: string;
	priority: number;
	priorityLabel: string;
	estimate?: number;
	boardOrder: number;
	sortOrder: number;
	subIssueSortOrder?: number;
	prioritySortOrder: number;
	labelIds: string[];
	previousIdentifiers: string[];
	trashed?: boolean;
	customerTicketCount: number;
	createdAt: Date;
	updatedAt: Date;
	archivedAt?: Date;
	autoArchivedAt?: Date;
	autoClosedAt?: Date;
	canceledAt?: Date;
	completedAt?: Date;
	startedAt?: Date;
	addedToCycleAt?: Date;
	addedToProjectAt?: Date;
	addedToTeamAt?: Date;
	startedTriageAt?: Date;
	triagedAt?: Date;
	slaStartedAt?: Date;
	slaBreachesAt?: Date;
	slaHighRiskAt?: Date;
	slaMediumRiskAt?: Date;
	snoozedUntilAt?: Date;
	dueDate?: string;

	// Relationship IDs
	assigneeId?: string;
	creatorId?: string;
	delegateId?: string;
	teamId?: string;
	stateId?: string;
	projectId?: string;
	projectMilestoneId?: string;
	cycleId?: string;
	parentId?: string;
	snoozedById?: string;
	sourceCommentId?: string;
	favoriteId?: string;
}

/**
 * Internal storage for a CLI Comment.
 */
export interface CLICommentData {
	id: string;
	body: string;
	url: string;
	quotedText?: string;
	createdAt: Date;
	updatedAt: Date;
	archivedAt?: Date;
	editedAt?: Date;
	resolvedAt?: Date;

	// Relationship IDs
	userId?: string;
	externalUserId?: string;
	issueId?: string;
	parentId?: string;
	agentSessionId?: string;
	resolvingUserId?: string;
	resolvingCommentId?: string;
}

/**
 * Internal storage for a CLI Team.
 */
export interface CLITeamData {
	id: string;
	key: string;
	name: string;
	displayName: string;
	description?: string;
	icon?: string;
	color?: string;
	private: boolean;
	issueCount: number;
	inviteHash: string;
	cyclesEnabled: boolean;
	cycleDuration: number;
	cycleCooldownTime: number;
	cycleStartDay: number;
	cycleLockToActive: boolean;
	cycleIssueAutoAssignStarted: boolean;
	cycleIssueAutoAssignCompleted: boolean;
	defaultIssueEstimate: number;
	issueEstimationType: string;
	issueEstimationAllowZero: boolean;
	issueEstimationExtended: boolean;
	autoArchivePeriod: number;
	createdAt: Date;
	updatedAt: Date;
	archivedAt?: Date;

	// Relationship IDs
	defaultIssueStateId?: string;
	triageIssueStateId?: string;
}

/**
 * Internal storage for a CLI User.
 */
export interface CLIUserData {
	id: string;
	name: string;
	displayName: string;
	email: string;
	url: string;
	active: boolean;
	admin: boolean;
	app: boolean;
	guest: boolean;
	isMe: boolean;
	isAssignable: boolean;
	isMentionable: boolean;
	avatarUrl?: string;
	avatarBackgroundColor: string;
	initials: string;
	description?: string;
	createdIssueCount: number;
	statusEmoji?: string;
	statusLabel?: string;
	createdAt: Date;
	updatedAt: Date;
	archivedAt?: Date;
	lastSeen?: Date;
}

/**
 * Internal storage for a CLI WorkflowState.
 */
export interface CLIWorkflowStateData {
	id: string;
	name: string;
	description?: string;
	color: string;
	type: string;
	position: number;
	createdAt: Date;
	updatedAt: Date;
	archivedAt?: Date;

	// Relationship IDs
	teamId?: string;
}

/**
 * Internal storage for a CLI Label.
 */
export interface CLILabelData {
	id: string;
	name: string;
	description?: string;
	color: string;
	isGroup: boolean;
	createdAt: Date;
	updatedAt: Date;
	archivedAt?: Date;

	// Relationship IDs
	teamId?: string;
	creatorId?: string;
	parentId?: string;
}

/**
 * Internal storage for a CLI AgentSession.
 */
export interface CLIAgentSessionData {
	id: string;
	externalLink?: string;
	summary?: string;
	status: AgentSessionStatus;
	type: AgentSessionType;
	createdAt: Date;
	updatedAt: Date;
	archivedAt?: Date;
	startedAt?: Date;
	endedAt?: Date;

	// Relationship IDs
	appUserId?: string;
	creatorId?: string;
	issueId?: string;
	commentId?: string;
}

/**
 * Internal storage for a CLI AgentActivity.
 */
export interface CLIAgentActivityData {
	id: string;
	agentSessionId: string;
	type: string;
	content: string;
	createdAt: Date;
	ephemeral?: boolean;
	signal?: string;
}

/**
 * Create a CLI Issue object compatible with our Pick-based Issue type.
 */
export function createCLIIssue(
	data: CLIIssueData,
	resolvedLabels?: CLILabelData[],
): Issue {
	// Create a partial object with all the required properties
	const issue = {
		// Direct properties
		id: data.id,
		identifier: data.identifier,
		title: data.title,
		description: data.description,
		number: data.number,
		url: data.url,
		branchName: data.branchName,
		priority: data.priority,
		priorityLabel: data.priorityLabel,
		estimate: data.estimate,
		boardOrder: data.boardOrder,
		sortOrder: data.sortOrder,
		subIssueSortOrder: data.subIssueSortOrder,
		prioritySortOrder: data.prioritySortOrder,
		labelIds: data.labelIds,
		previousIdentifiers: data.previousIdentifiers,
		trashed: data.trashed,
		customerTicketCount: data.customerTicketCount,
		createdAt: data.createdAt,
		updatedAt: data.updatedAt,
		archivedAt: data.archivedAt,
		autoArchivedAt: data.autoArchivedAt,
		autoClosedAt: data.autoClosedAt,
		canceledAt: data.canceledAt,
		completedAt: data.completedAt,
		startedAt: data.startedAt,
		addedToCycleAt: data.addedToCycleAt,
		addedToProjectAt: data.addedToProjectAt,
		addedToTeamAt: data.addedToTeamAt,
		startedTriageAt: data.startedTriageAt,
		triagedAt: data.triagedAt,
		slaStartedAt: data.slaStartedAt,
		slaBreachesAt: data.slaBreachesAt,
		slaHighRiskAt: data.slaHighRiskAt,
		slaMediumRiskAt: data.slaMediumRiskAt,
		snoozedUntilAt: data.snoozedUntilAt,

		// Relationship ID getters
		get assigneeId() {
			return data.assigneeId;
		},
		get creatorId() {
			return data.creatorId;
		},
		get delegateId() {
			return data.delegateId;
		},
		get teamId() {
			return data.teamId;
		},
		get stateId() {
			return data.stateId;
		},
		get projectId() {
			return data.projectId;
		},
		get parentId() {
			return data.parentId;
		},

		// Relationship getters (return Promise<Type> | undefined)
		get assignee() {
			return undefined;
		},
		get creator() {
			return undefined;
		},
		get delegate() {
			return undefined;
		},
		get team() {
			return undefined;
		},
		get state() {
			return undefined;
		},
		get parent() {
			return undefined;
		},
		get project() {
			return undefined;
		},

		// Collection methods - now use simplified Connection<T> (no casts needed!)
		children(
			_variables?: Omit<
				LinearSDK.LinearDocument.Issue_ChildrenQueryVariables,
				"id"
			>,
		): Promise<Connection<Issue>> {
			return Promise.resolve({ nodes: [] });
		},
		comments(
			_variables?: Omit<
				LinearSDK.LinearDocument.Issue_CommentsQueryVariables,
				"id"
			>,
		): Promise<Connection<Comment>> {
			return Promise.resolve({ nodes: [] });
		},
		labels(
			_variables?: Omit<
				LinearSDK.LinearDocument.Issue_LabelsQueryVariables,
				"id"
			>,
		): Promise<Connection<Label>> {
			if (!resolvedLabels || resolvedLabels.length === 0) {
				return Promise.resolve({ nodes: [] });
			}
			return Promise.resolve({
				nodes: resolvedLabels.map((label) => createCLILabel(label)),
			});
		},
		attachments(
			_variables?: Omit<
				LinearSDK.LinearDocument.Issue_AttachmentsQueryVariables,
				"id"
			>,
		): Promise<Connection<LinearSDK.Attachment>> {
			return Promise.resolve({ nodes: [] });
		},
		inverseRelations(
			_variables?: Omit<
				LinearSDK.LinearDocument.Issue_InverseRelationsQueryVariables,
				"id"
			>,
		): Promise<Connection<IssueRelation>> {
			return Promise.resolve({ nodes: [] });
		},
		update(
			_input?: LinearSDK.LinearDocument.IssueUpdateInput,
		): Promise<IssuePayload> {
			return Promise.resolve({
				success: true,
				issue: undefined,
				lastSyncId: 0,
			});
		},
	};

	// Return directly - structurally compatible with our Pick-based Issue type
	return issue;
}

/**
 * Create a CLI Comment object compatible with our Pick-based Comment type.
 */
export function createCLIComment(
	data: CLICommentData,
	/**
	 * Optional lookup so `comment.user` resolves to the authoring CLI user —
	 * the EdgeWorker reads `(await comment.user).id` to attribute follow-up
	 * prompts to a human (per-prompter credential resolution).
	 */
	resolveUser?: (userId: string) => User | undefined,
): Comment {
	const comment = {
		id: data.id,
		body: data.body,
		url: data.url,
		quotedText: data.quotedText,
		createdAt: data.createdAt,
		updatedAt: data.updatedAt,
		archivedAt: data.archivedAt,
		editedAt: data.editedAt,
		resolvedAt: data.resolvedAt,
		reactionData: [],
		reactions: () => Promise.resolve({ nodes: [] }),

		// Relationship ID getters
		get userId() {
			return data.userId;
		},
		get issueId() {
			return data.issueId;
		},
		get parentId() {
			return data.parentId;
		},
		get agentSessionId() {
			return data.agentSessionId;
		},

		// Relationship getters (return Promise<Type> | undefined)
		get user() {
			const user =
				data.userId && resolveUser ? resolveUser(data.userId) : undefined;
			// Our `User` is a Pick of the SDK user; callers only read the picked
			// fields, so widen the promise to the SDK's LinearFetch<User> shape.
			return user
				? (Promise.resolve(
						user,
					) as unknown as LinearSDK.LinearFetch<LinearSDK.User>)
				: undefined;
		},
		get issue() {
			return undefined;
		},
		get parent() {
			return undefined;
		},
		get agentSession() {
			return undefined;
		},

		// Collection methods - now use simplified Connection<T> (no casts needed!)
		children(
			_variables?: LinearSDK.LinearDocument.Comment_ChildrenQueryVariables,
		): Promise<Connection<Comment>> {
			return Promise.resolve({ nodes: [] });
		},
	};

	return comment;
}

/**
 * Create a CLI Team object compatible with our Pick-based Team type.
 */
export function createCLITeam(data: CLITeamData): Team {
	const team = {
		id: data.id,
		key: data.key,
		name: data.name,
		displayName: data.displayName,
		description: data.description,
		icon: data.icon,
		color: data.color,
		private: data.private,
		issueCount: data.issueCount,
		inviteHash: data.inviteHash,
		cyclesEnabled: data.cyclesEnabled,
		cycleDuration: data.cycleDuration,
		cycleCooldownTime: data.cycleCooldownTime,
		cycleStartDay: data.cycleStartDay,
		cycleLockToActive: data.cycleLockToActive,
		cycleIssueAutoAssignStarted: data.cycleIssueAutoAssignStarted,
		cycleIssueAutoAssignCompleted: data.cycleIssueAutoAssignCompleted,
		defaultIssueEstimate: data.defaultIssueEstimate,
		issueEstimationType: data.issueEstimationType,
		issueEstimationAllowZero: data.issueEstimationAllowZero,
		issueEstimationExtended: data.issueEstimationExtended,
		autoArchivePeriod: data.autoArchivePeriod,
		createdAt: data.createdAt,
		updatedAt: data.updatedAt,
		archivedAt: data.archivedAt,

		// Relationship ID getters
		get defaultIssueStateId() {
			return data.defaultIssueStateId;
		},
		get triageIssueStateId() {
			return data.triageIssueStateId;
		},

		// Relationship getters
		get defaultIssueState() {
			return Promise.resolve(undefined);
		},
		get triageIssueState() {
			return Promise.resolve(undefined);
		},

		// Collection methods - now use simplified Connection<T> (no casts needed!)
		states(
			_variables?: Omit<
				LinearSDK.LinearDocument.Team_StatesQueryVariables,
				"id"
			>,
		): Promise<Connection<WorkflowState>> {
			return Promise.resolve({ nodes: [] });
		},
		members(
			_variables?: Omit<
				LinearSDK.LinearDocument.Team_MembersQueryVariables,
				"id"
			>,
		): Promise<Connection<User>> {
			return Promise.resolve({ nodes: [] });
		},
	};

	return team;
}

/**
 * Create a CLI User object compatible with our Pick-based User type.
 */
export function createCLIUser(data: CLIUserData): User {
	const user = {
		id: data.id,
		name: data.name,
		displayName: data.displayName,
		email: data.email,
		url: data.url,
		active: data.active,
		admin: data.admin,
		app: data.app,
		guest: data.guest,
		isMe: data.isMe,
		isAssignable: data.isAssignable,
		isMentionable: data.isMentionable,
		avatarUrl: data.avatarUrl,
		avatarBackgroundColor: data.avatarBackgroundColor,
		initials: data.initials,
		description: data.description,
		createdIssueCount: data.createdIssueCount,
		statusEmoji: data.statusEmoji,
		statusLabel: data.statusLabel,
		createdAt: data.createdAt,
		updatedAt: data.updatedAt,
		archivedAt: data.archivedAt,
		lastSeen: data.lastSeen,

		// Methods
		assignedIssues: () => Promise.resolve({ nodes: [] }),
		createdIssues: () => Promise.resolve({ nodes: [] }),
		teams: () => Promise.resolve({ nodes: [] }),
	};

	return user;
}

/**
 * Create a CLI WorkflowState object compatible with our Pick-based WorkflowState type.
 */
export function createCLIWorkflowState(
	data: CLIWorkflowStateData,
): WorkflowState {
	const state = {
		id: data.id,
		name: data.name,
		description: data.description,
		color: data.color,
		type: data.type,
		position: data.position,
		createdAt: data.createdAt,
		updatedAt: data.updatedAt,
		archivedAt: data.archivedAt,

		// Relationship ID getters
		get teamId() {
			return data.teamId;
		},

		// Relationship getters
		get team() {
			return Promise.resolve(undefined);
		},

		// Collection methods
		issues: () => Promise.resolve({ nodes: [] }),
	};

	return state;
}

/**
 * Create a CLI Label object compatible with our Pick-based Label type.
 */
export function createCLILabel(data: CLILabelData): Label {
	const label = {
		id: data.id,
		name: data.name,
		description: data.description,
		color: data.color,
		isGroup: data.isGroup,
		createdAt: data.createdAt,
		updatedAt: data.updatedAt,
		archivedAt: data.archivedAt,

		// Relationship ID getters
		get teamId() {
			return data.teamId;
		},
		get creatorId() {
			return data.creatorId;
		},
		get parentId() {
			return data.parentId;
		},

		// Relationship getters
		get team() {
			return Promise.resolve(undefined);
		},
		get creator() {
			return Promise.resolve(undefined);
		},
		get parent() {
			return Promise.resolve(undefined);
		},

		// Collection methods
		children: () => Promise.resolve({ nodes: [] }),
		issues: () => Promise.resolve({ nodes: [] }),
	};

	return label;
}

/**
 * Create a CLI AgentSession object using our simplified AgentSessionSDKType.
 * No casts needed - uses Pick-based type with simplified Connection!
 */
export function createCLIAgentSession(
	data: CLIAgentSessionData,
): AgentSessionSDKType {
	return {
		// Direct properties
		id: data.id,
		externalLink: data.externalLink,
		summary: data.summary,
		status: data.status,
		type: data.type,
		createdAt: data.createdAt,
		updatedAt: data.updatedAt,
		archivedAt: data.archivedAt,
		startedAt: data.startedAt,
		endedAt: data.endedAt,

		// Relationship IDs - direct properties from Pick
		appUserId: data.appUserId,
		creatorId: data.creatorId,
		issueId: data.issueId,
		commentId: data.commentId,

		// Relationship async getters - return undefined to match Promise<T> | undefined type
		get appUser() {
			return undefined;
		},
		get creator() {
			return undefined;
		},
		get issue() {
			return undefined;
		},
		get comment() {
			return undefined;
		},

		// Collection method - return Promise wrapping Connection
		activities(
			_variables?: Omit<
				LinearSDK.LinearDocument.AgentSession_ActivitiesQueryVariables,
				"id"
			>,
		) {
			return Promise.resolve({ nodes: [] });
		},
	};
}
