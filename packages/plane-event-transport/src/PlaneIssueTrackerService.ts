import {
	type AgentActivityCreateInput,
	type AgentActivityPayload,
	type AgentEventTransportConfig,
	type AgentSessionCreateOnCommentInput,
	type AgentSessionCreateOnIssueInput,
	type Comment,
	type CommentCreateInput,
	type CommentWithAttachments,
	type Connection,
	createLogger,
	type FetchChildrenOptions,
	type FileUploadRequest,
	type FileUploadResponse,
	type IAgentEventTransport,
	type IIssueTrackerService,
	type ILogger,
	type Issue,
	type IssueUpdateInput,
	type IssueWithChildren,
	type Label,
	type PaginationOptions,
	type Team,
	type User,
	type WorkflowState,
} from "cyrus-core";
import { planeToolsMcpServerConfig } from "./mcp/PlaneToolsServer.js";
import type { PlaneApiClient } from "./PlaneApiClient.js";
import { PlaneProgressNotes } from "./PlaneProgressNotes.js";
import { htmlToText, markdownToHtml } from "./PlaneText.js";
import type {
	PlaneActivitySignal,
	PlaneComment,
	PlaneCreateActivityRequest,
	PlaneLabel,
	PlaneMember,
	PlanePriority,
	PlaneProject,
	PlaneState,
	PlaneStateGroup,
	PlaneWorkItem,
} from "./types.js";

type IssueTrackerAgentSession = Awaited<
	ReturnType<IIssueTrackerService["fetchAgentSession"]>
>;
type IssueTrackerAgentSessionPayload = Awaited<
	ReturnType<IIssueTrackerService["createAgentSessionOnIssue"]>
>;

/** Plane marks a run stale after 5 minutes without an activity. */
const HEARTBEAT_AFTER_MS = 4 * 60 * 1000;
const HEARTBEAT_CHECK_MS = 60 * 1000;
/** Give up on heartbeats for a run that never finished (crash, lost response). */
const HEARTBEAT_MAX_RUN_MS = 12 * 60 * 60 * 1000;
const CACHE_TTL_MS = 5 * 60 * 1000;

const STATE_TYPES: Record<PlaneStateGroup, string> = {
	backlog: "backlog",
	unstarted: "unstarted",
	started: "started",
	completed: "completed",
	cancelled: "canceled",
	triage: "triage",
};

// Linear priorities: 0 none, 1 urgent, 2 high, 3 normal, 4 low.
const PRIORITY_TO_NUMBER: Record<PlanePriority, number> = {
	none: 0,
	urgent: 1,
	high: 2,
	medium: 3,
	low: 4,
};
const NUMBER_TO_PRIORITY: PlanePriority[] = [
	"none",
	"urgent",
	"high",
	"medium",
	"low",
];

const SIGNALS: Record<string, PlaneActivitySignal> = {
	auth: "auth_request",
	continue: "continue",
	select: "select",
	stop: "stop",
};

interface RunTracking {
	startedAt: number;
	lastActivityAt: number;
}

/**
 * IIssueTrackerService for Plane.
 *
 * Cyrus's issue-tracker abstraction is shaped after Linear's SDK, so this
 * service translates Plane resources into those shapes, the way the CLI
 * adapter does: a Plane project plays the role of both Linear's team (its
 * identifier is the key in "WEB-12") and Linear's project (its name is what
 * `projectKeys` routing matches), and Plane state groups map onto Linear state
 * types. Agent activities are posted to the agent run with the same id as the
 * Cyrus session.
 *
 * Work-item endpoints need the project id, which webhook payloads carry; call
 * `rememberWorkItem` with it before Cyrus asks for the issue.
 */
export class PlaneIssueTrackerService implements IIssueTrackerService {
	private readonly logger: ILogger;
	private readonly workItemProjects = new Map<string, string>();
	private readonly commentLocations = new Map<
		string,
		{ projectId: string; workItemId: string }
	>();
	private readonly cache = new Map<string, { at: number; value: unknown }>();
	private readonly activeRuns = new Map<string, RunTracking>();
	private heartbeatTimer: NodeJS.Timeout | null = null;

	/** Visible "working on it" replies, since Plane hides agent progress on free plans. */
	private readonly progress: PlaneProgressNotes;

	constructor(
		readonly api: PlaneApiClient,
		readonly workspaceKey: string,
		logger?: ILogger,
	) {
		this.logger =
			logger ?? createLogger({ component: "PlaneIssueTrackerService" });
		this.progress = new PlaneProgressNotes(api, { logger: this.logger });
	}

	/** Remember which project a work item (and optionally a comment) is in. */
	rememberWorkItem(
		workItemId: string,
		projectId: string,
		commentId?: string | null,
	): void {
		this.workItemProjects.set(workItemId, projectId);
		if (commentId) {
			this.commentLocations.set(commentId, { projectId, workItemId });
		}
	}

	issueUrl(identifier: string): string {
		return `${this.api.baseUrl}/${this.api.workspaceSlug}/browse/${identifier}/`;
	}

	// ========================================================================
	// ISSUES
	// ========================================================================

	async fetchIssue(idOrIdentifier: string): Promise<Issue> {
		return this.toIssue(await this.fetchWorkItem(idOrIdentifier));
	}

	async fetchIssueChildren(
		issueId: string,
		_options?: FetchChildrenOptions,
	): Promise<IssueWithChildren> {
		const issue = await this.fetchIssue(issueId);
		return { ...issue, children: [], childCount: 0 } as IssueWithChildren;
	}

	async updateIssue(
		issueId: string,
		updates: IssueUpdateInput,
	): Promise<Issue> {
		const workItem = await this.fetchWorkItem(issueId);
		const changes: Record<string, unknown> = {};
		if (updates.stateId !== undefined) changes.state = updates.stateId;
		if (updates.title !== undefined) changes.name = updates.title;
		if (updates.description !== undefined)
			changes.description_html = markdownToHtml(updates.description);
		if (updates.assigneeId !== undefined)
			changes.assignees = updates.assigneeId ? [updates.assigneeId] : [];
		if (updates.priority !== undefined)
			changes.priority = NUMBER_TO_PRIORITY[updates.priority] ?? "none";
		if (updates.parentId !== undefined) changes.parent = updates.parentId;
		if (updates.labelIds !== undefined) changes.labels = updates.labelIds;
		const updated = await this.api.updateWorkItem(
			workItem.project,
			workItem.id,
			changes,
		);
		return this.toIssue({ ...workItem, ...updated });
	}

	async fetchIssueAttachments(
		_issueId: string,
	): Promise<Array<{ title: string; url: string }>> {
		return [];
	}

	// ========================================================================
	// COMMENTS
	// ========================================================================

	async fetchComments(
		issueId: string,
		_options?: PaginationOptions,
	): Promise<Connection<Comment>> {
		const workItem = await this.fetchWorkItem(issueId);
		const comments = await this.api.listComments(workItem.project, workItem.id);
		for (const c of comments) {
			this.commentLocations.set(c.id, {
				projectId: workItem.project,
				workItemId: workItem.id,
			});
		}
		return { nodes: comments.map((c) => this.toComment(c, workItem)) };
	}

	async fetchComment(commentId: string): Promise<Comment> {
		const location = this.commentLocations.get(commentId);
		if (!location) {
			throw new Error(`Plane comment ${commentId}: unknown work item`);
		}
		const [comment, workItem] = await Promise.all([
			this.api.getComment(location.projectId, location.workItemId, commentId),
			this.fetchWorkItem(location.workItemId),
		]);
		return this.toComment(comment, workItem);
	}

	async fetchCommentWithAttachments(
		commentId: string,
	): Promise<CommentWithAttachments> {
		return { ...(await this.fetchComment(commentId)), attachments: [] };
	}

	async createComment(
		issueId: string,
		input: CommentCreateInput,
	): Promise<Comment> {
		const workItem = await this.fetchWorkItem(issueId);
		const comment = await this.api.createComment(
			workItem.project,
			workItem.id,
			markdownToHtml(input.body),
		);
		return this.toComment(comment, workItem);
	}

	// ========================================================================
	// TEAMS (= Plane projects)
	// ========================================================================

	async fetchTeams(_options?: PaginationOptions): Promise<Connection<Team>> {
		const projects = await this.cached("projects", () =>
			this.api.listProjects(),
		);
		return { nodes: projects.map((p) => this.toTeam(p)) };
	}

	async fetchTeam(idOrKey: string): Promise<Team> {
		const projects = await this.cached("projects", () =>
			this.api.listProjects(),
		);
		const project = projects.find(
			(p) =>
				p.id === idOrKey ||
				p.identifier.toLowerCase() === idOrKey.toLowerCase(),
		);
		if (!project) {
			throw new Error(`Plane project ${idOrKey} not found`);
		}
		return this.toTeam(project);
	}

	// ========================================================================
	// LABELS
	// ========================================================================

	async fetchLabels(_options?: PaginationOptions): Promise<Connection<Label>> {
		const projects = await this.cached("projects", () =>
			this.api.listProjects(),
		);
		const byName = new Map<string, Label>();
		for (const project of projects) {
			for (const label of await this.labels(project.id)) {
				byName.set(label.name, toLabel(label));
			}
		}
		return { nodes: [...byName.values()] };
	}

	async fetchLabel(idOrName: string): Promise<Label> {
		const { nodes } = await this.fetchLabels();
		const label = nodes.find((l) => l.id === idOrName || l.name === idOrName);
		if (!label) {
			throw new Error(`Plane label ${idOrName} not found`);
		}
		return label;
	}

	async getIssueLabels(issueId: string): Promise<string[]> {
		const workItem = await this.fetchWorkItem(issueId);
		const labels = await this.labels(workItem.project);
		const ids = new Set(workItem.labels ?? []);
		return labels.filter((l) => ids.has(l.id)).map((l) => l.name);
	}

	// ========================================================================
	// WORKFLOW STATES
	// ========================================================================

	async fetchWorkflowStates(
		teamId: string,
		_options?: PaginationOptions,
	): Promise<Connection<WorkflowState>> {
		return { nodes: (await this.states(teamId)).map(toWorkflowState) };
	}

	async fetchWorkflowState(stateId: string): Promise<WorkflowState> {
		for (const [key, entry] of this.cache) {
			if (!key.startsWith("states:")) continue;
			const state = (entry.value as PlaneState[]).find((s) => s.id === stateId);
			if (state) return toWorkflowState(state);
		}
		throw new Error(`Plane state ${stateId} not found`);
	}

	// ========================================================================
	// USERS
	// ========================================================================

	async fetchUser(userId: string): Promise<User> {
		const member = (await this.members()).find((m) => m.id === userId);
		if (!member) {
			throw new Error(`Plane member ${userId} not found`);
		}
		return toUser(member);
	}

	/**
	 * Cyrus calls this to keep a Linear OAuth token fresh. For Plane it checks
	 * that the bot token still works with a cheap request.
	 */
	async fetchCurrentUser(): Promise<User> {
		await this.cached("projects", () => this.api.listProjects());
		return {
			id: "plane-bot",
			name: "Cyrus",
			displayName: "Cyrus",
			email: "",
			gitHubUserId: undefined,
			url: this.api.baseUrl,
		} as unknown as User;
	}

	// ========================================================================
	// AGENT SESSIONS (= Plane agent runs)
	// ========================================================================

	async createAgentSessionOnIssue(
		_input: AgentSessionCreateOnIssueInput,
	): Promise<IssueTrackerAgentSessionPayload> {
		throw new Error(
			"Starting a Plane agent run from Cyrus is not supported yet: mention or assign the agent in Plane",
		);
	}

	async createAgentSessionOnComment(
		_input: AgentSessionCreateOnCommentInput,
	): Promise<IssueTrackerAgentSessionPayload> {
		throw new Error(
			"Starting a Plane agent run from Cyrus is not supported yet: mention or assign the agent in Plane",
		);
	}

	async fetchAgentSession(
		sessionId: string,
	): Promise<IssueTrackerAgentSession> {
		const run = await this.api.getRun(sessionId);
		return {
			id: run.id,
			status: run.status,
			issueId: run.issue ?? undefined,
		} as unknown as IssueTrackerAgentSession;
	}

	async emitStopSignalEvent(_sessionId: string): Promise<void> {
		// Stop signals come from Plane (the user stops the run there).
	}

	// ========================================================================
	// AGENT ACTIVITIES (= Plane run activities)
	// ========================================================================

	async createAgentActivity(
		input: AgentActivityCreateInput,
	): Promise<AgentActivityPayload> {
		const runId = input.agentSessionId;
		const request = toPlaneActivity(input);
		const activity = await this.api.createActivity(runId, request);
		this.trackRun(runId, request.type);
		void this.progress.onActivity(
			runId,
			request.type,
			"body" in request.content ? request.content.body : undefined,
		);
		return {
			success: true,
			lastSyncId: 0,
			agentActivity: Promise.resolve({ id: activity?.id ?? "" }),
		} as unknown as AgentActivityPayload;
	}

	// ========================================================================
	// UNSUPPORTED / PLATFORM
	// ========================================================================

	async requestFileUpload(
		_request: FileUploadRequest,
	): Promise<FileUploadResponse> {
		throw new Error("File uploads are not supported for Plane yet");
	}

	getPlatformType(): string {
		return "plane";
	}

	getPlatformMetadata(): Record<string, unknown> {
		return {
			baseUrl: this.api.baseUrl,
			workspaceSlug: this.api.workspaceSlug,
		};
	}

	/** MCP server that gives the agent's sessions Plane tools, as this app's bot. */
	toolsMcpServerConfig(): ReturnType<typeof planeToolsMcpServerConfig> {
		return planeToolsMcpServerConfig(this.api.getCredentials());
	}

	createEventTransport(
		_config: AgentEventTransportConfig,
	): IAgentEventTransport {
		throw new Error(
			"Plane webhooks are received by PlaneEventTransport, registered by the edge worker",
		);
	}

	/** Stop the heartbeat timer (on shutdown). */
	dispose(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		this.activeRuns.clear();
	}

	// ========================================================================
	// HEARTBEAT: keep long runs from going stale in Plane
	// ========================================================================

	private trackRun(
		runId: string,
		type: PlaneCreateActivityRequest["type"],
	): void {
		const now = Date.now();
		if (type === "response" || type === "error" || type === "elicitation") {
			// The run is waiting on the user or done: no heartbeat until it resumes.
			this.activeRuns.delete(runId);
		} else {
			const tracking = this.activeRuns.get(runId);
			this.activeRuns.set(runId, {
				startedAt: tracking?.startedAt ?? now,
				lastActivityAt: now,
			});
		}
		if (this.activeRuns.size > 0 && !this.heartbeatTimer) {
			this.heartbeatTimer = setInterval(
				() => void this.sendHeartbeats(),
				HEARTBEAT_CHECK_MS,
			);
			this.heartbeatTimer.unref?.();
		} else if (this.activeRuns.size === 0 && this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	/** Exposed for tests. */
	async sendHeartbeats(now = Date.now()): Promise<void> {
		for (const [runId, tracking] of this.activeRuns) {
			if (now - tracking.startedAt > HEARTBEAT_MAX_RUN_MS) {
				this.activeRuns.delete(runId);
				continue;
			}
			if (now - tracking.lastActivityAt < HEARTBEAT_AFTER_MS) {
				continue;
			}
			try {
				await this.api.createActivity(runId, {
					type: "thought",
					content: { type: "thought", body: "Still working…" },
				});
				tracking.lastActivityAt = now;
			} catch (error) {
				this.logger.warn(
					`Heartbeat for Plane run ${runId} failed; not retrying`,
					error,
				);
				this.activeRuns.delete(runId);
			}
		}
	}

	// ========================================================================
	// HELPERS
	// ========================================================================

	private async fetchWorkItem(idOrIdentifier: string): Promise<PlaneWorkItem> {
		const projectId = this.workItemProjects.get(idOrIdentifier);
		if (projectId) {
			return this.api.getWorkItem(projectId, idOrIdentifier);
		}
		// Not a work item we've seen in a webhook: try it as "WEB-12".
		if (/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(idOrIdentifier)) {
			const workItem = await this.api.getWorkItemByIdentifier(idOrIdentifier);
			this.workItemProjects.set(workItem.id, workItem.project);
			return workItem;
		}
		throw new Error(
			`Plane work item ${idOrIdentifier}: project unknown (no webhook seen for it)`,
		);
	}

	private async toIssue(workItem: PlaneWorkItem): Promise<Issue> {
		const project = await this.project(workItem.project);
		const identifier = `${project.identifier}-${workItem.sequence_id}`;
		const states = await this.states(workItem.project);
		const state = states.find((s) => s.id === workItem.state);
		const service = this;
		const assigneeId = workItem.assignees?.[0];

		const issue = {
			id: workItem.id,
			identifier,
			title: workItem.name,
			description: htmlToText(
				workItem.description_html ?? workItem.description_stripped ?? "",
			),
			url: this.issueUrl(identifier),
			branchName: branchName(identifier, workItem.name),
			assigneeId,
			stateId: workItem.state ?? undefined,
			teamId: workItem.project,
			labelIds: workItem.labels ?? [],
			priority: PRIORITY_TO_NUMBER[workItem.priority ?? "none"] ?? 0,
			createdAt: new Date(workItem.created_at),
			updatedAt: new Date(workItem.updated_at),
			archivedAt: workItem.archived_at
				? new Date(workItem.archived_at)
				: undefined,
			get state() {
				return state ? Promise.resolve(toWorkflowState(state)) : undefined;
			},
			get assignee() {
				return assigneeId
					? service.fetchUser(assigneeId).catch(() => undefined)
					: undefined;
			},
			get team() {
				return Promise.resolve(service.toTeam(project));
			},
			get parent() {
				return workItem.parent
					? service.fetchIssue(workItem.parent).catch(() => undefined)
					: undefined;
			},
			get project() {
				return Promise.resolve({ id: project.id, name: project.name });
			},
			labels: async () => {
				const labels = await service.labels(workItem.project);
				const ids = new Set(workItem.labels ?? []);
				return { nodes: labels.filter((l) => ids.has(l.id)).map(toLabel) };
			},
			comments: () => service.fetchComments(workItem.id),
			attachments: () => Promise.resolve({ nodes: [] }),
			children: () => Promise.resolve({ nodes: [] }),
			inverseRelations: () => Promise.resolve({ nodes: [] }),
			update: async (input?: IssueUpdateInput) => {
				const updated = await service.updateIssue(workItem.id, input ?? {});
				return {
					success: true,
					issue: Promise.resolve(updated),
					lastSyncId: 0,
				};
			},
		};
		return issue as unknown as Issue;
	}

	private toComment(comment: PlaneComment, workItem: PlaneWorkItem): Comment {
		const service = this;
		const result = {
			id: comment.id,
			body: htmlToText(comment.comment_html ?? comment.comment_stripped ?? ""),
			createdAt: new Date(comment.created_at),
			updatedAt: new Date(comment.updated_at),
			get user() {
				return comment.actor
					? service.fetchUser(comment.actor).catch(() => undefined)
					: undefined;
			},
			get parent() {
				return comment.parent
					? service.fetchComment(comment.parent).catch(() => undefined)
					: undefined;
			},
			get issue() {
				return service.toIssue(workItem);
			},
			children: () => Promise.resolve({ nodes: [] }),
		};
		return result as unknown as Comment;
	}

	private toTeam(project: PlaneProject): Team {
		const team = {
			id: project.id,
			name: project.name,
			key: project.identifier,
			description: project.description,
			color: undefined,
			displayName: project.name,
			states: async () => ({
				nodes: (await this.states(project.id)).map(toWorkflowState),
			}),
			members: async () => ({
				nodes: (await this.members()).map(toUser),
			}),
		};
		return team as unknown as Team;
	}

	private project(projectId: string): Promise<PlaneProject> {
		return this.cached(`project:${projectId}`, () =>
			this.api.getProject(projectId),
		);
	}

	private states(projectId: string): Promise<PlaneState[]> {
		return this.cached(`states:${projectId}`, () =>
			this.api.listStates(projectId),
		);
	}

	private labels(projectId: string): Promise<PlaneLabel[]> {
		return this.cached(`labels:${projectId}`, () =>
			this.api.listLabels(projectId),
		);
	}

	private members(): Promise<PlaneMember[]> {
		return this.cached("members", () => this.api.listMembers());
	}

	private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
		const hit = this.cache.get(key);
		if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
			return hit.value as T;
		}
		const value = await load();
		this.cache.set(key, { at: Date.now(), value });
		return value;
	}
}

/** Linear-shaped activity input → Plane run activity. Exported for tests. */
export function toPlaneActivity(
	input: AgentActivityCreateInput,
): PlaneCreateActivityRequest {
	const content = input.content as {
		type: string;
		body?: string;
		action?: string;
		parameter?: unknown;
		result?: unknown;
	};
	const request: PlaneCreateActivityRequest =
		content.type === "action"
			? {
					type: "action",
					content: {
						type: "action",
						action: content.action ?? "action",
						// Plane only accepts string values here.
						parameters: {
							...(content.parameter !== undefined && {
								parameter: stringify(content.parameter),
							}),
							...(content.result !== undefined &&
								content.result !== null && {
									result: stringify(content.result),
								}),
						},
					},
				}
			: {
					type: toPlaneType(content.type),
					content: {
						type: toPlaneType(content.type),
						body: toPlaneBody(toPlaneType(content.type), content.body ?? ""),
					},
				};

	const signal = input.signal ? SIGNALS[String(input.signal)] : undefined;
	if (signal) {
		request.signal = signal;
	}
	const metadata = input.signalMetadata as
		| { options?: Array<{ value: string; label?: string }>; url?: string }
		| undefined;
	if (metadata) {
		request.signal_metadata =
			signal === "select" && metadata.options
				? {
						options: metadata.options.map((o) => ({
							id: o.value,
							label: o.label ?? o.value,
						})),
					}
				: (metadata as Record<string, unknown>);
	}
	return request;
}

/**
 * Responses, questions and errors become comments in the run's thread. Plane
 * renders a body that starts with "<" as HTML and escapes anything else, so
 * the agent's Markdown is converted. Thoughts stay plain text (they are not
 * kept as comments).
 */
function toPlaneBody(
	type: Exclude<PlaneCreateActivityRequest["type"], "action">,
	body: string,
): string {
	return type === "thought" ? body : markdownToHtml(body);
}

function toPlaneType(
	type: string,
): Exclude<PlaneCreateActivityRequest["type"], "action"> {
	switch (type) {
		case "response":
		case "elicitation":
		case "error":
		case "thought":
			return type;
		default:
			// "prompt" is user-only in Plane; anything unknown is shown as a thought.
			return "thought";
	}
}

function stringify(value: unknown): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
}

function toWorkflowState(state: PlaneState): WorkflowState {
	return {
		id: state.id,
		name: state.name,
		type: STATE_TYPES[state.group] ?? "unstarted",
		description: state.description,
		color: state.color ?? "#999999",
		position: state.sequence ?? 0,
	} as unknown as WorkflowState;
}

function toLabel(label: PlaneLabel): Label {
	return {
		id: label.id,
		name: label.name,
		description: label.description,
		color: label.color ?? "#999999",
	} as unknown as Label;
}

function toUser(member: PlaneMember): User {
	const name =
		[member.first_name, member.last_name].filter(Boolean).join(" ") ||
		member.display_name ||
		member.email ||
		member.id;
	return {
		id: member.id,
		name,
		displayName: member.display_name ?? name,
		email: member.email ?? "",
		gitHubUserId: undefined,
		url: "",
	} as unknown as User;
}

/** e.g. "web-12-fix-login-on-mobile", like Linear's branch names. */
export function branchName(identifier: string, title: string): string {
	const slug = title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 50)
		.replace(/-+$/, "");
	return slug
		? `${identifier.toLowerCase()}-${slug}`
		: identifier.toLowerCase();
}
