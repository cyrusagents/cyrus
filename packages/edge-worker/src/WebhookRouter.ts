import {
	type AgentSessionCreatedWebhook,
	type AgentSessionPromptedWebhook,
	createLogger,
	type ILogger,
	type InternalMessage,
	type IssueStateChangeMessage,
	type IssueUnassignedWebhook,
	type IssueUpdateWebhook,
	isAgentSessionCreatedWebhook,
	isAgentSessionPromptedWebhook,
	isContentUpdateMessage,
	isIssueAssignedWebhook,
	isIssueCommentMentionWebhook,
	isIssueDeletedWebhook,
	isIssueNewCommentWebhook,
	isIssueStateChangeMessage,
	isIssueStateChangeWebhook,
	isIssueStateIdUpdateWebhook,
	isIssueTitleOrDescriptionUpdateWebhook,
	isIssueUnassignedWebhook,
	isSessionStartMessage,
	isStopSignalMessage,
	isUnassignMessage,
	isUserPromptMessage,
	type RepositoryConfig,
	type Webhook,
} from "cyrus-core";
import type {
	GitHubCommentWebhookEvent,
	GitHubPushPayload,
	GitHubWebhookEvent,
} from "cyrus-github-event-transport";
import type { AskUserQuestionHandler } from "./AskUserQuestionHandler.js";
import type { RepositoryRouter } from "./RepositoryRouter.js";

/**
 * Result of a user-access check for a webhook.
 */
export type WebhookAccessResult =
	| { allowed: true }
	| { allowed: false; reason: string; userName: string };

/**
 * Result of a blocked-by-dependency check for an agent session.
 */
export interface BlockedByDependenciesResult {
	blocked: boolean;
	blockingIssueIds: string[];
	blockingIdentifiers: string[];
}

/**
 * Options carried alongside a routed agentSessionCreated decision.
 */
export interface RoutedSessionOptions {
	baseBranchOverrides?: Map<string, string>;
	routingMethod?: string;
}

/**
 * Injected seam for WebhookRouter. Every terminal effect is delegated back
 * through one of these callbacks. For Phase F the callbacks bind to the
 * existing (unchanged) EdgeWorker handler bodies; later phases re-point them
 * to SessionOrchestrator / ParkedSessionRegistry without changing the router.
 *
 * IMPORTANT: callbacks that wrap EdgeWorker methods MUST bind to the heavy-body
 * methods (initializeAgentRunner / startSession / handleNormalPromptedActivity /
 * handleStopSignal / handleGitHubWebhook / ...), NOT to the thin delegator
 * methods that forward into this router — binding a delegator would loop
 * through the router forever.
 */
export interface WebhookRouterDeps {
	/** Repository routing + selection state (pending-selection flag, routing, elicitation). */
	repositoryRouter: RepositoryRouter;
	/** Pending-question gate for the AskUserQuestion branch. */
	askUserQuestionHandler: AskUserQuestionHandler;

	/** Whether an issue currently has a parked (blocked-by) session. */
	isParked: (issueId: string) => boolean;

	/** Cached repositories for an issue (agentSessionPrompted Branch 3). */
	getCachedRepositories: (issueId: string) => RepositoryConfig[] | null;
	/** Recover the repository for an existing session (session-map fallback). */
	getRepositoryForSession: (agentSessionId: string) => RepositoryConfig | null;
	/** Persist the issue -> repository-id cache mapping. */
	cacheIssueRepositories: (issueId: string, repoIds: string[]) => void;
	/** All configured repositories (used for fallback re-routing). */
	allRepositories: () => RepositoryConfig[];
	/** Post the "session configuration was lost" response activity. */
	postSessionLostResponse: (agentSessionId: string) => Promise<void>;

	/** Access-control check for the webhook's creator against a repository. */
	checkUserAccess: (
		webhook: AgentSessionCreatedWebhook | AgentSessionPromptedWebhook,
		repository: RepositoryConfig,
	) => WebhookAccessResult;
	/** Handle a blocked user (posts response / ends session per config). */
	handleBlockedUser: (
		webhook: AgentSessionCreatedWebhook | AgentSessionPromptedWebhook,
		repository: RepositoryConfig,
		reason: string,
	) => Promise<void>;

	/** Check whether an agent session is blocked by dependency issues. */
	checkBlockedByDependencies: (
		agentSession: AgentSessionCreatedWebhook["agentSession"],
		linearWorkspaceId: string,
	) => Promise<BlockedByDependenciesResult>;
	/** Park a session behind blocking dependencies (no runner created). */
	parkSession: (
		webhook: AgentSessionCreatedWebhook,
		repositories: RepositoryConfig[],
		blockingIssueIds: string[],
		blockingIdentifiers: string[],
		opts: RoutedSessionOptions,
	) => Promise<void>;
	/** Start a new session (delegates to SessionOrchestrator today). */
	startSession: (
		webhook: AgentSessionCreatedWebhook,
		repositories: RepositoryConfig[],
		opts: RoutedSessionOptions,
	) => Promise<void>;

	/** Continue an existing session with a new prompt (Branch 3 terminal). */
	continuePromptedActivity: (
		webhook: AgentSessionPromptedWebhook,
		repositories: RepositoryConfig[],
	) => Promise<void>;
	/** Terminate the session(s) for a stop signal. */
	stopSession: (webhook: AgentSessionPromptedWebhook) => Promise<void>;
	/** Re-check a parked session on re-prompt (wakes if unblocked). */
	handleParkedReprompt: (
		webhook: AgentSessionPromptedWebhook,
		issueId: string,
	) => Promise<void>;
	/** Handle a repository-selection response (Branch 2). */
	handleRepositorySelection: (
		webhook: AgentSessionPromptedWebhook,
	) => Promise<void>;
	/** Handle an AskUserQuestion response (Branch 2.5). */
	handleAskUserQuestion: (
		webhook: AgentSessionPromptedWebhook,
	) => Promise<void>;

	/** Issue unassignment. */
	handleUnassigned: (webhook: IssueUnassignedWebhook) => Promise<void>;
	/** Issue title/description/attachments update. */
	handleContentUpdate: (webhook: IssueUpdateWebhook) => Promise<void>;
	/** Issue state-id update (parked-session wake path). */
	handleStateChange: (webhook: IssueUpdateWebhook) => Promise<void>;

	/** GitHub comment/review event. */
	handleGitHubComment: (event: GitHubCommentWebhookEvent) => Promise<void>;
	/** GitHub push event. */
	handleGitHubPush: (payload: GitHubPushPayload) => Promise<void>;

	/** Issue reached a terminal state (message-bus terminal cleanup). */
	handleIssueTerminal: (message: IssueStateChangeMessage) => Promise<void>;
}

/**
 * Bare-text stop request. Kept identical to the historical EdgeWorker regex so
 * a plain "stop" / "stop session" / "stop working" comment aborts the session.
 */
const TEXT_STOP_REQUEST = /^\s*stop(\s+session|\s+working)?[\s.!?]*$/i;

/**
 * Cap on remembered prompted-activity delivery keys, and how many of the
 * oldest keys to drop once the cap is exceeded. Mirrors the bounds used by
 * EdgeWorker's `processedIssueUpdateKeys`.
 */
const PROMPTED_DELIVERY_KEY_LIMIT = 500;
const PROMPTED_DELIVERY_KEY_PRUNE_COUNT = 250;

/**
 * WebhookRouter owns webhook/message dispatch and the agentSession
 * branch-selection state machine. It makes only routing decisions (mandated by
 * packages/CLAUDE.md's webhook constraints) and delegates every terminal effect
 * through {@link WebhookRouterDeps}. It holds no session state and no config,
 * performs no I/O of its own, and keeps only delivery-dedup bookkeeping (see
 * {@link WebhookRouter.isDuplicatePromptedDelivery}).
 *
 * Extracted from EdgeWorker's inlined routing tables (handleWebhook,
 * handleMessage, the GitHub transport listener, and the branch prologues of
 * handleUserPromptedAgentActivity + handleAgentSessionCreatedWebhook).
 */
export class WebhookRouter {
	private logger: ILogger;

	/**
	 * Delivery keys of prompted activities already routed. Linear redelivers a
	 * webhook when the ack is slow, and a redelivered prompt used to start a
	 * second agent process for the same comment — each one re-writing the whole
	 * conversation to the prompt cache. Keyed on the activity id, which is
	 * stable across redeliveries of one activity and distinct between genuine
	 * user prompts (so real re-prompts and double-stops still get through).
	 */
	private processedPromptedActivityKeys = new Set<string>();

	/**
	 * agentSession ids of created webhooks already routed. Linear's at-least-once
	 * delivery redelivers an `agentSessionCreated` webhook when the ack is slow,
	 * and each delivery used to call {@link WebhookRouterDeps.startSession}
	 * unconditionally — building a second runner that reused the worktree and
	 * overwrote the runner map entry while the first subprocess kept streaming
	 * (two runners → two runs → two answers). Keyed on agentSession.id, which is
	 * 1:1 with a creation event and stable across its redeliveries (a genuine
	 * additional @mention session gets a distinct id, so it still routes).
	 * Released on throw so a genuinely failed start can be retried by redelivery.
	 */
	private processedCreatedSessionKeys = new Set<string>();

	constructor(
		private deps: WebhookRouterDeps,
		logger?: ILogger,
	) {
		this.logger = logger ?? createLogger({ component: "WebhookRouter" });
	}

	/**
	 * True when this prompted activity has already been routed. Records the key
	 * as a side effect, so callers must only ask once per delivery.
	 *
	 * Applies to every prompted branch, not just normal continuation: a
	 * redelivered `stop` activity would otherwise look like the intentional
	 * second stop that EdgeWorker escalates into a hard kill.
	 */
	private isDuplicatePromptedDelivery(
		webhook: AgentSessionPromptedWebhook,
	): boolean {
		const activityId = webhook.agentActivity?.id;
		// Fall back to the same `${createdAt}:${entityId}` shape EdgeWorker uses
		// for issue updates; a redelivery repeats both halves.
		const key = activityId ?? `${webhook.createdAt}:${webhook.agentSession.id}`;

		if (this.processedPromptedActivityKeys.has(key)) {
			this.logger.debug(
				`Duplicate prompted activity delivery (key=${key}), skipping`,
			);
			return true;
		}
		this.processedPromptedActivityKeys.add(key);

		// Prevent unbounded growth — prune the oldest keys when the set gets large.
		if (this.processedPromptedActivityKeys.size > PROMPTED_DELIVERY_KEY_LIMIT) {
			const keys = [...this.processedPromptedActivityKeys];
			for (const stale of keys.slice(0, PROMPTED_DELIVERY_KEY_PRUNE_COUNT)) {
				this.processedPromptedActivityKeys.delete(stale);
			}
		}

		return false;
	}

	/**
	 * Stable dedup key for a created webhook. agentSession.id is 1:1 with the
	 * creation event; fall back to the `${createdAt}:${issueId}` shape used
	 * elsewhere when it is somehow absent.
	 */
	private createdDeliveryKey(webhook: AgentSessionCreatedWebhook): string {
		return (
			webhook.agentSession?.id ??
			`${webhook.createdAt}:${webhook.agentSession?.issue?.id}`
		);
	}

	/**
	 * True when this created webhook has already been routed. Records the key as
	 * a side effect (so callers must ask only once per delivery), guarding every
	 * created branch — needs_selection and start alike — against redelivery.
	 */
	private isDuplicateCreatedDelivery(
		webhook: AgentSessionCreatedWebhook,
	): boolean {
		const key = this.createdDeliveryKey(webhook);

		if (this.processedCreatedSessionKeys.has(key)) {
			this.logger.debug(
				`Duplicate created webhook delivery (key=${key}), skipping`,
			);
			return true;
		}
		this.processedCreatedSessionKeys.add(key);

		// Prevent unbounded growth — prune the oldest keys when the set gets large.
		if (this.processedCreatedSessionKeys.size > PROMPTED_DELIVERY_KEY_LIMIT) {
			const keys = [...this.processedCreatedSessionKeys];
			for (const stale of keys.slice(0, PROMPTED_DELIVERY_KEY_PRUNE_COUNT)) {
				this.processedCreatedSessionKeys.delete(stale);
			}
		}

		return false;
	}

	/**
	 * Release a created dedup key so Linear's redelivery can retry a start that
	 * threw. Called only on error — successful and early-return branches keep the
	 * key so redeliveries stay suppressed.
	 */
	private forgetCreatedDelivery(webhook: AgentSessionCreatedWebhook): void {
		this.processedCreatedSessionKeys.delete(this.createdDeliveryKey(webhook));
	}

	/**
	 * Route a Linear webhook to the correct handler. Mirrors the historical
	 * EdgeWorker.handleWebhook if/else table. The caller (EdgeWorker.handleWebhook)
	 * keeps the activeWebhookCount + try/catch shell around this call.
	 */
	async dispatch(webhook: Webhook, repos: RepositoryConfig[]): Promise<void> {
		// NOTE: Traditional webhooks (assigned, comment) are disabled in favor of
		// agent session events.
		if (isIssueAssignedWebhook(webhook)) {
			return;
		} else if (isIssueCommentMentionWebhook(webhook)) {
			return;
		} else if (isIssueNewCommentWebhook(webhook)) {
			return;
		} else if (isIssueUnassignedWebhook(webhook)) {
			await this.deps.handleUnassigned(webhook);
		} else if (isAgentSessionCreatedWebhook(webhook)) {
			await this.routeCreatedWebhook(webhook, repos);
		} else if (isAgentSessionPromptedWebhook(webhook)) {
			await this.routePromptedActivity(webhook);
		} else if (isIssueStateChangeWebhook(webhook)) {
			// State changes are handled exclusively via the message bus
			// (dispatchMessage -> handleIssueTerminal), not this legacy path.
			return;
		} else if (isIssueDeletedWebhook(webhook)) {
			// Issue deletion is also handled via the message bus.
			return;
		} else if (isIssueTitleOrDescriptionUpdateWebhook(webhook)) {
			await this.deps.handleContentUpdate(webhook);
		} else if (isIssueStateIdUpdateWebhook(webhook)) {
			await this.deps.handleStateChange(webhook);
		} else {
			if (process.env.CYRUS_WEBHOOK_DEBUG === "true") {
				this.logger.debug(
					`Unhandled webhook type: ${(webhook as { action?: string }).action}`,
				);
			}
		}
	}

	/**
	 * agentSessionCreated: cache -> route -> none|needs_selection|selected ->
	 * access -> blocked-by -> park|start.
	 *
	 * Per packages/CLAUDE.md: when routing yields needs_selection we MUST post a
	 * select signal and NOT initialize a runner (the runner waits for the
	 * subsequent agentSessionPrompted webhook).
	 */
	async routeCreatedWebhook(
		webhook: AgentSessionCreatedWebhook,
		repos: RepositoryConfig[],
	): Promise<void> {
		// Drop redelivered creation events before any branch can start a second
		// runner for the same agentSession (see processedCreatedSessionKeys).
		if (this.isDuplicateCreatedDelivery(webhook)) {
			return;
		}

		try {
			await this.routeCreatedWebhookInner(webhook, repos);
		} catch (error) {
			this.forgetCreatedDelivery(webhook);
			throw error;
		}
	}

	private async routeCreatedWebhookInner(
		webhook: AgentSessionCreatedWebhook,
		repos: RepositoryConfig[],
	): Promise<void> {
		const issueId = webhook.agentSession?.issue?.id;

		// Check the cache first — an @mention on an issue that already has a
		// session must reuse the existing repository (no repo switching).
		let repositories: RepositoryConfig[] | null = null;
		let baseBranchOverrides: Map<string, string> | undefined;
		let routingMethod: string | undefined;
		if (issueId) {
			const cachedRepos = this.deps.getCachedRepositories(issueId);
			if (cachedRepos && cachedRepos.length > 0) {
				repositories = cachedRepos;
				this.logger.debug(
					`Using cached repositories [${cachedRepos
						.map((r) => r.name)
						.join(", ")}] for issue ${issueId}`,
				);
			}
		}

		// If not cached, perform routing logic.
		if (!repositories) {
			const routingResult =
				await this.deps.repositoryRouter.determineRepositoryForWebhook(
					webhook,
					repos,
				);

			if (routingResult.type === "none") {
				if (process.env.CYRUS_WEBHOOK_DEBUG === "true") {
					this.logger.info(
						`No repository configured for webhook from workspace ${webhook.organizationId}`,
					);
				}
				return;
			}

			// needs_selection: post a select signal and wait — do NOT start a runner.
			if (routingResult.type === "needs_selection") {
				await this.deps.repositoryRouter.elicitUserRepositorySelection(
					webhook,
					routingResult.workspaceRepos,
				);
				return;
			}

			// routingResult.type === "selected"
			repositories = routingResult.repositories;
			baseBranchOverrides = routingResult.baseBranchOverrides;
			if (baseBranchOverrides && baseBranchOverrides.size > 0) {
				this.logger.info(
					`baseBranchOverrides received from routing: ${Array.from(
						baseBranchOverrides.entries(),
					)
						.map(([id, branch]) => `${id}→${branch}`)
						.join(", ")}`,
				);
			} else {
				this.logger.info(`No baseBranchOverrides from routing result`);
			}
			routingMethod = routingResult.routingMethod;

			// Cache all matched repositories for this issue.
			if (issueId) {
				this.deps.cacheIssueRepositories(
					issueId,
					repositories.map((r) => r.id),
				);
			}
		}

		if (!webhook.agentSession.issue) {
			this.logger.warn("Agent session created webhook missing issue");
			return;
		}

		// User access control check (use primary repo).
		const primaryRepo = repositories[0]!;
		const accessResult = this.deps.checkUserAccess(webhook, primaryRepo);
		if (!accessResult.allowed) {
			this.logger.info(
				`User ${accessResult.userName} blocked from delegating: ${accessResult.reason}`,
			);
			await this.deps.handleBlockedUser(
				webhook,
				primaryRepo,
				accessResult.reason,
			);
			return;
		}

		const linearWorkspaceId = webhook.organizationId;
		this.logger.info(
			`Handling agentSessionCreated for issue ${webhook.agentSession.issue.identifier}`,
		);

		// Check for blocked-by dependencies before starting work.
		const blockResult = await this.deps.checkBlockedByDependencies(
			webhook.agentSession,
			linearWorkspaceId,
		);
		if (blockResult.blocked) {
			await this.deps.parkSession(
				webhook,
				repositories,
				blockResult.blockingIssueIds,
				blockResult.blockingIdentifiers,
				{ baseBranchOverrides, routingMethod },
			);
			return;
		}

		await this.deps.startSession(webhook, repositories, {
			baseBranchOverrides,
			routingMethod,
		});
	}

	/**
	 * agentSessionPrompted: 5-way branch selection.
	 *
	 * Precedence (per packages/CLAUDE.md) — MUST be preserved exactly:
	 *   0. duplicate delivery guard (redelivered activities are dropped)
	 *   1. stop signal (evaluated BEFORE any repository lookup; session must exist)
	 *   1.5 parked re-prompt (re-check blockers, wake if resolved)
	 *   2. pending repository selection
	 *   2.5 pending AskUserQuestion
	 *   3. normal continuation (cache lookup + fallback ladder; no new routing)
	 */
	async routePromptedActivity(
		webhook: AgentSessionPromptedWebhook,
	): Promise<void> {
		// Branch 0: drop redelivered activities before any branch can act on them.
		if (this.isDuplicatePromptedDelivery(webhook)) {
			return;
		}

		const agentSessionId = webhook.agentSession.id;
		const activityBody = webhook.agentActivity?.content?.body || "";
		const signal = (webhook.agentActivity as { signal?: string } | undefined)
			?.signal;
		const isTextStopRequest = TEXT_STOP_REQUEST.test(activityBody);

		// Branch 1: stop signal — checked FIRST, no repository lookup.
		if (signal === "stop" || isTextStopRequest) {
			await this.deps.stopSession(webhook);
			return;
		}

		// Branch 1.5: parked (blocked-by) re-prompt.
		const issueIdForParkedCheck = webhook.agentSession?.issue?.id;
		if (issueIdForParkedCheck && this.deps.isParked(issueIdForParkedCheck)) {
			await this.deps.handleParkedReprompt(webhook, issueIdForParkedCheck);
			return;
		}

		// Branch 2: repository selection response.
		if (this.deps.repositoryRouter.hasPendingSelection(agentSessionId)) {
			await this.deps.handleRepositorySelection(webhook);
			return;
		}

		// Branch 2.5: AskUserQuestion response.
		if (this.deps.askUserQuestionHandler.hasPendingQuestion(agentSessionId)) {
			await this.deps.handleAskUserQuestion(webhook);
			return;
		}

		// Branch 3: normal continuation — cache lookup + fallback, no new routing.
		const issueId = webhook.agentSession?.issue?.id;
		if (!issueId) {
			this.logger.error(
				`No issue ID found in prompted webhook ${agentSessionId}`,
			);
			return;
		}

		let repositories = this.deps.getCachedRepositories(issueId);
		if (!repositories || repositories.length === 0) {
			this.logger.info(
				`No cached repository for prompted webhook ${agentSessionId}, attempting fallback resolution`,
			);

			// Fallback 1: recover repository from an existing session.
			const recovered = this.deps.getRepositoryForSession(agentSessionId);
			if (recovered) {
				repositories = [recovered];
				this.deps.cacheIssueRepositories(issueId, [recovered.id]);
				this.logger.info(
					`Recovered repository ${recovered.id} for issue ${issueId} from session manager`,
				);
			}

			// Fallback 2: re-route via the repository router.
			if (!repositories || repositories.length === 0) {
				try {
					const repos = this.deps.allRepositories();
					const routingResult =
						await this.deps.repositoryRouter.determineRepositoryForWebhook(
							webhook,
							repos,
						);

					if (routingResult.type === "selected") {
						repositories = routingResult.repositories;
						this.deps.cacheIssueRepositories(
							issueId,
							routingResult.repositories.map((r) => r.id),
						);
						this.logger.info(
							`Recovered repositories [${repositories
								.map((r) => r.name)
								.join(", ")}] for issue ${issueId} via fallback routing (${
								routingResult.routingMethod
							})`,
						);
					}
				} catch (error) {
					this.logger.warn(
						`Fallback repository routing failed for prompted webhook ${agentSessionId}`,
						error,
					);
				}
			}

			if (!repositories || repositories.length === 0) {
				// All recovery attempts failed — post visible feedback.
				await this.deps.postSessionLostResponse(agentSessionId);
				this.logger.warn(
					`Failed to recover repository for prompted webhook ${agentSessionId} - all fallback methods exhausted`,
				);
				return;
			}
		}

		// User access control check for mid-session prompts (use primary repo).
		const primaryRepo = repositories[0]!;
		const accessResult = this.deps.checkUserAccess(webhook, primaryRepo);
		if (!accessResult.allowed) {
			this.logger.info(
				`User ${accessResult.userName} blocked from prompting: ${accessResult.reason}`,
			);
			await this.deps.handleBlockedUser(
				webhook,
				primaryRepo,
				accessResult.reason,
			);
			return;
		}

		await this.deps.continuePromptedActivity(webhook, repositories);
	}

	/**
	 * GitHub transport fan-out: push -> push handler, everything else -> comment
	 * handler. The caller keeps the fire-and-forget `.catch` semantics; the
	 * comment handler owns its own activeWebhookCount shell.
	 */
	async dispatchGitHubEvent(event: GitHubWebhookEvent): Promise<void> {
		if (event.eventType === "push") {
			await this.deps.handleGitHubPush(event.payload as GitHubPushPayload);
			return;
		}
		await this.deps.handleGitHubComment(event as GitHubCommentWebhookEvent);
	}

	/**
	 * Internal message-bus routing. Only IssueStateChangeMessage has real
	 * behavior today; the other message types are near-no-op debug traces that
	 * run in parallel with the legacy webhook handlers (which already processed
	 * the underlying event), so they MUST NOT trigger any side effects here.
	 */
	async dispatchMessage(message: InternalMessage): Promise<void> {
		if (isSessionStartMessage(message)) {
			this.logger.debug(
				`[MessageBus] Session start: ${message.workItemIdentifier} from ${message.source}`,
			);
		} else if (isUserPromptMessage(message)) {
			this.logger.debug(
				`[MessageBus] User prompt: ${message.workItemIdentifier} from ${message.source}`,
			);
		} else if (isStopSignalMessage(message)) {
			this.logger.debug(
				`[MessageBus] Stop signal: ${message.workItemIdentifier} from ${message.source}`,
			);
		} else if (isContentUpdateMessage(message)) {
			this.logger.debug(
				`[MessageBus] Content update: ${message.workItemIdentifier} from ${message.source}`,
			);
		} else if (isUnassignMessage(message)) {
			this.logger.debug(
				`[MessageBus] Unassign: ${message.workItemIdentifier} from ${message.source}`,
			);
		} else if (isIssueStateChangeMessage(message)) {
			await this.deps.handleIssueTerminal(message);
		} else {
			if (process.env.CYRUS_WEBHOOK_DEBUG === "true") {
				this.logger.debug(
					`Unhandled message action: ${(message as InternalMessage).action}`,
				);
			}
		}
	}
}
