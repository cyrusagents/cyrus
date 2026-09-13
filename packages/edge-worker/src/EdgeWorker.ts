import { AsyncLocalStorage } from "node:async_hooks";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { LinearClient } from "@linear/sdk";
import type {
	McpServerConfig,
	SDKMessage,
	SessionStore,
	WarmQuery,
} from "cyrus-claude-runner";
import {
	buildBaseSessionEnv,
	ClaudeRunner,
	HttpSessionStore,
	normalizeMcpHttpTransport,
	resolveSubprocessEnvScrub,
} from "cyrus-claude-runner";
import { getCyrusAppUrl } from "cyrus-cloudflare-tunnel-client";
import { CodexRunner } from "cyrus-codex-runner";
import { ConfigUpdater } from "cyrus-config-updater";
import type {
	AgentActivityCreateInput,
	AgentEvent,
	AgentRunnerConfig,
	AgentSessionCreatedWebhook,
	AgentSessionPromptedWebhook,
	BaseBranchResolution,
	ContentUpdateMessage,
	CyrusAgentSession,
	EdgeWorkerConfig,
	GuidanceRule,
	IAgentRunner,
	IIssueTrackerService,
	ILogger,
	InternalMessage,
	Issue,
	IssueMinimal,
	IssueStateChangeMessage,
	IssueUnassignedWebhook,
	IssueUpdateWebhook,
	LogSink,
	RepositoryConfig,
	RunnerType,
	SerializableEdgeWorkerState,
	SessionCreator,
	SessionStartMessage,
	StopSignalMessage,
	UnassignMessage,
	UserPromptMessage,
	Webhook,
	WebhookAgentSession,
	WebhookIssue,
} from "cyrus-core";
import {
	CLIIssueTrackerService,
	CLIRPCServer,
	CYRUS_EVENTS,
	createLogger,
	cyrusAttributes,
	DEFAULT_PROXY_URL,
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
	McpHealthRegistry,
	PersistenceManager,
	requireLinearWorkspaceId,
	resetGlobalLogSink,
	resolvePath,
	setGlobalLogSink,
	WebhookIpValidator,
} from "cyrus-core";
import { CursorRunner } from "cyrus-cursor-runner";
import { GeminiRunner } from "cyrus-gemini-runner";
import {
	extractCommentAuthor,
	extractCommentBody,
	extractCommentId,
	extractCommentUrl,
	extractPRBaseBranchRef,
	extractPRBranchRef,
	extractPRNumber,
	extractPRTitle,
	extractRepoFullName,
	extractRepoName,
	extractRepoOwner,
	extractSessionKey,
	GitHubAppTokenProvider,
	GitHubCommentService,
	type GitHubCommentWebhookEvent,
	GitHubEventTransport,
	type GitHubPushPayload,
	type GitHubWebhookEvent,
	isCommentOnPullRequest,
	isIssueCommentPayload,
	isPullRequestReviewCommentPayload,
	isPullRequestReviewPayload,
	stripMention,
} from "cyrus-github-event-transport";
import type { GitLabWebhookEvent } from "cyrus-gitlab-event-transport";
import {
	extractDiscussionId,
	extractSessionKey as extractGitLabSessionKey,
	extractMRBaseBranchRef,
	extractMRBranchRef,
	extractMRIid,
	extractMRTitle,
	extractNoteAuthor,
	extractNoteBody,
	extractNoteId,
	extractNoteUrl,
	extractProjectId,
	extractProjectPath,
	GitLabCommentService,
	GitLabEventTransport,
	isNoteOnMergeRequest,
	stripMention as stripGitLabMention,
} from "cyrus-gitlab-event-transport";
import {
	LinearEventTransport,
	LinearIssueTrackerService,
	type LinearOAuthConfig,
} from "cyrus-linear-event-transport";
import {
	type CyrusToolsOptions,
	createCyrusToolsServer,
	createFetchFailureModesClient,
	type FailureModesHttpClient,
	type ResolvedSession,
} from "cyrus-mcp-tools";
import { OpenCodeRunner } from "cyrus-opencode-runner";
import { buildResourceAttributes } from "cyrus-otel-logs";
import {
	isOtelTracingEnabled,
	type OtelTracingHandle,
	readOtelSampleRatio,
	startOtelTracing,
} from "cyrus-otel-traces";
import {
	RouterConnection,
	RouterIssueTrackerService,
	RouterLogForwarder,
	RouterSpanForwarder,
	WAIT_REASON_ELICITATION,
} from "cyrus-router-client";
import {
	SlackEventTransport,
	type SlackWebhookEvent,
} from "cyrus-slack-event-transport";
import { postTeardownComplete, toHttpBase } from "cyrus-workspace-sync";
import {
	ZulipEventTransport,
	type ZulipWebhookEvent,
} from "cyrus-zulip-event-transport";
import { Sessions, streamableHttp } from "fastify-mcp";
import { ActivityPoster } from "./ActivityPoster.js";
import { AgentSessionManager } from "./AgentSessionManager.js";
import { AskUserQuestionHandler } from "./AskUserQuestionHandler.js";
import { AttachmentService } from "./AttachmentService.js";
import type { ChatRepositoryProvider } from "./ChatRepositoryProvider.js";
import { LiveChatRepositoryProvider } from "./ChatRepositoryProvider.js";
import type { ChatSessionHandlerDeps } from "./ChatSessionHandler.js";
import { ChatSessionHandler } from "./ChatSessionHandler.js";
import { ConfigManager, type RepositoryChanges } from "./ConfigManager.js";
import { DefaultSkillsDeployer } from "./DefaultSkillsDeployer.js";
import { EgressProxy } from "./EgressProxy.js";
import { GitService } from "./GitService.js";
import { GlobalSessionRegistry } from "./GlobalSessionRegistry.js";
import { McpConfigService } from "./McpConfigService.js";
import { McpHealthMonitor } from "./McpHealthMonitor.js";
import { PromptBuilder } from "./PromptBuilder.js";
import type {
	IssueContextResult,
	PromptAssembly,
	PromptAssemblyInput,
	PromptComponent,
	PromptType,
} from "./prompt-assembly/types.js";
import {
	RepositoryRouter,
	type RepositoryRouterDeps,
} from "./RepositoryRouter.js";
import { capRunnerStarts, SessionSemaphore } from "./RunnerConcurrency.js";
import {
	RunnerConfigBuilder,
	resolveIssueMcpConfigPath,
} from "./RunnerConfigBuilder.js";
import { RunnerSelectionService } from "./RunnerSelectionService.js";
import { SharedApplicationServer } from "./SharedApplicationServer.js";
import {
	type SkillSessionContext,
	SkillsPluginResolver,
} from "./SkillsPluginResolver.js";
import { SlackChatAdapter } from "./SlackChatAdapter.js";
import type { IActivitySink } from "./sinks/IActivitySink.js";
import { LinearActivitySink } from "./sinks/LinearActivitySink.js";
import { TeardownCallbackQueue } from "./TeardownCallbackQueue.js";
import { ToolPermissionResolver } from "./ToolPermissionResolver.js";
import type { AgentSessionData, EdgeWorkerEvents } from "./types.js";
import { UserAccessControl } from "./UserAccessControl.js";
import { WipSnapshotReaper } from "./WipSnapshotReaper.js";
import { WorkspaceSyncService } from "./WorkspaceSyncService.js";
import { ZulipChatAdapter } from "./ZulipChatAdapter.js";

export declare interface EdgeWorker {
	on<K extends keyof EdgeWorkerEvents>(
		event: K,
		listener: EdgeWorkerEvents[K],
	): this;
	emit<K extends keyof EdgeWorkerEvents>(
		event: K,
		...args: Parameters<EdgeWorkerEvents[K]>
	): boolean;
}

type CyrusToolsMcpContext = {
	contextId?: string;
};

/**
 * How long `stop()` waits for buffered spans to flush.
 *
 * Deliberately short. The flush writes to the router WSS connection, which at
 * shutdown may already be closing, so the realistic failure is that it never
 * resolves. Losing a few seconds of spans is strictly better than a shutdown
 * that hangs until the platform escalates to SIGKILL — which loses them anyway
 * AND skips whatever cleanup was still queued behind it.
 */
const TRACING_SHUTDOWN_TIMEOUT_MS = 2_000;

/**
 * Unified edge worker that **orchestrates**
 *   capturing Linear webhooks,
 *   managing Claude Code processes, and
 *   processes results through to Linear Agent Activity Sessions
 */
export class EdgeWorker extends EventEmitter {
	/**
	 * A `/skill` command leading the user's comment, tolerating any number of
	 * `@mention`s ahead of it (Linear puts its own there) and accepting
	 * `plugin:skill` qualified names. Anchored, so a slash appearing mid-sentence
	 * is prose and not a command.
	 */
	private static readonly LEADING_SLASH_COMMAND =
		/^\s*(?:@[\w.-]+[ \t]+)*(\/[a-zA-Z][\w-]*(?::[a-zA-Z][\w-]*)?)(?=[ \t\n]|$)/;

	private config: EdgeWorkerConfig;
	private repositories: Map<string, RepositoryConfig> = new Map(); // repository 'id' (internal, stored in config.json) mapped to the full repo config
	private agentSessionManager: AgentSessionManager; // Single instance managing all agent sessions across repositories
	private activitySinks: Map<string, IActivitySink> = new Map(); // Maps Linear workspace ID to activity sink (one per workspace, mirrors issueTrackers)
	private sessionRepositories: Map<string, string> = new Map(); // Maps session ID to repository ID
	private lastStopTimeBySession: Map<string, number> = new Map(); // Maps session ID to timestamp of last stop signal (for double-stop detection)
	private warmInstances: Map<string, WarmQuery> = new Map(); // Pre-warmed Claude sessions keyed by agentSessionId
	private issueTrackers: Map<string, IIssueTrackerService> = new Map(); // one issue tracker per Linear workspace (keyed by linearWorkspaceId)
	private linearEventTransport: LinearEventTransport | null = null; // Single event transport for webhook delivery
	private gitHubEventTransport: GitHubEventTransport | null = null; // GitHub event transport for forwarded GitHub webhooks
	private gitHubAppTokenProvider: GitHubAppTokenProvider | null = null; // Self-hosted GitHub App token minting
	private gitLabEventTransport: GitLabEventTransport | null = null; // GitLab event transport for forwarded GitLab webhooks
	private slackEventTransport: SlackEventTransport | null = null;
	private zulipEventTransport: ZulipEventTransport | null = null;
	private zulipChatSessionHandler: ChatSessionHandler<ZulipWebhookEvent> | null =
		null;
	private chatSessionHandler: ChatSessionHandler<SlackWebhookEvent> | null =
		null;
	private gitHubCommentService: GitHubCommentService; // Service for posting comments back to GitHub PRs
	private gitLabCommentService: GitLabCommentService; // Service for posting comments back to GitLab MRs
	private cliRPCServer: CLIRPCServer | null = null; // CLI RPC server for CLI platform mode
	private routerConnection?: RouterConnection; // Shared device-side WebSocket connection to the Cyrus Router (router platform mode)
	/**
	 * A fully-wired router connection whose dial loop has not started yet.
	 * `initializeComponents` attaches the event listeners and parks the connection
	 * here; `start()` dials it only after interrupted-session reconciliation has
	 * finished, so no queued prompt can race a terminal signal.
	 */
	private pendingRouterDial?: RouterConnection;
	/**
	 * Ships this worker's own logs to the router (router platform mode). Held so
	 * `stop()` can uninstall it — after shutdown the connection is gone, and a
	 * sink still pointing at it would silently count every remaining line as
	 * dropped.
	 */
	private logForwarder?: RouterLogForwarder;
	private previousLogSink?: LogSink;
	/**
	 * The span pipeline, when trace export is on. Held so `stop()` can flush it —
	 * the batch processor buffers up to 5 seconds of spans, which is exactly the
	 * window that explains a shutdown.
	 */
	private tracing?: OtelTracingHandle;
	private workspaceSync?: WorkspaceSyncService; // Persistence-floor sync of WIP snapshots + state bundles to the router (router platform mode, opt-in via floorSync === true)
	private readonly wipSnapshotReaper: WipSnapshotReaper; // Deletes WIP snapshot refs at terminal teardown, and retries the ones whose deletion failed
	private teardownCallbacks?: TeardownCallbackQueue; // Durable, retrying "terminal cleanup is done" callback to the router (router platform mode)
	private configUpdater: ConfigUpdater | null = null; // Single config updater for configuration updates
	private persistenceManager: PersistenceManager;
	private sharedApplicationServer: SharedApplicationServer;
	private cyrusHome: string;
	private globalSessionRegistry: GlobalSessionRegistry; // Centralized session storage across all repositories
	private configPath?: string; // Path to config.json file
	/** @internal - Exposed for testing only */
	public repositoryRouter: RepositoryRouter; // Repository routing and selection
	private gitService: GitService;
	private activeWebhookCount = 0; // Track number of webhooks currently being processed
	// GitHub webhook handlers share a PR worktree, so only one may run per PR.
	private activeGitHubPrSessions = new Set<string>();
	private queuedGitHubPrEvents = new Map<string, GitHubCommentWebhookEvent[]>();
	/** Handler for AskUserQuestion tool invocations via Linear select signal */
	private askUserQuestionHandler: AskUserQuestionHandler;
	/** User access control for whitelisting/blacklisting Linear users */
	private userAccessControl: UserAccessControl;
	private logger: ILogger;
	// Extracted service modules
	private attachmentService: AttachmentService;
	private runnerSelectionService: RunnerSelectionService;
	/** Global cap on concurrently executing runner sessions (see maxConcurrentSessions). */
	private runnerSlots: SessionSemaphore;
	private toolPermissionResolver: ToolPermissionResolver;
	private mcpConfigService: McpConfigService;
	/**
	 * Single view of MCP connection health, shared by `McpConfigService` (which
	 * declares configured servers and records headless skips) and
	 * `McpHealthMonitor` (which probes and folds in per-session SDK statuses).
	 */
	private readonly mcpHealthRegistry = new McpHealthRegistry();
	private mcpHealthMonitor: McpHealthMonitor;
	private runnerConfigBuilder: RunnerConfigBuilder;
	private activityPoster: ActivityPoster;
	private configManager: ConfigManager;
	private promptBuilder: PromptBuilder;
	private defaultSkillsDeployer: DefaultSkillsDeployer;
	private skillsPluginResolver: SkillsPluginResolver;
	private readonly cyrusToolsMcpEndpoint = "/mcp/cyrus-tools";
	private cyrusToolsMcpRegistered = false;
	private cyrusToolsMcpRequestContext =
		new AsyncLocalStorage<CyrusToolsMcpContext>();
	private cyrusToolsMcpSessions = new Sessions<any>();
	/** Validates webhook source IPs against known provider allowlists */
	private webhookIpValidator: WebhookIpValidator;
	/** Egress proxy for sandbox network traffic filtering and header injection */
	private egressProxy: EgressProxy | null = null;
	/** Base SDK sandbox settings to pass to ClaudeRunner sessions (set when proxy starts) */
	private sdkSandboxSettings:
		| import("cyrus-claude-runner").SandboxSettings
		| null = null;
	/** CA cert path for MITM TLS termination (passed per-session env, not process.env) */
	private egressCaCertPath: string | null = null;
	/**
	 * Remote SessionStore that mirrors Claude SDK transcripts to the Cyrus
	 * hosted control plane. Enabled when all three of `CYRUS_APP_URL`,
	 * `CYRUS_API_KEY`, and `CYRUS_TEAM_ID` are set — used by any Claude
	 * runner spawned from this worker so transcripts survive ephemeral
	 * worktrees and are resumable from any host.
	 */
	private claudeSessionStore: SessionStore | null = null;
	/**
	 * Tracks recently processed issue-update webhook keys to prevent
	 * duplicate deliveries from Linear's at-least-once delivery.
	 * Key format: `${createdAt}:${issueId}`
	 */
	private processedIssueUpdateKeys = new Set<string>();

	/**
	 * Sessions parked due to blocked-by dependencies.
	 * Key: Linear issue ID (the blocked issue)
	 * Value: All data needed to replay initializeAgentRunner when unblocked
	 */
	private parkedSessions = new Map<
		string,
		{
			agentSession: AgentSessionCreatedWebhook["agentSession"];
			repositories: RepositoryConfig[];
			linearWorkspaceId: string;
			guidance?: AgentSessionCreatedWebhook["guidance"];
			commentBody?: string | null;
			baseBranchOverrides?: Map<string, string>;
			routingMethod?: string;
			blockingIssueIds: string[];
		}
	>();

	/**
	 * Resolve `~/` prefixes in path-bearing config fields that are otherwise
	 * passed verbatim to `fs.readFileSync` (which does not expand tildes).
	 * Repository-scoped paths are normalized separately in addNew /
	 * updateModified; this covers the platform-level MCP config lists that
	 * cyrus-hosted writes with literal `~/.cyrus/...` prefixes when
	 * generating self-host config.
	 */
	private static normalizeConfigPaths(
		config: EdgeWorkerConfig,
	): EdgeWorkerConfig {
		const resolveList = (paths: string[] | undefined): string[] | undefined =>
			paths ? paths.map(resolvePath) : undefined;
		return {
			...config,
			slackMcpConfigs: resolveList(config.slackMcpConfigs),
			zulipMcpConfigs: resolveList(config.zulipMcpConfigs),
			linearMcpConfigs: resolveList(config.linearMcpConfigs),
			githubMcpConfigs: resolveList(config.githubMcpConfigs),
		};
	}

	constructor(config: EdgeWorkerConfig) {
		super();
		this.config = EdgeWorker.normalizeConfigPaths(config);
		this.cyrusHome = config.cyrusHome;
		this.logger = createLogger({ component: "EdgeWorker" });
		this.persistenceManager = new PersistenceManager(
			join(this.cyrusHome, "state"),
		);

		// Mirror Claude SDK session transcripts to the hosted control plane
		// when CYRUS_API_KEY (proof of team ownership) and CYRUS_TEAM_ID
		// (which team the transcripts belong to) are configured. The
		// destination URL defaults to DEFAULT_CYRUS_APP_URL but can be
		// overridden via CYRUS_APP_URL for preview environments. If either
		// of the required vars is missing the store stays null and the SDK
		// falls back to local JSONL only. Operators can also opt out
		// explicitly by setting CYRUS_DISABLE_REMOTE_SESSION_STORE=1, which
		// keeps transcripts local even when the vars above are present.
		const sessionStoreBaseUrl = getCyrusAppUrl();
		const sessionStoreApiKey = process.env.CYRUS_API_KEY;
		const sessionStoreTeamId = process.env.CYRUS_TEAM_ID;
		const sessionStoreDisabled = this.isRemoteSessionStoreDisabled();
		if (!sessionStoreDisabled && sessionStoreApiKey && sessionStoreTeamId) {
			this.claudeSessionStore = new HttpSessionStore({
				baseUrl: sessionStoreBaseUrl,
				apiKey: sessionStoreApiKey,
				teamId: sessionStoreTeamId,
				logger: this.logger,
			});
			this.logger.info(
				`[SessionStore] Mirroring Claude sessions to ${sessionStoreBaseUrl} for team ${sessionStoreTeamId}`,
			);
		} else if (
			sessionStoreDisabled &&
			sessionStoreApiKey &&
			sessionStoreTeamId
		) {
			this.logger.info(
				"[SessionStore] Remote session store disabled via CYRUS_DISABLE_REMOTE_SESSION_STORE; transcripts will stay local.",
			);
		}

		// Initialize GitHub comment service for posting replies to GitHub PRs
		this.gitHubCommentService = new GitHubCommentService();

		// Initialize GitLab comment service for posting replies to GitLab MRs.
		// For Self-Managed GitLab the API base URL must be derived from the
		// configured repos' gitlabUrl host; otherwise the service falls back to
		// gitlab.com and 404s on every reply. Picks the first configured
		// GitLab repo's host (single GitLab host per Cyrus instance).
		const firstGitlabRepo = config.repositories.find((r) => r.gitlabUrl);
		let gitlabApiBaseUrl: string | undefined;
		if (firstGitlabRepo?.gitlabUrl) {
			try {
				gitlabApiBaseUrl = new URL(firstGitlabRepo.gitlabUrl).origin;
			} catch {
				// malformed gitlabUrl — leave undefined and fall through to default
			}
		}
		this.gitLabCommentService = new GitLabCommentService(
			gitlabApiBaseUrl ? { apiBaseUrl: gitlabApiBaseUrl } : undefined,
		);

		// Initialize global session registry (centralized session storage)
		this.globalSessionRegistry = new GlobalSessionRegistry();

		// Initialize repository router with dependencies
		const repositoryRouterDeps: RepositoryRouterDeps = {
			fetchIssueLabels: async (issueId: string, linearWorkspaceId: string) => {
				// Use workspace ID directly from webhook context (Linear-native source)
				const issueTracker = this.issueTrackers.get(linearWorkspaceId);
				if (!issueTracker) return [];

				// Use platform-agnostic getIssueLabels method
				return await issueTracker.getIssueLabels(issueId);
			},
			fetchIssueDescription: async (
				issueId: string,
				linearWorkspaceId: string,
			): Promise<string | undefined> => {
				// Use workspace ID directly from webhook context (Linear-native source)
				const issueTracker = this.issueTrackers.get(linearWorkspaceId);
				if (!issueTracker) return undefined;

				// Fetch issue and get description
				try {
					const issue = await issueTracker.fetchIssue(issueId);
					return issue?.description ?? undefined;
				} catch (error) {
					this.logger.error(
						`Failed to fetch issue description for routing:`,
						error,
					);
					return undefined;
				}
			},
			hasActiveSession: (issueId: string, _repositoryId: string) => {
				const activeSessions =
					this.agentSessionManager.getActiveSessionsByIssueId(issueId);
				return activeSessions.length > 0;
			},
			getIssueTracker: (linearWorkspaceId: string) => {
				return this.getIssueTrackerForWorkspace(linearWorkspaceId);
			},
			// Routed through the same events as the AskUserQuestion path, so both
			// kinds of "blocked on the user" converge on one park/unpark handler.
			onSessionParked: (agentSessionId: string) =>
				this.agentSessionManager.emit("sessionParked", agentSessionId),
			onSessionUnparked: (agentSessionId: string) =>
				this.agentSessionManager.emit("sessionUnparked", agentSessionId),
		};
		this.repositoryRouter = new RepositoryRouter(repositoryRouterDeps);
		this.gitService = new GitService({ cyrusHome: this.cyrusHome });

		this.wipSnapshotReaper = new WipSnapshotReaper({
			stateFile: join(this.cyrusHome, "state", "wip-snapshot-deletions.json"),
			deleteSnapshot: (repoPath, branch) =>
				this.gitService.deleteWipSnapshot(repoPath, branch),
			logger: {
				info: (msg) => this.logger.info(msg),
				warn: (msg) => this.logger.warn(msg),
			},
		});

		// Initialize AskUserQuestion handler for elicitation via Linear select signal
		this.askUserQuestionHandler = new AskUserQuestionHandler({
			getIssueTracker: (linearWorkspaceId: string) => {
				return this.getIssueTrackerForWorkspace(linearWorkspaceId) ?? null;
			},
		});

		// Initialize webhook IP validator
		// Enabled by default in self-hosted mode (CYRUS_HOST_EXTERNAL=true),
		// can be overridden with WEBHOOK_IP_VALIDATION=false to disable
		const isExternalHost =
			process.env.CYRUS_HOST_EXTERNAL?.toLowerCase().trim() === "true";
		const ipValidationEnv =
			process.env.WEBHOOK_IP_VALIDATION?.toLowerCase().trim();
		const ipValidationEnabled =
			ipValidationEnv === "true" ||
			(ipValidationEnv !== "false" && isExternalHost);
		this.webhookIpValidator = new WebhookIpValidator({
			enabled: ipValidationEnabled,
		});
		if (ipValidationEnabled) {
			this.logger.info("Webhook IP validation enabled");
		}

		// Initialize shared application server
		const serverPort = config.serverPort || config.webhookPort || 3456;
		const serverHost = config.serverHost || "localhost";
		// Skip the Cloudflare tunnel when there is no inbound webhook surface to
		// expose: CLI mode (in-memory tracker) and router mode (events arrive
		// over the device WebSocket, not an HTTP webhook).
		const skipTunnel =
			config.platform === "cli" || config.platform === "router";
		this.sharedApplicationServer = new SharedApplicationServer(
			serverPort,
			serverHost,
			skipTunnel,
		);

		// Create single AgentSessionManager instance shared across all repositories
		this.agentSessionManager = new AgentSessionManager(
			(childSessionId: string) => {
				this.logger.debug(
					`Looking up parent session for child ${childSessionId}`,
				);
				const parentId =
					this.globalSessionRegistry.getParentSessionId(childSessionId);
				this.logger.debug(
					`Child ${childSessionId} -> Parent ${parentId || "not found"}`,
				);
				return parentId;
			},
			async (parentSessionId, prompt, childSessionId) => {
				const repoId = this.sessionRepositories.get(childSessionId);
				const repo = repoId ? this.repositories.get(repoId) : undefined;
				if (!repo) {
					this.logger.error(
						`No repository found for child session ${childSessionId}`,
					);
					return;
				}
				await this.handleResumeParentSession(
					parentSessionId,
					prompt,
					childSessionId,
				);
			},
			undefined, // logger
			// The terminal path flushes state to disk before it signals, so both
			// the router's affinity release and the persistence floor's bundle see
			// a session that reads terminal and carries its final response entry.
			() => this.savePersistedState(),
		);

		// Router mode: a session that just picked up a new runner has advanced past
		// whatever terminal state it last reported, so any still-unacked terminal
		// frame for it is stale. Drop it rather than let the next reconnect replay
		// it: the router applies terminal frames unconditionally, so a replay
		// lands mid-turn, clears the session affinity this turn's activities post
		// under, and the turn's final response is rejected with "session not owned
		// by this device". The session emits a fresh terminal frame when it
		// genuinely finishes (addAgentRunner re-arms the one-shot), so nothing is
		// lost by dropping the old one.
		this.agentSessionManager.on("sessionResumed", (sessionId: string) => {
			if (this.config.platform !== "router") return;
			try {
				this.routerConnection?.discardBufferedSessionState(sessionId);
			} catch (error) {
				this.logger.error(
					`Failed to discard the buffered terminal frame for session ${sessionId}`,
					error,
				);
			}
			// A runner has just been attached, which is the FIRST instant the
			// session can say which runner it is — and, before this, the only
			// instants that ever said so were a wait, a deferred turn, and the
			// terminal frame. An ordinary run reached none of them until it was
			// over, so `runner` stayed NULL for its whole life and the fleet view
			// rendered every in-flight run as `unknown`: the one column an operator
			// reads to answer "what is running on this?" was blank exactly while
			// the answer mattered.
			//
			// Fire-and-forget, like the pending-work report and for the same
			// reason: it carries no ownership transition, so a lost frame costs one
			// observation, and making it durable would make it REPLAYABLE — a
			// replayed `active` against a router that has since recorded a park
			// mints affinity back.
			//
			// The model is deliberately absent here when the runner's init message
			// has not landed yet. `getRunFacts` omits rather than guesses, and the
			// router merges only the keys a frame actually carries, so the model
			// fills in on the next frame instead of being written as a placeholder.
			try {
				this.routerConnection?.sendRunFacts(
					sessionId,
					this.agentSessionManager.getRunFacts(sessionId),
				);
			} catch (error) {
				this.logger.error(
					`Failed to report run facts for session ${sessionId}`,
					error,
				);
			}
		});

		// Router mode: a session blocked on a user answer reports that its RUN is
		// waiting — always, so a session blocked with a background build in flight
		// is observable rather than silent.
		//
		// Whether its EXECUTOR may park is a separate declaration on the same
		// frame, and it is the one with consequences: parking releases session
		// affinity, which is what lets ContainerLifecycle idle-suspend the
		// container. A container suspended with a build in flight has that build
		// frozen, and the completion that would normally wake the session can then
		// never arrive — so pending work withholds park permission while still
		// reporting the wait.
		//
		// Non-fatal: a failed report costs a suspend and an observation, not
		// correctness — the container simply stays up until the next transition.
		this.agentSessionManager.on("sessionParked", (sessionId: string) => {
			if (this.config.platform !== "router") return;
			try {
				const pendingWorkCount =
					this.agentSessionManager.pendingWorkCount(sessionId);
				this.routerConnection?.sendSessionWaiting(
					sessionId,
					{
						reason: WAIT_REASON_ELICITATION,
						since: new Date().toISOString(),
					},
					{
						executorMayPark: pendingWorkCount === 0,
						...this.agentSessionManager.getRunFacts(sessionId),
						pendingWorkCount,
					},
				);
			} catch (error) {
				this.logger.error(
					`Failed to signal waiting state for session ${sessionId}; its container will stay up until the next transition`,
					error,
				);
			}
		});

		// Router mode: a turn that ended holding a cron or a background task keeps
		// the session open, so no terminal frame is sent. Report the run as active
		// with what is holding it — a seven-hour pending-work run must stay
		// observable, not be mistaken for silence.
		//
		// Fire-and-forget on the connection side: losing this costs one
		// observation, and making it durable would make it replayable, which is a
		// real hazard for a frame the router reads as an unpark.
		this.agentSessionManager.on(
			"sessionPendingWork",
			(sessionId: string, pendingWorkCount: number) => {
				if (this.config.platform !== "router") return;
				try {
					this.routerConnection?.sendRunFacts(sessionId, {
						...this.agentSessionManager.getRunFacts(sessionId),
						pendingWorkCount,
					});
				} catch (error) {
					this.logger.error(
						`Failed to report pending work for session ${sessionId}`,
						error,
					);
				}
			},
		);

		// The counterpart. Durability cuts both ways: replaying a stale `parked`
		// on a later reconnect would clear the affinity a live turn is posting
		// under — the same hazard the `sessionResumed` listener above guards
		// against for terminal frames.
		//
		// Dropping the buffered frame is only half of it, and only the half that
		// helps while the frame is still unsent. Once the router has applied a
		// `parked`, affinity is gone on its side, and nothing local can bring it
		// back — the session runs on with every activity rejected as "session not
		// owned by this device" (PAR-146). `sendSessionUnparked` does both.
		this.agentSessionManager.on("sessionUnparked", (sessionId: string) => {
			if (this.config.platform !== "router") return;
			try {
				// Carries the CURRENT pending-work count, not just the identity. A
				// session that reported 3 while it waited and finished that work
				// while blocked would otherwise keep reporting 3 until it went
				// terminal, and a stale count is worse evidence than none — it is
				// what a `worker_owns_active_work` recovery refusal keys off.
				this.routerConnection?.sendSessionUnparked(sessionId, {
					...this.agentSessionManager.getRunFacts(sessionId),
					pendingWorkCount:
						this.agentSessionManager.pendingWorkCount(sessionId),
				});
			} catch (error) {
				this.logger.error(
					`Failed to unpark session ${sessionId}; it will keep its parked state on the router until the next terminal frame`,
					error,
				);
			}
		});

		// Router mode: when a session reaches a terminal state, tell the router
		// so it can release the issue lock + session affinity. Guarded by
		// platform inside the handler so the subscription is harmless otherwise.
		this.agentSessionManager.on(
			"sessionTerminal",
			(sessionId: string, state: "complete" | "error" | "stopped") => {
				if (this.config.platform !== "router") return;
				try {
					// Execution identity rides the terminal frame too: it describes the
					// run that just ended, which is exactly what a fleet operator
					// filters a completed run by. No pending-work count — a run that
					// has ended carries none, by definition.
					this.routerConnection?.sendSessionState(
						sessionId,
						state,
						this.agentSessionManager.getRunFacts(sessionId),
					);
				} catch (error) {
					// sendSessionState persists the frame to disk before transmitting.
					// A failure there must not abort session teardown (this listener
					// runs synchronously inside the emit, e.g. from the stop handler),
					// but it does mean the router keeps this issue locked until an
					// admin runs `cyrus router unlock` — so say so loudly.
					this.logger.error(
						`Failed to signal terminal state '${state}' for session ${sessionId} to the router; its issue lock may need \`cyrus router unlock\``,
						error,
					);
				}

				// Persistence floor: snapshot + bundle-upload this issue now that a
				// session on it just ended. syncIssueOnTermination() is independent
				// of the sendSessionState try/catch above — a router-lock signalling
				// failure must not skip the floor sync, and vice versa. It removes
				// this session from the issue's live-session refcount immediately,
				// then stops protecting the issue (removes it from the touched set)
				// once BOTH that refcount is empty (no other session on the same
				// issue is still running) AND a sync actually succeeds — a failed
				// sync, or another still-live session on the issue, leaves it
				// touched so a later periodic tick retries/re-evaluates it instead
				// of dropping protection forever.
				const session = this.agentSessionManager.getSession(sessionId);
				const identifier = session?.issue?.identifier;
				if (identifier) {
					void this.workspaceSync?.syncIssueOnTermination(
						identifier,
						sessionId,
					);
				}
			},
		);

		// Initialize repositories with path resolution
		for (const repo of config.repositories) {
			if (repo.isActive !== false) {
				// Resolve paths that may contain tilde (~) prefix
				const resolvedRepo: RepositoryConfig = {
					...repo,
					repositoryPath: resolvePath(repo.repositoryPath),
					workspaceBaseDir: resolvePath(repo.workspaceBaseDir),
					mcpConfigPath: Array.isArray(repo.mcpConfigPath)
						? repo.mcpConfigPath.map(resolvePath)
						: repo.mcpConfigPath
							? resolvePath(repo.mcpConfigPath)
							: undefined,
					promptTemplatePath: repo.promptTemplatePath
						? resolvePath(repo.promptTemplatePath)
						: undefined,
				};

				this.repositories.set(repo.id, resolvedRepo);
			}
		}

		// Router mode: create ONE shared device-side connection to the router.
		// The device holds no Linear tokens for issue-tracker operations — those
		// are forwarded to the router over this connection. (An operator MAY
		// still provision a static per-user Linear token via config.linearWorkspaces
		// — from LINEAR_API_TOKEN — purely to authenticate the hosted Linear MCP
		// inside the container's Claude session; that path does not go through the
		// router connection.)
		if (this.config.platform === "router") {
			if (!config.router) {
				throw new Error(
					"platform 'router' requires config.router { url, deviceToken }",
				);
			}
			this.routerConnection = new RouterConnection({
				url: config.router.url,
				deviceToken: config.router.deviceToken,
				stateDir: join(this.cyrusHome, "router-client"),
				// Declare the sessions we're still responsible for terminal-
				// signalling on every (re)connect, so the router can reclaim issue
				// locks for the rest — sessions we lost (e.g. a corrupt state file
				// wiped them) or that completed but whose terminal signal died with
				// a previous process. See AgentSessionManager.getLiveSessionIds.
				getActiveSessions: () => this.agentSessionManager.getLiveSessionIds(),
			});

			// Ship this process's own logs off the box over the connection we just
			// built. A sandbox worker's stdout is collected by nothing and dies
			// with the sandbox, so without this the only record of what a session
			// did is whatever reached Linear. Installed process-wide (mirroring
			// setGlobalErrorReporter) so every component's logger forwards without
			// the sink being threaded through each constructor.
			//
			// Inert unless the router advertises `log_ingest` AND the record clears
			// the forwarder's level threshold and rate limit, so a physical-device
			// user who happens to run in router mode pays essentially nothing.
			this.logForwarder = new RouterLogForwarder({
				connection: this.routerConnection,
			});
			this.previousLogSink = setGlobalLogSink(this.logForwarder);

			// Ship this process's SPANS off the box the same way, so a worker's
			// session work joins the router's trace instead of being a black box
			// between "router dispatched an event" and "session posted a result".
			//
			// Same egress argument as the logs above: the sandbox's allowlist has
			// the router's host as its only entry, so exporting straight to an
			// ingestion endpoint is not an option. Off unless
			// CYRUS_OTEL_TRACES_ENABLED is set, and inert on top of that unless the
			// router advertises `span_ingest` — so a physical-device user in router
			// mode pays nothing.
			this.startRouterTracing(this.routerConnection);

			// Durable record of "I owe the router a teardown callback". Written
			// before terminal cleanup starts and retried until the router accepts
			// it, so an idle-stopped-then-woken worker gets its sandbox destroyed
			// promptly instead of waiting out the router's 10-minute grace.
			const routerHttpBase = toHttpBase(config.router.url);
			const routerDeviceToken = config.router.deviceToken;
			this.teardownCallbacks = new TeardownCallbackQueue({
				stateDir: join(this.cyrusHome, "router-client"),
				post: (issueKey, idempotencyKey) =>
					postTeardownComplete(routerHttpBase, routerDeviceToken, issueKey, {
						idempotencyKey,
					}),
				logger: {
					info: (msg) => this.logger.info(msg),
					warn: (msg) => this.logger.warn(msg),
				},
			});

			// Persistence floor: WIP snapshot + bundle-upload sync so container
			// death (idle-stop, crash, host loss, executor switch) never loses
			// work. Opt-IN via `router.floorSync: true` — defaults OFF so this
			// is a no-op for every router-platform device that hasn't asked for
			// it. `ContainerBootCommand.writeConfig` sets `floorSync: true` for
			// every container it boots (that's what makes the container restore
			// ladder work); a physical-device user who wants the floor too (e.g.
			// to enable device -> container migration) opts in the same way, by
			// setting `floorSync: true` themselves.
			if (config.router.floorSync === true) {
				this.workspaceSync = new WorkspaceSyncService({
					cyrusHome: this.cyrusHome,
					routerUrl: config.router.url,
					deviceToken: config.router.deviceToken,
					gitService: this.gitService,
					logger: this.logger,
					onCaptureFailure: (issueKey, detail) =>
						this.reportWipSnapshotFailure(issueKey, detail),
				});
				this.workspaceSync.start();
			}
		}

		// Router mode has no linearWorkspaces block (the device holds no Linear
		// tokens — the router does). Build one RouterIssueTrackerService per
		// unique repo workspace id, backed by the shared RouterConnection.
		if (this.config.platform === "router") {
			for (const repo of this.repositories.values()) {
				const wsId = repo.linearWorkspaceId;
				if (wsId && !this.issueTrackers.has(wsId)) {
					this.issueTrackers.set(
						wsId,
						new RouterIssueTrackerService(this.getRouterConnection(), wsId),
					);
				}
			}
		}

		// Initialize issue trackers per workspace (one per workspace, not per repo)
		if (config.linearWorkspaces) {
			for (const [linearWorkspaceId, wsConfig] of Object.entries(
				config.linearWorkspaces,
			)) {
				const issueTracker =
					this.config.platform === "cli"
						? (() => {
								const service = new CLIIssueTrackerService();
								service.seedDefaultData();
								return service;
							})()
						: this.config.platform === "router"
							? new RouterIssueTrackerService(
									this.getRouterConnection(),
									linearWorkspaceId,
								)
							: new LinearIssueTrackerService(
									new LinearClient({
										accessToken: wsConfig.linearToken,
									}),
									this.buildOAuthConfig(linearWorkspaceId),
								);
				if (!this.issueTrackers.has(linearWorkspaceId)) {
					this.issueTrackers.set(linearWorkspaceId, issueTracker);
				}
			}
		}

		// Create activity sinks per workspace (one per workspace, mirrors issueTrackers)
		for (const [workspaceId, issueTracker] of this.issueTrackers) {
			this.activitySinks.set(
				workspaceId,
				new LinearActivitySink(issueTracker, workspaceId),
			);
		}

		// Initialize user access control with global and per-repository configs
		const repoAccessConfigs = new Map<
			string,
			import("cyrus-core").UserAccessControlConfig | undefined
		>();
		for (const repo of config.repositories) {
			if (repo.isActive !== false) {
				repoAccessConfigs.set(repo.id, repo.userAccessControl);
			}
		}
		this.userAccessControl = new UserAccessControl(
			config.userAccessControl,
			repoAccessConfigs,
		);

		// Initialize extracted service modules. In router mode the device has no
		// Linear token, so attachment downloads are proxied through the router
		// via a delegate that reaches the download RPC above both token guards.
		this.attachmentService = new AttachmentService(
			this.logger,
			this.cyrusHome,
			this.config.linearWorkspaces || {},
			this.config.platform === "router"
				? (url) => this.downloadAttachmentViaRouter(url)
				: undefined,
		);
		this.runnerSelectionService = new RunnerSelectionService(this.config);
		this.runnerSlots = new SessionSemaphore(
			this.config.maxConcurrentSessions ?? Number.POSITIVE_INFINITY,
			(message) => this.logger.info(message),
		);
		this.toolPermissionResolver = new ToolPermissionResolver(
			this.config,
			this.logger,
		);
		this.mcpConfigService = new McpConfigService({
			getLinearTokenForWorkspace: (workspaceId) =>
				this.getLinearTokenForWorkspace(workspaceId),
			getIssueTracker: (workspaceId) =>
				this.issueTrackers.get(workspaceId) as
					| (IIssueTrackerService & {
							getClient?: () => import("@linear/sdk").LinearClient;
					  })
					| undefined,
			getCyrusToolsMcpUrl: () => this.getCyrusToolsMcpUrl(),
			createCyrusToolsOptions: (parentSessionId) =>
				this.createCyrusToolsOptions(parentSessionId),
			healthRegistry: this.mcpHealthRegistry,
		});
		this.mcpHealthMonitor = new McpHealthMonitor({
			registry: this.mcpHealthRegistry,
			logger: this.logger,
		});
		this.runnerConfigBuilder = new RunnerConfigBuilder(
			this.toolPermissionResolver,
			this.mcpConfigService,
			this.runnerSelectionService,
		);
		this.activityPoster = new ActivityPoster(
			this.issueTrackers,
			this.repositories,
			this.logger,
		);
		this.configManager = new ConfigManager(
			this.config,
			this.logger,
			this.configPath,
			this.repositories,
		);
		this.promptBuilder = new PromptBuilder({
			logger: this.logger,
			repositories: this.repositories,
			issueTrackers: this.issueTrackers,
			gitService: this.gitService,
		});
		this.defaultSkillsDeployer = new DefaultSkillsDeployer(
			this.cyrusHome,
			this.logger,
		);
		this.skillsPluginResolver = new SkillsPluginResolver(
			this.cyrusHome,
			this.logger,
			{
				// Per-user switch over the bundled Cyrus skills. Sourced from the
				// environment rather than `EdgeWorkerConfig` on purpose: a new
				// top-level config field would have to be added to two hardcoded
				// lists in ConfigManager or it is silently dropped on every reload
				// (see CLAUDE.md note 9). For container targets it arrives from the
				// router's per-user SecretStore via `ContainerTargets.buildEnv`;
				// for physical devices, from `~/.cyrus/.env`.
				defaultSkills: process.env.CYRUS_DEFAULT_SKILLS,
			},
		);

		// Components will be initialized and registered in start() method before server starts
	}

	/**
	 * Start the edge worker
	 */
	async start(): Promise<void> {
		// Deploy default skills to cyrusHome if not already present (one-time setup)
		await this.defaultSkillsDeployer.ensureDeployed();

		// Scaffold user skills plugin manifest if needed (one-time setup)
		await this.skillsPluginResolver.ensureUserPluginScaffolded();

		// Load persisted state for each repository
		await this.loadPersistedState();

		// Retry any WIP snapshot ref whose deletion failed before this process
		// last exited. Backgrounded: it makes network calls per leaked ref, and
		// nothing about startup depends on it. Once an issue is closed and its
		// worktree gone, nothing else in the system remembers the ref should be
		// deleted, so this is the only thing standing between a badly-timed
		// outage and a ref that lives in the repository forever.
		this.wipSnapshotReaper.sweep().catch((err) => {
			this.logger.warn("WIP snapshot sweep failed (non-fatal):", err);
		});

		// Pre-warm the 30 most recent Claude sessions in the background
		// so their first query after restart has near-zero cold-start latency.
		// Disabled by default; opt in with CYRUS_ENABLE_WARM_SESSIONS=1.
		if (this.isWarmSessionsEnabled()) {
			this.warmupRecentSessions(30).catch((err) => {
				this.logger.warn("Session warmup failed (non-fatal):", err);
			});
		}

		// Start config file watcher via ConfigManager
		this.configManager.on(
			"configChanged",
			async (changes: RepositoryChanges) => {
				const strictMcpConfigChanged =
					(this.config.strictMcpConfig ?? true) !==
					(changes.newConfig.strictMcpConfig ?? true);
				if (strictMcpConfigChanged) {
					for (const warmSession of this.warmInstances.values()) {
						warmSession.close();
					}
					this.warmInstances.clear();
				}
				this.updateLinearWorkspaceTokens(changes.newConfig);
				await this.removeDeletedRepositories(changes.removed);
				await this.updateModifiedRepositories(changes.modified);
				await this.addNewRepositories(changes.added);
				// Live-update sandbox / egress proxy settings
				await this.applySandboxConfigChanges(changes.newConfig);
				this.config = EdgeWorker.normalizeConfigPaths(changes.newConfig);
				this.configManager.setConfig(changes.newConfig);
				this.runnerSelectionService.setConfig(changes.newConfig);
				this.toolPermissionResolver.setConfig(changes.newConfig);
				this.runnerSlots.setLimit(
					changes.newConfig.maxConcurrentSessions ?? Number.POSITIVE_INFINITY,
				);
			},
		);
		this.configManager.startConfigWatcher();

		// Start egress proxy if sandbox is enabled.
		// The proxy intercepts Bash-spawned subprocess traffic only (git, gh, npm, etc.).
		// Claude's inference API, MCP servers, and built-in file tools bypass the proxy.
		if (this.config.sandbox?.enabled) {
			this.logger.info("🛡️  Sandbox egress proxy: starting...");
			this.egressProxy = new EgressProxy(
				this.config.sandbox,
				this.cyrusHome,
				this.logger,
			);
			await this.egressProxy.start();

			// Store base SDK sandbox settings — merged per-session with worktree path
			this.sdkSandboxSettings = {
				enabled: true,
				network: {
					httpProxyPort: this.egressProxy.getHttpProxyPort(),
					socksProxyPort: this.egressProxy.getSocksProxyPort(),
				},
			};

			const systemWideCert = this.config.sandbox?.systemWideCert === true;
			this.logCertTrustInstructions(
				this.egressProxy.getCACertPath(),
				systemWideCert,
			);

			// When systemWideCert is true, the OS cert store handles trust
			// for all tools — skip per-session cert env vars.
			if (!systemWideCert) {
				this.egressCaCertPath = this.egressProxy.buildCACertBundle();
			}
		} else {
			this.logger.info(
				"🛡️  Sandbox egress proxy: disabled (set sandbox.enabled=true in config.json to enable)",
			);
		}

		// Initialize and register components BEFORE starting server (routes must be registered before listen())
		await this.initializeComponents();

		// Refresh GitHub webhook allowlist from /meta API (non-blocking)
		if (this.webhookIpValidator.isEnabled()) {
			this.webhookIpValidator.refreshGitHubAllowlist().catch((error) => {
				this.logger.warn(
					"Failed to refresh GitHub webhook allowlist",
					error instanceof Error ? error : new Error(String(error)),
				);
			});
		}

		// Report any session the previous process was running when it died. Runs
		// after initializeComponents() so the activity sinks and issue trackers
		// exist, and — critically — before the HTTP server accepts a webhook or the
		// router dial can deliver a queued prompt. Reconciliation drives a session
		// to `error` and emits a terminal signal that releases the router's issue
		// lock and session affinity; if a prompt for that same session is already
		// being resumed when it fires, it strips the affinity mid-turn and every
		// activity that turn posts — including its final response — is rejected
		// with "session not owned by this device". Ordering it ahead of all inbound
		// work is what makes that unreachable: `addAgentRunner` then always
		// observes the reconciled state and re-arms the session cleanly.
		//
		// Safe to run while offline: both the activity post and the terminal signal
		// are durable across a router disconnect.
		//
		// Non-fatal: a worker that cannot reconcile must still come up and serve
		// new work.
		try {
			const interrupted =
				await this.agentSessionManager.reconcileInterruptedSessions();
			if (interrupted.length > 0) {
				this.logger.warn(
					`Reconciled ${interrupted.length} session(s) interrupted by a host restart`,
				);
			}
		} catch (error) {
			this.logger.error("Failed to reconcile interrupted sessions:", error);
		}

		// Start shared application server (this also starts Cloudflare tunnel if CLOUDFLARE_TOKEN is set)
		await this.sharedApplicationServer.start();

		// Probe MCP connectivity now that the cyrus-tools endpoint is listening.
		// Deliberately NOT awaited: a slow or unreachable MCP server must never
		// delay accepting webhooks. Results land in `mcpHealthRegistry` and are
		// rendered by `getMcpHealthDiagnostics()` in the startup banner.
		this.probeMcpHealth().catch((error) => {
			this.logger.warn("MCP health probe failed (non-fatal):", error);
		});

		// Router mode: begin the dial loop. Deferred from initializeComponents() to
		// here so reconciliation above has already settled every restored session
		// before the router can deliver a queued prompt for one of them.
		if (this.pendingRouterDial) {
			const routerConnection = this.pendingRouterDial;
			this.pendingRouterDial = undefined;
			routerConnection.connect();
		}
	}

	/**
	 * Initialize and register components (routes) before server starts
	 */
	private async initializeComponents(): Promise<void> {
		// 1. Platform-specific initialization
		if (this.config.platform === "cli") {
			// CLI mode: ensure a CLIIssueTrackerService exists for each repo workspace.
			// Repos from config.repositories don't go through linearWorkspaces init,
			// so we create trackers here if missing.
			for (const [repoId, repo] of this.repositories) {
				const wsId = repo.linearWorkspaceId;
				if (wsId && !this.issueTrackers.has(wsId)) {
					const service = new CLIIssueTrackerService();
					service.seedDefaultData();
					this.issueTrackers.set(wsId, service);
					const activitySink = new LinearActivitySink(service, wsId);
					this.activitySinks.set(repoId, activitySink);
				}
			}

			const firstCliTracker = Array.from(this.issueTrackers.values()).find(
				(tracker): tracker is CLIIssueTrackerService =>
					tracker instanceof CLIIssueTrackerService,
			);

			if (firstCliTracker) {
				this.cliRPCServer = new CLIRPCServer({
					fastifyServer: this.sharedApplicationServer.getFastifyInstance(),
					issueTracker: firstCliTracker,
					version: "1.0.0",
				});

				// Register the /cli/rpc endpoint
				this.cliRPCServer.register();

				this.logger.info("✅ CLI RPC server registered");
				this.logger.info("   RPC endpoint: /cli/rpc");

				// Create CLI event transport and register listener
				const cliEventTransport = firstCliTracker.createEventTransport({
					platform: "cli",
					fastifyServer: this.sharedApplicationServer.getFastifyInstance(),
				});

				// Listen for webhook events
				cliEventTransport.on("event", (event: AgentEvent) => {
					const repos = Array.from(this.repositories.values());
					this.handleWebhook(event as unknown as Webhook, repos);
				});

				// Listen for unified internal messages (used by F1 to emit
				// IssueStateChangeMessage when an issue is terminated).
				cliEventTransport.on("message", (message: InternalMessage) => {
					this.handleMessage(message);
				});

				// Listen for errors
				cliEventTransport.on("error", (error: Error) => {
					this.handleError(error);
				});

				// Register the CLI event transport endpoints
				cliEventTransport.register();

				this.logger.info("✅ CLI event transport registered");
				this.logger.info(
					"   Event listener: listening for AgentSessionCreated events",
				);
			}
		} else if (this.config.platform === "router") {
			// Router mode: events arrive over the shared device WebSocket, not an
			// HTTP webhook. Ensure a RouterIssueTrackerService exists per repo
			// workspace (the constructor already created these; this mirrors the
			// CLI fallback loop for robustness/idempotency).
			for (const repo of this.repositories.values()) {
				const wsId = repo.linearWorkspaceId;
				if (wsId && !this.issueTrackers.has(wsId)) {
					const tracker = new RouterIssueTrackerService(
						this.getRouterConnection(),
						wsId,
					);
					this.issueTrackers.set(wsId, tracker);
					this.activitySinks.set(wsId, new LinearActivitySink(tracker, wsId));
				}
			}

			const firstRouterTracker = Array.from(this.issueTrackers.values()).find(
				(tracker): tracker is RouterIssueTrackerService =>
					tracker instanceof RouterIssueTrackerService,
			);

			if (firstRouterTracker) {
				const routerConnection = this.getRouterConnection();

				// Surface fatal connection errors (e.g. a rejected device token →
				// hello_error, emitted by RouterConnection as "error") instead of
				// letting them go unhandled. Attach BEFORE connect().
				routerConnection.on("error", (error: Error) => {
					this.handleError(error);
				});

				// Replay any teardown callback a previous process recorded but never
				// delivered — deliberately gated on "connected" rather than fired at
				// startup. The callback rides the router's HTTP surface, and a
				// reconnect (including the liveness watchdog's post-ACA-resume
				// redial) is the first point at which we know the router is
				// reachable at all. Runs on every reconnect; a no-op when the queue
				// is empty, which is the normal case.
				routerConnection.on("connected", () => {
					void this.teardownCallbacks?.resume();
				});

				// SYNCHRONOUS-CONSUMER CONTRACT: RouterConnection marks its durable
				// inbox entry processed the instant its "event" emit returns, and
				// RouterEventTransport re-emits synchronously. So the transport
				// "event" → handleWebhook handoff MUST be wired synchronously and
				// BEFORE connect() — mirroring the CLI/Linear "event" wiring exactly,
				// with no extra await/defer inserted between transport "event" and
				// handleWebhook. The transport ignores this config (no HTTP surface).
				const routerEventTransport = firstRouterTracker.createEventTransport({
					platform: "linear",
					verificationMode: "proxy",
					secret: "",
					fastifyServer: this.sharedApplicationServer.getFastifyInstance(),
				});

				// Listen for legacy webhook events (mirrors CLI/Linear "event" path)
				routerEventTransport.on("event", (event: AgentEvent) => {
					const repos = Array.from(this.repositories.values());
					this.handleWebhook(event as unknown as Webhook, repos);
				});

				// Listen for unified internal messages (new message bus)
				routerEventTransport.on("message", (message: InternalMessage) => {
					this.handleMessage(message);
				});

				// Listen for transport errors
				routerEventTransport.on("error", (error: Error) => {
					this.handleError(error);
				});

				// No-op for the router transport (no HTTP endpoint to mount), but
				// call it to honor the IAgentEventTransport contract.
				routerEventTransport.register();

				// The dial loop is deliberately NOT started here. Listeners are
				// attached now (so no replayed or live event can be emitted with zero
				// "event" consumers), but dialing waits until start() has reconciled
				// interrupted sessions — see the note there.
				this.pendingRouterDial = routerConnection;

				this.logger.info("✅ Router event transport registered");
				this.logger.info(`   Connecting to router: ${this.config.router?.url}`);
			}
		} else {
			// Linear mode: Create and register LinearEventTransport
			const useDirectWebhooks =
				process.env.LINEAR_DIRECT_WEBHOOKS?.toLowerCase() === "true";
			const verificationMode = useDirectWebhooks ? "direct" : "proxy";

			// Get appropriate secret based on mode
			const secret = useDirectWebhooks
				? process.env.LINEAR_WEBHOOK_SECRET || ""
				: process.env.CYRUS_API_KEY || "";

			this.linearEventTransport = new LinearEventTransport({
				fastifyServer: this.sharedApplicationServer.getFastifyInstance(),
				verificationMode,
				secret,
				ipAllowlist:
					verificationMode === "direct" && this.webhookIpValidator.isEnabled()
						? this.webhookIpValidator.getAllowlist("linear")
						: undefined,
			});

			// Listen for legacy webhook events (deprecated, kept for backward compatibility)
			this.linearEventTransport.on("event", (event: AgentEvent) => {
				const repos = Array.from(this.repositories.values());
				this.handleWebhook(event as unknown as Webhook, repos);
			});

			// Listen for unified internal messages (new message bus)
			this.linearEventTransport.on("message", (message: InternalMessage) => {
				this.handleMessage(message);
			});

			// Listen for errors
			this.linearEventTransport.on("error", (error: Error) => {
				this.handleError(error);
			});

			// Register the /linear-webhook endpoint (with /webhook retained as a deprecated alias)
			this.linearEventTransport.register();

			this.logger.info(
				`✅ Linear event transport registered (${verificationMode} mode)`,
			);
			this.logger.info(
				`   Webhook endpoint: ${this.sharedApplicationServer.getWebhookUrl()}`,
			);
		}

		// 2. Register GitHub and Slack event transports unconditionally
		// These don't require repositories and must be available during onboarding
		// for webhook URL verification to succeed.
		this.registerGitHubEventTransport();
		this.registerGitLabEventTransport();
		this.registerSlackEventTransport();
		this.registerZulipEventTransport();

		// 3. Create and register ConfigUpdater (both platforms)
		this.configUpdater = new ConfigUpdater(
			this.sharedApplicationServer.getFastifyInstance(),
			this.cyrusHome,
			() => process.env.CYRUS_API_KEY || "",
		);

		// Register config update routes
		this.configUpdater.register();

		this.logger.info("✅ Config updater registered");
		this.logger.info(
			"   Routes: /api/update/cyrus-config, /api/update/cyrus-env,",
		);
		this.logger.info(
			"           /api/update/repository, /api/update/test-mcp, /api/update/configure-mcp",
		);

		// 3. Register MCP endpoint for cyrus-tools on the same Fastify server/port
		await this.registerCyrusToolsMcpEndpoint();
		// 4. Register /status endpoint for process activity monitoring
		this.registerStatusEndpoint();

		// 5. Register /version endpoint for CLI version info
		this.registerVersionEndpoint();
	}

	/**
	 * Register the /status endpoint for checking if the process is busy or idle
	 * This endpoint is used to determine if the process can be safely restarted
	 */
	private registerStatusEndpoint(): void {
		const fastify = this.sharedApplicationServer.getFastifyInstance();

		fastify.get("/status", async (_request, reply) => {
			const status = this.computeStatus();
			return reply.status(200).send({ status });
		});

		this.logger.info("✅ Status endpoint registered");
		this.logger.info("   Route: GET /status");
	}

	/**
	 * Register the /version endpoint for CLI version information
	 * This endpoint is used by dashboards to display the installed CLI version
	 */
	private registerVersionEndpoint(): void {
		const fastify = this.sharedApplicationServer.getFastifyInstance();

		fastify.get("/version", async (_request, reply) => {
			return reply.status(200).send({
				cyrus_cli_version: this.config.version ?? null,
			});
		});

		this.logger.info("✅ Version endpoint registered");
		this.logger.info("   Route: GET /version");
	}

	/**
	 * Register the GitHub event transport for receiving forwarded GitHub webhooks from CYHOST.
	 * This creates a /github-webhook endpoint that handles @cyrusagent mentions on GitHub PRs.
	 */
	private registerGitHubEventTransport(): void {
		// Use direct GitHub signature verification only when BOTH:
		// 1. GITHUB_WEBHOOK_SECRET is set (we have the secret to verify)
		// 2. CYRUS_HOST_EXTERNAL is true (self-hosted: GitHub sends directly to us)
		// On cloud droplets, CYHOST forwards webhooks with Bearer token auth
		// (it verifies the GitHub signature itself and doesn't forward the headers).
		const isExternalHost =
			process.env.CYRUS_HOST_EXTERNAL?.toLowerCase().trim() === "true";
		const hasGithubWebhookSecret =
			process.env.GITHUB_WEBHOOK_SECRET != null &&
			process.env.GITHUB_WEBHOOK_SECRET !== "";
		const useSignatureVerification = isExternalHost && hasGithubWebhookSecret;
		const verificationMode = useSignatureVerification ? "signature" : "proxy";
		const secret = useSignatureVerification
			? process.env.GITHUB_WEBHOOK_SECRET!
			: process.env.CYRUS_API_KEY || "";

		this.gitHubEventTransport = new GitHubEventTransport({
			fastifyServer: this.sharedApplicationServer.getFastifyInstance(),
			verificationMode,
			secret,
			ipAllowlist:
				useSignatureVerification && this.webhookIpValidator.isEnabled()
					? this.webhookIpValidator.getAllowlist("github")
					: undefined,
		});

		// Listen for legacy GitHub webhook events (deprecated, kept for backward compatibility)
		this.gitHubEventTransport.on("event", (event: GitHubWebhookEvent) => {
			// Route push events to the base branch notification handler
			if (event.eventType === "push") {
				this.handleGitHubPushWebhook(event.payload as GitHubPushPayload).catch(
					(error) => {
						this.logger.error(
							"Failed to handle GitHub push webhook",
							error instanceof Error ? error : new Error(String(error)),
						);
					},
				);
				return;
			}
			this.handleGitHubWebhook(event as GitHubCommentWebhookEvent).catch(
				(error) => {
					this.logger.error(
						"Failed to handle GitHub webhook",
						error instanceof Error ? error : new Error(String(error)),
					);
				},
			);
		});

		// Listen for unified internal messages (new message bus)
		this.gitHubEventTransport.on("message", (message: InternalMessage) => {
			this.handleMessage(message);
		});

		// Listen for errors
		this.gitHubEventTransport.on("error", (error: Error) => {
			this.handleError(error);
		});

		// Register the /github-webhook endpoint
		this.gitHubEventTransport.register();

		// Initialize GitHub App token provider for self-hosted users
		const appId = process.env.GITHUB_APP_ID;
		const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
		if (appId && installationId) {
			const pemPath = join(this.cyrusHome, "github-app.pem");
			this.gitHubAppTokenProvider = new GitHubAppTokenProvider({
				appId,
				installationId,
				privateKeyPath: pemPath,
			});
			this.logger.info(
				"GitHub App token provider initialized (self-hosted mode)",
			);
		}

		this.logger.info(
			`GitHub event transport registered (${verificationMode} mode)`,
		);
		this.logger.info("Webhook endpoint: POST /github-webhook");
	}

	/**
	 * Register the GitLab event transport for receiving forwarded GitLab webhooks.
	 * This creates a /gitlab-webhook endpoint that handles note events on merge requests.
	 */
	private registerGitLabEventTransport(): void {
		const isExternalHost =
			process.env.CYRUS_HOST_EXTERNAL?.toLowerCase().trim() === "true";
		const hasGitlabWebhookSecret =
			process.env.GITLAB_WEBHOOK_SECRET != null &&
			process.env.GITLAB_WEBHOOK_SECRET !== "";
		const useSignatureVerification = isExternalHost && hasGitlabWebhookSecret;
		const verificationMode = useSignatureVerification ? "signature" : "proxy";
		const secret = useSignatureVerification
			? process.env.GITLAB_WEBHOOK_SECRET!
			: process.env.CYRUS_API_KEY || "";

		this.gitLabEventTransport = new GitLabEventTransport({
			fastifyServer: this.sharedApplicationServer.getFastifyInstance(),
			verificationMode,
			secret,
		});

		// Listen for legacy GitLab webhook events
		this.gitLabEventTransport.on("event", (event: GitLabWebhookEvent) => {
			this.handleGitLabWebhook(event).catch((error) => {
				this.logger.error(
					"Failed to handle GitLab webhook",
					error instanceof Error ? error : new Error(String(error)),
				);
			});
		});

		// Listen for unified internal messages (new message bus)
		this.gitLabEventTransport.on("message", (message: InternalMessage) => {
			this.handleMessage(message);
		});

		// Listen for errors
		this.gitLabEventTransport.on("error", (error: Error) => {
			this.handleError(error);
		});

		// Register the /gitlab-webhook endpoint
		this.gitLabEventTransport.register();

		this.logger.info(
			`GitLab event transport registered (${verificationMode} mode)`,
		);
		this.logger.info("Webhook endpoint: POST /gitlab-webhook");
	}

	/**
	 * Whether Cyrus should follow plain replies in a Slack thread it was
	 * @mentioned in. Enabled by default; controlled by the per-team
	 * `slackThreadFollowing` config toggle (Behaviours page) and force-disabled
	 * by the `CYRUS_SLACK_THREAD_FOLLOWING_DISABLED` env kill-switch, which takes
	 * precedence over the toggle. When disabled, only @mentions are processed.
	 */
	private isSlackThreadFollowingEnabled(): boolean {
		const envValue = (process.env.CYRUS_SLACK_THREAD_FOLLOWING_DISABLED ?? "")
			.toLowerCase()
			.trim();
		if (envValue === "true" || envValue === "1" || envValue === "yes") {
			return false;
		}
		// Config toggle defaults to enabled when unset.
		return this.config.slackThreadFollowing !== false;
	}

	/**
	 * Build the EdgeWorker-side dependencies every chat platform handler needs.
	 *
	 * Only the MCP config override list differs per platform, so it is the one
	 * parameter — everything else (runner factory, skills resolution, webhook
	 * accounting, state persistence) is identical across chat platforms and
	 * would otherwise be copied per registration.
	 */
	private buildChatSessionHandlerDeps(
		chatRepositoryProvider: ChatRepositoryProvider,
		getPlatformMcpConfigOverrides: () => readonly string[] | undefined,
	): ChatSessionHandlerDeps {
		return {
			cyrusHome: this.cyrusHome,
			chatRepositoryProvider,
			runnerConfigBuilder: this.runnerConfigBuilder,
			createRunner: (config, chatRunnerType) => {
				const runnerType =
					chatRunnerType ?? this.runnerSelectionService.getDefaultRunner();
				return this.createRunnerForType(runnerType, {
					...config,
					model: this.getDefaultModelForRunner(runnerType),
					fallbackModel: this.getDefaultFallbackModelForRunner(runnerType),
				});
			},
			getPlatformMcpConfigOverrides,
			getStrictMcpConfig: () => this.config.strictMcpConfig,
			resolveSkillsConfig: async ({ repository, repositoryPaths }) => {
				const plugins = await this.skillsPluginResolver.resolve();
				const skills = await this.skillsPluginResolver.discoverSkillNames(
					plugins,
					{
						repositoryId: repository?.id,
						repoPaths: repositoryPaths,
					},
				);
				return { plugins, skills };
			},
			getOpenCodeGlobalConfig: () => this.config.opencode?.config,
			getOpenCodeGlobalStateScope: () => this.config.opencode?.stateScope,
			onWebhookStart: () => {
				this.activeWebhookCount++;
			},
			onWebhookEnd: () => {
				this.activeWebhookCount--;
			},
			onStateChange: () => this.savePersistedState(),
			onClaudeError: (error) => this.handleClaudeError(error),
		};
	}

	/**
	 * Every chat platform handler that is actually registered.
	 *
	 * Slack is always registered; Zulip only when it is configured. Aggregate
	 * queries (busy check, runner enumeration, session enumeration) go through
	 * here so adding a chat platform does not mean hunting down every call site.
	 */
	private get activeChatSessionHandlers(): Array<
		| ChatSessionHandler<SlackWebhookEvent>
		| ChatSessionHandler<ZulipWebhookEvent>
	> {
		return [this.chatSessionHandler, this.zulipChatSessionHandler].filter(
			(handler) => handler !== null,
		);
	}

	/**
	 * Register the Zulip event transport, if Zulip is configured.
	 *
	 * Unlike Slack, this is conditional: a Zulip outgoing webhook has no URL
	 * verification handshake to answer during onboarding, so there is nothing
	 * to gain from mounting the route before credentials exist. All four
	 * values are required — the site, bot email and API key are how replies
	 * get posted, and the token is the only thing authenticating an inbound
	 * request.
	 */
	private registerZulipEventTransport(): void {
		const site = process.env.ZULIP_SITE?.trim();
		const botEmail = process.env.ZULIP_BOT_EMAIL?.trim();
		const apiKey = process.env.ZULIP_API_KEY?.trim();
		const token = process.env.ZULIP_WEBHOOK_TOKEN?.trim();

		if (!site || !botEmail || !apiKey || !token) {
			return;
		}

		const chatRepositoryProvider = new LiveChatRepositoryProvider(
			this.repositories,
			() => this.config.linearWorkspaces || {},
		);

		const zulipAdapter = new ZulipChatAdapter(
			chatRepositoryProvider,
			this.logger,
			{
				repositoryRoutingContext:
					this.promptBuilder.generateRoutingContextForAllWorkspaces(),
			},
		);

		this.zulipChatSessionHandler = new ChatSessionHandler(
			zulipAdapter,
			this.buildChatSessionHandlerDeps(
				chatRepositoryProvider,
				() => this.config.zulipMcpConfigs,
			),
			this.logger,
		);

		this.zulipEventTransport = new ZulipEventTransport(
			{
				fastifyServer: this.sharedApplicationServer.getFastifyInstance(),
				token,
				credentials: { site, botEmail, apiKey },
			},
			this.logger,
		);

		this.zulipEventTransport.on("event", (event: ZulipWebhookEvent) => {
			this.zulipChatSessionHandler!.handleEvent(event).catch((error) => {
				this.logger.error(
					"Failed to handle Zulip webhook",
					error instanceof Error ? error : new Error(String(error)),
				);
			});
		});
		this.zulipEventTransport.on("error", (error: Error) => {
			this.handleError(error);
		});

		this.zulipEventTransport.register();

		this.logger.info("Zulip event transport registered");
	}

	/**
	 * Register the Slack event transport for receiving forwarded Slack webhooks from CYHOST.
	 * This creates a /slack-webhook endpoint that handles @mention events from Slack.
	 */
	private registerSlackEventTransport(): void {
		// Live provider reads from the repository map on demand — no snapshot needed
		const chatRepositoryProvider = new LiveChatRepositoryProvider(
			this.repositories,
			() => this.config.linearWorkspaces || {},
		);

		const routingContext =
			this.promptBuilder.generateRoutingContextForAllWorkspaces();
		// Only managed teams (cloud or self-hosted, paired with cyrus-hosted)
		// have a Behaviours page where automatic Slack thread listening can be
		// turned off — CYRUS_API_KEY is proof of that pairing, so the
		// stop-listening prompt guidance is gated on it. Community members
		// don't have the key (or the page).
		const cyrusAppBaseUrl = process.env.CYRUS_API_KEY
			? getCyrusAppUrl()
			: undefined;
		const slackAdapter = new SlackChatAdapter(
			chatRepositoryProvider,
			this.logger,
			{ repositoryRoutingContext: routingContext, cyrusAppBaseUrl },
		);

		if (
			!chatRepositoryProvider.getDefaultLinearWorkspaceId() ||
			!chatRepositoryProvider.getDefaultRepository()
		) {
			this.logger.warn(
				"No repositories or workspaces configured — Slack sessions will not have access to MCP tools",
			);
		}

		this.chatSessionHandler = new ChatSessionHandler(
			slackAdapter,
			this.buildChatSessionHandlerDeps(
				chatRepositoryProvider,
				// Live read so hot-reloaded config (`setConfig`) picks up new
				// per-platform MCP paths without rebuilding the handler.
				() => this.config.slackMcpConfigs,
			),
			this.logger,
		);

		// Use direct Slack signature verification only when BOTH:
		// 1. SLACK_SIGNING_SECRET is set (we have the secret to verify)
		// 2. CYRUS_HOST_EXTERNAL is true (self-hosted: Slack sends directly to us)
		// On cloud droplets, CYHOST forwards webhooks with Bearer token auth
		// (it verifies the Slack signature itself and doesn't forward the headers).
		const isExternalHost =
			process.env.CYRUS_HOST_EXTERNAL?.toLowerCase().trim() === "true";
		const hasSlackSigningSecret =
			process.env.SLACK_SIGNING_SECRET != null &&
			process.env.SLACK_SIGNING_SECRET !== "";
		const useDirectSlackWebhooks = isExternalHost && hasSlackSigningSecret;

		const slackVerificationMode = useDirectSlackWebhooks ? "direct" : "proxy";
		const slackSecret = useDirectSlackWebhooks
			? process.env.SLACK_SIGNING_SECRET!
			: process.env.CYRUS_API_KEY || "";

		this.slackEventTransport = new SlackEventTransport({
			fastifyServer: this.sharedApplicationServer.getFastifyInstance(),
			verificationMode: slackVerificationMode,
			secret: slackSecret,
			// Live read so the per-team toggle (hot-reloaded via config) and the
			// env kill-switch both take effect without rebuilding the transport.
			isThreadFollowingEnabled: () => this.isSlackThreadFollowingEnabled(),
		});

		this.slackEventTransport.on("event", (event: SlackWebhookEvent) => {
			this.chatSessionHandler!.handleEvent(event).catch((error) => {
				this.logger.error(
					"Failed to handle Slack webhook",
					error instanceof Error ? error : new Error(String(error)),
				);
			});
		});
		this.slackEventTransport.on("message", (message: InternalMessage) => {
			this.handleMessage(message);
		});
		this.slackEventTransport.on("error", (error: Error) => {
			this.handleError(error);
		});

		this.slackEventTransport.register();

		this.logger.info(
			`Slack event transport registered (${slackVerificationMode} mode)`,
		);
	}

	/**
	 * Handle a GitHub webhook event (forwarded from CYHOST).
	 *
	 * This creates a new session for the GitHub PR comment, checks out the PR branch
	 * via git worktree, and processes the comment as a task prompt.
	 */
	/**
	 * Resolve a GitHub API token from (in priority order):
	 * 1. Forwarded installation token from CYHOST (cloud/proxy mode)
	 * 2. Self-minted installation token from GitHub App credentials (self-hosted)
	 * 3. Personal access token from GITHUB_TOKEN env var (fallback)
	 */
	private async resolveGitHubToken(
		event: GitHubWebhookEvent,
	): Promise<string | undefined> {
		if (event.installationToken) return event.installationToken;
		if (this.gitHubAppTokenProvider) {
			try {
				return await this.gitHubAppTokenProvider.getToken();
			} catch (error) {
				this.logger.warn(
					"Failed to mint GitHub App installation token, falling back to GITHUB_TOKEN",
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		}
		return process.env.GITHUB_TOKEN;
	}

	private async handleGitHubWebhook(
		event: GitHubCommentWebhookEvent,
		reservedGitHubPrSlot = false,
	): Promise<void> {
		this.activeWebhookCount++;
		let githubPrQueueKey: string | undefined;
		let hasReservedGitHubPrSlot = reservedGitHubPrSlot;
		let githubPrSlotReleased = false;

		try {
			// Only handle comments on pull requests
			if (!isCommentOnPullRequest(event)) {
				this.logger.debug("Ignoring GitHub comment on non-PR issue");
				return;
			}

			const repoFullName = extractRepoFullName(event);
			const prNumber = extractPRNumber(event);
			const commentBody = extractCommentBody(event);
			const commentAuthor = extractCommentAuthor(event);
			const prTitle = extractPRTitle(event);
			const sessionKey = extractSessionKey(event);
			githubPrQueueKey = sessionKey;

			const isPullRequestReview = isPullRequestReviewPayload(event.payload);

			// Skip comments from the bot itself to prevent infinite loops
			const botUsername = process.env.GITHUB_BOT_USERNAME;
			if (botUsername && commentAuthor === botUsername) {
				this.logger.debug(
					`Ignoring comment from bot user @${botUsername} on ${repoFullName}#${prNumber}`,
				);
				return;
			}

			// For pull_request_review events, defensively check review state
			// (must happen before the mention check — reviews don't contain @mentions)
			if (isPullRequestReviewPayload(event.payload)) {
				if (event.payload.review.state !== "changes_requested") {
					this.logger.debug(
						`Ignoring pull_request_review with state: ${event.payload.review.state}`,
					);
					return;
				}
			}

			// Honor the PR-review trigger toggle: when disabled, ignore
			// pull_request_review events entirely — no acknowledgement comment and
			// no agent session. Defaults to enabled when the flag is unset.
			if (isPullRequestReview && this.config.prReviewTrigger === false) {
				this.logger.debug(
					`PR review trigger is disabled, ignoring pull_request_review on ${repoFullName}#${prNumber}`,
				);
				return;
			}

			// Only trigger on comments that mention the bot (when configured)
			// Skip this check for pull_request_review events — reviews don't @mention the bot
			if (
				!isPullRequestReview &&
				botUsername &&
				!commentBody.includes(`@${botUsername}`)
			) {
				this.logger.debug(
					`Ignoring comment without @${botUsername} mention on ${repoFullName}#${prNumber}`,
				);
				return;
			}

			this.logger.info(
				`Processing GitHub webhook: ${repoFullName}#${prNumber} by @${commentAuthor}${isPullRequestReview ? " (pull_request_review)" : ""}`,
			);

			// Add "eyes" reaction to acknowledge receipt (not for pull_request_review — we post a comment instead)
			const reactionToken = await this.resolveGitHubToken(event);
			if (reactionToken && !isPullRequestReview) {
				const commentId = extractCommentId(event);
				if (commentId) {
					this.gitHubCommentService
						.addReaction({
							token: reactionToken,
							owner: extractRepoOwner(event),
							repo: extractRepoName(event),
							commentId,
							isPullRequestReviewComment: isPullRequestReviewCommentPayload(
								event.payload,
							),
							content: "eyes",
						})
						.catch((err: unknown) => {
							this.logger.warn(
								`Failed to add reaction: ${err instanceof Error ? err.message : err}`,
							);
						});
				}
			}

			// Find the repository configuration that matches this GitHub repo
			const repository = this.findRepositoryByGitHubUrl(repoFullName);
			if (!repository) {
				this.logger.warn(
					`No repository configured for GitHub repo: ${repoFullName}`,
				);

				// Only reply on signals where the user clearly directed something at us:
				// an explicit @-mention, or a pull_request_review requesting changes.
				const wasMentioned =
					!!botUsername && commentBody.includes(`@${botUsername}`);
				const shouldReply = wasMentioned || isPullRequestReview;

				if (shouldReply && reactionToken && prNumber) {
					// Presence of CYRUS_API_KEY indicates this worker is paired with the
					// managed control plane (paid customer). Absence means the worker is
					// running on the Community plan (self-managed config.json).
					const isManagedCustomer = !!process.env.CYRUS_API_KEY;

					const commonPreamble = [
						`Cyrus received this webhook but has no repository configured for \`${repoFullName}\`, so no agent session was started.`,
						``,
						`**Likely causes:**`,
						`- The owner/org was **renamed or transferred** on GitHub. Webhooks are delivered under the current owner name, but Cyrus's stored repository URL still points at the old one. GitHub's web redirects don't apply to webhook payloads — the stored URL has to be updated explicitly.`,
						`- The stored repository URL has a typo (e.g. wrong org/owner) and doesn't match the repo this event came from.`,
						`- The GitHub App / webhook is installed on a repo Cyrus isn't configured for at all.`,
						``,
					];

					const fix = isManagedCustomer
						? `**What to do:** there's currently no self-serve way to update the stored repository URL on your plan — please reach out to Cyrus support and reference \`${repoFullName}\` and we'll reconcile it on the backend.`
						: `**What to do:** open \`~/.cyrus/config.json\` on the worker and update the \`githubUrl\` of the relevant repository to \`https://github.com/${repoFullName}\`. The worker watches the config file and will pick up the change automatically. If this repo shouldn't be sending events to Cyrus at all, remove the GitHub App from it instead.`;

					this.gitHubCommentService
						.postIssueComment({
							token: reactionToken,
							owner: extractRepoOwner(event),
							repo: extractRepoName(event),
							issueNumber: prNumber,
							body: [...commonPreamble, fix].join("\n"),
						})
						.catch((err: unknown) => {
							this.logger.warn(
								`Failed to post unconfigured-repo notice: ${err instanceof Error ? err.message : err}`,
							);
						});
				}
				return;
			}

			const agentSessionManager = this.agentSessionManager;

			if (!reservedGitHubPrSlot) {
				if (this.activeGitHubPrSessions.has(sessionKey)) {
					const queue = this.queuedGitHubPrEvents.get(sessionKey) ?? [];
					queue.push(event);
					this.queuedGitHubPrEvents.set(sessionKey, queue);
					this.logger.info(
						`Queued GitHub webhook for ${repoFullName}#${prNumber}; ${queue.length} event(s) waiting`,
					);

					if (reactionToken && prNumber) {
						this.gitHubCommentService
							.postIssueComment({
								token: reactionToken,
								owner: extractRepoOwner(event),
								repo: extractRepoName(event),
								issueNumber: prNumber,
								body: "Received your request. It is queued and will start after Cyrus finishes the current task on this PR.",
							})
							.catch((err: unknown) => {
								this.logger.warn(
									`Failed to post queued acknowledgement: ${err instanceof Error ? err.message : err}`,
								);
							});
					}
					return;
				}

				this.activeGitHubPrSessions.add(sessionKey);
				hasReservedGitHubPrSlot = true;
			}

			// For pull_request_review events, post an instant acknowledgement comment
			if (isPullRequestReview && reactionToken && prNumber) {
				this.gitHubCommentService
					.postIssueComment({
						token: reactionToken,
						owner: extractRepoOwner(event),
						repo: extractRepoName(event),
						issueNumber: prNumber,
						body: "Received your change request. Getting started on those changes now.",
					})
					.catch((err: unknown) => {
						this.logger.warn(
							`Failed to post acknowledgement comment: ${err instanceof Error ? err.message : err}`,
						);
					});
			}

			// Determine the PR head branch and base branch
			let branchRef = extractPRBranchRef(event);
			let baseBranchRef = extractPRBaseBranchRef(event);

			// For issue_comment events, the branch refs are not in the payload
			// We need to fetch them from the GitHub API
			if (!branchRef && isIssueCommentPayload(event.payload)) {
				const refs = await this.fetchPRBranchRefs(event, repository);
				branchRef = refs?.headRef ?? null;
				baseBranchRef = refs?.baseRef ?? null;
			}

			if (!branchRef || !prNumber) {
				this.logger.error(
					`Could not determine branch or PR number for ${repoFullName}#${prNumber}`,
				);
				return;
			}

			// For pull_request_review, the review body IS the task context (no mention to strip)
			// For other events, strip the bot mention to get the task instructions
			const mentionHandle = botUsername ? `@${botUsername}` : "@cyrusagent";
			const taskInstructions = isPullRequestReview
				? commentBody ||
					"A reviewer has requested changes on this PR. Read the review comments to understand what needs to be changed."
				: stripMention(commentBody, mentionHandle);

			// Check for an existing multi-repo session that includes this repository.
			// If found, use its sub-worktree instead of creating a new workspace.
			let workspace: { path: string; isGitWorktree: boolean } | null = null;
			const multiRepoSession =
				agentSessionManager.getActiveMultiRepoSessionForRepository(
					repository.id,
				);

			if (multiRepoSession) {
				const subWorktreePath =
					multiRepoSession.workspace.repoPaths?.[repository.id];
				if (subWorktreePath) {
					workspace = { path: subWorktreePath, isGitWorktree: true };
					this.logger.info(
						`Resolved multi-repo sub-worktree for ${repository.name}: ${subWorktreePath}`,
					);
				} else {
					this.logger.warn(
						`No sub-worktree found for repo ${repository.name} in multi-repo session ${multiRepoSession.id}, falling back to root workspace`,
					);
					workspace = {
						path: multiRepoSession.workspace.path,
						isGitWorktree: true,
					};
				}
			} else {
				// Single-repo or no existing session: create workspace as before
				workspace = await this.createGitHubWorkspace(
					repository,
					branchRef,
					prNumber,
				);
			}

			if (!workspace) {
				this.logger.error(
					`Failed to create workspace for ${repoFullName}#${prNumber}`,
				);
				return;
			}

			this.logger.info(`GitHub workspace created at: ${workspace.path}`);

			// Create a synthetic session for this GitHub PR comment
			const issueMinimal: IssueMinimal = {
				id: sessionKey,
				identifier: `${extractRepoName(event)}#${prNumber}`,
				title: prTitle || `PR #${prNumber}`,
				branchName: branchRef,
			};

			// Create an internal agent session (no Linear session for GitHub)
			const githubSessionId = `github-${event.deliveryId}`;
			agentSessionManager.createCyrusAgentSession(
				githubSessionId,
				sessionKey,
				issueMinimal,
				workspace,
				"github", // Don't stream activities to Linear for GitHub sources
				[
					{
						repositoryId: repository.id,
						branchName: branchRef,
						baseBranchName: baseBranchRef ?? repository.baseBranch,
					},
				],
			);

			// Register session-to-repo mapping and activity sink
			this.sessionRepositories.set(githubSessionId, repository.id);
			const activitySink = this.getActivitySinkForRepo(repository.id);
			if (activitySink) {
				agentSessionManager.setActivitySink(githubSessionId, activitySink);
			}

			const session = agentSessionManager.getSession(githubSessionId);
			if (!session) {
				this.logger.error(
					`Failed to create session for GitHub webhook ${event.deliveryId}`,
				);
				return;
			}

			// Initialize session metadata
			if (!session.metadata) {
				session.metadata = {};
			}

			// Store GitHub-specific metadata for reply posting
			session.metadata.commentId = String(extractCommentId(event));

			// Build the system prompt for this GitHub PR session
			const systemPrompt = isPullRequestReview
				? this.buildGitHubChangeRequestSystemPrompt(
						event,
						branchRef,
						taskInstructions,
					)
				: this.buildGitHubSystemPrompt(event, branchRef, taskInstructions);

			// Build allowed tools using the GitHub platform resolver, which honors
			// `githubAllowedTools` on the workspace config and falls back to
			// `GITHUB_DEFAULT_ALLOWED_TOOLS` (which intentionally omits
			// `mcp__slack` — no subtractive filtering needed).
			const allowedTools =
				this.toolPermissionResolver.buildGithubAllowedTools(repository);
			const disallowedTools = this.buildDisallowedTools(repository);
			const allowedDirectories: string[] = [repository.repositoryPath];

			// Create agent runner using the standard config builder
			const { config: runnerConfig, runnerType } =
				await this.buildAgentRunnerConfig(
					session,
					repository,
					githubSessionId,
					systemPrompt,
					allowedTools,
					allowedDirectories,
					disallowedTools,
					undefined, // resumeSessionId
					undefined, // labels
					undefined, // issueDescription
					200, // maxTurns
					undefined, // linearWorkspaceId
					this.buildSkillSessionContext(repository, undefined, session),
					"github", // sessionPlatform → uses githubMcpConfigs override
				);

			// A runner's start() promise can remain open after a successful turn
			// (for example, warm Claude sessions). Advance the PR queue on the
			// terminal result instead, so one held-open process cannot block later
			// GitHub requests for the same worktree indefinitely.
			const onMessage = runnerConfig.onMessage;
			let githubReplyPosted = false;
			let runner: IAgentRunner;
			runnerConfig.onMessage = async (message: SDKMessage) => {
				try {
					await onMessage?.(message);
				} finally {
					if (message.type === "result" && !githubReplyPosted) {
						githubReplyPosted = true;
						this.postGitHubReply(event, runner, repository).catch((error) => {
							this.logger.error(
								`Failed to post GitHub reply to ${repoFullName}#${prNumber}`,
								error instanceof Error ? error : new Error(String(error)),
							);
						});
						runner.completeStream?.();
						if (hasReservedGitHubPrSlot && githubPrQueueKey) {
							this.advanceGitHubPrQueue(githubPrQueueKey);
							githubPrSlotReleased = true;
						}
					}
				}
			};

			runner = this.createRunnerForType(runnerType, runnerConfig);

			// Store the runner in the session manager
			agentSessionManager.addAgentRunner(githubSessionId, runner);

			// Save persisted state
			await this.savePersistedState();

			this.emit(
				"session:started",
				sessionKey,
				issueMinimal as unknown as Issue,
				repository.id,
			);

			this.logger.info(
				`Starting ${runnerType} runner for GitHub PR ${repoFullName}#${prNumber}`,
			);

			// Start the session and handle completion
			try {
				const sessionInfo = await runner.start(taskInstructions);
				this.logger.info(`GitHub session started: ${sessionInfo.sessionId}`);

				// A runner that exits before emitting a result still needs a reply.
				if (!githubReplyPosted) {
					githubReplyPosted = true;
					await this.postGitHubReply(event, runner, repository);
				}
			} catch (error) {
				this.logger.error(
					`GitHub session error for ${repoFullName}#${prNumber}`,
					error instanceof Error ? error : new Error(String(error)),
				);
			} finally {
				await this.savePersistedState();
			}
		} catch (error) {
			this.logger.error(
				"Failed to process GitHub webhook",
				error instanceof Error ? error : new Error(String(error)),
			);
		} finally {
			if (
				hasReservedGitHubPrSlot &&
				githubPrQueueKey &&
				!githubPrSlotReleased
			) {
				this.advanceGitHubPrQueue(githubPrQueueKey);
			}
			this.activeWebhookCount--;
		}
	}

	private advanceGitHubPrQueue(sessionKey: string): void {
		const queue = this.queuedGitHubPrEvents.get(sessionKey);
		const nextEvent = queue?.shift();
		if (queue && queue.length === 0) {
			this.queuedGitHubPrEvents.delete(sessionKey);
		}

		if (nextEvent) {
			// Keep the slot reserved while the next event starts to prevent a newly
			// arrived webhook from overtaking the FIFO queue.
			this.handleGitHubWebhook(nextEvent, true).catch((error) => {
				this.logger.error(
					"Failed to process queued GitHub webhook",
					error instanceof Error ? error : new Error(String(error)),
				);
			});
		} else {
			this.activeGitHubPrSessions.delete(sessionKey);
		}
	}

	/**
	 * Handle GitHub push webhook events.
	 * When a base branch receives new commits, find active sessions tracking that
	 * branch and stream a rebase notification to the running agent.
	 */
	private async handleGitHubPushWebhook(
		payload: GitHubPushPayload,
	): Promise<void> {
		// Only handle branch pushes (refs/heads/*), not tags
		if (!payload.ref.startsWith("refs/heads/")) {
			return;
		}

		// Ignore branch deletions
		if (payload.deleted) {
			return;
		}

		const branchName = payload.ref.replace("refs/heads/", "");
		const repoFullName = payload.repository.full_name;

		// Find the matching repository config
		const repository = this.findRepositoryByGitHubUrl(repoFullName);
		if (!repository) {
			this.logger.debug(
				`No repository configured for GitHub push from ${repoFullName}`,
			);
			return;
		}

		// Find active sessions tracking this branch as their base branch
		const sessions = this.agentSessionManager.getSessionsByBaseBranch(
			branchName,
			repository.id,
		);

		if (sessions.length === 0) {
			this.logger.debug(
				`No active sessions tracking base branch ${branchName} for ${repository.name}`,
			);
			return;
		}

		// Build a notification prompt with commit summary
		const commitCount = payload.commits.length;
		const commitSummary = payload.commits
			.slice(0, 5)
			.map((c) => `- ${c.message.split("\n")[0]}`)
			.join("\n");
		const moreCommits =
			commitCount > 5 ? `\n- ... and ${commitCount - 5} more` : "";

		const notification = `<base_branch_update>
<branch>${branchName}</branch>
<repository>${repoFullName}</repository>
<commit_count>${commitCount}</commit_count>
<compare_url>${payload.compare}</compare_url>
<commits>
${commitSummary}${moreCommits}
</commits>
<guidance>
Your base branch \`${branchName}\` has received ${commitCount} new commit(s). Consider rebasing your working branch onto the updated base to avoid merge conflicts. You can do this with: \`git fetch origin && git rebase origin/${branchName}\`
</guidance>
</base_branch_update>`;

		this.logger.info(
			`Base branch ${branchName} updated (${commitCount} commits) — notifying ${sessions.length} active session(s)`,
		);

		// Stream notification to the first running session that supports streaming
		const sortedSessions = [...sessions].sort(
			(a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
		);

		for (const session of sortedSessions) {
			const existingRunner = session.agentRunner;
			const isRunning = existingRunner?.isRunning() || false;

			if (
				isRunning &&
				existingRunner?.supportsStreamingInput &&
				existingRunner.addStreamMessage
			) {
				// Best-effort notification; a steer-only backend may reject it if no
				// turn is active. Don't let that throw out of the update handler.
				try {
					existingRunner.addStreamMessage(notification);
					this.logger.debug(
						`[base-branch-update] Streamed notification to session ${session.id} for branch ${branchName}`,
					);
					break;
				} catch (error) {
					this.logger.debug(
						`[base-branch-update] Stream rejected for session ${session.id}; skipping`,
						{ error: error instanceof Error ? error.message : String(error) },
					);
				}
			}
		}
	}

	/**
	 * Find a repository configuration that matches a GitHub repository URL.
	 * Matches against the githubUrl field in repository config.
	 */
	private findRepositoryByGitHubUrl(
		repoFullName: string,
	): RepositoryConfig | null {
		for (const repo of this.repositories.values()) {
			if (!repo.githubUrl) continue;
			// Match against full name (owner/repo) or URL containing it
			if (
				repo.githubUrl.includes(repoFullName) ||
				repo.githubUrl.endsWith(`/${repoFullName}`)
			) {
				return repo;
			}
		}
		return null;
	}

	/**
	 * Fetch the PR head and base branch refs for an issue_comment webhook.
	 * For issue_comment events, the branch refs are not in the payload
	 * and must be fetched from the GitHub API.
	 */
	private async fetchPRBranchRefs(
		event: GitHubCommentWebhookEvent,
		_repository: RepositoryConfig,
	): Promise<{ headRef: string; baseRef: string } | null> {
		if (!isIssueCommentPayload(event.payload)) return null;

		const prUrl = event.payload.issue.pull_request?.url;
		if (!prUrl) return null;

		try {
			const owner = extractRepoOwner(event);
			const repo = extractRepoName(event);
			const prNumber = event.payload.issue.number;

			const headers: Record<string, string> = {
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			};

			// Resolve GitHub token (installation token > App token > PAT)
			const token = await this.resolveGitHubToken(event);
			if (token) {
				headers.Authorization = `Bearer ${token}`;
			}

			const response = await fetch(
				`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
				{ headers },
			);

			if (!response.ok) {
				this.logger.warn(
					`Failed to fetch PR details from GitHub API: ${response.status}`,
				);
				return null;
			}

			const prData = (await response.json()) as {
				head?: { ref?: string };
				base?: { ref?: string };
			};
			const headRef = prData.head?.ref;
			const baseRef = prData.base?.ref;
			if (!headRef) return null;
			return { headRef, baseRef: baseRef ?? "" };
		} catch (error) {
			this.logger.error(
				"Failed to fetch PR branch refs",
				error instanceof Error ? error : new Error(String(error)),
			);
			return null;
		}
	}

	/**
	 * Create a git worktree for a GitHub PR branch.
	 * If the worktree already exists for this branch, reuse it.
	 */
	private async createGitHubWorkspace(
		repository: RepositoryConfig,
		branchRef: string,
		prNumber: number,
	): Promise<{ path: string; isGitWorktree: boolean } | null> {
		try {
			// Use the GitService to create the worktree
			// Create a synthetic issue-like object for the git service
			const syntheticIssue = {
				id: `github-pr-${prNumber}`,
				identifier: `PR-${prNumber}`,
				title: `PR #${prNumber}`,
				description: null,
				url: "",
				branchName: branchRef,
				assigneeId: null,
				stateId: null,
				teamId: null,
				labelIds: [],
				priority: 0,
				createdAt: new Date(),
				updatedAt: new Date(),
				archivedAt: null,
				state: Promise.resolve(undefined),
				assignee: Promise.resolve(undefined),
				team: Promise.resolve(undefined),
				parent: Promise.resolve(undefined),
				project: Promise.resolve(undefined),
				labels: () => Promise.resolve({ nodes: [] }),
				comments: () => Promise.resolve({ nodes: [] }),
				attachments: () => Promise.resolve({ nodes: [] }),
				children: () => Promise.resolve({ nodes: [] }),
				inverseRelations: () => Promise.resolve({ nodes: [] }),
				update: () =>
					Promise.resolve({
						success: true,
						issue: undefined,
						lastSyncId: 0,
					}),
			} as unknown as Issue;

			return await this.gitService.createGitWorktree(syntheticIssue, [
				repository,
			]);
		} catch (error) {
			this.logger.error(
				`Failed to create GitHub workspace for PR #${prNumber}`,
				error instanceof Error ? error : new Error(String(error)),
			);
			return null;
		}
	}

	/**
	 * Build a system prompt for a GitHub PR comment session.
	 */
	private buildGitHubSystemPrompt(
		event: GitHubCommentWebhookEvent,
		branchRef: string,
		taskInstructions: string,
	): string {
		const repoFullName = extractRepoFullName(event);
		const prNumber = extractPRNumber(event);
		const prTitle = extractPRTitle(event);
		const commentAuthor = extractCommentAuthor(event);
		const commentUrl = extractCommentUrl(event);

		return `You are working on a GitHub Pull Request.

## Context
- **Repository**: ${repoFullName}
- **PR**: #${prNumber} - ${prTitle || "Untitled"}
- **Branch**: ${branchRef}
- **Requested by**: @${commentAuthor}
- **Comment URL**: ${commentUrl}

## Task
${taskInstructions}

## Instructions
- You are already checked out on the PR branch \`${branchRef}\`
- Make changes directly to the code on this branch
- After making changes, commit and push them to the branch
- Be concise in your responses as they will be posted back to the GitHub PR`;
	}

	/**
	 * Build a system prompt for a GitHub PR change request review session.
	 */
	private buildGitHubChangeRequestSystemPrompt(
		event: GitHubCommentWebhookEvent,
		branchRef: string,
		reviewBody: string,
	): string {
		const repoFullName = extractRepoFullName(event);
		const prNumber = extractPRNumber(event);
		const prTitle = extractPRTitle(event);
		const commentAuthor = extractCommentAuthor(event);
		const commentUrl = extractCommentUrl(event);

		const hasReviewBody = reviewBody.trim().length > 0;

		const taskSection = hasReviewBody
			? `## Reviewer Feedback
${reviewBody}

## Instructions
- Read the PR diff and the reviewer's feedback above to understand all requested changes
- You are already checked out on the PR branch \`${branchRef}\`
- Address all the reviewer's feedback and make the necessary changes
- After making changes, commit and push them to the branch
- Respond with a concise summary of the changes you made`
			: `## Instructions
- The reviewer has requested changes but did not leave a summary comment
- Use \`gh api repos/${repoFullName}/pulls/${prNumber}/reviews\` to read the review comments and understand what changes are needed
- You are already checked out on the PR branch \`${branchRef}\`
- Address all the reviewer's feedback and make the necessary changes
- After making changes, commit and push them to the branch
- Respond with a concise summary of the changes you made`;

		return `You are working on a GitHub Pull Request that has received a change request review.

## Context
- **Repository**: ${repoFullName}
- **PR**: #${prNumber} - ${prTitle || "Untitled"}
- **Branch**: ${branchRef}
- **Reviewer**: @${commentAuthor}
- **Review URL**: ${commentUrl}

${taskSection}`;
	}

	/**
	 * Post a reply back to the GitHub PR comment after the session completes.
	 */
	private async postGitHubReply(
		event: GitHubCommentWebhookEvent,
		runner: IAgentRunner,
		_repository: RepositoryConfig,
	): Promise<void> {
		try {
			// Get the last assistant message from the runner as the summary
			const messages = runner.getMessages();
			const lastAssistantMessage = [...messages]
				.reverse()
				.find((m) => m.type === "assistant");

			let summary = "Task completed. Please review the changes on this branch.";
			if (
				lastAssistantMessage &&
				lastAssistantMessage.type === "assistant" &&
				"message" in lastAssistantMessage
			) {
				const msg = lastAssistantMessage as {
					message: { content: Array<{ type: string; text?: string }> };
				};
				const textBlock = msg.message.content?.find(
					(block) => block.type === "text" && block.text,
				);
				if (textBlock?.text) {
					summary = textBlock.text;
				}
			}

			const owner = extractRepoOwner(event);
			const repo = extractRepoName(event);
			const prNumber = extractPRNumber(event);
			const commentId = extractCommentId(event);

			if (!prNumber) {
				this.logger.warn("Cannot post GitHub reply: no PR number");
				return;
			}

			// Resolve GitHub token (installation token > App token > PAT)
			const token = await this.resolveGitHubToken(event);
			if (!token) {
				this.logger.warn(
					"Cannot post GitHub reply: no installation token or GITHUB_TOKEN configured",
				);
				this.logger.debug(
					`Would have posted reply to ${owner}/${repo}#${prNumber} (comment ${commentId}): ${summary}`,
				);
				return;
			}

			if (event.eventType === "pull_request_review_comment") {
				// Reply to the specific review comment thread
				await this.gitHubCommentService.postReviewCommentReply({
					token,
					owner,
					repo,
					pullNumber: prNumber,
					commentId,
					body: summary,
				});
			} else {
				// Post as a regular issue comment on the PR
				await this.gitHubCommentService.postIssueComment({
					token,
					owner,
					repo,
					issueNumber: prNumber,
					body: summary,
				});
			}

			this.logger.info(`Posted GitHub reply to ${owner}/${repo}#${prNumber}`);
		} catch (error) {
			this.logger.error(
				"Failed to post GitHub reply",
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	/**
	 * Handle an incoming GitLab webhook event (note on a merge request).
	 * Mirrors the GitHub webhook handler but uses GitLab-specific utilities.
	 */
	private async handleGitLabWebhook(event: GitLabWebhookEvent): Promise<void> {
		this.activeWebhookCount++;

		try {
			// Only handle notes on merge requests
			if (!isNoteOnMergeRequest(event)) {
				this.logger.debug(
					"Ignoring GitLab event: not a note on a merge request",
				);
				return;
			}

			const projectPath = extractProjectPath(event);
			const mrIid = extractMRIid(event);
			const noteBody = extractNoteBody(event);
			const noteAuthor = extractNoteAuthor(event);
			const mrTitle = extractMRTitle(event);
			const sessionKey = extractGitLabSessionKey(event);

			// Skip comments from the bot itself to prevent infinite loops
			const botUsername = process.env.GITLAB_BOT_USERNAME;
			if (botUsername && noteAuthor === botUsername) {
				this.logger.debug(
					`Ignoring note from bot user @${botUsername} on ${projectPath}!${mrIid}`,
				);
				return;
			}

			// Only trigger on notes that mention the bot (when configured)
			if (botUsername && !noteBody.includes(`@${botUsername}`)) {
				this.logger.debug(
					`Ignoring note without @${botUsername} mention on ${projectPath}!${mrIid}`,
				);
				return;
			}

			this.logger.info(
				`Processing GitLab webhook: ${projectPath}!${mrIid} by @${noteAuthor}`,
			);

			// Add "eyes" emoji reaction to acknowledge receipt
			const reactionToken =
				event.accessToken || process.env.GITLAB_ACCESS_TOKEN;
			const noteId = extractNoteId(event);
			const projectId = extractProjectId(event);
			if (reactionToken && noteId && projectId && mrIid) {
				this.gitLabCommentService
					.addAwardEmoji({
						token: reactionToken,
						projectId,
						mrIid,
						noteId,
						name: "eyes",
					})
					.catch((err: unknown) => {
						this.logger.warn(
							`Failed to add GitLab emoji reaction: ${err instanceof Error ? err.message : err}`,
						);
					});
			}

			// Find the repository configuration that matches this GitLab project
			const repository = this.findRepositoryByGitLabUrl(projectPath);
			if (!repository) {
				this.logger.warn(
					`No repository configured for GitLab project: ${projectPath}`,
				);
				return;
			}

			const agentSessionManager = this.agentSessionManager;

			// Branch refs are available directly from the MR payload
			const branchRef = extractMRBranchRef(event);
			const baseBranchRef = extractMRBaseBranchRef(event);

			if (!branchRef || !mrIid) {
				this.logger.error(
					`Could not determine branch or MR iid for ${projectPath}!${mrIid}`,
				);
				return;
			}

			// Strip the bot mention to get the task instructions
			const mentionHandle = botUsername ? `@${botUsername}` : "@cyrusagent";
			const taskInstructions = stripGitLabMention(noteBody, mentionHandle);

			// Check for an existing multi-repo session that includes this repository
			let workspace: { path: string; isGitWorktree: boolean } | null = null;
			const multiRepoSession =
				agentSessionManager.getActiveMultiRepoSessionForRepository(
					repository.id,
				);

			if (multiRepoSession) {
				const subWorktreePath =
					multiRepoSession.workspace.repoPaths?.[repository.id];
				if (subWorktreePath) {
					workspace = {
						path: subWorktreePath,
						isGitWorktree: true,
					};
					this.logger.info(
						`Resolved multi-repo sub-worktree for ${repository.name}: ${subWorktreePath}`,
					);
				} else {
					this.logger.warn(
						`No sub-worktree found for repo ${repository.name} in multi-repo session ${multiRepoSession.id}, falling back to root workspace`,
					);
					workspace = {
						path: multiRepoSession.workspace.path,
						isGitWorktree: true,
					};
				}
			} else {
				// Single-repo or no existing session: create workspace
				workspace = await this.createGitLabWorkspace(
					repository,
					branchRef,
					mrIid,
				);
			}

			if (!workspace) {
				this.logger.error(
					`Failed to create workspace for ${projectPath}!${mrIid}`,
				);
				return;
			}

			this.logger.info(`GitLab workspace created at: ${workspace.path}`);

			// Check if another active session is already using this branch/workspace
			const existingSessions =
				agentSessionManager.getActiveSessionsByBranchName(branchRef);
			const firstExisting = existingSessions[0];
			if (firstExisting) {
				this.logger.warn(
					`Reusing workspace from active session ${firstExisting.id} — concurrent writes possible`,
				);
			}

			// Create a synthetic session for this GitLab MR note
			const issueMinimal: IssueMinimal = {
				id: sessionKey,
				identifier: `${projectPath}!${mrIid}`,
				title: mrTitle || `MR !${mrIid}`,
				branchName: branchRef,
			};

			// Create an internal agent session (no Linear session for GitLab)
			const gitlabSessionId = `gitlab-${Date.now()}`;
			agentSessionManager.createCyrusAgentSession(
				gitlabSessionId,
				sessionKey,
				issueMinimal,
				workspace,
				"gitlab", // Don't stream activities to Linear for GitLab sources
				[
					{
						repositoryId: repository.id,
						branchName: branchRef,
						baseBranchName: baseBranchRef ?? repository.baseBranch,
					},
				],
			);

			// Register session-to-repo mapping and activity sink
			this.sessionRepositories.set(gitlabSessionId, repository.id);
			const activitySink = this.getActivitySinkForRepo(repository.id);
			if (activitySink) {
				agentSessionManager.setActivitySink(gitlabSessionId, activitySink);
			}

			const session = agentSessionManager.getSession(gitlabSessionId);
			if (!session) {
				this.logger.error(
					`Failed to create session for GitLab webhook on ${projectPath}!${mrIid}`,
				);
				return;
			}

			// Initialize procedure metadata
			if (!session.metadata) {
				session.metadata = {};
			}

			// Store GitLab-specific metadata for reply posting
			// Reuse commentId for note ID (serves the same purpose across platforms)
			session.metadata.commentId = String(noteId);

			// Build the system prompt for this GitLab MR session
			// TODO: Use buildGitLabChangeRequestSystemPrompt for merge_request approval events
			const isMergeRequestEvent = event.eventType === "merge_request";
			const systemPrompt = isMergeRequestEvent
				? this.buildGitLabChangeRequestSystemPrompt(
						event,
						branchRef,
						taskInstructions,
					)
				: this.buildGitLabSystemPrompt(event, branchRef, taskInstructions);

			// Build allowed tools using the GitHub platform resolver — GitLab and
			// GitHub share the same PR-targeted, single-repo intent, so they use
			// the same `githubAllowedTools` knob and the same `GITHUB_*` default.
			const allowedTools =
				this.toolPermissionResolver.buildGithubAllowedTools(repository);
			const disallowedTools = this.buildDisallowedTools(repository);
			const allowedDirectories: string[] = [repository.repositoryPath];

			// Create agent runner using the standard config builder
			const { config: runnerConfig, runnerType } =
				await this.buildAgentRunnerConfig(
					session,
					repository,
					gitlabSessionId,
					systemPrompt,
					allowedTools,
					allowedDirectories,
					disallowedTools,
					undefined, // resumeSessionId
					undefined, // labels
					undefined, // issueDescription
					200, // maxTurns
					undefined, // linearWorkspaceId
					this.buildSkillSessionContext(repository, undefined, session),
					"gitlab", // sessionPlatform → uses githubMcpConfigs override
				);

			const runner = this.createRunnerForType(runnerType, runnerConfig);

			// Store the runner in the session manager
			agentSessionManager.addAgentRunner(gitlabSessionId, runner);

			// Save persisted state
			await this.savePersistedState();

			this.emit(
				"session:started",
				sessionKey,
				issueMinimal as unknown as Issue,
				repository.id,
			);

			this.logger.info(
				`Starting ${runnerType} runner for GitLab MR ${projectPath}!${mrIid}`,
			);

			// Start the session and handle completion
			try {
				const sessionInfo = await runner.start(taskInstructions);
				this.logger.info(`GitLab session started: ${sessionInfo.sessionId}`);

				// When session completes, post the reply back to GitLab
				await this.postGitLabReply(event, runner, repository);
			} catch (error) {
				this.logger.error(
					`GitLab session error for ${projectPath}!${mrIid}`,
					error instanceof Error ? error : new Error(String(error)),
				);
			} finally {
				await this.savePersistedState();
			}
		} catch (error) {
			this.logger.error(
				"Failed to process GitLab webhook",
				error instanceof Error ? error : new Error(String(error)),
			);
		} finally {
			this.activeWebhookCount--;
		}
	}

	/**
	 * Find a repository configuration that matches a GitLab project URL.
	 * Matches against the gitlabUrl field in repository config.
	 */
	private findRepositoryByGitLabUrl(
		projectPath: string,
	): RepositoryConfig | null {
		for (const repo of this.repositories.values()) {
			if (!repo.gitlabUrl) continue;
			if (
				repo.gitlabUrl.includes(projectPath) ||
				repo.gitlabUrl.endsWith(`/${projectPath}`)
			) {
				return repo;
			}
		}
		return null;
	}

	/**
	 * Create a git worktree for a GitLab MR branch.
	 * If the worktree already exists for this branch, reuse it.
	 */
	private async createGitLabWorkspace(
		repository: RepositoryConfig,
		branchRef: string,
		mrIid: number,
	): Promise<{ path: string; isGitWorktree: boolean } | null> {
		try {
			// Create a synthetic issue-like object for the git service
			const syntheticIssue = {
				id: `gitlab-mr-${mrIid}`,
				identifier: `MR-${mrIid}`,
				title: `MR !${mrIid}`,
				description: null,
				url: "",
				branchName: branchRef,
				assigneeId: null,
				stateId: null,
				teamId: null,
				labelIds: [],
				priority: 0,
				createdAt: new Date(),
				updatedAt: new Date(),
				archivedAt: null,
				state: Promise.resolve(undefined),
				assignee: Promise.resolve(undefined),
				team: Promise.resolve(undefined),
				parent: Promise.resolve(undefined),
				project: Promise.resolve(undefined),
				labels: () => Promise.resolve({ nodes: [] }),
				comments: () => Promise.resolve({ nodes: [] }),
				attachments: () => Promise.resolve({ nodes: [] }),
				children: () => Promise.resolve({ nodes: [] }),
				inverseRelations: () => Promise.resolve({ nodes: [] }),
				update: () =>
					Promise.resolve({
						success: true,
						issue: undefined,
						lastSyncId: 0,
					}),
			} as unknown as Issue;

			return await this.gitService.createGitWorktree(syntheticIssue, [
				repository,
			]);
		} catch (error) {
			this.logger.error(
				`Failed to create GitLab workspace for MR !${mrIid}`,
				error instanceof Error ? error : new Error(String(error)),
			);
			return null;
		}
	}

	/**
	 * Build a system prompt for a GitLab MR note session.
	 */
	private buildGitLabSystemPrompt(
		event: GitLabWebhookEvent,
		branchRef: string,
		taskInstructions: string,
	): string {
		const projectPath = extractProjectPath(event);
		const mrIid = extractMRIid(event);
		const mrTitle = extractMRTitle(event);
		const noteAuthor = extractNoteAuthor(event);
		const noteUrl = extractNoteUrl(event);

		return `You are working on a GitLab Merge Request.

## Context
- **Project**: ${projectPath}
- **MR**: !${mrIid} - ${mrTitle || "Untitled"}
- **Branch**: ${branchRef}
- **Requested by**: @${noteAuthor}
- **Note URL**: ${noteUrl}

## Task
${taskInstructions}

## Instructions
- You are already checked out on the MR branch \`${branchRef}\`
- Make changes directly to the code on this branch
- After making changes, commit and push them to the branch
- Use \`glab\` CLI commands for GitLab-specific operations
- Be concise in your responses as they will be posted back to the GitLab MR`;
	}

	/**
	 * Build a system prompt for a GitLab MR change request session.
	 */
	private buildGitLabChangeRequestSystemPrompt(
		event: GitLabWebhookEvent,
		branchRef: string,
		reviewBody: string,
	): string {
		const projectPath = extractProjectPath(event);
		const mrIid = extractMRIid(event);
		const mrTitle = extractMRTitle(event);
		const noteAuthor = extractNoteAuthor(event);
		const noteUrl = extractNoteUrl(event);

		const hasReviewBody = reviewBody.trim().length > 0;

		const taskSection = hasReviewBody
			? `## Reviewer Feedback
${reviewBody}

## Instructions
- Read the MR diff and the reviewer's feedback above to understand all requested changes
- You are already checked out on the MR branch \`${branchRef}\`
- Address all the reviewer's feedback and make the necessary changes
- After making changes, commit and push them to the branch
- Respond with a concise summary of the changes you made`
			: `## Instructions
- The reviewer has requested changes but did not leave a summary comment
- Use \`glab mr view ${mrIid}\` and \`glab mr diff ${mrIid}\` to review the MR context
- You are already checked out on the MR branch \`${branchRef}\`
- Address all the reviewer's feedback and make the necessary changes
- After making changes, commit and push them to the branch
- Respond with a concise summary of the changes you made`;

		return `You are working on a GitLab Merge Request that has received a change request review.

## Context
- **Project**: ${projectPath}
- **MR**: !${mrIid} - ${mrTitle || "Untitled"}
- **Branch**: ${branchRef}
- **Reviewer**: @${noteAuthor}
- **Note URL**: ${noteUrl}

${taskSection}`;
	}

	/**
	 * Post a reply back to the GitLab MR after the session completes.
	 */
	private async postGitLabReply(
		event: GitLabWebhookEvent,
		runner: IAgentRunner,
		_repository: RepositoryConfig,
	): Promise<void> {
		try {
			// Get the last assistant message from the runner as the summary
			const messages = runner.getMessages();
			const lastAssistantMessage = [...messages]
				.reverse()
				.find((m) => m.type === "assistant");

			let summary = "Task completed. Please review the changes on this branch.";
			if (
				lastAssistantMessage &&
				lastAssistantMessage.type === "assistant" &&
				"message" in lastAssistantMessage
			) {
				const msg = lastAssistantMessage as {
					message: {
						content: Array<{ type: string; text?: string }>;
					};
				};
				const textBlock = msg.message.content?.find(
					(block) => block.type === "text" && block.text,
				);
				if (textBlock?.text) {
					summary = textBlock.text;
				}
			}

			const projectId = extractProjectId(event);
			const mrIid = extractMRIid(event);
			const discussionId = extractDiscussionId(event);

			if (!mrIid) {
				this.logger.warn("Cannot post GitLab reply: no MR iid");
				return;
			}

			const token = event.accessToken || process.env.GITLAB_ACCESS_TOKEN;
			if (!token) {
				this.logger.warn(
					"Cannot post GitLab reply: no access token or GITLAB_ACCESS_TOKEN configured",
				);
				this.logger.debug(
					`Would have posted reply to ${extractProjectPath(event)}!${mrIid}: ${summary}`,
				);
				return;
			}

			if (discussionId) {
				// Reply to the specific discussion thread
				await this.gitLabCommentService.postDiscussionReply({
					token,
					projectId,
					mrIid,
					discussionId,
					body: summary,
				});
			} else {
				// Post as a top-level MR note
				await this.gitLabCommentService.postMRNote({
					token,
					projectId,
					mrIid,
					body: summary,
				});
			}

			this.logger.info(
				`Posted GitLab reply to ${extractProjectPath(event)}!${mrIid}`,
			);
		} catch (error) {
			this.logger.error(
				"Failed to post GitLab reply",
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	/**
	 * Compute the current status of the Cyrus process
	 * @returns "idle" if the process can be safely restarted, "busy" if work is in progress
	 */
	private computeStatus(): "idle" | "busy" {
		// Busy if any webhooks are currently being processed
		if (this.activeWebhookCount > 0) {
			return "busy";
		}

		// Busy if any runner is actively running
		const runners = this.agentSessionManager.getAllAgentRunners();
		for (const runner of runners) {
			if (runner.isRunning()) {
				return "busy";
			}
		}

		// Busy if any chat platform runner is actively running
		if (
			this.activeChatSessionHandlers.some((handler) =>
				handler.isAnyRunnerBusy(),
			)
		) {
			return "busy";
		}

		return "idle";
	}

	/**
	 * Test-only: dispatch a synthetic Slack webhook event through the chat
	 * session handler. Used by the F1 test harness to exercise the Slack →
	 * ClaudeRunner code path end-to-end without a real Slack signature.
	 */
	async dispatchChatTestEvent(event: SlackWebhookEvent): Promise<void> {
		if (!this.chatSessionHandler) {
			throw new Error("chatSessionHandler not initialized");
		}
		await this.chatSessionHandler.handleEvent(event);
	}

	/**
	 * Public accessor for the shared Fastify-based application server.
	 * Used by F1 to register test-only routes alongside production webhook routes.
	 */
	getSharedApplicationServer(): SharedApplicationServer {
		return this.sharedApplicationServer;
	}

	/**
	 * Test-only: list active chat threads (threadKey → sessionId).
	 */
	listChatThreads(): Array<{ threadKey: string; sessionId: string }> {
		if (!this.chatSessionHandler) return [];
		return this.chatSessionHandler.listThreads();
	}

	/**
	 * Test-only: fetch the last assistant text reply for a chat thread.
	 * Returns null when the thread or runner is unknown, or no assistant
	 * message has been produced yet.
	 */
	getChatThreadLastReply(threadKey: string): {
		text: string;
		isRunning: boolean;
		messageCount: number;
	} | null {
		if (!this.chatSessionHandler) return null;
		const runner = this.chatSessionHandler.getRunnerForThread(threadKey);
		if (!runner) return null;
		const messages = runner.getMessages();
		const lastAssistant = [...messages]
			.reverse()
			.find((m) => m.type === "assistant");
		let text = "";
		if (
			lastAssistant &&
			lastAssistant.type === "assistant" &&
			"message" in lastAssistant
		) {
			const msg = lastAssistant as {
				message: { content: Array<{ type: string; text?: string }> };
			};
			const block = msg.message.content?.find(
				(b) => b.type === "text" && b.text,
			);
			if (block?.text) text = block.text;
		}
		return {
			text,
			isRunning: runner.isRunning(),
			messageCount: messages.length,
		};
	}

	/**
	 * Stop the edge worker
	 */
	async stop(): Promise<void> {
		// Stop config file watcher
		await this.configManager.stop();

		try {
			await this.savePersistedState();
			this.logger.info("✅ EdgeWorker state saved successfully");
		} catch (error) {
			this.logger.error(
				"❌ Failed to save EdgeWorker state during shutdown:",
				error,
			);
		}

		// get all agent runners (including chat platform sessions)
		const agentRunners: IAgentRunner[] = [
			...this.agentSessionManager.getAllAgentRunners(),
		];
		for (const handler of this.activeChatSessionHandlers) {
			agentRunners.push(...handler.getAllRunners());
		}

		// Kill all agent processes with null checking
		for (const runner of agentRunners) {
			if (runner) {
				try {
					runner.stop();
				} catch (error) {
					this.logger.error("Error stopping Claude runner:", error);
				}
			}
		}

		// Clear event transport (no explicit cleanup needed, routes are removed when server stops)
		this.linearEventTransport = null;
		this.configUpdater = null;
		this.mcpConfigService.clearAllContexts();
		this.cyrusToolsMcpSessions.removeAllListeners();
		this.cyrusToolsMcpRegistered = false;

		// Stop egress proxy
		if (this.egressProxy) {
			await this.egressProxy.stop();
			this.egressProxy = null;
			this.sdkSandboxSettings = null;
			this.egressCaCertPath = null;
		}

		// Stop shared application server (this also stops Cloudflare tunnel if running)
		await this.sharedApplicationServer.stop();

		// Persistence floor: this is the last chance to WIP-push + upload
		// session bundles before the process (and possibly the container it
		// runs in) is gone. Deliberately LAST — runner kill, egress-proxy
		// stop, and server stop must not wait behind a potentially slow git
		// push / router upload. `stop()` never throws (every per-issue sync
		// swallows and logs its own errors) and is internally time-capped, so
		// it can't block process exit indefinitely either.
		await this.workspaceSync?.stop();

		// Abandon in-flight callback retries rather than holding the process
		// open on backoff sleeps. Anything still queued is on disk and replays
		// on the next start (and the router's grace deadline covers the gap).
		this.teardownCallbacks?.stop();

		// Uninstall the log sink last: everything above still gets forwarded, and
		// only now does the connection it writes to stop being useful. Restores
		// whatever was installed before us rather than assuming it was the no-op,
		// so a host that installed its own sink (Phase 3's OTel sink) gets it back.
		if (this.logForwarder) {
			if (this.previousLogSink) setGlobalLogSink(this.previousLogSink);
			else resetGlobalLogSink();
			this.logForwarder = undefined;
			this.previousLogSink = undefined;
		}

		// Flush and tear down tracing after the sink, and bounded: the batch
		// processor holds up to 5 seconds of spans, so without a flush the last
		// window — which is exactly the window that explains a shutdown — never
		// leaves the sandbox. The timeout matters more here than for logs: this
		// flush writes to the WSS connection, which by this point may already be
		// closing, and a hung shutdown gets the process SIGKILLed and loses the
		// spans anyway.
		if (this.tracing) {
			const tracing = this.tracing;
			this.tracing = undefined;
			await Promise.race([
				tracing.shutdown(),
				new Promise<void>((resolve) =>
					setTimeout(resolve, TRACING_SHUTDOWN_TIMEOUT_MS).unref?.(),
				),
			]).catch(() => {
				// A failed flush is not worth failing a shutdown over.
			});
		}
	}

	/**
	 * Start span export over the router connection, if an operator asked for it.
	 *
	 * Returns without doing anything unless `CYRUS_OTEL_TRACES_ENABLED` is
	 * explicitly truthy — the same opt-in contract as the logs bridge, so adding
	 * this code changes nothing for upstream CLI users and every self-host
	 * deployment.
	 *
	 * ── SAMPLING IS NOT DECIDED HERE ──
	 * The sampler is parent-based, so for the work that matters (a session the
	 * router dispatched) this process takes NO sampling decision: it inherits the
	 * router's, off the `traceparent` on the event frame. The ratio configured
	 * here only ever applies to a root span the worker starts on its own, which
	 * is a path that should not normally exist. See
	 * `docs/adr/0004-parent-based-head-sampling-for-traces.md`.
	 */
	private startRouterTracing(connection: RouterConnection): void {
		if (!isOtelTracingEnabled(process.env)) return;
		try {
			const resourceAttributes = buildResourceAttributes({
				serviceName:
					process.env.CYRUS_OTEL_SERVICE_NAME?.trim() || "cyrus-worker",
				...(process.env.CYRUS_OTEL_SERVICE_VERSION
					? { serviceVersion: process.env.CYRUS_OTEL_SERVICE_VERSION }
					: {}),
				// The issue key is the identifier an operator has in hand, and in a
				// per-issue sandbox it is exactly "which replica is this" — which is
				// what `service.instance.id` is for.
				...(process.env.CYRUS_ISSUE_KEY
					? { serviceInstanceId: process.env.CYRUS_ISSUE_KEY }
					: {}),
				...(process.env.CYRUS_OTEL_DEPLOYMENT_ENV
					? { deploymentEnvironment: process.env.CYRUS_OTEL_DEPLOYMENT_ENV }
					: {}),
			});
			this.tracing = startOtelTracing({
				exporter: new RouterSpanForwarder({ connection, resourceAttributes }),
				resourceAttributes,
				...(readOtelSampleRatio(process.env) !== undefined
					? { sampleRatio: readOtelSampleRatio(process.env) }
					: {}),
			});
			this.logger.info(
				`OpenTelemetry span export enabled, relayed via the router (${Object.entries(
					resourceAttributes,
				)
					.map(([key, value]) => `${key}=${value}`)
					.join(", ")})`,
			);
		} catch (err) {
			// Telemetry must never be able to stop a worker from doing its job.
			this.logger.warn("Failed to start OpenTelemetry span export", err);
		}
	}

	/**
	 * Apply sandbox config changes from a config reload.
	 * Handles three transitions:
	 * - enabled → enabled: update network policy on the running proxy
	 * - disabled → enabled: start a new proxy
	 * - enabled → disabled: stop the running proxy
	 */
	private async applySandboxConfigChanges(
		newConfig: EdgeWorkerConfig,
	): Promise<void> {
		const wasEnabled = this.egressProxy !== null;
		const isEnabled = newConfig.sandbox?.enabled === true;

		if (wasEnabled && isEnabled) {
			// Policy update — proxy stays running, rules change
			// Pass current policy (or empty object to reset to allow-all)
			this.egressProxy!.updateNetworkPolicy(
				newConfig.sandbox?.networkPolicy ?? {},
			);
			// Handle systemWideCert toggling while proxy is running
			if (newConfig.sandbox?.systemWideCert) {
				this.egressCaCertPath = null;
			} else if (!this.egressCaCertPath) {
				this.egressCaCertPath = this.egressProxy!.buildCACertBundle();
			}
		} else if (!wasEnabled && isEnabled) {
			// Start proxy for the first time
			this.logger.info("🛡️  Sandbox egress proxy: starting (config change)...");
			this.egressProxy = new EgressProxy(
				newConfig.sandbox!,
				this.cyrusHome,
				this.logger,
			);
			await this.egressProxy.start();

			this.sdkSandboxSettings = {
				enabled: true,
				network: {
					httpProxyPort: this.egressProxy.getHttpProxyPort(),
					socksProxyPort: this.egressProxy.getSocksProxyPort(),
				},
			};
			const systemWideCert = newConfig.sandbox?.systemWideCert === true;
			this.logCertTrustInstructions(
				this.egressProxy.getCACertPath(),
				systemWideCert,
			);

			if (!systemWideCert) {
				this.egressCaCertPath = this.egressProxy.buildCACertBundle();
			}
		} else if (wasEnabled && !isEnabled) {
			// Stop proxy
			this.logger.info(
				"🛡️  Sandbox egress proxy: stopping (disabled in config)",
			);
			await this.egressProxy!.stop();
			this.egressProxy = null;
			this.sdkSandboxSettings = null;
			this.egressCaCertPath = null;
		}
	}

	/**
	 * Log instructions for trusting the egress proxy CA certificate.
	 * When systemWideCert is true, logs that env vars are skipped and trust
	 * is expected from the OS cert store. Otherwise logs env var list and
	 * checks macOS keychain trust status.
	 */
	private logCertTrustInstructions(
		certPath: string,
		systemWideCert = false,
	): void {
		this.logger.info(`🛡️  Sandbox TLS interception CA certificate: ${certPath}`);

		if (systemWideCert) {
			this.logger.info(
				"🛡️  systemWideCert: true — per-session CA cert env vars are skipped (OS cert store handles trust)",
			);
		} else {
			this.logger.info(
				"🛡️  Per-session env vars are set automatically: NODE_EXTRA_CA_CERTS, GIT_SSL_CAINFO, SSL_CERT_FILE, REQUESTS_CA_BUNDLE, PIP_CERT, CURL_CA_BUNDLE, CARGO_HTTP_CAINFO, AWS_CA_BUNDLE, DENO_CERT",
			);
		}

		const trusted = this.isCertTrustedSystemWide();
		if (trusted) {
			this.logger.info("🛡️  CA certificate is trusted system-wide ✓");
			if (!systemWideCert) {
				this.logger.info(
					"🛡️  Tip: set sandbox.systemWideCert: true in config.json to skip per-session cert env vars",
				);
			}
		} else {
			if (process.platform === "darwin") {
				this.logger.warn(
					"🛡️  CA certificate is NOT trusted in the macOS System keychain. To trust (requires sudo):",
				);
				this.logger.warn(
					`🛡️  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${certPath}`,
				);
			} else if (process.platform === "linux") {
				this.logger.warn(
					"🛡️  CA certificate is NOT trusted system-wide. To trust (requires sudo):",
				);
				this.logger.warn(
					`🛡️  sudo cp ${certPath} /usr/local/share/ca-certificates/cyrus-egress-ca.crt && sudo update-ca-certificates`,
				);
			}
			if (systemWideCert) {
				this.logger.warn(
					"🛡️  systemWideCert is true but cert is not trusted — tools using the OS cert store will fail TLS verification",
				);
			}
		}
	}

	/**
	 * Check whether the Cyrus egress proxy CA is trusted at the OS level.
	 * macOS: searches the System keychain. Linux: checks update-ca-certificates output.
	 */
	private isCertTrustedSystemWide(): boolean {
		try {
			if (process.platform === "darwin") {
				execSync(
					'security find-certificate -c "Cyrus Egress Proxy CA" /Library/Keychains/System.keychain',
					{ stdio: "ignore" },
				);
				return true;
			}
			if (process.platform === "linux") {
				// Check if our cert exists in the system CA certificates directory
				execSync(
					"test -f /usr/local/share/ca-certificates/cyrus-egress-ca.crt",
					{ stdio: "ignore" },
				);
				return true;
			}
			return false;
		} catch {
			return false;
		}
	}

	/**
	 * Set the config file path for dynamic reloading
	 */
	setConfigPath(configPath: string): void {
		this.configPath = configPath;
		this.configManager.setConfigPath(configPath);
	}

	/**
	 * Handle resuming a parent session when a child session completes
	 * This is the core logic used by the resume parent session callback
	 * Extracted to reduce duplication between constructor and addNewRepositories
	 */
	private async handleResumeParentSession(
		parentSessionId: string,
		prompt: string,
		childSessionId: string,
	): Promise<void> {
		const log = this.logger.withContext({ sessionId: parentSessionId });
		log.info(
			`Child session completed, resuming parent session ${parentSessionId}`,
		);

		// Find parent session from the single session manager
		log.debug(`Looking up parent session ${parentSessionId}`);
		const parentSession = this.agentSessionManager.getSession(parentSessionId);
		const parentRepoId = this.sessionRepositories.get(parentSessionId);
		const parentRepo = parentRepoId
			? this.repositories.get(parentRepoId)
			: undefined;
		const parentAgentSessionManager = this.agentSessionManager;

		if (!parentSession || !parentRepo) {
			log.error(
				`Parent session ${parentSessionId} not found in any repository's agent session manager`,
			);
			return;
		}

		// Extract workspace ID once for all operations in this method
		const parentWorkspaceId = requireLinearWorkspaceId(parentRepo);

		log.debug(
			`Found parent session - Issue: ${parentSession.issueId}, Workspace: ${parentSession.workspace.path}`,
		);

		// Get the child session to access its workspace path
		const childSession = this.agentSessionManager.getSession(childSessionId);
		const childWorkspaceDirs: string[] = [];
		if (childSession) {
			childWorkspaceDirs.push(childSession.workspace.path);
			log.debug(
				`Adding child workspace to parent allowed directories: ${childSession.workspace.path}`,
			);
		} else {
			log.warn(
				`Could not find child session ${childSessionId} to add workspace to parent allowed directories`,
			);
		}

		await this.postParentResumeAcknowledgment(
			parentSessionId,
			parentWorkspaceId,
		);

		// Post thought showing child result receipt
		// Use parent's issue tracker since we're posting to the parent's session
		const issueTracker = this.issueTrackers.get(parentWorkspaceId);
		if (issueTracker && childSession) {
			const childIssueIdentifier =
				childSession.issue?.identifier || childSession.issueId;
			const resultThought = `Received result from sub-issue ${childIssueIdentifier}:\n\n---\n\n${prompt}\n\n---`;

			await this.postActivityDirect(
				issueTracker,
				{
					agentSessionId: parentSessionId,
					content: { type: "thought", body: resultThought },
				},
				"child result receipt",
			);
		}

		// Use centralized streaming check and routing logic
		log.info(`Handling child result for parent session ${parentSessionId}`);
		try {
			await this.handlePromptWithStreamingCheck(
				parentSession,
				parentRepo,
				parentSessionId,
				parentAgentSessionManager,
				prompt,
				"", // No attachment manifest for child results
				false, // Not a new session
				childWorkspaceDirs, // Add child workspace directories to parent's allowed directories
				"parent resume from child",
				parentWorkspaceId,
			);
			log.info(
				`Successfully handled child result for parent session ${parentSessionId}`,
			);
		} catch (error) {
			log.error(`Failed to resume parent session ${parentSessionId}:`, error);
			log.error(
				`Error context - Parent issue: ${parentSession.issueId}, Repository: ${parentRepo.name}`,
			);
		}
	}

	/**
	 * Detect workspace token changes and update all dependent services.
	 *
	 * When an OAuth token is refreshed (at least once per day), the new token is
	 * persisted to config.json which triggers the file watcher.  This method
	 * compares the previous in-memory tokens against the new config and calls
	 * `setAccessToken()` on any affected `LinearIssueTrackerService` instances,
	 * and pushes the updated workspace configs to `AttachmentService`.
	 */
	private updateLinearWorkspaceTokens(newConfig: EdgeWorkerConfig): void {
		const oldWorkspaces = this.config.linearWorkspaces ?? {};
		const newWorkspaces = newConfig.linearWorkspaces ?? {};

		let anyTokenChanged = false;

		for (const [workspaceId, newWsConfig] of Object.entries(newWorkspaces)) {
			const oldWsConfig = oldWorkspaces[workspaceId];
			const oldToken = oldWsConfig?.linearToken;
			const newToken = newWsConfig.linearToken;
			const newRefreshToken = newWsConfig.linearRefreshToken;

			if (
				oldToken === newToken &&
				oldWsConfig?.linearRefreshToken === newRefreshToken
			) {
				continue;
			}

			anyTokenChanged = true;

			// Update existing issue tracker in-place
			const issueTracker = this.issueTrackers.get(workspaceId);
			if (issueTracker) {
				// Hand over the refresh token too, not just the access token. A
				// re-authorization (`cyrus refresh-token` / `self-auth-linear`) lands
				// here as a config.json change, and if Linear had already rejected the
				// old refresh token the tracker is suppressing every refresh attempt
				// for this workspace. That suppression is only lifted when a
				// *different* refresh token is registered — so passing the access
				// token alone would leave a live re-auth inert until restart.
				(issueTracker as LinearIssueTrackerService).setAccessToken(
					newToken,
					newRefreshToken,
				);
				this.logger.info(
					`🔑 Updated Linear token for workspace ${workspaceId}`,
				);
			} else if (this.config.platform !== "cli") {
				// Workspace is new — create a tracker and activity sink for it
				const newIssueTracker = new LinearIssueTrackerService(
					new LinearClient({ accessToken: newToken }),
					this.buildOAuthConfig(workspaceId),
				);
				this.issueTrackers.set(workspaceId, newIssueTracker);
				this.activitySinks.set(
					workspaceId,
					new LinearActivitySink(newIssueTracker, workspaceId),
				);
				this.logger.info(
					`🔑 Created issue tracker for new workspace ${workspaceId}`,
				);
			}
		}

		if (anyTokenChanged) {
			// Push refreshed workspace configs to AttachmentService
			this.attachmentService.setLinearWorkspaces(newWorkspaces);
		}
	}

	/**
	 * Add new repositories to the running EdgeWorker
	 */
	private async addNewRepositories(repos: RepositoryConfig[]): Promise<void> {
		for (const repo of repos) {
			if (repo.isActive === false) {
				this.logger.info(`⏭️  Skipping inactive repository: ${repo.name}`);
				continue;
			}

			try {
				this.logger.info(`➕ Adding repository: ${repo.name} (${repo.id})`);

				// Resolve paths that may contain tilde (~) prefix
				const resolvedRepo: RepositoryConfig = {
					...repo,
					repositoryPath: resolvePath(repo.repositoryPath),
					workspaceBaseDir: resolvePath(repo.workspaceBaseDir),
					mcpConfigPath: Array.isArray(repo.mcpConfigPath)
						? repo.mcpConfigPath.map(resolvePath)
						: repo.mcpConfigPath
							? resolvePath(repo.mcpConfigPath)
							: undefined,
					promptTemplatePath: repo.promptTemplatePath
						? resolvePath(repo.promptTemplatePath)
						: undefined,
				};

				// Add to internal map
				this.repositories.set(repo.id, resolvedRepo);

				this.logger.info(`✅ Repository added successfully: ${repo.name}`);
			} catch (error) {
				this.logger.error(`❌ Failed to add repository ${repo.name}:`, error);
			}
		}
	}

	/**
	 * Update existing repositories
	 */
	private async updateModifiedRepositories(
		repos: RepositoryConfig[],
	): Promise<void> {
		for (const repo of repos) {
			try {
				const oldRepo = this.repositories.get(repo.id);
				if (!oldRepo) {
					this.logger.warn(
						`⚠️  Repository ${repo.id} not found for update, skipping`,
					);
					continue;
				}

				this.logger.info(`🔄 Updating repository: ${repo.name} (${repo.id})`);

				// Resolve paths that may contain tilde (~) prefix
				const resolvedRepo: RepositoryConfig = {
					...repo,
					repositoryPath: resolvePath(repo.repositoryPath),
					workspaceBaseDir: resolvePath(repo.workspaceBaseDir),
					mcpConfigPath: Array.isArray(repo.mcpConfigPath)
						? repo.mcpConfigPath.map(resolvePath)
						: repo.mcpConfigPath
							? resolvePath(repo.mcpConfigPath)
							: undefined,
					promptTemplatePath: repo.promptTemplatePath
						? resolvePath(repo.promptTemplatePath)
						: undefined,
				};

				// Update stored config
				this.repositories.set(repo.id, resolvedRepo);

				// If active status changed
				if (oldRepo.isActive !== repo.isActive) {
					if (repo.isActive === false) {
						this.logger.info(
							`  ⏸️  Repository set to inactive - existing sessions will continue`,
						);
					} else {
						this.logger.info(`  ▶️  Repository reactivated`);
					}
				}

				this.logger.info(`✅ Repository updated successfully: ${repo.name}`);
			} catch (error) {
				this.logger.error(
					`❌ Failed to update repository ${repo.name}:`,
					error,
				);
			}
		}
	}

	/**
	 * Remove deleted repositories
	 */
	private async removeDeletedRepositories(
		repos: RepositoryConfig[],
	): Promise<void> {
		for (const repo of repos) {
			try {
				this.logger.info(`🗑️  Removing repository: ${repo.name} (${repo.id})`);

				// Check for active sessions for this repository
				const allActiveSessions = this.agentSessionManager.getActiveSessions();
				const activeSessions = allActiveSessions.filter(
					(s) => this.sessionRepositories.get(s.id) === repo.id,
				);

				if (activeSessions.length > 0) {
					this.logger.warn(
						`  ⚠️  Repository has ${activeSessions.length} active sessions - stopping them`,
					);

					// Stop all active sessions and notify Linear
					for (const session of activeSessions) {
						try {
							this.logger.debug(
								`  🛑 Stopping session for issue ${session.issueId}`,
							);

							// Get the agent runner for this session
							const runner = this.agentSessionManager.getAgentRunner(
								session.id,
							);
							if (runner) {
								// Stop the agent process
								runner.stop();
								this.logger.debug(
									`  ✅ Stopped Claude runner for session ${session.id}`,
								);
							}

							// Post cancellation message to tracker
							const issueTracker = this.issueTrackers.get(
								requireLinearWorkspaceId(repo),
							);
							if (issueTracker && session.externalSessionId) {
								await this.postActivityDirect(
									issueTracker,
									{
										agentSessionId: session.externalSessionId,
										content: {
											type: "response",
											body: `**Repository Removed from Configuration**\n\nThis repository (\`${repo.name}\`) has been removed from the Cyrus configuration. All active sessions for this repository have been stopped.\n\nIf you need to continue working on this issue, please contact your administrator to restore the repository configuration.`,
										},
									},
									"repository removal",
								);
							}
						} catch (error) {
							this.logger.error(
								`  ❌ Failed to stop session ${session.id}:`,
								error,
							);
						}
					}
				}

				// Remove repository from the repositories map.
				// Note: we intentionally do NOT remove workspace-level issue trackers
				// or activity sinks here. They are keyed by workspace ID and may be
				// needed by other repositories in the same workspace, or by new
				// repositories about to be added in the same configChanged cycle.
				// They will be naturally replaced when workspace tokens are updated.
				this.repositories.delete(repo.id);

				this.logger.info(`✅ Repository removed successfully: ${repo.name}`);
			} catch (error) {
				this.logger.error(
					`❌ Failed to remove repository ${repo.name}:`,
					error,
				);
			}
		}
	}

	/**
	 * Handle errors
	 */
	private handleError(error: Error): void {
		this.emit("error", error);
		this.config.handlers?.onError?.(error);
	}

	/**
	 * Get cached repositories for an issue (used by agentSessionPrompted Branch 3)
	 * Returns null if nothing cached, or array of resolved RepositoryConfigs.
	 */
	private getCachedRepositories(issueId: string): RepositoryConfig[] | null {
		return this.repositoryRouter.getCachedRepositories(
			issueId,
			this.repositories,
		);
	}

	/**
	 * Get first cached repository for an issue (convenience for single-repo callers)
	 */
	private getCachedRepository(issueId: string): RepositoryConfig | null {
		const repos = this.getCachedRepositories(issueId);
		return repos && repos.length > 0 ? repos[0]! : null;
	}

	/**
	 * Handle webhook events from proxy - main router for all webhooks
	 */
	private async handleWebhook(
		webhook: Webhook,
		repos: RepositoryConfig[],
	): Promise<void> {
		// Track active webhook processing for status endpoint
		this.activeWebhookCount++;

		const webhookAction = (webhook as { action?: string }).action;
		const webhookType = (webhook as { type?: string }).type;
		this.logger.event(
			CYRUS_EVENTS.webhookReceived,
			cyrusAttributes({
				source: "linear",
				action: webhookAction,
				type: webhookType,
				repo_count: repos.length,
			}),
		);

		// Log verbose webhook info if enabled
		if (process.env.CYRUS_WEBHOOK_DEBUG === "true") {
			this.logger.debug(
				`Full webhook payload:`,
				JSON.stringify(webhook, null, 2),
			);
		}

		try {
			// Route to specific webhook handlers based on webhook type
			// NOTE: Traditional webhooks (assigned, comment) are disabled in favor of agent session events
			if (isIssueAssignedWebhook(webhook)) {
				return;
			} else if (isIssueCommentMentionWebhook(webhook)) {
				return;
			} else if (isIssueNewCommentWebhook(webhook)) {
				return;
			} else if (isIssueUnassignedWebhook(webhook)) {
				// Keep unassigned webhook active
				await this.handleIssueUnassignedWebhook(webhook);
			} else if (isAgentSessionCreatedWebhook(webhook)) {
				await this.handleAgentSessionCreatedWebhook(webhook, repos);
			} else if (isAgentSessionPromptedWebhook(webhook)) {
				await this.handleUserPromptedAgentActivity(webhook);
			} else if (isIssueStateChangeWebhook(webhook)) {
				// Intentional early return: state changes are handled exclusively via the message bus
				// (handleIssueStateChangeMessage), not the legacy webhook path. This differs from
				// unassign which still uses the legacy handler — state change was built message-bus-first.
				return;
			} else if (isIssueDeletedWebhook(webhook)) {
				// Issue deletion also handled via message bus — same cleanup as terminal state.
				return;
			} else if (isIssueTitleOrDescriptionUpdateWebhook(webhook)) {
				// Handle issue title/description/attachments updates - feed changes into active session
				await this.handleIssueContentUpdate(webhook);
			} else if (isIssueStateIdUpdateWebhook(webhook)) {
				// Handle issue state changes — wake up parked sessions when blocking issues complete
				await this.handleIssueStateChange(webhook);
			} else {
				if (process.env.CYRUS_WEBHOOK_DEBUG === "true") {
					this.logger.debug(
						`Unhandled webhook type: ${(webhook as any).action}`,
					);
				}
			}
		} catch (error) {
			this.logger.error(
				`Failed to process webhook: ${(webhook as any).action}`,
				error,
			);
			// Don't re-throw webhook processing errors to prevent application crashes
			// The error has been logged and individual webhook failures shouldn't crash the entire system
		} finally {
			// Always decrement counter when webhook processing completes
			this.activeWebhookCount--;
		}
	}

	// ============================================================================
	// INTERNAL MESSAGE BUS HANDLERS
	// ============================================================================
	// These handlers process unified InternalMessage types from the message bus.
	// They provide a platform-agnostic interface for handling events from
	// Linear, GitHub, Slack, and other platforms.
	// ============================================================================

	/**
	 * Handle unified internal messages from the message bus.
	 * This is the new entry point for processing events from all platforms.
	 *
	 * Note: For now, this runs in parallel with legacy webhook handlers.
	 * Once migration is complete, legacy handlers will be removed.
	 */
	private async handleMessage(message: InternalMessage): Promise<void> {
		// NOTE: activeWebhookCount is NOT tracked here because legacy webhook handlers
		// already increment/decrement it for every event. Counting here would double-count.
		// TODO: When legacy handlers are removed, restore activeWebhookCount tracking here.

		// Log verbose message info if enabled
		if (process.env.CYRUS_WEBHOOK_DEBUG === "true") {
			this.logger.debug(
				`Internal message received: ${message.source}/${message.action}`,
				JSON.stringify(message, null, 2),
			);
		}

		try {
			// Route to specific message handlers based on action type
			if (isSessionStartMessage(message)) {
				await this.handleSessionStartMessage(message);
			} else if (isUserPromptMessage(message)) {
				await this.handleUserPromptMessage(message);
			} else if (isStopSignalMessage(message)) {
				await this.handleStopSignalMessage(message);
			} else if (isContentUpdateMessage(message)) {
				await this.handleContentUpdateMessage(message);
			} else if (isUnassignMessage(message)) {
				await this.handleUnassignMessage(message);
			} else if (isIssueStateChangeMessage(message)) {
				await this.handleIssueStateChangeMessage(message);
			} else {
				// This branch should never be reached due to exhaustive type checking
				// If it is reached, log the unexpected message for debugging
				if (process.env.CYRUS_WEBHOOK_DEBUG === "true") {
					const unexpectedMessage = message as InternalMessage;
					this.logger.debug(
						`Unhandled message action: ${unexpectedMessage.action}`,
					);
				}
			}
		} catch (error) {
			this.logger.error(
				`Failed to process message: ${message.source}/${message.action}`,
				error,
			);
			// Don't re-throw message processing errors to prevent application crashes
		}
	}

	/**
	 * Handle session start message (unified handler for session creation).
	 *
	 * This is a placeholder that logs the message for now.
	 * TODO: Migrate logic from handleAgentSessionCreatedWebhook and handleGitHubWebhook.
	 */
	private async handleSessionStartMessage(
		message: SessionStartMessage,
	): Promise<void> {
		this.logger.debug(
			`[MessageBus] Session start: ${message.workItemIdentifier} from ${message.source}`,
		);
		// TODO: Implement unified session start handling
		// For now, the legacy handlers (handleAgentSessionCreatedWebhook, handleGitHubWebhook)
		// continue to process the actual session creation via the 'event' emitter.
	}

	/**
	 * Handle user prompt message (unified handler for mid-session prompts).
	 *
	 * This is a placeholder that logs the message for now.
	 * TODO: Migrate logic from handleUserPromptedAgentActivity (branch 3).
	 */
	private async handleUserPromptMessage(
		message: UserPromptMessage,
	): Promise<void> {
		this.logger.debug(
			`[MessageBus] User prompt: ${message.workItemIdentifier} from ${message.source}`,
		);
		// TODO: Implement unified user prompt handling
		// For now, the legacy handler (handleUserPromptedAgentActivity)
		// continues to process the actual prompt via the 'event' emitter.
	}

	/**
	 * Handle stop signal message (unified handler for session termination).
	 *
	 * This is a placeholder that logs the message for now.
	 * TODO: Migrate logic from handleUserPromptedAgentActivity (branch 1).
	 */
	private async handleStopSignalMessage(
		message: StopSignalMessage,
	): Promise<void> {
		this.logger.debug(
			`[MessageBus] Stop signal: ${message.workItemIdentifier} from ${message.source}`,
		);
		// TODO: Implement unified stop signal handling
		// For now, the legacy handler (handleUserPromptedAgentActivity)
		// continues to process the actual stop via the 'event' emitter.
	}

	/**
	 * Handle content update message (unified handler for issue/PR content changes).
	 *
	 * This is a placeholder that logs the message for now.
	 * TODO: Migrate logic from handleIssueContentUpdate.
	 */
	private async handleContentUpdateMessage(
		message: ContentUpdateMessage,
	): Promise<void> {
		this.logger.debug(
			`[MessageBus] Content update: ${message.workItemIdentifier} from ${message.source}`,
		);
		// TODO: Implement unified content update handling
		// For now, the legacy handler (handleIssueContentUpdate)
		// continues to process the actual update via the 'event' emitter.
	}

	/**
	 * Handle unassign message (unified handler for task unassignment).
	 *
	 * This is a placeholder that logs the message for now.
	 * TODO: Migrate logic from handleIssueUnassignedWebhook.
	 */
	private async handleUnassignMessage(message: UnassignMessage): Promise<void> {
		this.logger.debug(
			`[MessageBus] Unassign: ${message.workItemIdentifier} from ${message.source}`,
		);
		// TODO: Implement unified unassign handling
		// For now, the legacy handler (handleIssueUnassignedWebhook)
		// continues to process the actual unassignment via the 'event' emitter.
	}

	/**
	 * Derive the git branch name for an issue exactly the way
	 * GitService.createSingleRepoWorktree does (`issue.branchName` when set,
	 * otherwise `<identifier>-<slugified-title-30-chars>`). Used by
	 * pre-teardown WIP push so the push targets the same branch the worktree
	 * was actually created on, even when Linear didn't suggest a branch name.
	 *
	 * Delegates to GitService.deriveWorktreeBranchName — the single source
	 * of truth for this fallback — so worktree creation and teardown's WIP
	 * push can never drift onto different branches.
	 */
	private deriveWorktreeBranchName(issue: IssueMinimal): string {
		return this.gitService.deriveWorktreeBranchName(issue);
	}

	/**
	 * Handle issue state change message (terminal state reached).
	 * Stops active sessions and deletes worktrees for the issue.
	 */
	private async handleIssueStateChangeMessage(
		message: IssueStateChangeMessage,
	): Promise<void> {
		// FIRST, and synchronously — before this method's first `await`, so the
		// write lands inside the window where RouterConnection's inbox entry for
		// this webhook is still unprocessed. From here on, a kill at ANY point
		// (mid floor flush, mid worktree removal, or in the gap before the
		// callback) leaves the intent on disk to be replayed on the next start.
		const teardownCallbackKey =
			this.config.platform === "router"
				? this.teardownCallbacks?.record(message.workItemIdentifier)
				: undefined;

		this.logger.info(
			`[MessageBus] Issue reached terminal state: ${message.workItemIdentifier}${
				teardownCallbackKey
					? ` (teardown callback ${teardownCallbackKey} recorded)`
					: ""
			}`,
		);

		const issueId = message.workItemId;

		// Stop all active sessions for this issue
		const sessions = this.agentSessionManager.getSessionsByIssueId(issueId);
		for (const session of sessions) {
			this.logger.info(
				`Stopping agent runner for ${message.workItemIdentifier} (issue terminal)`,
			);
			this.agentSessionManager.requestSessionStop(session.id);
			session.agentRunner?.stop();
		}

		// Capture the terminal sessions and their worktrees before removeSession
		// erases them from persisted state or deleteWorktree marks the workspace
		// gone. A forced call waits out any periodic sync and then performs a
		// fresh pass rather than coalescing with stale in-flight work.
		await this.workspaceSync?.syncIssue(message.workItemIdentifier, {
			force: true,
		});

		// That was the last snapshot this issue gets. From here the WIP refs are
		// terminal cleanup's to delete, and a capture landing after the reap
		// would not merely race it — `deleteWipSnapshot` drops the LOCAL ref
		// unconditionally, and that local ref is exactly what `captureWipSnapshot`
		// reads to decide the remote is already current, so the next capture is
		// GUARANTEED to push the ref back. It would then look like a success on
		// both sides: nothing recorded as failed for `sweep()` to retry, and the
		// ref back on the remote permanently. Stopping the runners above does not
		// prevent this (`requestSessionStop` only sets a flag; the runner's real
		// terminal arrives later and fires `syncIssueOnTermination` from a
		// listener), and the 5-minute periodic tick keeps firing across the
		// seconds-to-minutes that teardown scripts and `git worktree remove`
		// take. Awaits any capture already in flight before returning.
		await this.workspaceSync?.abandonIssue(message.workItemIdentifier);

		// The path creation actually returned, recorded on the session and
		// captured before `removeSession` erases it. Re-deriving it from config
		// is a reconstruction — correct only while the repository config that
		// produced it is still present and unchanged — whereas this is the
		// authoritative answer, and is what `WorkspaceSyncService` already uses.
		// `deleteWorktree` falls back to re-deriving when this is empty, which is
		// the redelivered-webhook case.
		const recordedWorkspacePaths = [
			...new Set(
				sessions
					.map((session) => session.workspace?.path)
					.filter((path): path is string => Boolean(path)),
			),
		];

		// Post a response activity to each stopped session's Linear thread,
		// then remove the session so subsequent prompts don't find stale state.
		for (const session of sessions) {
			await this.agentSessionManager.createResponseActivity(
				session.id,
				`Session stopped — ${message.workItemIdentifier} was marked as Done or Canceled.`,
			);
			this.agentSessionManager.removeSession(session.id);
		}

		// Build the set of repositories involved with this issue. Everything
		// below is driven off it: which `cyrus-teardown.sh` scripts run, which
		// remotes have a WIP snapshot deleted, and — since NOR-411 — which
		// `workspaceBaseDir` the workspace itself is resolved from. That last
		// one makes an incomplete list silently destructive rather than merely
		// incomplete, and there are two ways it used to come up short.
		//
		// A session records only its PRIMARY repository (`sessionRepositories`
		// is set from `repositories[0]`), so a multi-repo issue lost every
		// secondary repository's snapshot. And on a REDELIVERED terminal
		// webhook there are no sessions left at all — the first delivery calls
		// `removeSession` above, and the router replays unacked events by
		// design — leaving the list empty, the workspace resolved from the
		// default base directory, and a real worktree neither cleaned up nor
		// reported.
		//
		// The issue's own routing decision covers both: it is the same list
		// worktree creation was handed, and it outlives the sessions. Sessions
		// still go first so the primary repository stays first, which is the
		// one `resolveIssueWorkspacePath` takes the base directory from.
		const repoIds = new Set<string>();
		for (const session of sessions) {
			const repoId = this.sessionRepositories.get(session.id);
			if (repoId) repoIds.add(repoId);
		}
		for (const repo of this.getCachedRepositories(issueId) ?? []) {
			repoIds.add(repo.id);
		}
		const teardownRepositories: RepositoryConfig[] = [];
		for (const repoId of repoIds) {
			const repo = this.repositories.get(repoId);
			if (repo) teardownRepositories.push(repo);
		}

		// The issue is over, so its WIP snapshots are deleted rather than
		// refreshed: refs are advertised on every clone and fetch,
		// repository-wide, and count toward the repository's size limit, so
		// leaving them behind would tax every contributor's fetch forever. A
		// reopened issue rebuilds from the issue branch instead. Deletion is a
		// network call and can fail; `WipSnapshotReaper` records the ones that
		// do and retries them on the next teardown and on the next start, so
		// failure never blocks cleanup and never leaks a ref permanently.
		if (teardownRepositories.length > 0) {
			// A session's `issue.branchName` can be empty even when an issue is
			// attached (Linear doesn't always suggest one) — GitService's own
			// worktree creation falls back to a derived name in that case
			// (see createSingleRepoWorktree), so mirror that fallback here via
			// deriveWorktreeBranchName rather than requiring a truthy
			// branchName, which would otherwise silently skip the deletion for
			// any issue Linear didn't suggest a branch name for.
			const sessionWithIssue = sessions.find((session) => session.issue);
			if (sessionWithIssue?.issue) {
				// deriveWorktreeBranchName already returns a sanitized branch
				// name (it delegates to GitService.deriveWorktreeBranchName,
				// which sanitizes internally) — no further sanitization needed.
				const branchName = this.deriveWorktreeBranchName(
					sessionWithIssue.issue,
				);
				// Reaped from each repository's MAIN checkout, not from the
				// issue's worktree. Deleting the ref is a remote operation —
				// any checkout whose `origin` carries it will do — and two
				// things follow from preferring the durable one. It cannot go
				// looking for a worktree at a path that was reconstructed
				// rather than resolved, which is how every container sandbox
				// ended up reaping a directory that had never existed
				// (NOR-411). And the path outlives this teardown, so `sweep()`
				// — which discards any entry whose path has since disappeared,
				// as a worktree always has by the next sweep — can still retry
				// it. Each repository carries its own snapshot under the same
				// ref name, so every one of them has to be deleted.
				//
				// That retry is a PHYSICAL-DEVICE guarantee only, and it is
				// worth being exact about because the mode this bug was
				// reported from is the one it does not cover. The reaper's
				// durable file lives under `cyrusHome`, which in a container
				// sandbox is `$CYRUS_WORKSPACES_DIR/.cyrus` — inside the same
				// per-issue sandbox as `repositoryPath`, and this handler is
				// the last thing that sandbox does before it is destroyed. A
				// sandbox serves one issue, so neither trigger for `sweep()`
				// (the next terminal teardown, or process start) ever fires for
				// it again. A remote that is unreachable for the duration of a
				// container teardown therefore still leaks the ref, and the
				// only signal is the reaper's warning in logs that outlive the
				// container.
				for (const repository of teardownRepositories) {
					await this.wipSnapshotReaper.reap(
						repository.repositoryPath,
						branchName,
					);
				}
			} else if (sessions.length === 0) {
				// A redelivered terminal webhook: the first delivery removed the
				// sessions, and with them the only source of a branch name. The
				// repositories are still worth carrying for the worktree deletion
				// below, which is what an idempotent replay is for.
				//
				// Deliberately NOT phrased as "already reaped on an earlier
				// delivery". Nothing records that a reap SUCCEEDED — the reaper's
				// durable file records only failures — so that would be an
				// assumption stated as fact, and stating it at `info` is the same
				// benign-looking silent miss this issue was about on the worktree
				// half. Say what is actually known instead.
				this.logger.warn(
					`No sessions remain for ${message.workItemIdentifier}, so there is no branch name to derive and its WIP snapshots cannot be reaped on this delivery. If an earlier delivery did not complete the reap, any refs/cyrus-wip/* for this issue are still on its remotes and must be removed by hand`,
				);
			} else {
				// No session carries any issue data at all (e.g. only
				// standalone/no-issue sessions were found for this issueId) —
				// there is no branch name to derive from, so there is no ref to
				// delete. Warn rather than silently leaking one.
				this.logger.warn(
					`Skipping WIP snapshot deletion for ${message.workItemIdentifier}: no session has issue data to derive a branch name from`,
				);
			}
		} else {
			// Neither a live session nor the cached routing decision knows which
			// repositories this issue used, so there is no remote to delete from.
			// Reachable on a cold container that restored no state (the router
			// 404s the floor bundle) while the remote still carries refs the
			// sandbox's previous incarnation pushed. Previously this skipped the
			// whole block with no output at all.
			this.logger.warn(
				`Skipping WIP snapshot deletion for ${message.workItemIdentifier}: no repository is known for this issue, from either a live session or the cached routing decision, so any refs/cyrus-wip/* it has must be removed by hand`,
			);
		}

		// Unconditional, and outside every branch above: this retries snapshots
		// that a PREVIOUS teardown failed to delete, which has nothing to do with
		// whether this issue got as far as reaping its own. Gating it on the reap
		// branch meant the one delivery that admits it is a retry — a redelivered
		// webhook with no sessions left — was also the one that declined to retry.
		await this.wipSnapshotReaper.sweep();

		// Delete worktrees for this issue, keyed by the Linear issue identifier.
		await this.gitService.deleteWorktree(message.workItemIdentifier, {
			repositories: teardownRepositories,
			recordedWorkspacePaths,
		});

		// Last by design: provider destruction is only safe after all in-container
		// cleanup, including worktree deletion, has completed. The queue retries
		// the recorded callback (same idempotency key) until the router accepts
		// it, and never rejects — the router's grace deadline runs the same
		// destroy path if delivery ultimately fails.
		if (teardownCallbackKey) {
			await this.teardownCallbacks?.flush();
		}

		this.logger.info(
			`Completed cleanup for ${message.workItemIdentifier}: stopped ${sessions.length} session(s)`,
		);
	}

	// ============================================================================
	// LEGACY WEBHOOK HANDLERS
	// ============================================================================

	/**
	 * Handle issue unassignment webhook
	 */
	private async handleIssueUnassignedWebhook(
		webhook: IssueUnassignedWebhook,
	): Promise<void> {
		if (!webhook.notification.issue) {
			this.logger.warn("Received issue unassignment webhook without issue");
			return;
		}

		const issueId = webhook.notification.issue.id;

		// Get cached repository, with fallback to searching sessions
		let repository = this.getCachedRepository(issueId);
		if (!repository) {
			// Fallback: search sessions for this issue to find the repository
			this.logger.info(
				`No cached repository for issue unassignment ${webhook.notification.issue.identifier}, searching sessions`,
			);

			const sessions = this.agentSessionManager.getSessionsByIssueId(issueId);
			if (sessions.length > 0) {
				const firstSession = sessions[0]!;
				const repoId = this.sessionRepositories.get(firstSession.id);
				if (repoId) {
					repository = this.repositories.get(repoId) ?? null;
					if (repository) {
						this.logger.info(
							`Recovered repository ${repoId} for unassignment of ${webhook.notification.issue.identifier} from session manager`,
						);
					}
				}

				if (!repository) {
					// Sessions exist but no repository mapping — still stop the sessions
					this.logger.warn(
						`Found ${sessions.length} session(s) for unassigned issue ${webhook.notification.issue.identifier} but no repository mapping, stopping sessions without farewell comment`,
					);
					for (const session of sessions) {
						this.agentSessionManager.requestSessionStop(session.id);
						session.agentRunner?.stop();
					}
					return;
				}
			}

			if (!repository) {
				this.logger.debug(
					`No active sessions found for unassigned issue ${webhook.notification.issue.identifier}`,
				);
				return;
			}
		}

		this.logger.info(
			`Handling issue unassignment: ${webhook.notification.issue.identifier}`,
		);

		await this.handleIssueUnassigned(
			webhook.notification.issue,
			webhook.organizationId,
		);
	}

	/**
	 * Handle issue content update webhook (title, description, or attachments).
	 *
	 * When the title, description, or attachments of an issue are updated, this handler feeds
	 * the changes into any active session for that issue, allowing the AI to
	 * compare old vs new values and decide whether to take action.
	 *
	 * The prompt uses XML-style formatting to clearly show what changed:
	 * - <issue_update> wrapper with timestamp and issue identifier
	 * - <title_change> with <old_title> and <new_title> if title changed
	 * - <description_change> with <old_description> and <new_description> if description changed
	 * - <attachments_change> with <old_attachments> and <new_attachments> if attachments changed
	 * - <guidance> section instructing the agent to evaluate whether changes affect its work
	 *
	 * @see https://studio.apollographql.com/public/Linear-Webhooks/variant/current/schema/reference/objects/EntityWebhookPayload
	 * @see https://studio.apollographql.com/public/Linear-Webhooks/variant/current/schema/reference/objects/IssueWebhookPayload
	 * @see https://studio.apollographql.com/public/Linear-Webhooks/variant/current/schema/reference/unions/DataWebhookPayload
	 */
	private async handleIssueContentUpdate(
		webhook: IssueUpdateWebhook,
	): Promise<void> {
		// Check if issue update trigger is enabled (defaults to true if not set)
		if (this.config.issueUpdateTrigger === false) {
			if (process.env.CYRUS_WEBHOOK_DEBUG === "true") {
				this.logger.debug(
					"Issue update trigger is disabled, skipping issue content update",
				);
			}
			return;
		}

		const issueData = webhook.data;
		const issueId = issueData.id;
		const issueIdentifier = issueData.identifier;
		const updatedFrom = webhook.updatedFrom;
		const webhookKey = `${webhook.createdAt}:${issueId}`;

		if (!updatedFrom) {
			this.logger.warn(
				`Issue update webhook for ${issueIdentifier} has no updatedFrom data`,
			);
			return;
		}

		// Deduplicate: skip if we've already processed a webhook with the same key
		if (this.processedIssueUpdateKeys.has(webhookKey)) {
			this.logger.debug(
				`Duplicate issue update webhook for ${issueIdentifier} (key=${webhookKey}), skipping`,
			);
			return;
		}
		this.processedIssueUpdateKeys.add(webhookKey);

		// Prevent unbounded growth — prune old keys when the set gets large
		if (this.processedIssueUpdateKeys.size > 500) {
			const keys = [...this.processedIssueUpdateKeys];
			for (const key of keys.slice(0, 250)) {
				this.processedIssueUpdateKeys.delete(key);
			}
		}

		// Get cached repository, with fallback to searching sessions
		let repository = this.getCachedRepository(issueId);
		if (!repository) {
			// Fallback: search sessions for this issue to find the repository
			const issueSessions =
				this.agentSessionManager.getSessionsByIssueId(issueId);
			if (issueSessions.length > 0) {
				const firstSession = issueSessions[0]!;
				const repoId = this.sessionRepositories.get(firstSession.id);
				if (repoId) {
					repository = this.repositories.get(repoId) ?? null;
					if (repository) {
						this.logger.info(
							`Recovered repository ${repoId} for issue update ${issueIdentifier} from session manager`,
						);
					}
				}
			}

			if (!repository) {
				this.logger.debug(
					`No active sessions found for issue update ${issueIdentifier}`,
				);
				return;
			}
		}

		// Determine what changed for logging
		const changedFields: string[] = [];
		if ("title" in updatedFrom) changedFields.push("title");
		if ("description" in updatedFrom) changedFields.push("description");
		if ("attachments" in updatedFrom) changedFields.push("attachments");

		this.logger.info(
			`Handling issue content update: ${issueIdentifier} (changed: ${changedFields.join(", ")})`,
		);

		// Find session(s) for this issue
		const sessions = this.agentSessionManager.getSessionsByIssueId(issueId);
		if (sessions.length === 0) {
			if (process.env.CYRUS_WEBHOOK_DEBUG === "true") {
				this.logger.debug(
					`No sessions found for issue ${issueIdentifier} to receive update`,
				);
			}
			return;
		}

		// Process attachments from the updated description if description changed
		let attachmentManifest = "";
		if ("description" in updatedFrom && issueData.description) {
			const firstSession = sessions[0];
			if (!firstSession) {
				this.logger.debug(`No sessions found for issue ${issueIdentifier}`);
				return;
			}
			const workspaceFolderName = basename(firstSession.workspace.path);
			const attachmentsDir = join(
				this.cyrusHome,
				workspaceFolderName,
				"attachments",
			);

			try {
				// Ensure directory exists
				await mkdir(attachmentsDir, { recursive: true });

				// Count existing attachments
				const existingFiles = await readdir(attachmentsDir).catch(() => []);
				const existingAttachmentCount = existingFiles.filter(
					(file) => file.startsWith("attachment_") || file.startsWith("image_"),
				).length;

				// Download attachments from the new description
				// Use organizationId from webhook as the Linear-native workspace ID source
				const linearToken = this.getLinearTokenForWorkspace(
					webhook.organizationId,
				);
				const downloadResult = await this.downloadCommentAttachments(
					issueData.description,
					attachmentsDir,
					linearToken,
					existingAttachmentCount,
				);

				if (downloadResult.totalNewAttachments > 0) {
					attachmentManifest =
						this.generateNewAttachmentManifest(downloadResult);
					this.logger.debug(
						`Downloaded ${downloadResult.totalNewAttachments} attachments from updated description`,
					);
				}
			} catch (error) {
				this.logger.error(
					"Failed to process attachments from updated description:",
					error,
				);
			}
		}

		// Build the XML-formatted prompt showing old vs new values
		const promptBody = this.buildIssueUpdatePrompt(
			issueIdentifier,
			issueData,
			updatedFrom,
		);

		// CYPACK-954: Issue update events are ONLY delivered to the first running
		// session (by most-recently-updated) that supports streaming input.
		// If no such session exists, the event is silently ignored.

		// Combine prompt body with attachment manifest
		let fullPrompt = promptBody;
		if (attachmentManifest) {
			fullPrompt = `${promptBody}\n\n${attachmentManifest}`;
		}

		// Sort by updatedAt descending so the most recent session is first
		const sortedSessions = [...sessions].sort(
			(a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
		);

		let delivered = false;
		for (const session of sortedSessions) {
			const sessionId = session.id;
			const existingRunner = session.agentRunner;
			const isRunning = existingRunner?.isRunning() || false;

			if (
				isRunning &&
				existingRunner?.supportsStreamingInput &&
				existingRunner.addStreamMessage
			) {
				// Best-effort; a steer-only backend may reject when no turn is active.
				try {
					existingRunner.addStreamMessage(fullPrompt);
					delivered = true;
					this.logger.debug(
						`[issue-update] Streamed update to session ${sessionId} (key=${webhookKey}, changed=[${changedFields.join(", ")}])`,
					);
					break;
				} catch (error) {
					this.logger.debug(
						`[issue-update] Stream rejected for session ${sessionId}; skipping (key=${webhookKey})`,
						{ error: error instanceof Error ? error.message : String(error) },
					);
				}
			} else if (isRunning) {
				this.logger.debug(
					`[issue-update] Session ${sessionId} is running but doesn't support streaming input, skipping (key=${webhookKey})`,
				);
			} else {
				this.logger.debug(
					`[issue-update] Session ${sessionId} is idle, ignoring update (key=${webhookKey})`,
				);
			}
		}

		if (!delivered) {
			this.logger.debug(
				`[issue-update] No running streaming sessions for ${issueIdentifier}, update discarded (key=${webhookKey})`,
			);
		}
	}

	/**
	 * Build an XML-formatted prompt for issue content updates (title, description, attachments).
	 *
	 * The prompt clearly shows what fields changed by comparing old vs new values,
	 * and includes guidance for the agent to evaluate whether these changes affect
	 * its current implementation or action plan.
	 */
	/**
	 * Check if an issue has unresolved blocked-by dependencies.
	 * Fetches the issue from Linear and checks its inverse relations for blocking issues
	 * that haven't been completed or canceled.
	 */
	private async checkBlockedByDependencies(
		agentSession: AgentSessionCreatedWebhook["agentSession"],
		linearWorkspaceId: string,
	): Promise<{
		blocked: boolean;
		blockingIssueIds: string[];
		blockingIdentifiers: string[];
	}> {
		const issue = agentSession.issue;
		if (!issue) {
			return { blocked: false, blockingIssueIds: [], blockingIdentifiers: [] };
		}

		try {
			const fullIssue = await this.fetchFullIssueDetails(
				issue.id,
				linearWorkspaceId,
			);
			if (!fullIssue) {
				return {
					blocked: false,
					blockingIssueIds: [],
					blockingIdentifiers: [],
				};
			}

			const blockingIssues =
				await this.promptBuilder.fetchBlockingIssues(fullIssue);
			if (blockingIssues.length === 0) {
				return {
					blocked: false,
					blockingIssueIds: [],
					blockingIdentifiers: [],
				};
			}

			// Filter to only unresolved blockers (not completed or canceled)
			const unresolvedBlockers: Array<{
				id: string;
				identifier: string;
			}> = [];
			for (const blocker of blockingIssues) {
				try {
					const state = await blocker.state;
					if (
						state &&
						state.type !== "completed" &&
						state.type !== "canceled"
					) {
						unresolvedBlockers.push({
							id: blocker.id,
							identifier: blocker.identifier,
						});
					}
				} catch {
					// If we can't resolve the state, assume it's unresolved
					unresolvedBlockers.push({
						id: blocker.id,
						identifier: blocker.identifier,
					});
				}
			}

			if (unresolvedBlockers.length === 0) {
				return {
					blocked: false,
					blockingIssueIds: [],
					blockingIdentifiers: [],
				};
			}

			return {
				blocked: true,
				blockingIssueIds: unresolvedBlockers.map((b) => b.id),
				blockingIdentifiers: unresolvedBlockers.map((b) => b.identifier),
			};
		} catch (error) {
			this.logger.error(
				`Failed to check blocked-by dependencies for ${issue.identifier}:`,
				error,
			);
			// On error, don't block — proceed with normal flow
			return { blocked: false, blockingIssueIds: [], blockingIdentifiers: [] };
		}
	}

	/**
	 * Handle issue state change webhooks.
	 * When a blocking issue is completed, wake up any parked sessions that were waiting on it.
	 */
	private async handleIssueStateChange(
		webhook: IssueUpdateWebhook,
	): Promise<void> {
		const issueData = webhook.data;
		const completedIssueId = issueData.id;
		const issueIdentifier = issueData.identifier;

		// Only care about transitions TO completed or canceled states
		// The IssueWebhookPayload has a stateId field — resolve the state
		// via the issue tracker to check if it's a completion state
		const stateId = issueData.stateId;
		if (!stateId) {
			return;
		}

		// Find workspace for this webhook to resolve state type
		const linearWorkspaceId = webhook.organizationId;
		const issueTracker = this.issueTrackers.get(linearWorkspaceId);
		if (!issueTracker) {
			return;
		}

		// Fetch the issue to check its current state type
		let stateType: string | undefined;
		try {
			const fullIssue = await issueTracker.fetchIssue(completedIssueId);
			const state = await fullIssue.state;
			stateType = state?.type;
		} catch {
			// Can't resolve state — skip
			return;
		}

		if (stateType !== "completed" && stateType !== "canceled") {
			return;
		}

		this.logger.debug(
			`Issue ${issueIdentifier} moved to ${stateType} — checking for parked sessions to wake`,
		);

		// Find parked sessions that were blocked by this issue
		const sessionsToWake: string[] = [];
		for (const [blockedIssueId, parked] of this.parkedSessions.entries()) {
			if (parked.blockingIssueIds.includes(completedIssueId)) {
				// Remove this blocker from the list
				parked.blockingIssueIds = parked.blockingIssueIds.filter(
					(id) => id !== completedIssueId,
				);

				// If no more blockers, wake the session
				if (parked.blockingIssueIds.length === 0) {
					sessionsToWake.push(blockedIssueId);
				} else {
					this.logger.debug(
						`Parked session for issue ${blockedIssueId} still has ${parked.blockingIssueIds.length} remaining blocker(s)`,
					);
				}
			}
		}

		// Wake up unblocked sessions
		for (const blockedIssueId of sessionsToWake) {
			const parked = this.parkedSessions.get(blockedIssueId);
			if (!parked) continue;

			this.parkedSessions.delete(blockedIssueId);

			this.logger.info(
				`Waking parked session for issue ${parked.agentSession.issue?.identifier} — all blockers resolved`,
			);

			// Post activity about waking up
			await this.activityPoster.postThoughtActivity(
				parked.agentSession.id,
				parked.linearWorkspaceId,
				`All blocking dependencies are now resolved — starting work.`,
			);

			// Replay the normal initializeAgentRunner flow
			try {
				await this.initializeAgentRunner(
					parked.agentSession,
					parked.repositories,
					parked.linearWorkspaceId,
					parked.guidance,
					parked.commentBody,
					parked.baseBranchOverrides,
					parked.routingMethod,
				);
			} catch (error) {
				this.logger.error(
					`Failed to wake parked session for issue ${blockedIssueId}:`,
					error,
				);
			}
		}
	}

	/**
	 * Handle a user re-prompt on a parked (blocked-by) session.
	 * Re-checks blocking status: if clear, wakes the session; if still blocked, re-posts status.
	 */
	private async handleParkedSessionReprompt(
		_webhook: AgentSessionPromptedWebhook,
		issueId: string,
	): Promise<void> {
		const parked = this.parkedSessions.get(issueId);
		if (!parked) return;

		const blockResult = await this.checkBlockedByDependencies(
			parked.agentSession,
			parked.linearWorkspaceId,
		);

		if (blockResult.blocked) {
			// Still blocked — update the parked entry and re-post status
			parked.blockingIssueIds = blockResult.blockingIssueIds;
			const blockerList = blockResult.blockingIdentifiers
				.map((id) => `**${id}**`)
				.join(", ");
			await this.activityPoster.postThoughtActivity(
				parked.agentSession.id,
				parked.linearWorkspaceId,
				`Still blocked by ${blockerList}. Will start automatically when resolved.`,
			);
			this.logger.info(
				`Re-prompt on parked session for ${parked.agentSession.issue?.identifier}: still blocked by ${blockResult.blockingIdentifiers.join(", ")}`,
			);
			return;
		}

		// Blockers resolved — wake the session
		this.parkedSessions.delete(issueId);
		this.logger.info(
			`Re-prompt cleared blockers for ${parked.agentSession.issue?.identifier} — waking session`,
		);

		await this.activityPoster.postThoughtActivity(
			parked.agentSession.id,
			parked.linearWorkspaceId,
			`Blocking dependencies are now resolved — starting work.`,
		);

		try {
			await this.initializeAgentRunner(
				parked.agentSession,
				parked.repositories,
				parked.linearWorkspaceId,
				parked.guidance,
				parked.commentBody,
				parked.baseBranchOverrides,
				parked.routingMethod,
			);
		} catch (error) {
			this.logger.error(
				`Failed to wake parked session for issue ${issueId} on re-prompt:`,
				error,
			);
		}
	}

	private buildIssueUpdatePrompt(
		issueIdentifier: string,
		issueData: {
			title: string;
			description?: string | null;
			attachments?: unknown;
		},
		updatedFrom: {
			title?: string;
			description?: string;
			attachments?: unknown;
		},
	): string {
		return this.promptBuilder.buildIssueUpdatePrompt(
			issueIdentifier,
			issueData,
			updatedFrom,
		);
	}

	/**
	 * Get issue tracker for a workspace (direct lookup by workspace ID)
	 */
	private getIssueTrackerForWorkspace(
		linearWorkspaceId: string,
	): IIssueTrackerService | undefined {
		return this.issueTrackers.get(linearWorkspaceId);
	}

	/**
	 * Get the activity sink for a repository by looking up its workspace.
	 */
	private getActivitySinkForRepo(repoId: string): IActivitySink | undefined {
		const repo = this.repositories.get(repoId);
		if (!repo?.linearWorkspaceId) return undefined;
		return this.activitySinks.get(repo.linearWorkspaceId);
	}

	/**
	 * Get the Linear API token for a workspace from workspace-level config.
	 */
	private getLinearTokenForWorkspace(linearWorkspaceId: string): string | null {
		const workspaceConfig = this.config.linearWorkspaces?.[linearWorkspaceId];
		if (!workspaceConfig) {
			return null; // CLI platform / router platform / unconfigured workspace
		}
		return workspaceConfig.linearToken;
	}

	/**
	 * Return the shared RouterConnection, asserting it exists. Only valid to
	 * call in router mode (the constructor creates it when
	 * `platform === "router"`).
	 */
	private getRouterConnection(): RouterConnection {
		if (!this.routerConnection) {
			throw new Error(
				"RouterConnection is not initialized (platform is not 'router')",
			);
		}
		return this.routerConnection;
	}

	/**
	 * Download an attachment's bytes through the router (router mode). The
	 * device holds no Linear token, so it asks the router — which does — to
	 * fetch the attachment URL and return the bytes. Uses the first available
	 * router-backed tracker; a router device is bound to its own workspace(s)
	 * through a single connection, so any router tracker resolves the same
	 * download RPC.
	 */
	private downloadAttachmentViaRouter(
		url: string,
	): Promise<{ base64: string; contentType: string }> {
		for (const tracker of this.issueTrackers.values()) {
			if (tracker instanceof RouterIssueTrackerService) {
				return tracker.downloadAttachment(url);
			}
		}
		return Promise.reject(
			new Error("No router issue tracker available for attachment download"),
		);
	}

	/**
	 * Create a new Cyrus agent session with all necessary setup
	 * @param sessionId The Linear agent activity session ID
	 * @param issue Linear issue object
	 * @param repositories Repository configurations (primary repo is repositories[0])
	 * @param agentSessionManager Agent session manager instance
	 * @param linearWorkspaceId Linear workspace ID (from webhook.organizationId)
	 * @returns Object containing session details and setup information
	 */
	private async createCyrusAgentSession(
		sessionId: string,
		issue: { id: string; identifier: string },
		repositoriesOrSingle: RepositoryConfig | RepositoryConfig[],
		agentSessionManager: AgentSessionManager,
		linearWorkspaceId: string,
		baseBranchOverrides?: Map<string, string>,
		routingMethod?: string,
		creator?: SessionCreator,
	): Promise<AgentSessionData> {
		const repositories = Array.isArray(repositoriesOrSingle)
			? repositoriesOrSingle
			: [repositoriesOrSingle];
		const primaryRepo = repositories[0]!;

		// Fetch full Linear issue details using workspace ID from webhook context
		const fullIssue = await this.fetchFullIssueDetails(
			issue.id,
			linearWorkspaceId,
		);
		if (!fullIssue) {
			throw new Error(`Failed to fetch full issue details for ${issue.id}`);
		}

		// Move issue to started state automatically, in case it's not already
		await this.moveIssueToStartedState(fullIssue, linearWorkspaceId);

		// Create workspace using full issue data
		// IMPORTANT: The CLI app (apps/cli/src/services/WorkerService.ts) typically provides
		// a custom createWorkspace handler, so the handler path is the one taken in production.
		// When adding new options here, always update the handler signature in config-types.ts
		// AND the CLI's handler implementation in WorkerService.ts to pass them through.
		this.logger.info(
			`createCyrusAgentSession: passing baseBranchOverrides=${baseBranchOverrides ? `Map(size=${baseBranchOverrides.size}, keys=[${Array.from(baseBranchOverrides.keys()).join(",")}])` : "undefined"}, useCustomHandler=${!!this.config.handlers?.createWorkspace}`,
		);
		const workspace = this.config.handlers?.createWorkspace
			? await this.config.handlers.createWorkspace(fullIssue, repositories, {
					baseBranchOverrides,
					onRepoSetupHookEvent: (activity) =>
						this.activityPoster.postRepoSetupHookActivity(
							sessionId,
							linearWorkspaceId,
							activity,
						),
				})
			: await this.gitService.createGitWorktree(fullIssue, repositories, {
					baseBranchOverrides,
					onRepoSetupHookEvent: (activity) =>
						this.activityPoster.postRepoSetupHookActivity(
							sessionId,
							linearWorkspaceId,
							activity,
						),
				});

		this.logger.debug(`Workspace created at: ${workspace.path}`);

		const issueMinimal = this.convertLinearIssueToCore(fullIssue);

		// Create RepositoryContext entries for ALL repositories
		// Use resolved base branches from workspace creation (already accounts for
		// commit-ish overrides, graphite blocked-by, parent issues, and defaults)
		const repositoryContexts = repositories.map((repo) => ({
			repositoryId: repo.id,
			branchName: issueMinimal.branchName,
			baseBranchName:
				workspace.resolvedBaseBranches?.[repo.id]?.branch ?? repo.baseBranch,
			baseBranchSource: workspace.resolvedBaseBranches?.[repo.id]?.source,
		}));

		agentSessionManager.createCyrusAgentSession(
			sessionId,
			issue.id,
			issueMinimal,
			workspace,
			"linear",
			repositoryContexts,
			creator,
		);

		// Register session-to-repo mapping and activity sink (use primary repo)
		this.sessionRepositories.set(sessionId, primaryRepo.id);
		const activitySink = this.getActivitySinkForRepo(primaryRepo.id);
		if (activitySink) {
			agentSessionManager.setActivitySink(sessionId, activitySink);
		}

		// Post combined routing + base branch activity
		{
			const repoLines = repositories.map((repo) => {
				const resolution = workspace.resolvedBaseBranches?.[repo.id];
				const branch = resolution?.branch ?? repo.baseBranch;
				const sourceLabel = !resolution
					? "default"
					: resolution.source === "commit-ish"
						? "override"
						: resolution.source === "graphite-blocked-by"
							? (resolution.detail ?? "graphite")
							: resolution.source === "parent-issue"
								? (resolution.detail ?? "parent")
								: "default";
				return `- **${repo.name}** → \`${branch}\` (${sourceLabel})`;
			});
			await this.postRoutingActivity(
				sessionId,
				linearWorkspaceId,
				repoLines,
				routingMethod,
			);
		}

		// Get the newly created session
		const session = agentSessionManager.getSession(sessionId);
		if (!session) {
			throw new Error(
				`Failed to create session for agent activity session ${sessionId}`,
			);
		}

		// Download attachments before creating Claude runner
		const attachmentResult = await this.downloadIssueAttachments(
			fullIssue,
			linearWorkspaceId,
			workspace.path,
		);

		// Pre-create attachments directory even if no attachments exist yet
		const workspaceFolderName = basename(workspace.path);
		const attachmentsDir = join(
			this.cyrusHome,
			workspaceFolderName,
			"attachments",
		);
		await mkdir(attachmentsDir, { recursive: true });

		// Write Claude settings to disable co-authored-by attribution in the workspace.
		// This uses the SDK's "local" settings source (loaded via settingSources: ["user", "project", "local"])
		// to ensure Cyrus sessions don't add "Co-Authored-By: Claude" trailers to git commits.
		const claudeSettingsDir = join(workspace.path, ".claude");
		await mkdir(claudeSettingsDir, { recursive: true });
		await writeFile(
			join(claudeSettingsDir, "settings.local.json"),
			JSON.stringify(
				{
					includeCoAuthoredBy: false,
				},
				null,
				"\t",
			),
		);

		// Build allowed directories list - always include attachments directory
		// Include repository paths from all repositories
		const allRepoPaths = repositories.map((repo) => repo.repositoryPath);
		const allowedDirectories: string[] = [
			...new Set([
				attachmentsDir,
				...allRepoPaths,
				...this.gitService.getGitMetadataDirectoriesForWorkspace(workspace),
			]),
		];

		this.logger.debug(
			`Configured allowed directories for ${fullIssue.identifier}:`,
			allowedDirectories,
		);

		// Build allowed tools list with Linear MCP tools
		const allowedTools = this.buildAllowedTools(repositories);
		const disallowedTools = this.buildDisallowedTools(repositories);

		return {
			session,
			fullIssue,
			workspace,
			attachmentResult,
			attachmentsDir,
			allowedDirectories,
			allowedTools,
			disallowedTools,
		};
	}

	/**
	 * Handle agent session created webhook
	 * Can happen due to being 'delegated' or @ mentioned in a new thread
	 * @param webhook The agent session created webhook
	 * @param repos All available repositories for routing
	 */
	private async handleAgentSessionCreatedWebhook(
		webhook: AgentSessionCreatedWebhook,
		repos: RepositoryConfig[],
	): Promise<void> {
		const issueId = webhook.agentSession?.issue?.id;

		// Check the cache first, as the agentSessionCreated webhook may have been triggered by an @mention
		// on an issue that already has an agentSession and an associated repository.
		let repositories: RepositoryConfig[] | null = null;
		let baseBranchOverrides: Map<string, string> | undefined;
		let routingMethod: string | undefined;
		if (issueId) {
			const cachedRepos = this.getCachedRepositories(issueId);
			if (cachedRepos && cachedRepos.length > 0) {
				repositories = cachedRepos;
				this.logger.debug(
					`Using cached repositories [${cachedRepos.map((r) => r.name).join(", ")}] for issue ${issueId}`,
				);
			}
		}

		// If not cached, perform routing logic
		if (!repositories) {
			const routingResult =
				await this.repositoryRouter.determineRepositoryForWebhook(
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

			// Handle needs_selection case
			if (routingResult.type === "needs_selection") {
				await this.repositoryRouter.elicitUserRepositorySelection(
					webhook,
					routingResult.workspaceRepos,
				);
				// Selection in progress - will be handled by handleRepositorySelectionResponse
				return;
			}

			// At this point, routingResult.type === "selected"
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

			// Cache all matched repositories for this issue as string[]
			if (issueId) {
				this.repositoryRouter.getIssueRepositoryCache().set(
					issueId,
					repositories.map((r) => r.id),
				);
			}
		}

		if (!webhook.agentSession.issue) {
			this.logger.warn("Agent session created webhook missing issue");
			return;
		}

		// User access control check (use primary repo)
		const primaryRepo = repositories[0]!;
		const accessResult = this.checkUserAccess(webhook, primaryRepo);
		if (!accessResult.allowed) {
			this.logger.info(
				`User ${accessResult.userName} blocked from delegating: ${accessResult.reason}`,
			);
			await this.handleBlockedUser(webhook, primaryRepo, accessResult.reason);
			return;
		}

		// Use organizationId from webhook as the Linear-native workspace ID source
		const linearWorkspaceId = webhook.organizationId;

		const log = this.logger.withContext({
			sessionId: webhook.agentSession.id,
			platform: this.getRepositoryPlatform(linearWorkspaceId),
			issueIdentifier: webhook.agentSession.issue.identifier,
		});
		log.info(`Handling agent session created`);
		const { agentSession, guidance } = webhook;
		const commentBody = agentSession.comment?.body;

		// If this issue is a sub-issue of an issue Cyrus has a session on, link the
		// two so the parent is resumed when this session completes. Done before the
		// blocked-by check so a parked child is linked as well.
		await this.linkChildSessionToParentIssueSession(
			agentSession.id,
			agentSession.issue,
			linearWorkspaceId,
		);

		// Check for blocked-by dependencies before starting work
		const blockResult = await this.checkBlockedByDependencies(
			agentSession,
			linearWorkspaceId,
		);
		if (blockResult.blocked) {
			// Park the session — don't create worktree or runner
			const parkedIssueId = agentSession.issue!.id;
			this.parkedSessions.set(parkedIssueId, {
				agentSession,
				repositories,
				linearWorkspaceId,
				guidance,
				commentBody,
				baseBranchOverrides,
				routingMethod,
				blockingIssueIds: blockResult.blockingIssueIds,
			});

			// Post acknowledgment to the Linear agent session
			const blockerList = blockResult.blockingIdentifiers
				.map((id) => `**${id}**`)
				.join(", ");
			await this.activityPoster.postThoughtActivity(
				agentSession.id,
				linearWorkspaceId,
				`Blocked by ${blockerList} — will start automatically when ${blockResult.blockingIdentifiers.length === 1 ? "it is" : "they are"} resolved.`,
			);

			log.info(
				`Session parked: issue ${agentSession.issue!.identifier} is blocked by ${blockResult.blockingIdentifiers.join(", ")}`,
			);
			return;
		}

		// Initialize agent runner using shared logic (pass full repositories array)
		await this.initializeAgentRunner(
			agentSession,
			repositories,
			linearWorkspaceId,
			guidance,
			commentBody,
			baseBranchOverrides,
			routingMethod,
		);
	}

	/**

	/**
	 * Initialize and start agent runner for an agent session
	 * This method contains the shared logic for creating an agent runner that both
	 * handleAgentSessionCreatedWebhook and handleUserPromptedAgentActivity use.
	 *
	 * @param agentSession The Linear agent session
	 * @param repositories Repository configurations (primary repo is repositories[0])
	 * @param linearWorkspaceId Linear workspace ID (from webhook.organizationId)
	 * @param guidance Optional guidance rules from Linear
	 * @param commentBody Optional comment body (for mentions)
	 * @param baseBranchOverrides Per-repo base branch overrides from [repo=name#branch] syntax
	 */
	private async initializeAgentRunner(
		agentSession: AgentSessionCreatedWebhook["agentSession"],
		repositories: RepositoryConfig[],
		linearWorkspaceId: string,
		guidance?: AgentSessionCreatedWebhook["guidance"],
		commentBody?: string | null,
		baseBranchOverrides?: Map<string, string>,
		routingMethod?: string,
	): Promise<void> {
		const sessionId = agentSession.id;
		const { issue } = agentSession;

		if (!issue) {
			this.logger.warn("Cannot initialize Claude runner without issue");
			return;
		}

		// Persistence floor: this issue is about to get a runner that may work
		// for a long time before its session ever reaches a terminal state.
		// touch() here (rather than only at session end) is what lets the
		// periodic timer keep re-syncing it on every tick while it runs, and
		// registers `sessionId` as a live session on the issue (a refcount —
		// see WorkspaceSyncService's class doc — so a sibling session on the
		// same issue can't be un-protected by this one's eventual termination).
		// A no-op on non-router platforms — `workspaceSync` is only
		// constructed when `platform === "router"`.
		this.workspaceSync?.touch(issue.identifier, sessionId);

		const primaryRepo = repositories[0]!;

		const log = this.logger.withContext({
			sessionId,
			issueIdentifier: issue.identifier,
		});

		// Log guidance if present
		if (guidance && guidance.length > 0) {
			log.debug(`Agent guidance received: ${guidance.length} rule(s)`);
			for (const rule of guidance) {
				let origin = "Unknown";
				if (rule.origin) {
					if (rule.origin.__typename === "TeamOriginWebhookPayload") {
						origin = `Team: ${rule.origin.team.displayName}`;
					} else {
						origin = "Organization";
					}
				}
				log.info(`- ${origin}: ${rule.body.substring(0, 100)}...`);
			}
		}

		// HACK: This is required since the comment body is always populated, thus there is no other way to differentiate between the two trigger events
		const AGENT_SESSION_MARKER = "This thread is for an agent session";
		const isMentionTriggered =
			commentBody && !commentBody.includes(AGENT_SESSION_MARKER);
		// Check if the comment contains the /label-based-prompt command
		const isLabelBasedPromptRequested = commentBody?.includes(
			"/label-based-prompt",
		);

		const agentSessionManager = this.agentSessionManager;

		// Post instant acknowledgment thought
		await this.postInstantAcknowledgment(sessionId, linearWorkspaceId);

		// Create the session using the shared method (pass full repositories array)
		// agentSession.creator is threaded onto the session on every entry path
		// (created webhook, parked auto-wake, parked reprompt,
		// repository-selection response) for session provenance/bookkeeping —
		// e.g. display attribution and router-mode device routing (see
		// EventRouter.resolveTarget's creator-based user/device lookup) —
		// not for per-user credential resolution, which was removed.
		const sessionData = await this.createCyrusAgentSession(
			sessionId,
			issue,
			repositories,
			agentSessionManager,
			linearWorkspaceId,
			baseBranchOverrides,
			routingMethod,
			agentSession.creator ?? undefined,
		);

		// Destructure the session data (excluding allowedTools which we'll build with promptType)
		const {
			session,
			fullIssue,
			workspace: _workspace,
			attachmentResult,
			attachmentsDir: _attachmentsDir,
			allowedDirectories,
		} = sessionData;

		// Fetch labels early (needed for system prompt and runner selection)
		const labels = await this.fetchIssueLabels(fullIssue);

		log.info(`Starting agent session for issue ${fullIssue.identifier}`);

		// Build and start Claude with initial prompt using full issue (streaming mode)
		log.info(`Building initial prompt for issue ${fullIssue.identifier}`);
		try {
			// Create input for unified prompt assembly
			const input: PromptAssemblyInput = {
				session,
				fullIssue,
				repositories,
				repository: primaryRepo,
				userComment: commentBody || "", // Empty for delegation, present for mentions
				attachmentManifest: attachmentResult.manifest,
				guidance: guidance || undefined,
				agentSession,
				labels,
				isNewSession: true,
				isStreaming: false, // Not yet streaming
				isMentionTriggered: isMentionTriggered || false,
				isLabelBasedPromptRequested: isLabelBasedPromptRequested || false,
				resolvedBaseBranches: sessionData.workspace.resolvedBaseBranches,
				linearWorkspaceId,
			};

			// Use unified prompt assembly
			const assembly = await this.assemblePrompt(input);

			// Get systemPromptVersion for tracking (TODO: add to PromptAssembly metadata)
			let systemPromptVersion: string | undefined;
			let promptType:
				| "debugger"
				| "builder"
				| "scoper"
				| "orchestrator"
				| "graphite-orchestrator"
				| undefined;

			if (!isMentionTriggered || isLabelBasedPromptRequested) {
				const systemPromptResult = await this.determineSystemPromptFromLabels(
					labels,
					primaryRepo,
				);
				systemPromptVersion = systemPromptResult?.version;
				promptType = systemPromptResult?.type;

				// Post thought about system prompt selection
				if (assembly.systemPrompt) {
					await this.postSystemPromptSelectionThought(
						sessionId,
						labels,
						linearWorkspaceId,
						primaryRepo.id,
					);
				}
			}

			// Build allowed tools list with Linear MCP tools (now with prompt type context)
			const allowedTools = this.buildAllowedTools(repositories, promptType);
			const disallowedTools = this.buildDisallowedTools(
				repositories,
				promptType,
			);

			log.debug(
				`Configured allowed tools for ${fullIssue.identifier}:`,
				allowedTools,
			);
			if (disallowedTools.length > 0) {
				log.debug(
					`Configured disallowed tools for ${fullIssue.identifier}:`,
					disallowedTools,
				);
			}

			// Create agent runner with system prompt from assembly
			// buildAgentRunnerConfig now determines runner type from labels internally
			const { config: runnerConfig, runnerType } =
				await this.buildAgentRunnerConfig(
					session,
					primaryRepo,
					sessionId,
					assembly.systemPrompt,
					allowedTools,
					allowedDirectories,
					disallowedTools,
					undefined, // resumeSessionId
					labels, // Pass labels for runner selection and model override
					fullIssue.description || undefined, // Description tags can override label selectors
					undefined, // maxTurns
					linearWorkspaceId,
					this.buildSkillSessionContext(primaryRepo, fullIssue, session),
				);

			log.debug(
				`Label-based runner selection for new session: ${runnerType} (session ${sessionId})`,
			);

			const runner = this.createRunnerForType(runnerType, runnerConfig);

			// Store runner by comment ID
			agentSessionManager.addAgentRunner(sessionId, runner);

			// Save state after mapping changes
			await this.savePersistedState();

			// Emit events using full issue (core Issue type)
			this.emit("session:started", fullIssue.id, fullIssue, primaryRepo.id);
			this.config.handlers?.onSessionStart?.(
				fullIssue.id,
				fullIssue,
				primaryRepo.id,
			);

			// Update runner with version information (if available)
			// Note: updatePromptVersions is specific to ClaudeRunner
			if (
				systemPromptVersion &&
				"updatePromptVersions" in runner &&
				typeof runner.updatePromptVersions === "function"
			) {
				runner.updatePromptVersions({
					systemPromptVersion,
				});
			}

			// Log metadata for debugging
			log.debug(
				`Initial prompt built successfully - components: ${assembly.metadata.components.join(", ")}, type: ${assembly.metadata.promptType}, length: ${assembly.userPrompt.length} characters`,
			);

			// Start session - use streaming mode if supported for ability to add messages later
			if (runner.supportsStreamingInput && runner.startStreaming) {
				log.debug(`Starting streaming session`);
				const sessionInfo = await runner.startStreaming(assembly.userPrompt);
				log.debug(`Streaming session started: ${sessionInfo.sessionId}`);
			} else {
				log.debug(`Starting non-streaming session`);
				const sessionInfo = await runner.start(assembly.userPrompt);
				log.debug(`Non-streaming session started: ${sessionInfo.sessionId}`);
			}
			// Note: AgentSessionManager will be initialized automatically when the first system message
			// is received via handleClaudeMessage() callback
		} catch (error) {
			log.error(`Error in prompt building/starting:`, error);
			// Nothing above us turns this into anything a user can see.
			// `handleWebhook`'s catch logs and deliberately does not rethrow, so
			// without this the session sits at "Working…" in Linear forever, with
			// the router's issue lock and affinity still held. Post the reason and
			// go terminal here, where we still know which session it was.
			//
			// This matters most for the failure it was added for — a host that
			// opted into subprocess env scrubbing it cannot provide
			// (SubprocessEnvScrubUnavailableError, NOR-412) — whose entire purpose
			// is to be a loud abort rather than a silent degradation. But every
			// start-time throw has the same shape, so the handling is general.
			await this.failSessionOnStartupError(
				agentSessionManager,
				sessionId,
				error,
			);
			throw error;
		}
	}

	/**
	 * Report a session that died before the agent ran, then let the error keep
	 * propagating. Best-effort: if we cannot reach Linear, the original failure
	 * is still the one worth surfacing, so it must not be masked by this.
	 */
	private async failSessionOnStartupError(
		agentSessionManager: AgentSessionManager,
		sessionId: string,
		error: unknown,
	): Promise<void> {
		const reason = error instanceof Error ? error.message : String(error);
		try {
			await agentSessionManager.failSession(
				sessionId,
				`This session could not be started.\n\n\`\`\`\n${reason}\n\`\`\``,
			);
		} catch (err) {
			this.logger.error(
				`Failed to mark session ${sessionId} as failed after a startup error:`,
				err,
			);
		}
	}

	/**
	 * Handle stop signal from prompted webhook
	 * Branch 1 of agentSessionPrompted (see packages/CLAUDE.md)
	 *
	 * IMPORTANT: Stop signals do NOT require repository lookup.
	 * The session must already exist (per CLAUDE.md), so we search
	 * all agent session managers to find it.
	 */
	private async handleStopSignal(
		webhook: AgentSessionPromptedWebhook,
	): Promise<void> {
		const agentSessionId = webhook.agentSession.id;
		const { issue } = webhook.agentSession;
		const log = this.logger.withContext({ sessionId: agentSessionId });

		log.info(
			`Received stop signal for agent activity session ${agentSessionId}`,
		);

		// Find the session in the single session manager
		const foundSession = this.agentSessionManager.getSession(agentSessionId);

		if (!foundSession) {
			// Legacy recovery: session lost after restart/migration
			// Post acknowledgment so the user doesn't see a hanging state
			log.info(
				`No session found for stop signal ${agentSessionId} (likely a legacy session after restart)`,
			);

			const issueTitle = issue?.title || "this issue";
			await this.agentSessionManager.createResponseActivity(
				agentSessionId,
				`Stop signal received for ${issueTitle}. No active session was found (the session may have ended or the system was restarted). No further action is needed.`,
			);
			// Acknowledging the user is not the whole job. Routing this stop's
			// `prompted` webhook re-established the router's session affinity for
			// this device, and only a terminal frame drops it again. Returning here
			// leaves a row nothing will ever clear, and ContainerLifecycle skips
			// any device with affinity > 0 — so the container is neither
			// idle-stopped nor stale-destroyed (PAR-146). Forced, because a session
			// we cannot find may well have emitted its terminal already.
			await this.agentSessionManager.abortSession(agentSessionId, {
				force: true,
			});
			return;
		}

		// Double-stop detection: two stop signals within 10s → full abort
		const now = Date.now();
		const lastStop = this.lastStopTimeBySession.get(agentSessionId);
		const isDoubleStop = lastStop !== undefined && now - lastStop < 10_000;
		this.lastStopTimeBySession.set(agentSessionId, now);

		const existingRunner = foundSession.agentRunner;
		const issueTitle = issue?.title || "this issue";
		const senderName = webhook.agentSession.creator?.name || "user";

		// Only warm sessions can be safely interrupted without killing the
		// underlying request. Non-warm sessions get a single-shot full stop —
		// calling interrupt() on them surfaces a "Request was aborted" error
		// from the SDK (see CYPACK-1145).
		const supportsInterrupt = Boolean(
			existingRunner?.interrupt && existingRunner?.isWarm?.(),
		);

		if (isDoubleStop || !supportsInterrupt) {
			// Either a second stop within window, or a non-warm runner — full kill
			this.agentSessionManager.requestSessionStop(agentSessionId);
			if (existingRunner) {
				existingRunner.stop();
				log.info(
					isDoubleStop
						? `Double-stop: fully aborted session ${agentSessionId}`
						: `Stopped session ${agentSessionId} (interrupt not supported)`,
				);
			}
			// Post the closing response BEFORE going terminal, for the same reason
			// completeSession does: the router drops this device's ownership of the
			// session the instant it sees the terminal state and rejects anything
			// posted afterwards with "session not owned by this device". Posting
			// after the abort cost this path its final response, leaving the thread
			// with no record that the stop ever landed.
			await this.agentSessionManager.createResponseActivity(
				agentSessionId,
				isDoubleStop
					? `I've fully stopped working on ${issueTitle}.\n\n**Stop Signal:** Received from ${senderName} (second stop)\n**Action Taken:** Session terminated`
					: `I've stopped working on ${issueTitle}.\n\n**Stop Signal:** Received from ${senderName}\n**Action Taken:** Session terminated`,
			);
			// The kill tears the query down before it can yield a result, so
			// completeSession() — and with it the "sessionTerminal" emit — never
			// runs. Signal the terminal state explicitly, or router mode holds this
			// issue's lock until an admin runs `cyrus router unlock`. The interrupt
			// branch below needs no such call: the query still returns a result.
			//
			// Forced: a stop can land on a session that already finished, whose
			// terminal one-shot is therefore spent. Routing the stop re-established
			// the router's session affinity, so a silent no-op here strands that
			// row and pins the container forever (PAR-146). When the session really
			// is live the one-shot is unspent and `force` changes nothing.
			await this.agentSessionManager.abortSession(agentSessionId, {
				force: true,
			});
			this.lastStopTimeBySession.delete(agentSessionId);
		} else {
			// First stop on a warm session — interrupt current turn, keep session warm
			await existingRunner!.interrupt!();
			log.info(
				`Interrupted current turn for session ${agentSessionId} (send stop again within 10s to fully terminate)`,
			);
			await this.agentSessionManager.createResponseActivity(
				agentSessionId,
				`Interrupted by ${senderName}\n**Tip:** Type and send "stop" within 10 seconds to fully terminate the session.`,
			);
		}
	}

	/**
	 * Handle repository selection response from prompted webhook
	 * Branch 2 of agentSessionPrompted (see packages/CLAUDE.md)
	 *
	 * This method extracts the user's repository selection from their response,
	 * or uses the fallback repository if their message doesn't match any option.
	 * In both cases, the selected repository is cached for future use.
	 */
	private async handleRepositorySelectionResponse(
		webhook: AgentSessionPromptedWebhook,
	): Promise<void> {
		const { agentSession, agentActivity, guidance } = webhook;
		const commentBody = agentSession.comment?.body;
		const agentSessionId = agentSession.id;
		const log = this.logger.withContext({ sessionId: agentSessionId });

		if (!agentActivity) {
			log.warn("Cannot handle repository selection without agentActivity");
			return;
		}

		if (!agentSession.issue) {
			log.warn("Cannot handle repository selection without issue");
			return;
		}

		const userMessage = agentActivity.content.body;

		log.debug(`Processing repository selection response: "${userMessage}"`);

		// Get the selected repository (or fallback)
		const repository = await this.repositoryRouter.selectRepositoryFromResponse(
			agentSessionId,
			userMessage,
		);

		if (!repository) {
			log.error(
				`Failed to select repository for agent session ${agentSessionId}`,
			);
			return;
		}

		// Cache the selected repository for this issue as string[]
		const issueId = agentSession.issue.id;
		this.repositoryRouter
			.getIssueRepositoryCache()
			.set(issueId, [repository.id]);

		log.debug(
			`Initializing agent runner after repository selection: ${agentSession.issue.identifier} -> ${repository.name}`,
		);

		// The created webhook returned early to ask for a repository, so the
		// parent-issue link has not been established yet for this session.
		await this.linkChildSessionToParentIssueSession(
			agentSessionId,
			agentSession.issue,
			webhook.organizationId,
		);

		// Initialize agent runner with the selected repository (wrapped in array)
		// routingMethod="user-selected" will be included in the combined routing activity
		// Use organizationId from webhook as the Linear-native workspace ID source
		await this.initializeAgentRunner(
			agentSession,
			[repository],
			webhook.organizationId,
			guidance,
			commentBody,
			undefined,
			"user-selected",
		);
	}

	/**
	 * Handle AskUserQuestion response from prompted webhook
	 * Branch 2.5: User response to a question posed via AskUserQuestion tool
	 *
	 * @param webhook The prompted webhook containing user's response
	 */
	private async handleAskUserQuestionResponse(
		webhook: AgentSessionPromptedWebhook,
	): Promise<void> {
		const { agentSession, agentActivity } = webhook;
		const agentSessionId = agentSession.id;

		if (!agentActivity) {
			this.logger.warn(
				"Cannot handle AskUserQuestion response without agentActivity",
			);
			// Resolve with a denial to unblock the waiting promise
			this.askUserQuestionHandler.cancelPendingQuestion(
				agentSessionId,
				"No agent activity in webhook",
			);
			return;
		}

		// Extract the user's response from the activity body
		const userResponse = agentActivity.content?.body || "";

		this.logger.debug(
			`Processing AskUserQuestion response for session ${agentSessionId}: "${userResponse}"`,
		);

		// Pass the response to the handler to resolve the waiting promise
		const handled = this.askUserQuestionHandler.handleUserResponse(
			agentSessionId,
			userResponse,
		);

		if (!handled) {
			this.logger.warn(
				`AskUserQuestion response not handled for session ${agentSessionId} (no pending question)`,
			);
		} else {
			this.logger.debug(
				`AskUserQuestion response handled for session ${agentSessionId}`,
			);
		}
	}

	/**
	 * Releases the router-side claim for a prompted event we cannot service.
	 *
	 * The router re-establishes session affinity for EVERY prompt, including one
	 * for an already-completed session (deliberately — a Linear agent session
	 * outlives its turns). If we then drop the event silently, no terminal frame
	 * ever follows and that affinity row is permanent, pinning the container out
	 * of the idle sweep. Non-fatal: reconciliation is the real backstop.
	 */
	private signalUnserviceablePrompt(sessionId: string, reason: string): void {
		if (this.config.platform !== "router") return;
		try {
			this.routerConnection?.sendSessionState(sessionId, "error");
			this.logger.warn(
				`Released router claim for unserviceable prompt on session ${sessionId}: ${reason}`,
			);
		} catch (err) {
			this.logger.warn(
				`Failed to release router claim for session ${sessionId}: ${String(err)}`,
			);
		}
	}

	/**
	 * Handle normal prompted activity (existing session continuation)
	 * Branch 3 of agentSessionPrompted (see packages/CLAUDE.md)
	 */
	private async handleNormalPromptedActivity(
		webhook: AgentSessionPromptedWebhook,
		repositories: RepositoryConfig[],
	): Promise<void> {
		const repository = repositories[0]!;
		const { agentSession } = webhook;
		const sessionId = agentSession.id;
		const { issue } = agentSession;
		// Use organizationId from webhook as the Linear-native workspace ID source
		const linearWorkspaceId = webhook.organizationId;

		if (!issue) {
			this.logger.warn("Cannot handle prompted activity without issue");
			this.signalUnserviceablePrompt(sessionId, "missing issue");
			return;
		}

		if (!webhook.agentActivity) {
			this.logger.warn("Cannot handle prompted activity without agentActivity");
			this.signalUnserviceablePrompt(sessionId, "missing agentActivity");
			return;
		}

		const commentId = webhook.agentActivity.sourceCommentId;

		const agentSessionManager = this.agentSessionManager;

		let session = agentSessionManager.getSession(sessionId);
		let isNewSession = false;
		let fullIssue: Issue | null = null;

		if (!session) {
			this.logger.debug(
				`No existing session found for agent activity session ${sessionId}, creating new session`,
			);
			isNewSession = true;

			// Post instant acknowledgment for new session creation
			await this.postInstantPromptedAcknowledgment(
				sessionId,
				linearWorkspaceId,
				false,
			);

			// Create the session using the shared method with all repositories
			const sessionData = await this.createCyrusAgentSession(
				sessionId,
				issue,
				repositories,
				agentSessionManager,
				linearWorkspaceId,
				undefined, // baseBranchOverrides
				undefined, // routingMethod
				webhook.agentSession.creator ?? undefined,
			);

			// Destructure session data for new session
			fullIssue = sessionData.fullIssue;
			session = sessionData.session;

			this.logger.debug(`Created new session ${sessionId} (prompted webhook)`);

			// Save state and emit events for new session
			await this.savePersistedState();
			// Emit events using full issue (core Issue type)
			this.emit("session:started", fullIssue.id, fullIssue, repository.id);
			this.config.handlers?.onSessionStart?.(
				fullIssue.id,
				fullIssue,
				repository.id,
			);
		} else {
			this.logger.debug(
				`Found existing session ${sessionId} for new user prompt`,
			);

			// Post instant acknowledgment for existing session BEFORE any async work
			// Check if runner is currently running (streaming is Claude-specific, use isRunning for both)
			const isCurrentlyStreaming = session?.agentRunner?.isRunning() || false;

			await this.postInstantPromptedAcknowledgment(
				sessionId,
				linearWorkspaceId,
				isCurrentlyStreaming,
			);

			// Need to fetch full issue for routing context
			const issueTracker = this.issueTrackers.get(linearWorkspaceId);
			if (issueTracker) {
				try {
					fullIssue = await issueTracker.fetchIssue(issue.id);
				} catch (error) {
					this.logger.warn(
						`Failed to fetch full issue for routing: ${issue.id}`,
						error,
					);
					// Continue with degraded routing context
				}
			}
		}

		// Note: Streaming check happens later in handlePromptWithStreamingCheck
		// after attachments are processed

		// Ensure session is not null after creation/retrieval
		if (!session) {
			throw new Error(
				`Failed to get or create session for agent activity session ${sessionId}`,
			);
		}

		// Acknowledgment already posted above for both new and existing sessions
		// (before any async routing work to ensure instant user feedback)

		// Get issue tracker using workspace ID from webhook context
		const issueTracker = this.issueTrackers.get(linearWorkspaceId);
		if (!issueTracker) {
			this.logger.error(
				"Unexpected: There was no IssueTrackerService for workspace",
				linearWorkspaceId,
			);
			return;
		}

		// Always set up attachments directory, even if no attachments in current comment
		const workspaceFolderName = basename(session.workspace.path);
		const attachmentsDir = join(
			this.cyrusHome,
			workspaceFolderName,
			"attachments",
		);
		// Ensure directory exists
		await mkdir(attachmentsDir, { recursive: true });

		let attachmentManifest = "";
		let commentAuthor: string | undefined;
		let commentTimestamp: string | undefined;

		if (!commentId) {
			this.logger.warn("No comment ID provided for attachment handling");
		}

		try {
			const comment = commentId
				? await issueTracker.fetchComment(commentId)
				: null;

			// Extract comment metadata for multi-player context
			if (comment) {
				const user = await comment.user;
				commentAuthor =
					user?.displayName || user?.name || user?.email || "Unknown";
				commentTimestamp = comment.createdAt
					? comment.createdAt.toISOString()
					: new Date().toISOString();
			}

			// Count existing attachments
			const existingFiles = await readdir(attachmentsDir).catch(() => []);
			const existingAttachmentCount = existingFiles.filter(
				(file) => file.startsWith("attachment_") || file.startsWith("image_"),
			).length;

			// Download new attachments from the comment
			const linearTokenForAttachments =
				this.getLinearTokenForWorkspace(linearWorkspaceId);
			const downloadResult = comment
				? await this.downloadCommentAttachments(
						comment.body,
						attachmentsDir,
						linearTokenForAttachments,
						existingAttachmentCount,
					)
				: {
						totalNewAttachments: 0,
						newAttachmentMap: {},
						newImageMap: {},
						failedCount: 0,
					};

			if (downloadResult.totalNewAttachments > 0) {
				attachmentManifest = this.generateNewAttachmentManifest(downloadResult);
			}
		} catch (error) {
			this.logger.error("Failed to fetch comments for attachments:", error);
		}

		const promptBody = webhook.agentActivity.content.body;

		// Use centralized streaming check and routing logic
		try {
			await this.handlePromptWithStreamingCheck(
				session,
				repository,
				sessionId,
				agentSessionManager,
				promptBody,
				attachmentManifest,
				isNewSession,
				[], // No additional allowed directories for regular continuation
				`prompted webhook (${isNewSession ? "new" : "existing"} session)`,
				linearWorkspaceId,
				commentAuthor,
				commentTimestamp,
			);
		} catch (error) {
			this.logger.error("Failed to handle prompted webhook:", error);
		}
	}

	/**
	 * Handle user-prompted agent activity webhook
	 * Implements three-branch architecture from packages/CLAUDE.md:
	 *   1. Stop signal - terminate existing runner
	 *   2. Repository selection response - initialize Claude runner for first time
	 *   3. Normal prompted activity - continue existing session or create new one
	 *
	 * @param webhook The prompted webhook containing user's message
	 */
	private async handleUserPromptedAgentActivity(
		webhook: AgentSessionPromptedWebhook,
	): Promise<void> {
		const agentSessionId = webhook.agentSession.id;
		const activityBody = webhook.agentActivity?.content?.body || "";
		const signal = (webhook.agentActivity as any)?.signal;
		const isTextStopRequest = /^\s*stop(\s+session|\s+working)?[\s.!?]*$/i.test(
			activityBody,
		);

		// Branch 1: Handle stop signal (checked FIRST, before any routing work)
		// Per CLAUDE.md: "an agentSession MUST already exist" for stop signals
		// IMPORTANT: Stop signals do NOT require repository lookup
		if (signal === "stop" || isTextStopRequest) {
			await this.handleStopSignal(webhook);
			return;
		}

		// Branch 1.5: Handle re-prompt for parked (blocked-by) sessions
		// When a user re-prompts and the session is parked, re-check blocking status.
		// If blockers are resolved, wake the session immediately.
		const issueIdForParkedCheck = webhook.agentSession?.issue?.id;
		if (
			issueIdForParkedCheck &&
			this.parkedSessions.has(issueIdForParkedCheck)
		) {
			await this.handleParkedSessionReprompt(webhook, issueIdForParkedCheck);
			return;
		}

		// Branch 2: Handle repository selection response
		// This is the first Claude runner initialization after user selects a repository.
		// The selection handler extracts the choice from the response (or uses fallback)
		// and caches the repository for future use.
		if (this.repositoryRouter.hasPendingSelection(agentSessionId)) {
			await this.handleRepositorySelectionResponse(webhook);
			return;
		}

		// Branch 2.5: Handle AskUserQuestion response
		// This handles responses to questions posed via the AskUserQuestion tool.
		// The response is passed to the pending promise resolver.
		if (this.askUserQuestionHandler.hasPendingQuestion(agentSessionId)) {
			await this.handleAskUserQuestionResponse(webhook);
			return;
		}

		// Branch 3: Handle normal prompted activity (existing session continuation)
		// Per CLAUDE.md: "an agentSession MUST exist and a repository MUST already
		// be associated with the Linear issue. The repository will be retrieved from
		// the issue-to-repository cache - no new routing logic is performed."
		const issueId = webhook.agentSession?.issue?.id;
		if (!issueId) {
			this.logger.error(
				`No issue ID found in prompted webhook ${agentSessionId}`,
			);
			return;
		}

		// Resolve ALL cached repositories for this issue (not just the first).
		// Multi-repo sessions need the full set for workspace recreation.
		let repositories = this.getCachedRepositories(issueId);
		if (!repositories || repositories.length === 0) {
			// Fallback: attempt to recover repository for legacy/restarted sessions
			this.logger.info(
				`No cached repository for prompted webhook ${agentSessionId}, attempting fallback resolution`,
			);

			// First, check if the session manager already has this session
			const session = this.agentSessionManager.getSession(agentSessionId);
			if (session) {
				const repoId = this.sessionRepositories.get(agentSessionId);
				if (repoId) {
					const repo = this.repositories.get(repoId) ?? null;
					if (repo) {
						repositories = [repo];
						this.repositoryRouter
							.getIssueRepositoryCache()
							.set(issueId, [repoId]);
						this.logger.info(
							`Recovered repository ${repoId} for issue ${issueId} from session manager`,
						);
					}
				}
			}

			// Second fallback: re-route via repository router
			if (!repositories || repositories.length === 0) {
				try {
					const repos = Array.from(this.repositories.values());
					const routingResult =
						await this.repositoryRouter.determineRepositoryForWebhook(
							webhook,
							repos,
						);

					if (routingResult.type === "selected") {
						repositories = routingResult.repositories;
						this.repositoryRouter.getIssueRepositoryCache().set(
							issueId,
							routingResult.repositories.map((r) => r.id),
						);
						this.logger.info(
							`Recovered repositories [${repositories.map((r) => r.name).join(", ")}] for issue ${issueId} via fallback routing (${routingResult.routingMethod})`,
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
				// All recovery attempts failed - post visible feedback
				await this.agentSessionManager.createResponseActivity(
					agentSessionId,
					"I couldn't process your message because the session configuration was lost. Please create a new session by mentioning me (@cyrus) in a new comment with your prompt.",
				);
				this.logger.warn(
					`Failed to recover repository for prompted webhook ${agentSessionId} - all fallback methods exhausted`,
				);
				return;
			}
		}

		// User access control check for mid-session prompts (use primary repo)
		const primaryRepo = repositories[0]!;
		const accessResult = this.checkUserAccess(webhook, primaryRepo);
		if (!accessResult.allowed) {
			this.logger.info(
				`User ${accessResult.userName} blocked from prompting: ${accessResult.reason}`,
			);
			await this.handleBlockedUser(webhook, primaryRepo, accessResult.reason);
			return;
		}

		await this.handleNormalPromptedActivity(webhook, repositories);
	}

	/**
	 * Handle issue unassignment
	 * @param issue Linear issue object from webhook data
	 * @param linearWorkspaceId Linear workspace ID (from webhook.organizationId)
	 */
	private async handleIssueUnassigned(
		issue: WebhookIssue,
		linearWorkspaceId: string,
	): Promise<void> {
		const sessions = this.agentSessionManager.getSessionsByIssueId(issue.id);
		const activeThreadCount = sessions.length;

		// Stop all agent runners for this issue
		for (const session of sessions) {
			this.logger.info(`Stopping agent runner for issue ${issue.identifier}`);
			this.agentSessionManager.requestSessionStop(session.id);
			session.agentRunner?.stop();
		}

		// Post ONE farewell comment on the issue (not in any thread) if there were active sessions
		if (activeThreadCount > 0) {
			await this.postComment(
				issue.id,
				"I've been unassigned and am stopping work now.",
				linearWorkspaceId,
				// No parentId - post as a new comment on the issue
			);
		}

		// Emit events
		this.logger.info(
			`Stopped ${activeThreadCount} sessions for unassigned issue ${issue.identifier}`,
		);
	}

	/**
	 * Handle Claude messages
	 */
	private async handleClaudeMessage(
		sessionId: string,
		message: SDKMessage,
		repositoryId: string,
	): Promise<void> {
		this.recordMcpSessionInit(sessionId, message, repositoryId);
		await this.agentSessionManager.handleClaudeMessage(sessionId, message);
	}

	/**
	 * Fold the SDK's per-session MCP connection report into the health registry.
	 *
	 * The `system`/`init` message is the only place the SDK reports per-server
	 * connection state, and with `MCP_CONNECTION_NONBLOCKING=true` a server that
	 * never connected does not fail the session — so this is the hook that turns
	 * "the agent mentioned MCP was reconnecting" into an operator-visible
	 * diagnostic plus a bounded re-probe of anything that failed transiently.
	 *
	 * Never throws: MCP diagnostics must not be able to break message handling.
	 */
	private recordMcpSessionInit(
		sessionId: string,
		message: SDKMessage,
		repositoryId: string,
	): void {
		if (message.type !== "system" || message.subtype !== "init") return;
		const servers = message.mcp_servers;
		if (!servers || servers.length === 0) return;

		try {
			// Re-derive the configs so a transient failure can be re-probed. Safe
			// and side-effect-free (no context is registered).
			let configs: Record<string, McpServerConfig> | undefined;
			const repo = this.repositories.get(repositoryId);
			if (repo) {
				try {
					configs = this.mcpConfigService.describeMcpServers(
						repo.id,
						requireLinearWorkspaceId(repo),
					);
					// `cyrus-tools` cannot be probed without a live session context —
					// see the exemption in probeMcpHealth().
					delete configs["cyrus-tools"];
				} catch {
					configs = undefined;
				}
			}

			this.mcpHealthMonitor.recordSessionInit({
				sessionId,
				servers,
				...(configs ? { configs } : {}),
			});
		} catch (error) {
			this.logger.warn("Failed to record MCP session init statuses:", error);
		}
	}

	/**
	 * Handle Claude session error
	 * Silently ignores AbortError (user-initiated stop), logs other errors
	 */
	private async handleClaudeError(error: Error): Promise<void> {
		// AbortError is expected when user stops Claude process, don't log it
		// Check by name since the SDK's AbortError class may not match our imported definition
		const isAbortError =
			error.name === "AbortError" || error.message.includes("aborted by user");

		// Also check for SIGTERM (exit code 143), which indicates graceful termination
		const isSigterm = error.message.includes(
			"Claude Code process exited with code 143",
		);

		if (isAbortError || isSigterm) {
			return;
		}
		this.logger.error("Unhandled claude error:", error);
	}

	/**
	 * Fetch issue labels for a given issue
	 */
	private async fetchIssueLabels(issue: Issue): Promise<string[]> {
		return this.promptBuilder.fetchIssueLabels(issue);
	}

	/**
	 * Build the session context used to evaluate per-skill scope restrictions.
	 *
	 * Skill scopes (persisted in `scope.json` sidecars by the config-updater)
	 * match against:
	 * - the active repository's Cyrus config ID,
	 * - the Linear team that owns the issue, and
	 * - the Linear label IDs attached to the issue.
	 *
	 * The session's repo working-tree path(s) are also captured so that
	 * repo-local skills (`<repoPath>/.claude/skills/*`) get unioned into the
	 * resolved whitelist. When a `session` is provided its workspace is used to
	 * resolve those paths (covering multi-repo sessions); otherwise the active
	 * repository's path is used.
	 */
	private buildSkillSessionContext(
		repository: RepositoryConfig,
		fullIssue?: Issue,
		session?: CyrusAgentSession,
	): SkillSessionContext {
		const context: SkillSessionContext = {
			repositoryId: repository.id,
			repoPaths: this.resolveSkillRepoPaths(repository, session),
		};
		if (fullIssue?.teamId) {
			context.linearTeamId = fullIssue.teamId;
		}
		if (
			Array.isArray(fullIssue?.labelIds) &&
			(fullIssue?.labelIds?.length ?? 0) > 0
		) {
			context.linearLabelIds = [...(fullIssue?.labelIds ?? [])];
		}
		return context;
	}

	/**
	 * Resolve the repo working-tree path(s) whose `.claude/skills/` directories
	 * should contribute to the skill whitelist for a session.
	 *
	 * - Multi-repo sessions: every sub-worktree in `workspace.repoPaths`.
	 * - Single-repo / GitHub-mention sessions: the active repository's path.
	 */
	private resolveSkillRepoPaths(
		repository: RepositoryConfig,
		session?: CyrusAgentSession,
	): string[] {
		const repoPaths = session?.workspace?.repoPaths;
		if (repoPaths) {
			const paths = Object.values(repoPaths).filter(
				(p): p is string => typeof p === "string" && p.length > 0,
			);
			if (paths.length > 0) {
				return [...new Set(paths)];
			}
		}
		return [repository.repositoryPath];
	}

	/**
	 * Resolve default model for a given runner from config with sensible built-in defaults.
	 * Supports legacy config keys for backwards compatibility.
	 */
	private getDefaultModelForRunner(runnerType: RunnerType): string | undefined {
		return this.runnerSelectionService.getDefaultModelForRunner(runnerType);
	}

	/**
	 * Resolve default fallback model for a given runner from config with sensible built-in defaults.
	 * Supports legacy Claude fallback key for backwards compatibility.
	 */
	private getDefaultFallbackModelForRunner(
		runnerType: RunnerType,
	): string | undefined {
		return this.runnerSelectionService.getDefaultFallbackModelForRunner(
			runnerType,
		);
	}

	/**
	 * Instantiate the appropriate runner for the given type.
	 *
	 * Every runner is wrapped so its `start()`/`startStreaming()` hold a
	 * global concurrency slot for the session's lifetime — this is the single
	 * choke point that makes `maxConcurrentSessions` cover Linear, GitHub,
	 * GitLab, and chat sessions alike.
	 */
	private createRunnerForType(
		runnerType: RunnerType,
		config: AgentRunnerConfig,
	): IAgentRunner {
		return capRunnerStarts(
			this.buildRunnerForType(runnerType, config),
			this.runnerSlots,
		);
	}

	private buildRunnerForType(
		runnerType: RunnerType,
		config: AgentRunnerConfig,
	): IAgentRunner {
		switch (runnerType) {
			case "claude": {
				// Inject the hosted SessionStore at the last moment so it only
				// attaches to Claude runners (the field is Claude-specific).
				const claudeConfig = this.claudeSessionStore
					? { ...config, sessionStore: this.claudeSessionStore }
					: config;
				return new ClaudeRunner(claudeConfig, this.isWarmSessionsEnabled());
			}
			case "gemini":
				return new GeminiRunner(config);
			case "codex":
				return new CodexRunner(config);
			case "cursor":
				return new CursorRunner(config);
			case "opencode":
				return new OpenCodeRunner(config);
			default:
				throw new Error(`Unknown runner type: ${runnerType satisfies never}`);
		}
	}

	/**
	 * Determine system prompt based on issue labels and repository configuration
	 */
	private async determineSystemPromptFromLabels(
		labels: string[],
		repository: RepositoryConfig,
	): Promise<
		| {
				prompt: string;
				version?: string;
				type?:
					| "debugger"
					| "builder"
					| "scoper"
					| "orchestrator"
					| "graphite-orchestrator";
		  }
		| undefined
	> {
		return this.promptBuilder.determineSystemPromptFromLabels(labels, [
			repository,
		]);
	}

	/**
	 * Build prompt for mention-triggered sessions
	 * @param issue Full Linear issue object
	 * @param repository Repository configuration
	 * @param agentSession The agent session containing the mention
	 * @param attachmentManifest Optional attachment manifest to append
	 * @param guidance Optional agent guidance rules from Linear
	 * @returns The constructed prompt and optional version tag
	 */
	private async buildMentionPrompt(
		issue: Issue,
		agentSession: WebhookAgentSession,
		attachmentManifest: string = "",
		guidance?: GuidanceRule[],
	): Promise<{ prompt: string; version?: string }> {
		return this.promptBuilder.buildMentionPrompt(
			issue,
			agentSession,
			attachmentManifest,
			guidance,
		);
	}

	/**
	 * Convert full Linear SDK issue to CoreIssue interface for Session creation
	 */
	private convertLinearIssueToCore(issue: Issue): IssueMinimal {
		return this.promptBuilder.convertLinearIssueToCore(issue);
	}

	/**
	 * Get connection status by repository ID
	 */
	getConnectionStatus(): Map<string, boolean> {
		const status = new Map<string, boolean>();
		// Single event transport is "connected" if it exists
		if (this.linearEventTransport) {
			// Mark all repositories as connected since they share the single transport
			for (const repoId of this.repositories.keys()) {
				status.set(repoId, true);
			}
		}
		return status;
	}

	/**
	 * Get event transport (for testing purposes)
	 * @internal
	 */
	_getClientByToken(_token: string): any {
		// Return the single shared event transport
		return this.linearEventTransport;
	}

	/**
	 * Start OAuth flow using the shared application server
	 */
	async startOAuthFlow(proxyUrl?: string): Promise<{
		linearToken: string;
		linearWorkspaceId: string;
		linearWorkspaceName: string;
	}> {
		const oauthProxyUrl = proxyUrl || this.config.proxyUrl || DEFAULT_PROXY_URL;
		return this.sharedApplicationServer.startOAuthFlow(oauthProxyUrl);
	}

	/**
	 * Get the server port
	 */
	getServerPort(): number {
		return this.config.serverPort || this.config.webhookPort || 3456;
	}

	/**
	 * Get the OAuth callback URL
	 */
	getOAuthCallbackUrl(): string {
		return this.sharedApplicationServer.getOAuthCallbackUrl();
	}

	/**
	 * Move issue to started state when assigned
	 * @param issue Full Linear issue object from Linear SDK
	 * @param linearWorkspaceId Workspace ID for issue tracker lookup
	 */

	private async moveIssueToStartedState(
		issue: Issue,
		linearWorkspaceId: string,
	): Promise<void> {
		try {
			const issueTracker = this.issueTrackers.get(linearWorkspaceId);
			if (!issueTracker) {
				this.logger.warn(
					`No issue tracker found for workspace ${linearWorkspaceId}, skipping state update`,
				);
				return;
			}

			// Check if issue is already in a started state
			const currentState = await issue.state;
			if (currentState?.type === "started") {
				this.logger.debug(
					`Issue ${issue.identifier} is already in started state (${currentState.name})`,
				);
				return;
			}

			// Get team for the issue
			const team = await issue.team;
			if (!team) {
				this.logger.warn(
					`No team found for issue ${issue.identifier}, skipping state update`,
				);
				return;
			}

			// Get available workflow states for the issue's team
			const teamStates = await issueTracker.fetchWorkflowStates(team.id);

			const states = teamStates;

			// Find all states with type "started" and pick the one with lowest position
			// This ensures we pick "In Progress" over "In Review" when both have type "started"
			// Linear uses standardized state types: triage, backlog, unstarted, started, completed, canceled
			const startedStates = states.nodes.filter(
				(state) => state.type === "started",
			);
			const startedState = startedStates.sort(
				(a, b) => a.position - b.position,
			)[0];

			if (!startedState) {
				throw new Error(
					'Could not find a state with type "started" for this team',
				);
			}

			// Update the issue state
			this.logger.debug(
				`Moving issue ${issue.identifier} to started state: ${startedState.name}`,
			);
			if (!issue.id) {
				this.logger.warn(
					`Issue ${issue.identifier} has no ID, skipping state update`,
				);
				return;
			}

			await issueTracker.updateIssue(issue.id, {
				stateId: startedState.id,
			});

			this.logger.debug(
				`✅ Successfully moved issue ${issue.identifier} to ${startedState.name} state`,
			);
		} catch (error) {
			this.logger.error(
				`Failed to move issue ${issue.identifier} to started state:`,
				error,
			);
			// Don't throw - we don't want to fail the entire assignment process due to state update failure
		}
	}

	/**
	 * Post initial comment when assigned to issue
	 */
	// private async postInitialComment(issueId: string, repositoryId: string): Promise<void> {
	//   const body = "I'm getting started right away."
	//   // Get the issue tracker for this repository
	//   const issueTracker = this.issueTrackers.get(repositoryId)
	//   if (!issueTracker) {
	//     throw new Error(`No issue tracker found for repository ${repositoryId}`)
	//   }
	//   const commentData = {

	//     body
	//   }
	//   await issueTracker.createComment(commentData)
	// }

	/**
	 * Post a comment to Linear
	 */
	private async postComment(
		issueId: string,
		body: string,
		linearWorkspaceId: string,
		parentId?: string,
	): Promise<void> {
		return this.activityPoster.postComment(
			issueId,
			body,
			linearWorkspaceId,
			parentId,
		);
	}

	/**
	 * Format todos as Linear checklist markdown
	 */
	// private formatTodosAsChecklist(todos: Array<{id: string, content: string, status: string, priority: string}>): string {
	//   return todos.map(todo => {
	//     const checkbox = todo.status === 'completed' ? '[x]' : '[ ]'
	//     const statusEmoji = todo.status === 'in_progress' ? ' 🔄' : ''
	//     return `- ${checkbox} ${todo.content}${statusEmoji}`
	//   }).join('\n')
	// }

	/**
	 * Download attachments from Linear issue
	 * @param issue Linear issue object from webhook data
	 * @param repository Repository configuration
	 * @param workspacePath Path to workspace directory
	 */
	private async downloadIssueAttachments(
		issue: Issue,
		linearWorkspaceId: string,
		workspacePath: string,
	): Promise<{ manifest: string; attachmentsDir: string | null }> {
		const issueTracker = this.issueTrackers.get(linearWorkspaceId);
		return this.attachmentService.downloadIssueAttachments(
			issue,
			linearWorkspaceId,
			workspacePath,
			issueTracker,
		);
	}

	/**
	 * Download attachments from a specific comment
	 * @param commentBody The body text of the comment
	 * @param attachmentsDir Directory where attachments should be saved
	 * @param linearToken Linear API token
	 * @param existingAttachmentCount Current number of attachments already downloaded
	 */
	private async downloadCommentAttachments(
		commentBody: string,
		attachmentsDir: string,
		linearToken: string | null,
		existingAttachmentCount: number,
	): Promise<{
		newAttachmentMap: Record<string, string>;
		newImageMap: Record<string, string>;
		totalNewAttachments: number;
		failedCount: number;
	}> {
		return this.attachmentService.downloadCommentAttachments(
			commentBody,
			attachmentsDir,
			linearToken,
			existingAttachmentCount,
		);
	}

	/**
	 * Generate attachment manifest for new comment attachments
	 */
	private generateNewAttachmentManifest(result: {
		newAttachmentMap: Record<string, string>;
		newImageMap: Record<string, string>;
		totalNewAttachments: number;
		failedCount: number;
	}): string {
		return this.attachmentService.generateNewAttachmentManifest(result);
	}

	private async registerCyrusToolsMcpEndpoint(): Promise<void> {
		if (this.cyrusToolsMcpRegistered) {
			return;
		}

		const fastify = this.sharedApplicationServer.getFastifyInstance() as any;
		if (
			typeof fastify.register !== "function" ||
			typeof fastify.addHook !== "function"
		) {
			this.logger.warn(
				"Skipping cyrus-tools MCP endpoint registration: Fastify instance does not support register/addHook",
			);
			return;
		}

		fastify.addHook("onRequest", (request: any, _reply: any, done: any) => {
			const rawUrl =
				typeof request?.raw?.url === "string"
					? request.raw.url
					: typeof request?.url === "string"
						? request.url
						: "";
			const requestPath = rawUrl.split("?")[0];

			if (requestPath !== this.cyrusToolsMcpEndpoint) {
				done();
				return;
			}

			if (
				!this.mcpConfigService.isAuthorizationValid(
					request.headers?.authorization,
				)
			) {
				_reply.code(401).send({
					error: "Unauthorized cyrus-tools MCP request",
				});
				done();
				return;
			}

			const rawContextHeader = request.headers?.["x-cyrus-mcp-context-id"];
			const contextId = Array.isArray(rawContextHeader)
				? rawContextHeader[0]
				: rawContextHeader;

			this.cyrusToolsMcpRequestContext.run({ contextId }, () => {
				done();
			});
		});

		this.cyrusToolsMcpSessions.on("connected", (sessionId) => {
			this.logger.debug(`cyrus-tools MCP session connected: ${sessionId}`);
		});

		this.cyrusToolsMcpSessions.on("terminated", (sessionId) => {
			this.logger.debug(`cyrus-tools MCP session terminated: ${sessionId}`);
		});

		this.cyrusToolsMcpSessions.on("error", (error) => {
			this.logger.error("cyrus-tools MCP session error:", error);
		});

		await fastify.register(streamableHttp, {
			stateful: true,
			mcpEndpoint: this.cyrusToolsMcpEndpoint,
			sessions: this.cyrusToolsMcpSessions,
			createServer: async () => {
				const contextId =
					this.cyrusToolsMcpRequestContext.getStore()?.contextId;
				if (!contextId) {
					throw new Error(
						"Missing x-cyrus-mcp-context-id header for cyrus-tools MCP request",
					);
				}

				const context = this.mcpConfigService.getContext(contextId);
				if (!context) {
					throw new Error(
						`Unknown cyrus-tools MCP context '${contextId}'. Build MCP config before connecting.`,
					);
				}

				let sdkServer = context.prebuiltServer;
				if (!sdkServer) {
					// Rebuild for a subsequent connection to the same context (the
					// prebuilt server is cleared after first use). Router-mode
					// contexts carry a tracker backing instead of a LinearClient.
					const backing = context.linearClient
						? context.linearClient
						: context.issueTracker
							? { issueTracker: context.issueTracker }
							: undefined;
					if (!backing) {
						throw new Error(
							`No cyrus-tools backing available for context '${contextId}'`,
						);
					}
					sdkServer = createCyrusToolsServer(
						backing,
						this.createCyrusToolsOptions(context.parentSessionId),
					);
				}
				this.mcpConfigService.clearPrebuiltServer(contextId);

				return sdkServer.server;
			},
		});

		this.cyrusToolsMcpRegistered = true;
		this.logger.info(
			`Cyrus tools MCP endpoint registered at ${this.cyrusToolsMcpEndpoint}`,
		);
	}

	private failureModesClient: FailureModesHttpClient | null = null;

	/**
	 * Lazily build the HTTP client used by `log_failure_mode` to POST to
	 * cyrus-hosted. Uses `CYRUS_APP_URL` (the same env var the remote
	 * session-store client reads, see top of this file) so preview
	 * environments and prod share a single way to point at a control
	 * plane. Returns null when either the URL or the `CYRUS_API_KEY` are
	 * missing — in that mode the tool is simply not registered, so
	 * customer-mode CLI users without a control plane don't see a broken
	 * tool.
	 */
	private getFailureModesClient(): FailureModesHttpClient | null {
		if (this.failureModesClient) return this.failureModesClient;
		const apiKey = process.env.CYRUS_API_KEY?.trim();
		if (!apiKey) return null;
		const baseUrl = getCyrusAppUrl();
		this.failureModesClient = createFetchFailureModesClient({
			baseUrl,
			apiKey,
		});
		return this.failureModesClient;
	}

	/**
	 * Resolve a working-directory string to the agent session id that owns
	 * that workspace. The `log_failure_mode` MCP tool calls this with the
	 * agent's reported `cwd`. We normalize and compare against each known
	 * session's `workspace.path` (and any sub-repo paths the session opens).
	 */
	/**
	 * Resolve a working-directory string to the rich session bundle a
	 * Cyrus team member needs to triage a failure-mode report: the
	 * internal session id (for dedup), the runner session id + runner
	 * type (so triage can pull the Claude/Gemini/Codex/Cursor transcript),
	 * the Linear AgentSession + source-issue identifiers (so triage can
	 * jump to the customer thread), and the workspace path (for repro).
	 *
	 * Returns null only when no session matches. We prefer an exact
	 * workspace-path or sub-repo-path match; if neither hits, we fall
	 * back to a prefix match for nested cwds (e.g. shells in a subdir).
	 */
	/**
	 * Aggregator over every place active sessions live in this process.
	 * Today: the primary AgentSessionManager (issue sessions) and the
	 * ChatSessionHandler's private one (Slack / GitHub-PR-chat / future
	 * chat platforms). New session origins should be added here so
	 * downstream consumers (currently just resolveSessionFromCwd) keep
	 * working without modification — single open extension point (OCP),
	 * single responsibility (SRP: this method's only job is "where do
	 * sessions live?", separate from "how do we match one by cwd?").
	 */
	private getAllKnownSessions(): CyrusAgentSession[] {
		return [
			...this.agentSessionManager.getAllSessions(),
			...this.activeChatSessionHandlers.flatMap((handler) =>
				handler.getAllChatSessions(),
			),
		];
	}

	private resolveSessionFromCwd(cwd: string): ResolvedSession | null {
		if (!cwd) return null;
		const normalize = (p: string) => p.replace(/\/+$/, "");
		const target = normalize(cwd);

		const sessions = this.getAllKnownSessions();

		const exact = sessions.find((session) => {
			if (normalize(session.workspace?.path ?? "") === target) return true;
			const repoPaths = session.workspace?.repoPaths;
			if (repoPaths) {
				for (const p of Object.values(repoPaths)) {
					if (typeof p === "string" && normalize(p) === target) return true;
				}
			}
			return false;
		});

		const prefix = exact
			? undefined
			: sessions.find((session) => {
					const root = normalize(session.workspace?.path ?? "");
					return root && target.startsWith(`${root}/`);
				});

		const session = exact ?? prefix;
		if (!session) return null;

		const runnerType = session.claudeSessionId
			? "claude"
			: session.geminiSessionId
				? "gemini"
				: session.codexSessionId
					? "codex"
					: session.cursorSessionId
						? "cursor"
						: session.opencodeSessionId
							? "opencode"
							: null;
		const runnerSessionId =
			session.claudeSessionId ??
			session.geminiSessionId ??
			session.codexSessionId ??
			session.cursorSessionId ??
			session.opencodeSessionId ??
			null;

		const sessionSource = session.id.startsWith("github-")
			? "github"
			: session.id.startsWith("gitlab-")
				? "gitlab"
				: session.id.startsWith("slack-")
					? "slack"
					: (session.issueContext?.trackerId ?? "linear");

		// For Linear-source sessions, `session.id` is already the Linear
		// AgentSession id (they're literally the same UUID — the v3 rename
		// from `linearAgentActivitySessionId` to `id` kept the value). So we
		// don't surface a separate `linearAgentSessionId` — the server keys
		// dedup on `session_id` and that *is* the Linear AgentSession id when
		// `session_source === 'linear'`.
		return {
			sessionId: session.id,
			runnerSessionId,
			runnerType,
			sourceIssueIdentifier:
				session.issueContext?.issueIdentifier ??
				session.issue?.identifier ??
				null,
			workspacePath: session.workspace?.path ?? null,
			sessionSource,
		};
	}

	private createCyrusToolsOptions(parentSessionId?: string): CyrusToolsOptions {
		const failureModesClient = this.getFailureModesClient();
		const options: CyrusToolsOptions = {
			parentSessionId,
			onSessionCreated: (childSessionId: string, parentId: string) => {
				this.handleChildSessionMapping(childSessionId, parentId);
			},
			onFeedbackDelivery: async (childSessionId: string, message: string) => {
				return this.handleFeedbackDeliveryToChildSession(
					childSessionId,
					message,
				);
			},
		};
		if (failureModesClient) {
			options.failureModes = {
				resolveSessionFromCwd: (cwd: string) => this.resolveSessionFromCwd(cwd),
				httpClient: failureModesClient,
			};
		}
		return options;
	}

	private handleChildSessionMapping(
		childSessionId: string,
		parentSessionId: string,
	): void {
		this.logger.info(
			`Agent session created: ${childSessionId}, mapping to parent ${parentSessionId}`,
		);
		this.globalSessionRegistry.setParentSession(
			childSessionId,
			parentSessionId,
		);
		this.logger.debug(
			`Parent-child mapping registered in GlobalSessionRegistry`,
		);
	}

	/**
	 * Link a newly created agent session to the most recent Cyrus session on its
	 * parent issue, so that when this (child) session completes, the parent
	 * session is resumed with the child's result.
	 *
	 * Parent-child *issue* relationships are the channel for child completion
	 * messages. Any issue whose parent has a Cyrus session is linked, regardless
	 * of whether that parent session is currently running: an orchestrator that
	 * has halted to wait for its sub-issue has status "complete" and is exactly
	 * the parent that must be woken, so this deliberately does not filter to
	 * active sessions. The resume path handles both a still-running parent
	 * (streams the message in) and an exited one (resumes from its stored
	 * runner session id).
	 *
	 * This replaces the mapping that used to be established by the removed
	 * `linear_agent_session_create*` cyrus-tools. Linear delegation creates
	 * exactly one session per issue, so deriving the link from the issue
	 * hierarchy does not reintroduce concurrent child sessions on one issue.
	 *
	 * Never throws: a failed lookup only means the parent is not notified.
	 */
	private async linkChildSessionToParentIssueSession(
		agentSessionId: string,
		issue: { id: string; identifier: string } | null | undefined,
		linearWorkspaceId: string,
	): Promise<void> {
		if (!issue) {
			return;
		}

		// Already mapped (e.g. restored from persisted state) — leave it alone.
		if (this.globalSessionRegistry.getParentSessionId(agentSessionId)) {
			return;
		}

		const log = this.logger.withContext({
			sessionId: agentSessionId,
			issueIdentifier: issue.identifier,
		});

		try {
			// The webhook's issue payload does not carry the parent, so fetch it.
			const fullIssue = await this.fetchFullIssueDetails(
				issue.id,
				linearWorkspaceId,
			);
			const parentIssue = await fullIssue?.parent;
			const parentIssueId = parentIssue?.id;
			if (!parentIssueId) {
				return;
			}

			const parentSessions =
				this.agentSessionManager.getSessionsByIssueId(parentIssueId);
			if (parentSessions.length === 0) {
				log.debug(
					`Parent issue ${parentIssueId} has no Cyrus session; no parent callback will be sent`,
				);
				return;
			}

			const parentSession = parentSessions.reduce((latest, candidate) =>
				candidate.updatedAt > latest.updatedAt ? candidate : latest,
			);

			this.globalSessionRegistry.setParentSession(
				agentSessionId,
				parentSession.id,
			);
			log.info(
				`Linked to parent session ${parentSession.id} via parent issue ${parentIssueId}; parent will be resumed when this session completes`,
			);
		} catch (error) {
			log.warn(
				`Failed to link session to a parent issue session; continuing without parent callback`,
				error,
			);
		}
	}

	private async handleFeedbackDeliveryToChildSession(
		childSessionId: string,
		message: string,
	): Promise<boolean> {
		this.logger.info(
			`Processing feedback delivery to child session ${childSessionId}`,
		);

		// Find the parent session ID for context
		const parentSessionId =
			this.globalSessionRegistry.getParentSessionId(childSessionId);

		// Find the repository containing the child session
		const childRepoId = this.sessionRepositories.get(childSessionId);
		const childRepo = childRepoId
			? this.repositories.get(childRepoId)
			: undefined;

		if (
			!childRepo ||
			!this.agentSessionManager.hasAgentRunner(childSessionId)
		) {
			this.logger.error(
				`Child session ${childSessionId} not found in any repository`,
			);
			return false;
		}

		// Get the child session
		const childSession = this.agentSessionManager.getSession(childSessionId);
		if (!childSession) {
			this.logger.error(`Child session ${childSessionId} not found`);
			return false;
		}

		this.logger.debug(`Found child session - Issue: ${childSession.issueId}`);

		// Get parent session info for better context in the thought
		let parentIssueId: string | undefined;
		if (parentSessionId) {
			const parentSession =
				this.agentSessionManager.getSession(parentSessionId);
			if (parentSession) {
				parentIssueId =
					parentSession.issue?.identifier || parentSession.issueId;
			}
		}

		// Extract workspace ID once for all operations
		const childWorkspaceId = requireLinearWorkspaceId(childRepo);

		// Post thought to Linear showing feedback receipt
		const issueTracker = this.issueTrackers.get(childWorkspaceId);
		if (issueTracker) {
			const feedbackThought = parentIssueId
				? `Received feedback from orchestrator (${parentIssueId}):\n\n---\n\n${message}\n\n---`
				: `Received feedback from orchestrator:\n\n---\n\n${message}\n\n---`;

			try {
				const result = await issueTracker.createAgentActivity({
					agentSessionId: childSessionId,
					content: {
						type: "thought",
						body: feedbackThought,
					},
				});

				if (result.success) {
					this.logger.debug(
						`Posted feedback receipt thought for child session ${childSessionId}`,
					);
				} else {
					this.logger.error(`Failed to post feedback receipt thought:`, result);
				}
			} catch (error) {
				this.logger.error(`Error posting feedback receipt thought:`, error);
			}
		}

		const feedbackPrompt = `## Received feedback from orchestrator\n\n---\n\n${message}\n\n---`;

		this.logger.debug(
			`Handling feedback delivery to child session ${childSessionId}`,
		);

		this.handlePromptWithStreamingCheck(
			childSession,
			childRepo,
			childSessionId,
			this.agentSessionManager,
			feedbackPrompt,
			"",
			false,
			[],
			"give feedback to child",
			childWorkspaceId,
		)
			.then(() => {
				this.logger.info(
					`Child session ${childSessionId} completed processing feedback`,
				);
			})
			.catch((error) => {
				this.logger.error(
					`Failed to process feedback in child session:`,
					error,
				);
			});

		this.logger.info(
			`Feedback delivered successfully to child session ${childSessionId}`,
		);
		return true;
	}

	private getCyrusToolsMcpUrl(): string {
		const server = this.sharedApplicationServer as {
			getPort?: () => number;
		};
		const port =
			typeof server.getPort === "function"
				? server.getPort()
				: this.config.serverPort || this.config.webhookPort || 3456;
		return `http://127.0.0.1:${port}${this.cyrusToolsMcpEndpoint}`;
	}

	/**
	 * Build the complete prompt for a session - shows full prompt assembly in one place
	 *
	 * New session prompt structure:
	 * 1. Issue context (from buildIssueContextPrompt)
	 * 2. User comment
	 *
	 * Existing session prompt structure:
	 * 1. User comment
	 * 2. Attachment manifest (if present)
	 */
	private async buildSessionPrompt(
		isNewSession: boolean,
		session: CyrusAgentSession,
		fullIssue: Issue,
		repository: RepositoryConfig,
		promptBody: string,
		attachmentManifest?: string,
		commentAuthor?: string,
		commentTimestamp?: string,
	): Promise<string> {
		// Fetch labels for system prompt determination
		const labels = await this.fetchIssueLabels(fullIssue);

		// Create input for unified prompt assembly
		const input: PromptAssemblyInput = {
			session,
			fullIssue,
			repositories: [repository],
			repository,
			userComment: promptBody,
			commentAuthor,
			commentTimestamp,
			attachmentManifest,
			isNewSession,
			isStreaming: false, // This path is only for non-streaming prompts
			labels,
		};

		// Use unified prompt assembly
		const assembly = await this.assemblePrompt(input);

		// Log metadata for debugging
		this.logger.debug(
			`Built prompt - components: ${assembly.metadata.components.join(", ")}, type: ${assembly.metadata.promptType}`,
		);

		return assembly.userPrompt;
	}

	/**
	 * Assemble a complete prompt - unified entry point for all prompt building
	 * This method contains all prompt assembly logic in one place
	 */
	private async assemblePrompt(
		input: PromptAssemblyInput,
	): Promise<PromptAssembly> {
		const assembly = await this.buildPromptForInput(input);
		return await this.prefixSlashCommand(assembly, input);
	}

	private async buildPromptForInput(
		input: PromptAssemblyInput,
	): Promise<PromptAssembly> {
		// If actively streaming, just pass through the comment
		if (input.isStreaming) {
			return this.buildStreamingPrompt(input);
		}

		// If new session, build full prompt with all components
		if (input.isNewSession) {
			return this.buildNewSessionPrompt(input);
		}

		// Existing session continuation - just user comment + attachments
		return this.buildContinuationPrompt(input);
	}

	/**
	 * Echo a leading `/<skill>` token from the user's comment onto line 1 of the
	 * assembled prompt.
	 *
	 * Claude Code expands a slash command ONLY when the prompt string starts
	 * with `/<name>`. Every builder above either wraps the comment in XML
	 * (`<user_comment>` / `<new_comment>`) or lets Linear's `@mention` lead, so
	 * `@cyrus1 /grill-with-docs ...` never expands. The model is then left to
	 * guess at the name from prose, and measurably refuses ("no such skill
	 * available") about as often as it guesses right.
	 *
	 * Two measured properties of the expansion make this the whole fix
	 * (`@anthropic-ai/claude-agent-sdk` 0.3.220):
	 *
	 * 1. Text AFTER the command is preserved and reaches the model verbatim,
	 *    whether or not the skill body references `$ARGUMENTS`. So the wrapped
	 *    comment stays exactly where it is and no context is lost — this is a
	 *    prefix, not a rewrite.
	 * 2. Expansion ignores both `disable-model-invocation: true` and the SDK
	 *    `skills` allowlist. That is what makes the slash-only skills in a
	 *    dotfiles set (14 of the 25 in `mattpocock-skills`) reachable from
	 *    Linear at all — they are invisible to the `Skill` tool by design.
	 *
	 * The command MUST be checked against the discovered skills first. An
	 * unrecognised one does not degrade to plain text — the CLI answers
	 * "Unknown command: /foo" and the rest of the prompt never reaches the
	 * model, so blindly prefixing would swallow the comment of anyone who
	 * opened with a `/word` we do not own. Observed in an F1 drive against a
	 * skill that was not in the worktree.
	 */
	private async prefixSlashCommand(
		assembly: PromptAssembly,
		input: PromptAssemblyInput,
	): Promise<PromptAssembly> {
		const command = EdgeWorker.LEADING_SLASH_COMMAND.exec(
			input.userComment,
		)?.[1];
		if (!command || assembly.userPrompt.startsWith(command)) {
			return assembly;
		}
		if (!(await this.isKnownSkill(command.slice(1), input))) {
			this.logger.debug(
				`Comment opens with "${command}", which is not a discovered skill — left as prose`,
			);
			return assembly;
		}

		this.logger.event(
			CYRUS_EVENTS.skillSlashInvoked,
			cyrusAttributes({
				skill: command.slice(1),
				prompt_type: assembly.metadata.promptType,
				issue_key: input.fullIssue?.identifier,
				new_session: assembly.metadata.isNewSession,
				streaming: assembly.metadata.isStreaming,
			}),
		);

		return {
			...assembly,
			userPrompt: `${command}\n${assembly.userPrompt}`,
		};
	}

	/**
	 * Whether `name` is a skill this session can actually run.
	 *
	 * Matches `discoverSkillNames`, the same list handed to the SDK as the
	 * `skills` allowlist, so the check cannot drift from what is installed.
	 * A plugin-qualified `plugin:skill` is matched on either form because the
	 * SDK accepts both.
	 *
	 * Fails OPEN on a discovery error: leaving the comment as prose is the
	 * behaviour that predates NOR-368, and losing a slash invocation is far
	 * cheaper than losing the comment.
	 */
	private async isKnownSkill(
		name: string,
		input: PromptAssemblyInput,
	): Promise<boolean> {
		const repository = input.repositories?.[0] ?? input.repository;
		if (!repository) return false;
		try {
			const names = await this.skillsPluginResolver.discoverSkillNames(
				await this.skillsPluginResolver.resolve(),
				this.buildSkillSessionContext(
					repository,
					input.fullIssue,
					input.session,
				),
			);
			const unqualified = name.includes(":") ? name.split(":").pop() : name;
			return names.some(
				(known) =>
					known === name ||
					known === unqualified ||
					known.split(":").pop() === unqualified,
			);
		} catch (error) {
			this.logger.warn(
				`Skill discovery failed while checking "/${name}"; leaving the comment as prose: ${(error as Error).message}`,
			);
			return false;
		}
	}

	/**
	 * Build prompt for actively streaming session - pass through user comment as-is
	 */
	private buildStreamingPrompt(input: PromptAssemblyInput): PromptAssembly {
		const components: PromptComponent[] = ["user-comment"];
		if (input.attachmentManifest) {
			components.push("attachment-manifest");
		}

		const parts: string[] = [input.userComment];
		if (input.attachmentManifest) {
			parts.push(input.attachmentManifest);
		}

		return {
			systemPrompt: undefined,
			userPrompt: parts.join("\n\n"),
			metadata: {
				components,
				promptType: "continuation",
				isNewSession: false,
				isStreaming: true,
			},
		};
	}

	/**
	 * Build prompt for new session - includes issue context and user comment
	 */
	private async buildNewSessionPrompt(
		input: PromptAssemblyInput,
	): Promise<PromptAssembly> {
		const components: PromptComponent[] = [];
		const parts: string[] = [];

		// 1. Determine system prompt from labels
		// Only for delegation (not mentions) or when /label-based-prompt is requested
		const repositories = input.repositories ?? [input.repository];
		let labelBasedSystemPrompt: string | undefined;
		if (!input.isMentionTriggered || input.isLabelBasedPromptRequested) {
			const result = await this.promptBuilder.determineSystemPromptFromLabels(
				input.labels || [],
				repositories,
			);
			labelBasedSystemPrompt = result?.prompt;
		}

		// 2. Determine system prompt based on prompt type
		// Label-based: Use only the label-based system prompt
		// Fallback: Use scenarios system prompt (shared instructions)
		let systemPrompt: string;
		if (labelBasedSystemPrompt) {
			// Use label-based system prompt as-is (no shared instructions)
			systemPrompt = labelBasedSystemPrompt;
		} else {
			// Use scenarios system prompt for fallback cases
			const sharedInstructions = await this.loadSharedInstructions();
			systemPrompt = sharedInstructions;
		}

		// 3. Append skills guidance — instruct the agent to use skills based on context.
		// Skills hidden by per-skill scope (repo / Linear team / Linear label) are
		// omitted from the guidance so the model doesn't reference skills it
		// cannot invoke.
		const skillsContext = this.buildSkillSessionContext(
			repositories[0]!,
			input.fullIssue,
			input.session,
		);
		systemPrompt += await this.skillsPluginResolver.buildSkillsGuidance(
			undefined,
			skillsContext,
		);

		// 4. Append agent context — dynamic values for skills to reference
		systemPrompt += this.buildAgentContextBlock();

		// 5. Build issue context using appropriate builder
		// Use label-based prompt ONLY if we have a label-based system prompt
		const promptType = this.determinePromptType(
			input,
			!!labelBasedSystemPrompt,
		);
		// Build workspace repo paths map for prompt context.
		// For multi-repo sessions, workspace.repoPaths maps each repo ID to its worktree.
		// For single-repo sessions, use workspace.path as the worktree for the primary repo.
		const workspaceRepoPaths =
			input.session.workspace.repoPaths ??
			(repositories.length === 1
				? { [repositories[0]!.id]: input.session.workspace.path }
				: undefined);
		const issueContext = await this.buildIssueContextForPromptAssembly(
			input.fullIssue,
			repositories,
			promptType,
			input.attachmentManifest,
			input.guidance,
			input.agentSession,
			input.resolvedBaseBranches,
			workspaceRepoPaths,
		);

		parts.push(issueContext.prompt);
		components.push("issue-context");

		// 4. Add user comment (if present)
		// Skip for mention-triggered prompts since the comment is already in the mention block
		if (input.userComment.trim() && !input.isMentionTriggered) {
			// If we have author/timestamp metadata, include it for multi-player context
			if (input.commentAuthor || input.commentTimestamp) {
				const author = input.commentAuthor || "Unknown";
				const timestamp = input.commentTimestamp || new Date().toISOString();
				parts.push(`<user_comment>
  <author>${author}</author>
  <timestamp>${timestamp}</timestamp>
  <content>
${input.userComment}
  </content>
</user_comment>`);
			} else {
				// Legacy format without metadata
				parts.push(`<user_comment>\n${input.userComment}\n</user_comment>`);
			}
			components.push("user-comment");
		}

		// 6. Add guidance rules (if present)
		if (input.guidance && input.guidance.length > 0) {
			components.push("guidance-rules");
		}

		return {
			systemPrompt,
			userPrompt: parts.join("\n\n"),
			metadata: {
				components,
				promptType,
				isNewSession: true,
				isStreaming: false,
			},
		};
	}

	/**
	 * Build an <agent_context> block with dynamic values that skills can reference.
	 *
	 * Provides bot usernames so skills (e.g. verify-and-ship) can refer to the
	 * correct bot account without hardcoding.
	 */
	private buildAgentContextBlock(): string {
		const githubBot = process.env.GITHUB_BOT_USERNAME || "";
		const gitlabBot = process.env.GITLAB_BOT_USERNAME || "";

		if (!githubBot && !gitlabBot) {
			return "";
		}

		const lines: string[] = ["\n\n<agent_context>"];
		if (githubBot) {
			lines.push(`  <github_bot_username>${githubBot}</github_bot_username>`);
		}
		if (gitlabBot) {
			lines.push(`  <gitlab_bot_username>${gitlabBot}</gitlab_bot_username>`);
		}
		lines.push("</agent_context>");

		return lines.join("\n");
	}

	/**
	 * Build prompt for existing session continuation - user comment and attachments only
	 */
	private buildContinuationPrompt(input: PromptAssemblyInput): PromptAssembly {
		const components: PromptComponent[] = ["user-comment"];
		if (input.attachmentManifest) {
			components.push("attachment-manifest");
		}

		// Wrap comment in XML with author and timestamp for multi-player context
		const author = input.commentAuthor || "Unknown";
		const timestamp = input.commentTimestamp || new Date().toISOString();

		const commentXml = `<new_comment>
  <author>${author}</author>
  <timestamp>${timestamp}</timestamp>
  <content>
${input.userComment}
  </content>
</new_comment>`;

		const parts: string[] = [commentXml];
		if (input.attachmentManifest) {
			parts.push(input.attachmentManifest);
		}

		return {
			systemPrompt: undefined,
			userPrompt: parts.join("\n\n"),
			metadata: {
				components,
				promptType: "continuation",
				isNewSession: false,
				isStreaming: false,
			},
		};
	}

	/**
	 * Determine the prompt type based on input flags and system prompt availability
	 */
	private determinePromptType(
		input: PromptAssemblyInput,
		hasSystemPrompt: boolean,
	): PromptType {
		if (input.isMentionTriggered && input.isLabelBasedPromptRequested) {
			return "label-based-prompt-command";
		}
		if (input.isMentionTriggered) {
			return "mention";
		}
		if (hasSystemPrompt) {
			return "label-based";
		}
		return "fallback";
	}

	/**
	 * Load shared instructions that get appended to all system prompts
	 */
	private async loadSharedInstructions(): Promise<string> {
		return this.promptBuilder.loadSharedInstructions();
	}

	/**
	 * Adapter method for prompt assembly - routes to appropriate issue context builder
	 */
	private async buildIssueContextForPromptAssembly(
		issue: Issue,
		repositories: RepositoryConfig[],
		promptType: PromptType,
		attachmentManifest?: string,
		guidance?: GuidanceRule[],
		agentSession?: WebhookAgentSession,
		resolvedBaseBranches?: Record<string, BaseBranchResolution>,
		workspaceRepoPaths?: Record<string, string>,
	): Promise<IssueContextResult> {
		// Delegate to appropriate builder based on promptType
		if (promptType === "mention") {
			if (!agentSession) {
				throw new Error(
					"agentSession is required for mention-triggered prompts",
				);
			}
			return this.buildMentionPrompt(
				issue,
				agentSession,
				attachmentManifest,
				guidance,
			);
		}
		if (
			promptType === "label-based" ||
			promptType === "label-based-prompt-command"
		) {
			return this.promptBuilder.buildLabelBasedPrompt(
				issue,
				repositories,
				attachmentManifest,
				guidance,
				resolvedBaseBranches,
			);
		}
		// Fallback to standard issue context
		return this.promptBuilder.buildIssueContextPrompt(
			issue,
			repositories,
			undefined, // No new comment for initial prompt assembly
			attachmentManifest,
			guidance,
			resolvedBaseBranches,
			workspaceRepoPaths,
		);
	}

	/**
	 * Resolve the default runner type for SimpleRunner (classification) use.
	 * Uses config.defaultRunner if set, otherwise auto-detects from API keys,
	 * falling back to "claude".
	 */
	/**
	 * Build agent runner configuration with common settings.
	 * Delegates to RunnerConfigBuilder for shared config assembly.
	 * @returns Object containing the runner config and runner type to use
	 */
	private async buildAgentRunnerConfig(
		session: CyrusAgentSession,
		repository: RepositoryConfig,
		sessionId: string,
		systemPrompt: string | undefined,
		allowedTools: string[],
		allowedDirectories: string[],
		disallowedTools: string[],
		resumeSessionId?: string,
		labels?: string[],
		issueDescription?: string,
		maxTurns?: number,
		linearWorkspaceId?: string,
		skillContext?: SkillSessionContext,
		/**
		 * Which platform initiated the session — drives which
		 * `EdgeWorkerConfig.<platform>McpConfigs` override list applies.
		 * Defaults to `"linear"` (the pre-platform-aware behavior).
		 */
		sessionPlatform: "linear" | "github" | "gitlab" = "linear",
	): Promise<{ config: AgentRunnerConfig; runnerType: RunnerType }> {
		const log = this.logger.withContext({
			sessionId,
			platform: session.issueContext?.trackerId,
			issueIdentifier: session.issueContext?.issueIdentifier,
		});

		// Resolve plugins once so we can also derive the per-session scoped
		// skill allow-list from the same filesystem snapshot.
		const plugins = await this.skillsPluginResolver.resolve();
		const resolvedSkillContext: SkillSessionContext = skillContext ?? {
			repositoryId: repository.id,
			repoPaths: this.resolveSkillRepoPaths(repository, session),
		};
		const allowedSkillNames =
			await this.skillsPluginResolver.discoverSkillNames(
				plugins,
				resolvedSkillContext,
			);

		const result = this.runnerConfigBuilder.buildIssueConfig({
			session,
			repository,
			sessionId,
			systemPrompt,
			allowedTools,
			allowedDirectories,
			disallowedTools,
			resumeSessionId,
			labels,
			issueDescription,
			maxTurns,
			// Per-platform MCP config paths — GitHub + GitLab share the
			// `githubMcpConfigs` knob (single-repo PR contexts both); Linear
			// gets `linearMcpConfigs`. Not a blanket override: the builder
			// uses `repository.mcpConfigPath` when this repo has its own
			// `allowedTools` override (so the repo's permission rules and
			// MCP server set travel as a unit), and only falls through to
			// this list when the repo inherits the platform allow-list.
			platformMcpConfigOverrides:
				sessionPlatform === "linear"
					? this.config.linearMcpConfigs
					: this.config.githubMcpConfigs,
			strictMcpConfig: this.config.strictMcpConfig,
			linearWorkspaceId,
			cyrusHome: this.cyrusHome,
			logger: log,
			plugins,
			opencodeGlobalConfig: this.config.opencode?.config,
			opencodeGlobalStateScope: this.config.opencode?.stateScope,
			skills: allowedSkillNames,
			sandboxSettings: this.sdkSandboxSettings ?? undefined,
			egressCaCertPath: this.egressCaCertPath ?? undefined,
			onMessage: (message: SDKMessage) => {
				this.handleClaudeMessage(sessionId, message, repository.id);
			},
			onError: (error: Error) => this.handleClaudeError(error),
			createAskUserQuestionCallback: (sid, wid) =>
				this.createAskUserQuestionCallback(sid, wid)!,
			requireLinearWorkspaceId,
		});

		// Attach pre-warmed session if available (only for Claude runner).
		// Skipped entirely when warm sessions are not enabled.
		if (result.runnerType === "claude" && this.isWarmSessionsEnabled()) {
			const warmSession = this.warmInstances.get(sessionId);
			if (warmSession) {
				this.warmInstances.delete(sessionId);
				(
					result.config as AgentRunnerConfig & { warmSession?: WarmQuery }
				).warmSession = warmSession;
				log.debug("Attaching pre-warmed session to runner config");
			}
		}

		return result;
	}

	/**
	 * Create an onAskUserQuestion callback for the ClaudeRunner.
	 * This callback delegates to the AskUserQuestionHandler which posts
	 * elicitations to Linear and waits for user responses.
	 *
	 * @param linearAgentSessionId - Linear agent session ID for tracking
	 * @param organizationId - Linear organization/workspace ID
	 */
	private createAskUserQuestionCallback(
		linearAgentSessionId: string,
		organizationId: string,
	): AgentRunnerConfig["onAskUserQuestion"] {
		return async (input, _sessionId, signal) => {
			// Report the run as waiting for the duration of the elicitation: this
			// await can outlive the container by hours, and it holds the SDK query
			// open, so no terminal frame is ever sent and the router would otherwise
			// pin the device forever (PAR-146).
			//
			// But ONLY once the question is actually in front of the user. The
			// waiting report can release the router's session affinity, and posting
			// the elicitation is a session-scoped RPC — so reporting first makes the
			// post fail with "session not owned by this device". That failure is
			// silent and unrecoverable: no question ever reaches the user, so nothing
			// wakes the session, and every activity the agent posts for the rest of
			// the turn is rejected the same way. `RepositoryRouter` reports after its
			// own successful post for exactly this reason; this is the same ordering.
			//
			// Pending work no longer suppresses the report — it withholds only the
			// EXECUTOR's park permission, which the `sessionParked` listener decides
			// from `pendingWorkCount`. The two used to be one decision, which is why
			// a run blocked on a user with a live background build was reported as
			// nothing at all.
			let waiting = false;
			try {
				// Note: We use linearAgentSessionId (from closure) instead of the passed sessionId
				// because the passed sessionId is the Claude session ID, not the Linear agent session ID
				return await this.askUserQuestionHandler.handleAskUserQuestion(
					input,
					linearAgentSessionId,
					organizationId,
					signal,
					() => {
						waiting = true;
						this.agentSessionManager.emit(
							"sessionParked",
							linearAgentSessionId,
						);
					},
				);
			} finally {
				// `finally`, not the success path: an abort or a throw leaves the
				// session just as un-waiting, and a still-buffered wait frame would
				// then replay over the next live turn.
				if (waiting) {
					this.agentSessionManager.emit(
						"sessionUnparked",
						linearAgentSessionId,
					);
				}
			}
		};
	}

	/**
	 * Build disallowed tools list following the same hierarchy as allowed tools.
	 * Accepts single or multiple repositories (intersection for multi-repo).
	 */
	private buildDisallowedTools(
		repositories: RepositoryConfig | RepositoryConfig[],
		promptType?:
			| "debugger"
			| "builder"
			| "scoper"
			| "orchestrator"
			| "graphite-orchestrator",
	): string[] {
		return this.toolPermissionResolver.buildDisallowedTools(
			repositories,
			promptType,
		);
	}

	/**
	 * Build allowed tools list with Linear MCP tools automatically included.
	 * Accepts single or multiple repositories (union for multi-repo).
	 */
	private buildAllowedTools(
		repositories: RepositoryConfig | RepositoryConfig[],
		promptType?:
			| "debugger"
			| "builder"
			| "scoper"
			| "orchestrator"
			| "graphite-orchestrator",
	): string[] {
		return this.toolPermissionResolver.buildAllowedTools(
			repositories,
			promptType,
		);
	}

	/**
	 * Get Agent Sessions for an issue
	 */
	public getAgentSessionsForIssue(
		issueId: string,
		_repositoryId: string,
	): any[] {
		return this.agentSessionManager.getSessionsByIssueId(issueId);
	}

	// ========================================================================
	// User Access Control
	// ========================================================================

	/**
	 * Check if the user who triggered the webhook is allowed to interact.
	 * @param webhook The webhook containing user information
	 * @param repository The repository configuration
	 * @returns Access check result with allowed status and user name
	 */
	private checkUserAccess(
		webhook: AgentSessionCreatedWebhook | AgentSessionPromptedWebhook,
		repository: RepositoryConfig,
	): { allowed: true } | { allowed: false; reason: string; userName: string } {
		const creator = webhook.agentSession.creator;
		const userId = creator?.id;
		const userEmail = creator?.email;
		const userName = creator?.name || userId || "Unknown";

		const result = this.userAccessControl.checkAccess(
			userId,
			userEmail,
			repository.id,
		);

		if (!result.allowed) {
			return { allowed: false, reason: result.reason, userName };
		}
		return { allowed: true };
	}

	/**
	 * Handle blocked user according to configured behavior.
	 * Posts a response activity to end the session.
	 * @param webhook The webhook that triggered the blocked access
	 * @param repository The repository configuration
	 * @param _reason The reason for blocking (for logging)
	 */
	private async handleBlockedUser(
		webhook: AgentSessionCreatedWebhook | AgentSessionPromptedWebhook,
		repository: RepositoryConfig,
		_reason: string,
	): Promise<void> {
		// Use organizationId from webhook as the Linear-native workspace ID source
		const issueTracker = this.issueTrackers.get(webhook.organizationId);
		const agentSessionId = webhook.agentSession.id;
		const behavior = this.userAccessControl.getBlockBehavior(repository.id);

		if (!issueTracker) {
			return;
		}

		if (behavior === "comment") {
			// Get user info for templating
			const creator = webhook.agentSession.creator;
			const userName = creator?.name || "User";
			const userId = creator?.id || "";

			// Get the message template and replace variables
			// Supported variables:
			// - {{userName}} - The user's display name
			// - {{userId}} - The user's Linear ID
			let message = this.userAccessControl.getBlockMessage(repository.id);
			message = message
				.replace(/\{\{userName\}\}/g, userName)
				.replace(/\{\{userId\}\}/g, userId);

			await this.postActivityDirect(
				issueTracker,
				{
					agentSessionId,
					content: { type: "response", body: message },
				},
				"blocked user message",
			);
		}
		// For "silent" behavior, we don't post any activity.
		// The session will remain in "Working" state until manually stopped or timed out.
	}

	/**
	 * Diagnostic lines describing MCP connection health — which servers
	 * connected, which are retrying/degraded/failed, and which were deliberately
	 * skipped (e.g. `cyrus-docs` in a headless container).
	 *
	 * Consumed by the CLI's startup banner alongside the port / repository lines,
	 * so an operator sees MCP state in the same place as everything else. Returns
	 * `[]` before the first probe or config build, so callers can splice it in
	 * unconditionally.
	 */
	getMcpHealthDiagnostics(): string[] {
		return this.mcpHealthMonitor.diagnosticLines();
	}

	/**
	 * Probe every remote MCP server Cyrus would configure, once, at startup.
	 *
	 * Builds the MCP config for each configured repository (the same call the
	 * live session path makes, minus a parent session id) and hands the deduped
	 * union to `McpHealthMonitor`, which handshakes each remote server with
	 * bounded exponential backoff. Servers dropped for headless mode are already
	 * recorded as `skipped` by `McpConfigService` and are not probed.
	 *
	 * Never throws — an unreachable MCP server is a diagnostic, not a boot
	 * failure.
	 */
	private async probeMcpHealth(): Promise<void> {
		const servers: Record<string, McpServerConfig> = {};
		for (const repo of this.repositories.values()) {
			try {
				const workspaceId = requireLinearWorkspaceId(repo);
				Object.assign(
					servers,
					this.mcpConfigService.describeMcpServers(repo.id, workspaceId),
				);
			} catch (error) {
				this.logger.debug(
					`Skipping MCP health probe for repository ${repo.id}:`,
					error,
				);
			}
		}

		if (Object.keys(servers).length === 0) return;

		if (this.mcpConfigService.isHeadless()) {
			this.logger.info(
				"🔌 MCP: headless container mode — servers requiring interactive OAuth are omitted",
			);
		}

		await this.mcpHealthMonitor.probeAll(servers, {
			// `cyrus-tools` is served by THIS process and only answers a request
			// carrying a live `x-cyrus-mcp-context-id` (see
			// registerCyrusToolsMcpEndpoint). A context-free probe would get a 500
			// and be recorded as a false failure, so its health comes from the SDK's
			// per-session `system`/`init` report instead — which is now blocking for
			// this server (`alwaysLoad: true`), so a genuine failure shows up on the
			// very first turn.
			skip: ["cyrus-tools"],
		});
		for (const line of this.getMcpHealthDiagnostics()) {
			this.logger.info(line);
		}
	}

	/**
	 * Load persisted EdgeWorker state for all repositories
	 */
	private async loadPersistedState(): Promise<void> {
		try {
			const state = await this.persistenceManager.loadEdgeWorkerState();
			if (state) {
				this.restoreMappings(state);
				this.logger.debug(
					`✅ Loaded persisted EdgeWorker state with ${Object.keys(state.agentSessions || {}).length} sessions`,
				);
			}
		} catch (error) {
			this.logger.error(`Failed to load persisted EdgeWorker state:`, error);
		}
	}

	/**
	 * Whether the warm-session feature is enabled.
	 *
	 * Warm sessions are an opt-in optimization that pre-spawns Claude Code
	 * subprocesses on startup so the first query after a restart skips the
	 * cold-start cost. Disabled by default; opt in by setting
	 * `CYRUS_ENABLE_WARM_SESSIONS=1` (or `=true`).
	 */
	private isWarmSessionsEnabled(): boolean {
		const raw = process.env.CYRUS_ENABLE_WARM_SESSIONS;
		if (!raw) return false;
		const v = raw.toLowerCase().trim();
		return v === "1" || v === "true";
	}

	/**
	 * Whether the remote Claude session store is explicitly disabled.
	 *
	 * The remote store mirrors SDK transcripts to the Cyrus hosted control
	 * plane and is on by default whenever `CYRUS_APP_URL`, `CYRUS_API_KEY`,
	 * and `CYRUS_TEAM_ID` are all set. Operators can opt out — without
	 * unsetting those vars (which other features depend on) — by setting
	 * `CYRUS_DISABLE_REMOTE_SESSION_STORE=1` (or `=true`).
	 */
	private isRemoteSessionStoreDisabled(): boolean {
		const raw = process.env.CYRUS_DISABLE_REMOTE_SESSION_STORE;
		if (!raw) return false;
		const v = raw.toLowerCase().trim();
		return v === "1" || v === "true";
	}

	/**
	 * Pre-warm the N most recently updated Claude sessions so the first query
	 * after a CLI restart has near-zero cold-start latency (~20x faster).
	 *
	 * Uses startup() from @anthropic-ai/claude-agent-sdk with MCP_CONNECTION_NONBLOCKING=true
	 * so the warm instances are ready in ~500ms rather than ~4s.
	 * Warm instances are stored in this.warmInstances keyed by agentSessionId and
	 * consumed by buildAgentRunnerConfig() when the first message arrives.
	 *
	 * Gated by `isWarmSessionsEnabled()` — callers should check before invoking.
	 */
	private async warmupRecentSessions(count = 30): Promise<void> {
		const allSessions = this.agentSessionManager.getAllSessions();

		// Only warm Claude sessions that have a persisted session ID and a workspace path
		const candidates = allSessions
			.filter((s) => s.claudeSessionId && s.workspace?.path)
			.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
			.slice(0, count);

		if (candidates.length === 0) {
			this.logger.debug("No Claude sessions to pre-warm");
			return;
		}

		this.logger.info(
			`Pre-warming ${candidates.length} most recent Claude sessions...`,
		);

		const { startup } = await import("@anthropic-ai/claude-agent-sdk");

		await Promise.all(
			candidates.map(async (session) => {
				try {
					const repoId = this.sessionRepositories.get(session.id);
					const repo = repoId ? this.repositories.get(repoId) : undefined;
					if (!repo) {
						this.logger.debug(
							`No repo for session ${session.id}, skipping warmup`,
						);
						return;
					}

					// Build MCP config for this session (same as the live runner would use)
					const linearWorkspaceId = requireLinearWorkspaceId(repo);
					const mcpConfig = this.mcpConfigService.buildMcpConfig(
						repo.id,
						linearWorkspaceId,
						session.id,
					);

					// Merge any file-based MCP configs (reuses shared normalization).
					// Warmup paths reconstruct Linear-triggered issue sessions:
					// if the repo has its own `allowedTools` override its
					// mcpConfigPath stays scoped to that repo, otherwise the
					// team-level `linearMcpConfigs` list applies. Same coupling
					// the live `buildIssueConfig` path uses.
					const mcpConfigPath = resolveIssueMcpConfigPath(
						repo,
						this.config.linearMcpConfigs,
						this.mcpConfigService.buildMergedMcpConfigPath.bind(
							this.mcpConfigService,
						),
					);
					let mcpServers: Record<string, McpServerConfig> = { ...mcpConfig };
					if (mcpConfigPath) {
						const paths = Array.isArray(mcpConfigPath)
							? mcpConfigPath
							: [mcpConfigPath];
						for (const filePath of paths) {
							try {
								if (existsSync(filePath)) {
									const fileContent = JSON.parse(
										readFileSync(filePath, "utf8"),
									);
									const servers = fileContent.mcpServers || {};
									normalizeMcpHttpTransport(servers);
									mcpServers = { ...mcpServers, ...servers };
								}
							} catch {
								// Ignore unreadable MCP config files
							}
						}
					}

					const repoConfig = repo as unknown as Record<string, unknown>;
					const model =
						(session.metadata?.model as string | undefined) ||
						(repoConfig.claudeDefaultModel as string | undefined) ||
						(repoConfig.model as string | undefined) ||
						"claude-opus-4-6";

					// Build allowed/disallowed tools — same as what buildAgentRunnerConfig() uses.
					// Without these, startup() inherits the user's defaultMode ("default"),
					// which causes macOS permission prompts for file writes.
					const allowedTools = this.buildAllowedTools(repo);
					const disallowedTools = this.buildDisallowedTools(repo);

					const warm = await startup({
						options: {
							resume: session.claudeSessionId,
							model,
							cwd: session.workspace.path,
							...(Object.keys(mcpServers).length > 0 && { mcpServers }),
							...(allowedTools.length > 0 && { allowedTools }),
							...(disallowedTools.length > 0 && { disallowedTools }),
							settingSources: ["user", "project", "local"],
							strictMcpConfig: this.config.strictMcpConfig ?? true,
							// Must match what ClaudeRunner.start() decides, or a session
							// that lands on a warm instance runs with a different scrub
							// posture than the same session started cold. A throw here is
							// caught below and simply skips the pre-warm; the real session
							// start then fails loudly with the same error (NOR-412).
							env: {
								...buildBaseSessionEnv(),
								CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: resolveSubprocessEnvScrub({
									logger: this.logger,
								}).enabled
									? "1"
									: undefined,
							},
						},
					});

					this.warmInstances.set(session.id, warm);
					this.logger.info(
						`Pre-warmed session ${session.id} (${session.issueContext?.issueIdentifier ?? "unknown"})`,
					);
				} catch (err) {
					this.logger.debug(`Failed to pre-warm session ${session.id}:`, err);
				}
			}),
		);

		this.logger.info(
			`Session pre-warm complete: ${this.warmInstances.size} sessions ready`,
		);
	}

	/**
	 * Save current EdgeWorker state for all repositories
	 */
	private async savePersistedState(): Promise<void> {
		try {
			const state = this.serializeMappings();
			await this.persistenceManager.saveEdgeWorkerState(state);
			this.logger.debug(
				`✅ Saved EdgeWorker state for ${Object.keys(state.agentSessions || {}).length} sessions`,
			);
		} catch (error) {
			this.logger.error(`Failed to save persisted EdgeWorker state:`, error);
		}
	}

	/**
	 * Serialize EdgeWorker mappings to a serializable format (v4.0 flat format)
	 */
	public serializeMappings(): SerializableEdgeWorkerState {
		// Serialize Agent Session state - flat structure from single ASM
		const serializedState = this.agentSessionManager.serializeState();

		// Serialize child to parent agent session mapping from GlobalSessionRegistry
		const registryState = this.globalSessionRegistry.serializeState();
		const childToParentAgentSession = registryState.childToParentMap;

		// Serialize issue to repository cache from RepositoryRouter
		const issueRepositoryCache = Object.fromEntries(
			this.repositoryRouter.getIssueRepositoryCache().entries(),
		);

		return {
			agentSessions: serializedState.sessions,
			agentSessionEntries: serializedState.entries,
			childToParentAgentSession,
			issueRepositoryCache,
		};
	}

	/**
	 * Restore EdgeWorker mappings from serialized state (v4.0 flat format)
	 */
	public restoreMappings(state: SerializableEdgeWorkerState): void {
		// Restore Agent Session state from flat format
		if (state.agentSessions && state.agentSessionEntries) {
			this.agentSessionManager.restoreState(
				state.agentSessions,
				state.agentSessionEntries,
			);

			// Rebuild session-to-repo mapping from issueRepositoryCache
			// For each restored session, look up its issue in the cache to find the repo
			if (state.issueRepositoryCache) {
				for (const [sessionId, session] of Object.entries(
					state.agentSessions,
				)) {
					const issueId =
						(session as any).issueContext?.issueId ?? (session as any).issueId;
					if (issueId && state.issueRepositoryCache[issueId]) {
						const cachedRepoIds = state.issueRepositoryCache[issueId];
						// Use first repo ID for session-to-repo mapping (primary repo)
						const repoId = cachedRepoIds[0];
						if (repoId) {
							this.sessionRepositories.set(sessionId, repoId);
							// Also register the activity sink for this restored session
							const activitySink = this.getActivitySinkForRepo(repoId);
							if (activitySink) {
								this.agentSessionManager.setActivitySink(
									sessionId,
									activitySink,
								);
							}
						}
					}
				}
			}

			this.logger.debug(
				`Restored ${Object.keys(state.agentSessions).length} sessions`,
			);
		}

		// Restore child to parent agent session mapping into GlobalSessionRegistry
		if (state.childToParentAgentSession) {
			const entries = Object.entries(state.childToParentAgentSession);
			for (const [childId, parentId] of entries) {
				this.globalSessionRegistry.setParentSession(childId, parentId);
			}
			this.logger.debug(
				`Restored ${entries.length} child-to-parent agent session mappings`,
			);
		}

		// Restore issue to repository cache in RepositoryRouter
		// Handles migration from old Record<string, string> to Record<string, string[]>
		if (state.issueRepositoryCache) {
			const cache = new Map(
				Object.entries(state.issueRepositoryCache) as [
					string,
					string | string[],
				][],
			);
			this.repositoryRouter.restoreIssueRepositoryCache(cache);
			this.logger.debug(
				`Restored ${cache.size} issue-to-repository cache mappings`,
			);
		}
	}

	/**
	 * Post an activity directly via an issue tracker instance.
	 * Consolidates try/catch and success/error logging for EdgeWorker call sites
	 * that already have the issueTracker and agentSessionId resolved.
	 *
	 * @returns The activity ID when resolved, `null` otherwise.
	 */
	private async postActivityDirect(
		issueTracker: IIssueTrackerService,
		input: AgentActivityCreateInput,
		label: string,
	): Promise<string | null> {
		return this.activityPoster.postActivityDirect(issueTracker, input, label);
	}

	/**
	 * Post instant acknowledgment thought when agent session is created
	 */
	private async postInstantAcknowledgment(
		sessionId: string,
		linearWorkspaceId: string,
	): Promise<void> {
		return this.activityPoster.postInstantAcknowledgment(
			sessionId,
			linearWorkspaceId,
		);
	}

	/**
	 * Post parent resume acknowledgment thought when parent session is resumed from child
	 */
	private async postParentResumeAcknowledgment(
		sessionId: string,
		linearWorkspaceId: string,
	): Promise<void> {
		return this.activityPoster.postParentResumeAcknowledgment(
			sessionId,
			linearWorkspaceId,
		);
	}

	/**
	 * Post combined routing activity showing repos selected + base branches resolved
	 */
	private async postRoutingActivity(
		sessionId: string,
		linearWorkspaceId: string,
		repoLines: string[],
		routingMethod?: string,
	): Promise<void> {
		return this.activityPoster.postRoutingActivity(
			sessionId,
			linearWorkspaceId,
			repoLines,
			routingMethod,
		);
	}

	/**
	 * Handle prompt with streaming check - centralized logic for all input types
	 *
	 * This method implements the unified pattern for handling prompts:
	 * 1. Check if runner is actively streaming
	 * 2. Add to stream if streaming, OR resume session if not
	 *
	 * @param session The Cyrus agent session
	 * @param repository Repository configuration
	 * @param sessionId Linear agent activity session ID
	 * @param agentSessionManager Agent session manager instance
	 * @param promptBody The prompt text to send
	 * @param attachmentManifest Optional attachment manifest to append
	 * @param isNewSession Whether this is a new session
	 * @param additionalAllowedDirs Additional directories to allow access to
	 * @param logContext Context string for logging (e.g., "prompted webhook", "parent resume")
	 * @returns true if message was added to stream, false if session was resumed
	 */
	private async handlePromptWithStreamingCheck(
		session: CyrusAgentSession,
		repository: RepositoryConfig,
		sessionId: string,
		agentSessionManager: AgentSessionManager,
		promptBody: string,
		attachmentManifest: string,
		isNewSession: boolean,
		additionalAllowedDirs: string[],
		logContext: string,
		linearWorkspaceId: string,
		commentAuthor?: string,
		commentTimestamp?: string,
	): Promise<boolean> {
		const log = this.logger.withContext({ sessionId });
		const existingRunner = session.agentRunner;

		// Handle running case - add message to existing stream (if supported)
		if (
			existingRunner?.isRunning() &&
			existingRunner.supportsStreamingInput &&
			existingRunner.addStreamMessage
		) {
			log.debug(
				`Adding prompt to existing stream for ${sessionId} (${logContext})`,
			);

			// Append attachment manifest to the prompt if we have one
			let fullPrompt = promptBody;
			if (attachmentManifest) {
				fullPrompt = `${promptBody}\n\n${attachmentManifest}`;
			}

			// `addStreamMessage` can reject the message if the turn ended in the
			// race window between "still running" and "turn finished" (e.g. the
			// Codex app-server backend, which only steers an active turn). Fall
			// through to the resume path so the comment is never dropped. Claude's
			// streaming input never throws here, so this is a no-op for Claude.
			try {
				existingRunner.addStreamMessage(fullPrompt);
				return true; // Message added to stream
			} catch (error) {
				log.warn(
					`Streaming message rejected for ${sessionId}; falling back to resume (${logContext})`,
					{ error: error instanceof Error ? error.message : String(error) },
				);
			}
		}

		// Not streaming (or streaming was rejected) - resume/start session
		log.debug(`Resuming Claude session for ${sessionId} (${logContext})`);

		await this.resumeAgentSession(
			session,
			repository,
			sessionId,
			agentSessionManager,
			promptBody,
			attachmentManifest,
			isNewSession,
			additionalAllowedDirs,
			linearWorkspaceId,
			undefined, // maxTurns
			commentAuthor,
			commentTimestamp,
		);

		return false; // Session was resumed
	}

	/**
	 * Post thought about system prompt selection based on labels
	 */
	private async postSystemPromptSelectionThought(
		sessionId: string,
		labels: string[],
		linearWorkspaceId: string,
		repositoryId: string,
	): Promise<void> {
		return this.activityPoster.postSystemPromptSelectionThought(
			sessionId,
			labels,
			linearWorkspaceId,
			repositoryId,
		);
	}

	/**
	 * Surface a failed WIP snapshot capture onto the issue itself.
	 *
	 * The issue branch used to be the fallback for a failed floor push, so
	 * logging it was enough. It isn't any more: a failed capture means the only
	 * copy of the agent's uncommitted work never left this machine, and whoever
	 * can act on that is watching the issue, not the logs. Repository push
	 * rules (file size, path, extension) apply to every push regardless of ref,
	 * so a snapshot really can be rejected on an otherwise healthy remote.
	 *
	 * `WorkspaceSyncService` already coalesces repeated failures for the same
	 * issue, so this posts once per unbroken run rather than every five minutes.
	 */
	private async reportWipSnapshotFailure(
		issueKey: string,
		detail: string,
	): Promise<void> {
		const sessions = this.agentSessionManager
			.getAllSessions()
			.filter((session) => session.issue?.identifier === issueKey);

		for (const session of sessions) {
			const repoId = this.sessionRepositories.get(session.id);
			const workspaceId = repoId
				? this.repositories.get(repoId)?.linearWorkspaceId
				: undefined;
			if (!workspaceId) continue;
			await this.activityPoster.postThoughtActivity(
				session.id,
				workspaceId,
				`⚠️ I could not save a snapshot of my uncommitted work for ${issueKey}. Until this succeeds, that work only exists on the machine I'm running on and would be lost if it goes away.\n\n\`\`\`\n${detail}\n\`\`\``,
			);
			return;
		}

		this.logger.warn(
			`Could not surface the WIP snapshot failure for ${issueKey}: no session with a resolvable workspace`,
		);
	}

	/**
	 * Restore-ladder gap-closer: re-creates a session's git-worktree workspace
	 * if it no longer exists (or was reduced to an empty/invalid directory)
	 * before a resume attempts to use it as the runner's cwd.
	 *
	 * This is the single choke point for every resume path — new-comment
	 * continuation (`handleNormalPromptedActivity`), parent-resume-from-child,
	 * and feedback-to-child all funnel through `resumeAgentSession`, which
	 * calls this before `buildAgentRunnerConfig` sets `cwd = session.workspace.path`.
	 * Without it, a destroyed-and-recreated container (or a worktree deleted by
	 * hand on a physical device) would resume the Claude transcript into a
	 * directory `ClaudeRunner`'s own `mkdirSync(cwd, { recursive: true })`
	 * silently manufactures empty — no repo, no `.git`, and no sight of the
	 * work the persistence floor saved.
	 *
	 * A no-op on the happy path: `GitService.isWorkspaceValid` is a cheap
	 * filesystem check, and plain (non-git) workspaces always report valid
	 * (a missing one is already handled correctly by a plain `mkdir`).
	 *
	 * Reuses the exact same workspace-creation path `createCyrusAgentSession`
	 * uses for brand-new sessions — the custom `handlers.createWorkspace`
	 * override when configured (the path production takes), else
	 * `GitService.createGitWorktree` directly. Both already implement
	 * "worktree continuity": when the issue's branch already exists on
	 * origin (which it will, since the floor pushes WIP there), the new
	 * worktree is checked out from `origin/<branch>` instead of branching
	 * fresh from the base branch — so re-creation here never loses
	 * committed-but-unmerged work.
	 */
	private async ensureSessionWorkspaceExists(
		session: CyrusAgentSession,
		repository: RepositoryConfig,
		fullIssue: Issue,
		sessionId: string,
		linearWorkspaceId: string,
	): Promise<void> {
		if (this.gitService.isWorkspaceValid(session.workspace)) {
			return;
		}

		this.logger.warn(
			`Workspace missing/invalid for session ${sessionId} (issue ${fullIssue.identifier}) at ${session.workspace.path} — recreating the worktree from the issue branch before resuming. Likely cause: destroyed/recreated container or a manually removed worktree.`,
		);

		const repositoriesForSession = session.repositories
			.map((ctx) => this.repositories.get(ctx.repositoryId))
			.filter((r): r is RepositoryConfig => Boolean(r));
		const resolvedRepositories =
			repositoriesForSession.length > 0 ? repositoriesForSession : [repository];

		// Recreation must land the worktree on the same EXPLICIT base branch
		// the session originally resolved to (e.g. a `[repo=name#branch]`
		// description selector), not whatever `determineBaseBranch` would
		// re-derive today. The session's own persisted
		// `RepositoryContext.baseBranchName` already carries that resolved
		// branch per repo (set once in `createCyrusAgentSession`), so reuse
		// it here as a `baseBranchOverrides` map — the same mechanism
		// `createCyrusAgentSession` itself passes through — instead of
		// re-deriving from scratch.
		//
		// Only repos whose `baseBranchSource === "commit-ish"` are pinned this
		// way; leaving the rest out lets `determineBaseBranch` recompute
		// exactly as it would for a brand-new session. Note that an override
		// passed here no longer suppresses worktree continuity — published
		// work on the issue branch wins over it, precisely because this method
		// re-passes the original selector on every recreation and letting it
		// win twice would discard everything published since. See
		// `createSingleRepoWorktree`.
		const baseBranchOverrides = new Map<string, string>();
		for (const ctx of session.repositories) {
			if (ctx.baseBranchName && ctx.baseBranchSource === "commit-ish") {
				baseBranchOverrides.set(ctx.repositoryId, ctx.baseBranchName);
			}
		}

		const workspace = this.config.handlers?.createWorkspace
			? await this.config.handlers.createWorkspace(
					fullIssue,
					resolvedRepositories,
					{
						baseBranchOverrides:
							baseBranchOverrides.size > 0 ? baseBranchOverrides : undefined,
						onRepoSetupHookEvent: (activity) =>
							this.activityPoster.postRepoSetupHookActivity(
								sessionId,
								linearWorkspaceId,
								activity,
							),
					},
				)
			: await this.gitService.createGitWorktree(
					fullIssue,
					resolvedRepositories,
					{
						baseBranchOverrides:
							baseBranchOverrides.size > 0 ? baseBranchOverrides : undefined,
						onRepoSetupHookEvent: (activity) =>
							this.activityPoster.postRepoSetupHookActivity(
								sessionId,
								linearWorkspaceId,
								activity,
							),
					},
				);

		session.workspace = workspace;
	}

	/**
	 * Resume or create an Agent session with the given prompt
	 * This is the core logic for handling prompted agent activities
	 * @param session The Cyrus agent session
	 * @param repository The repository configuration
	 * @param sessionId The Linear agent session ID
	 * @param agentSessionManager The agent session manager
	 * @param promptBody The prompt text to send
	 * @param attachmentManifest Optional attachment manifest
	 * @param isNewSession Whether this is a new session
	 */
	async resumeAgentSession(
		session: CyrusAgentSession,
		repository: RepositoryConfig,
		sessionId: string,
		agentSessionManager: AgentSessionManager,
		promptBody: string,
		attachmentManifest: string = "",
		isNewSession: boolean = false,
		additionalAllowedDirectories: string[] = [],
		linearWorkspaceId?: string,
		maxTurns?: number,
		commentAuthor?: string,
		commentTimestamp?: string,
	): Promise<void> {
		const log = this.logger.withContext({ sessionId });

		// Persistence floor: this turn (new or resumed) may run for a long time
		// before the session next reaches a terminal state. Touching here —
		// not only at session end — is what lets the periodic timer keep
		// re-syncing this issue on every tick while the runner is active, and
		// (re-)registers this sessionId as live on the issue (idempotent — see
		// WorkspaceSyncService's refcount). A no-op on non-router platforms
		// (`workspaceSync` is only constructed when `platform === "router"`).
		if (session.issue?.identifier) {
			this.workspaceSync?.touch(session.issue.identifier, sessionId);
		}

		// A prompt is an explicit instruction to continue, so drop any stop request
		// left over from a previous turn. Without this, a stop delivered while the
		// runner was already dead (OOM kill, crash) stays latched and is consumed
		// by this turn's result — swallowing the prompt and reporting the session
		// as stopped. Cleared before both branches: the streaming path completes
		// through the same `completeSession`.
		agentSessionManager.clearStopRequest(sessionId);

		// Check for existing runner
		const existingRunner = session.agentRunner;

		// If there's an existing running runner that supports streaming, add to it
		if (
			existingRunner?.isRunning() &&
			existingRunner.supportsStreamingInput &&
			existingRunner.addStreamMessage
		) {
			let fullPrompt = promptBody;
			if (attachmentManifest) {
				fullPrompt = `${promptBody}\n\n${attachmentManifest}`;
			}
			// See handlePromptWithStreamingCheck: a steer-only backend can reject
			// the message if the turn just ended. Fall through to a fresh resume
			// turn rather than dropping the comment. No-op for Claude.
			try {
				existingRunner.addStreamMessage(fullPrompt);
				return;
			} catch (error) {
				log.warn(
					`Streaming message rejected for ${sessionId}; falling back to resume`,
					{ error: error instanceof Error ? error.message : String(error) },
				);
			}
		}

		// Stop existing runner if it's not running
		if (existingRunner) {
			existingRunner.stop();
		}

		// Get issueId from issueContext (preferred) or deprecated issueId field
		const issueIdForResume = session.issueContext?.issueId ?? session.issueId;
		if (!issueIdForResume) {
			log.error(`No issue ID found for session ${session.id}`);
			throw new Error(`No issue ID found for session ${session.id}`);
		}

		// Fetch full issue details using workspace ID (from webhook context or repo fallback)
		const resolvedWorkspaceId =
			linearWorkspaceId ?? requireLinearWorkspaceId(repository);
		const fullIssue = await this.fetchFullIssueDetails(
			issueIdForResume,
			resolvedWorkspaceId,
		);
		if (!fullIssue) {
			log.error(`Failed to fetch full issue details for ${issueIdForResume}`);
			throw new Error(
				`Failed to fetch full issue details for ${issueIdForResume}`,
			);
		}

		// Restore-ladder gap-closer: re-create the workspace if it no longer
		// exists (or was reduced to an empty/invalid directory) before it's
		// used as the runner's cwd below. See ensureSessionWorkspaceExists.
		await this.ensureSessionWorkspaceExists(
			session,
			repository,
			fullIssue,
			sessionId,
			resolvedWorkspaceId,
		);

		// Fetch issue labels early to determine runner type
		const labels = await this.fetchIssueLabels(fullIssue);

		// Determine which runner to use based on existing session IDs
		const hasClaudeSession = !isNewSession && Boolean(session.claudeSessionId);
		const hasGeminiSession = !isNewSession && Boolean(session.geminiSessionId);
		const hasCodexSession = !isNewSession && Boolean(session.codexSessionId);
		const hasCursorSession = !isNewSession && Boolean(session.cursorSessionId);
		const hasOpenCodeSession =
			!isNewSession && Boolean(session.opencodeSessionId);
		const needsNewSession =
			isNewSession ||
			(!hasClaudeSession &&
				!hasGeminiSession &&
				!hasCodexSession &&
				!hasCursorSession &&
				!hasOpenCodeSession);

		// Fetch system prompt based on labels

		const systemPromptResult = await this.determineSystemPromptFromLabels(
			labels,
			repository,
		);
		const systemPrompt = systemPromptResult?.prompt;
		const promptType = systemPromptResult?.type;

		// Build allowed and disallowed tools lists
		const allowedTools = this.buildAllowedTools(repository, promptType);
		const disallowedTools = this.buildDisallowedTools(repository, promptType);

		// Set up attachments directory
		const workspaceFolderName = basename(session.workspace.path);
		const attachmentsDir = join(
			this.cyrusHome,
			workspaceFolderName,
			"attachments",
		);
		await mkdir(attachmentsDir, { recursive: true });

		const allowedDirectories = [
			...new Set([
				attachmentsDir,
				repository.repositoryPath,
				...additionalAllowedDirectories,
				...this.gitService.getGitMetadataDirectoriesForWorkspace(
					session.workspace,
				),
			]),
		];

		const resumeSessionId = needsNewSession
			? undefined
			: session.claudeSessionId
				? session.claudeSessionId
				: session.geminiSessionId
					? session.geminiSessionId
					: session.codexSessionId
						? session.codexSessionId
						: session.cursorSessionId
							? session.cursorSessionId
							: session.opencodeSessionId;

		this.logger.debug(
			`resumeAgentSession: needsNewSession=${needsNewSession}, resumeSessionId=${resumeSessionId ?? "none"}`,
		);

		// Create runner configuration
		// buildAgentRunnerConfig determines runner type from labels for new sessions
		// For existing sessions, we still need labels for model override but ignore runner type
		const { config: runnerConfig, runnerType } =
			await this.buildAgentRunnerConfig(
				session,
				repository,
				sessionId,
				systemPrompt,
				allowedTools,
				allowedDirectories,
				disallowedTools,
				resumeSessionId,
				labels, // Always pass labels to preserve model override
				fullIssue.description || undefined, // Description tags can override label selectors
				maxTurns, // Pass maxTurns if specified
				resolvedWorkspaceId,
				this.buildSkillSessionContext(repository, fullIssue, session),
			);

		// Create the appropriate runner based on session state
		const runner = this.createRunnerForType(runnerType, runnerConfig);

		// Store runner
		agentSessionManager.addAgentRunner(sessionId, runner);

		// Save state
		await this.savePersistedState();

		// Prepare the full prompt
		const fullPrompt = this.withRestoredWorkPreamble(
			await this.buildSessionPrompt(
				isNewSession,
				session,
				fullIssue,
				repository,
				promptBody,
				attachmentManifest,
				commentAuthor,
				commentTimestamp,
			),
			session,
			needsNewSession,
		);

		// Start session - use streaming mode if supported for ability to add messages later
		try {
			if (runner.supportsStreamingInput && runner.startStreaming) {
				await runner.startStreaming(fullPrompt);
			} else {
				await runner.start(fullPrompt);
			}
		} catch (error) {
			log.error(`Failed to start streaming session for ${sessionId}:`, error);
			// Same reasoning as initializeAgentRunner's catch: this rethrow reaches
			// handleWebhook, which logs and stops. Without a terminal state here the
			// prompted session hangs in Linear exactly as a created one would.
			await this.failSessionOnStartupError(
				agentSessionManager,
				sessionId,
				error,
			);
			throw error;
		}
	}

	/**
	 * Prefix `prompt` with a short note when this session woke into a
	 * workspace whose uncommitted work was rebuilt from a WIP snapshot AND its
	 * own transcript could not be resumed.
	 *
	 * That combination is the only one that needs explaining. An agent that
	 * resumed its transcript remembers doing the work; an agent starting fresh
	 * does not, and finds a workspace full of changes with no record of making
	 * them. The likely failure mode without this is the agent "tidying up"
	 * unexplained changes by reverting them — throwing away exactly what the
	 * persistence floor just saved.
	 *
	 * Says what happened, not how the floor works. A stale snapshot that was
	 * deliberately NOT applied gets its own note, because work exists that the
	 * agent cannot see and may need to recover by hand.
	 */
	private withRestoredWorkPreamble(
		prompt: string,
		session: CyrusAgentSession,
		needsNewSession: boolean,
	): string {
		if (!needsNewSession) return prompt;
		const outcomes = Object.values(session.workspace?.wipRestores ?? {});
		if (outcomes.length === 0) return prompt;

		// One-shot: the note describes what happened when this workspace was
		// last built. Leaving the marker in place would repeat it on every
		// future un-resumable turn, long after the agent has been told.
		session.workspace.wipRestores = undefined;

		const notes: string[] = [];
		if (outcomes.includes("applied")) {
			notes.push(
				"Uncommitted changes already in this workspace were restored from a previous run on this issue. They are your own earlier work, not someone else's — review them and carry on rather than reverting them.",
			);
		}
		if (outcomes.includes("stale")) {
			notes.push(
				"Earlier uncommitted work on this issue was found but deliberately not restored, because the branch has been updated since it was saved. Nothing has been lost, but that work is not in this workspace — say so if it looks like something is missing.",
			);
		}
		return `${notes.join("\n\n")}\n\n${prompt}`;
	}

	/**
	 * Post instant acknowledgment thought when receiving prompted webhook
	 */
	private async postInstantPromptedAcknowledgment(
		sessionId: string,
		linearWorkspaceId: string,
		isStreaming: boolean,
	): Promise<void> {
		return this.activityPoster.postInstantPromptedAcknowledgment(
			sessionId,
			linearWorkspaceId,
			isStreaming,
		);
	}

	/**
	 * Get the platform type for a workspace's issue tracker.
	 */
	private getRepositoryPlatform(linearWorkspaceId: string): string | undefined {
		try {
			return this.issueTrackers.get(linearWorkspaceId)?.getPlatformType();
		} catch {
			return undefined;
		}
	}

	/**
	 * Fetch complete issue details from Linear API
	 */
	public async fetchFullIssueDetails(
		issueId: string,
		linearWorkspaceId: string,
	): Promise<Issue | null> {
		const issueTracker = this.issueTrackers.get(linearWorkspaceId);
		if (!issueTracker) {
			this.logger.warn(
				`No issue tracker found for workspace ${linearWorkspaceId}`,
			);
			return null;
		}

		try {
			this.logger.debug(`Fetching full issue details for ${issueId}`);
			const fullIssue = await issueTracker.fetchIssue(issueId);
			this.logger.debug(`Successfully fetched issue details for ${issueId}`);

			// Check if issue has a parent
			try {
				const parent = await fullIssue.parent;
				if (parent) {
					this.logger.debug(
						`Issue ${issueId} has parent: ${parent.identifier}`,
					);
				}
			} catch (_error) {
				// Parent field might not exist, ignore error
			}

			return fullIssue;
		} catch (error) {
			this.logger.error(`Failed to fetch issue details for ${issueId}:`, error);
			return null;
		}
	}

	// ========================================================================
	// OAuth Token Refresh
	// ========================================================================

	/**
	 * Build OAuth config for LinearIssueTrackerService.
	 * Uses workspace-level token storage.
	 * Returns undefined if OAuth credentials are not available.
	 */
	private buildOAuthConfig(
		linearWorkspaceId: string,
	): LinearOAuthConfig | undefined {
		const clientId = process.env.LINEAR_CLIENT_ID;
		const clientSecret = process.env.LINEAR_CLIENT_SECRET;

		if (!clientId || !clientSecret) {
			this.logger.warn(
				"LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET not set, token refresh disabled",
			);
			return undefined;
		}

		const workspaceConfig = this.config.linearWorkspaces?.[linearWorkspaceId];
		if (!workspaceConfig?.linearRefreshToken) {
			this.logger.warn(
				`No refresh token for workspace ${linearWorkspaceId}, token refresh disabled`,
			);
			return undefined;
		}

		// Get workspace name from workspace-level config
		const workspaceName =
			this.config.linearWorkspaces?.[linearWorkspaceId]?.linearWorkspaceName ||
			linearWorkspaceId;

		return {
			clientId,
			clientSecret,
			refreshToken: workspaceConfig.linearRefreshToken,
			workspaceId: linearWorkspaceId,
			onTokenRefresh: async (tokens) => {
				// Update workspace config in memory
				if (this.config.linearWorkspaces?.[linearWorkspaceId]) {
					this.config.linearWorkspaces[linearWorkspaceId].linearToken =
						tokens.accessToken;
					this.config.linearWorkspaces[linearWorkspaceId].linearRefreshToken =
						tokens.refreshToken;
				}

				// Persist tokens to config.json
				await this.saveOAuthTokens({
					linearToken: tokens.accessToken,
					linearRefreshToken: tokens.refreshToken,
					linearWorkspaceId: linearWorkspaceId,
					linearWorkspaceName: workspaceName,
				});
			},
		};
	}

	/**
	 * Save OAuth tokens to config.json (workspace-level storage)
	 */
	private async saveOAuthTokens(tokens: {
		linearToken: string;
		linearRefreshToken?: string;
		linearWorkspaceId: string;
		linearWorkspaceName?: string;
	}): Promise<void> {
		if (!this.configPath) {
			this.logger.warn("No config path set, cannot save OAuth tokens");
			return;
		}

		try {
			const configContent = await readFile(this.configPath, "utf-8");
			const config = JSON.parse(configContent);

			// Ensure linearWorkspaces exists
			if (!config.linearWorkspaces) {
				config.linearWorkspaces = {};
			}

			// Update workspace-level token storage
			config.linearWorkspaces[tokens.linearWorkspaceId] = {
				linearToken: tokens.linearToken,
				...(tokens.linearRefreshToken
					? { linearRefreshToken: tokens.linearRefreshToken }
					: config.linearWorkspaces[tokens.linearWorkspaceId]
								?.linearRefreshToken
						? {
								linearRefreshToken:
									config.linearWorkspaces[tokens.linearWorkspaceId]
										.linearRefreshToken,
							}
						: {}),
				...(tokens.linearWorkspaceName
					? { linearWorkspaceName: tokens.linearWorkspaceName }
					: config.linearWorkspaces[tokens.linearWorkspaceId]
								?.linearWorkspaceName
						? {
								linearWorkspaceName:
									config.linearWorkspaces[tokens.linearWorkspaceId]
										.linearWorkspaceName,
							}
						: {}),
			};

			await writeFile(this.configPath, JSON.stringify(config, null, "\t"));
			this.logger.debug(
				`OAuth tokens saved to config for workspace ${tokens.linearWorkspaceId}`,
			);
		} catch (error) {
			this.logger.error("Failed to save OAuth tokens:", error);
		}
	}
}
