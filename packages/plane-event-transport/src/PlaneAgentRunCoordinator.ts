import { createLogger, type ILogger, type Issue } from "cyrus-core";
import type { PlaneIssueTrackerService } from "./PlaneIssueTrackerService.js";
import { htmlToText } from "./PlaneText.js";
import type {
	PlaneAgentRunCreatedPayload,
	PlaneAgentRunPromptedPayload,
	PlaneAgentWebhookPayload,
} from "./types.js";

/** Linear-shaped AgentSessionEvent webhook, as the edge worker consumes it. */
export type LinearShapedAgentSessionWebhook = Record<string, unknown> & {
	type: "AgentSessionEvent";
	action: "created" | "prompted";
	organizationId: string;
};

export interface PlaneAgentRunCoordinatorDeps {
	tracker: PlaneIssueTrackerService;
	/** True if Cyrus already has a session (or a pending question) for this run id. */
	isKnownSession: (runId: string) => boolean;
	/** Hand the Linear-shaped webhook to the edge worker. */
	dispatch: (webhook: LinearShapedAgentSessionWebhook) => Promise<void> | void;
	logger?: ILogger;
}

interface RunState {
	/** False until the run's starting prompt has arrived (it is not a follow-up). */
	initialPromptSeen: boolean;
}

/**
 * Turns Plane agent-run webhooks into the AgentSessionEvent webhooks the edge
 * worker already handles for Linear.
 *
 * Plane starts every run with two webhooks: `agent_run_create` (no text) and
 * `agent_run_user_prompt` carrying the starting prompt. Either can arrive
 * first. The first one seen for a run becomes `created`; the run's first
 * prompt is never a follow-up, so it is dropped once the session exists.
 * Every later prompt becomes `prompted` (follow-ups, replies to questions,
 * and stop signals).
 *
 * A mention starts a conversational session on the mention comment, like a
 * Linear @mention. Any other trigger (assignment) is a delegation: the session
 * gets no comment, so Cyrus works the whole work item. Plane's generated
 * assignment prompt ("Act on this work item ...") is not passed on.
 *
 * Events for the same run are handled one at a time, in arrival order.
 */
export class PlaneAgentRunCoordinator {
	private readonly runs = new Map<string, RunState>();
	private readonly queues = new Map<string, Promise<void>>();
	private readonly logger: ILogger;

	constructor(private readonly deps: PlaneAgentRunCoordinatorDeps) {
		this.logger =
			deps.logger ?? createLogger({ component: "PlaneAgentRunCoordinator" });
	}

	handle(payload: PlaneAgentWebhookPayload): Promise<void> {
		const runId = payload.agent_run.id;
		const previous = this.queues.get(runId) ?? Promise.resolve();
		const next = previous
			.then(() => this.process(payload))
			.catch((error) => {
				this.logger.error(
					`Plane run ${runId}: failed to handle webhook`,
					error,
				);
			});
		this.queues.set(runId, next);
		void next.finally(() => {
			if (this.queues.get(runId) === next) {
				this.queues.delete(runId);
			}
		});
		return next;
	}

	private async process(payload: PlaneAgentWebhookPayload): Promise<void> {
		const runId = payload.agent_run.id;
		const projectId = payload.agent_run.project ?? payload.project_id;
		const issueId = payload.agent_run.issue ?? payload.issue_id;
		if (!projectId || !issueId) {
			this.logger.warn(
				`Plane run ${runId} is not on a work item; Cyrus only handles work-item runs`,
			);
			return;
		}
		const known = this.runs.has(runId) || this.deps.isKnownSession(runId);
		const isMention = payload.agent_run.trigger_type === "mention";

		if (payload.type === "agent_run") {
			if (known) {
				return; // the starting prompt already started the session
			}
			const commentId =
				payload.agent_run.comment ?? payload.comment_id ?? undefined;
			this.deps.tracker.rememberWorkItem(issueId, projectId, commentId);
			this.runs.set(runId, { initialPromptSeen: false });
			const body =
				isMention && commentId ? await this.commentBody(commentId) : undefined;
			await this.dispatch(
				"created",
				payload,
				issueId,
				isMention ? { commentId, body } : {},
			);
			return;
		}

		const activity = payload.agent_run_activity;
		// Prompts are editor HTML (replies, chosen options) or plain text.
		const text = htmlToText(
			activity.content && "body" in activity.content
				? activity.content.body
				: "",
		);
		this.deps.tracker.rememberWorkItem(issueId, projectId, activity.comment);

		if (!known) {
			this.runs.set(runId, { initialPromptSeen: true });
			const commentId = activity.comment ?? payload.comment_id;
			await this.dispatch(
				"created",
				payload,
				issueId,
				isMention ? { commentId, body: text } : {},
			);
			return;
		}

		const run = this.runs.get(runId);
		if (run && !run.initialPromptSeen) {
			run.initialPromptSeen = true;
			return; // the starting prompt: the session already has it
		}
		await this.dispatch("prompted", payload, issueId, {
			commentId: activity.comment,
			body: text,
		});
	}

	private async commentBody(commentId: string): Promise<string | undefined> {
		try {
			return (await this.deps.tracker.fetchComment(commentId)).body;
		} catch (error) {
			this.logger.warn(`Could not read Plane comment ${commentId}`, error);
			return undefined;
		}
	}

	private async dispatch(
		action: "created" | "prompted",
		payload: PlaneAgentRunCreatedPayload | PlaneAgentRunPromptedPayload,
		issueId: string,
		comment: { commentId?: string | null; body?: string },
	): Promise<void> {
		const { tracker } = this.deps;
		const run = payload.agent_run;
		const issue: Issue = await tracker.fetchIssue(issueId);
		const team = await issue.team;
		const actorId =
			payload.type === "agent_run_activity"
				? (payload.agent_run_activity.actor ?? run.creator)
				: run.creator;
		const creator = actorId
			? await tracker.fetchUser(actorId).catch(() => undefined)
			: undefined;
		const now = new Date();
		const appUserId = payload.agent_user_id ?? run.agent_user ?? "plane-agent";

		const webhook: LinearShapedAgentSessionWebhook = {
			type: "AgentSessionEvent",
			action,
			organizationId: tracker.workspaceKey,
			oauthClientId: payload.app_client_id ?? "plane",
			appUserId,
			createdAt: now,
			guidance: [],
			agentSession: {
				id: run.id,
				appUserId,
				organizationId: tracker.workspaceKey,
				createdAt: run.started_at ?? now.toISOString(),
				updatedAt: now.toISOString(),
				status: "active",
				type: "issue",
				issueId: issue.id,
				issue: {
					id: issue.id,
					identifier: issue.identifier,
					title: issue.title,
					url: issue.url,
					teamId: team?.id,
					team: team
						? { id: team.id, key: team.key, name: team.name }
						: undefined,
				},
				...(action === "created" &&
					comment.body !== undefined && {
						comment: { id: comment.commentId ?? "", body: comment.body },
					}),
				...(creator && {
					creator: { id: creator.id, name: creator.name, email: creator.email },
				}),
			},
		};

		if (action === "prompted" && payload.type === "agent_run_activity") {
			const activity = payload.agent_run_activity;
			webhook.agentActivity = {
				id: activity.id,
				agentSessionId: run.id,
				createdAt: now.toISOString(),
				updatedAt: now.toISOString(),
				content: { type: "prompt", body: comment.body ?? "" },
				...(activity.signal === "stop" && { signal: "stop" }),
				...(comment.commentId && { sourceCommentId: comment.commentId }),
			};
		}

		this.logger.info(
			`Plane run ${run.id} on ${issue.identifier}: dispatching ${action}`,
		);
		await this.deps.dispatch(webhook);
	}
}
