import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { LinearClient } from "@linear/sdk";
import type { SessionStore } from "cyrus-claude-runner";
import { HttpSessionStore, WarmSessionRegistry } from "cyrus-claude-runner";
import { getCyrusAppUrl } from "cyrus-cloudflare-tunnel-client";
import { ConfigUpdater } from "cyrus-config-updater";
import type {
	AgentActivityCreateInput,
	AgentEvent,
	AgentRunnerConfig,
	AgentSessionCreatedWebhook,
	AgentSessionPromptedWebhook,
	CyrusAgentSession,
	EdgeWorkerConfig,
	IAgentRunner,
	IIssueTrackerService,
	ILogger,
	InternalMessage,
	Issue,
	IssueMinimal,
	IssueStateChangeMessage,
	IssueUnassignedWebhook,
	IssueUpdateWebhook,
	RepositoryConfig,
	SerializableEdgeWorkerState,
	Webhook,
	WebhookIssue,
} from "cyrus-core";
import {
	CLIIssueTrackerService,
	CLIRPCServer,
	compute,
	createLogger,
	DEFAULT_PROXY_URL,
	getReadParentDirectories,
	normalizeConfigPaths,
	PersistenceManager,
	requireLinearWorkspaceId,
	toClaudeToolPatterns,
	WebhookIpValidator,
	withLinearMcpPruned,
} from "cyrus-core";
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
import {
	LinearEventTransport,
	LinearIssueTrackerService,
	type LinearOAuthConfig,
} from "cyrus-linear-event-transport";
import { ActivityPoster } from "./ActivityPoster.js";
import { AgentSessionManager } from "./AgentSessionManager.js";
import {
	AskUserQuestionHandler,
	questionTimeoutMsFromMinutes,
} from "./AskUserQuestionHandler.js";
import { AttachmentService } from "./AttachmentService.js";
import type { Activity } from "./activity/index.js";
import {
	formatLabelRoleThought,
	formatRepoSetupHookActivity,
	formatRoutingThought,
} from "./activity/index.js";
import { ConfigManager, type RepositoryChanges } from "./ConfigManager.js";
import { CyrusToolsHost } from "./CyrusToolsHost.js";
import { DefaultSkillsDeployer } from "./DefaultSkillsDeployer.js";
import { EgressProxy } from "./EgressProxy.js";
import { GitHubUsernameResolver } from "./GitHubUsernameResolver.js";
import { GitService } from "./GitService.js";
import { GlobalSessionRegistry } from "./GlobalSessionRegistry.js";
import { McpConfigService } from "./McpConfigService.js";
import { ParkedSessionRegistry } from "./ParkedSessionRegistry.js";
import { PromptBuilder } from "./PromptBuilder.js";
import { PromptAssembler } from "./prompt-assembly/PromptAssembler.js";
import type { PromptAssemblyInput } from "./prompt-assembly/types.js";
import {
	RepositoryRouter,
	type RepositoryRouterDeps,
} from "./RepositoryRouter.js";
import { RunnerConfigBuilder } from "./RunnerConfigBuilder.js";
import { RunnerSelectionService } from "./RunnerSelectionService.js";
import { SessionOrchestrator } from "./SessionOrchestrator.js";
import { SharedApplicationServer } from "./SharedApplicationServer.js";
import {
	type SkillSessionContext,
	SkillsPluginResolver,
} from "./SkillsPluginResolver.js";
import type { IActivitySink } from "./sinks/IActivitySink.js";
import { LinearActivitySink } from "./sinks/LinearActivitySink.js";
import { NoopActivitySink } from "./sinks/NoopActivitySink.js";
import { ToolPermissionResolver } from "./ToolPermissionResolver.js";
import type { AgentSessionData, EdgeWorkerEvents } from "./types.js";
import { UserAccessControl } from "./UserAccessControl.js";
import { WarmSessionPool } from "./WarmSessionPool.js";
import { WebhookRouter, type WebhookRouterDeps } from "./WebhookRouter.js";

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

/**
 * Unified edge worker that **orchestrates**
 *   capturing Linear webhooks,
 *   managing Claude Code processes, and
 *   processes results through to Linear Agent Activity Sessions
 */
export class EdgeWorker extends EventEmitter {
	private config: EdgeWorkerConfig;
	private repositories: Map<string, RepositoryConfig> = new Map(); // repository 'id' (internal, stored in config.json) mapped to the full repo config
	private agentSessionManager!: AgentSessionManager; // Single instance managing all agent sessions across repositories
	private activitySinks: Map<string, IActivitySink> = new Map(); // Maps Linear workspace ID to activity sink (one per workspace, mirrors issueTrackers)
	private sessionRepositories: Map<string, string> = new Map(); // Maps session ID to repository ID
	private lastStopTimeBySession: Map<string, number> = new Map(); // Maps session ID to timestamp of last stop signal (for double-stop detection)
	private warmPool!: WarmSessionPool; // Pre-warmed Claude session subprocess pool
	private warmSessionRegistry!: WarmSessionRegistry; // LRU cap over concurrently-warm idle Claude sessions
	private parkedRegistry!: ParkedSessionRegistry; // Sessions parked behind blocked-by dependencies
	private sessionOrchestrator!: SessionOrchestrator; // Runner creation + message wiring
	private issueTrackers: Map<string, IIssueTrackerService> = new Map(); // one issue tracker per Linear workspace (keyed by linearWorkspaceId)
	private linearEventTransport: LinearEventTransport | null = null; // Single event transport for webhook delivery
	private gitHubEventTransport: GitHubEventTransport | null = null; // GitHub event transport for forwarded GitHub webhooks
	private gitHubAppTokenProvider: GitHubAppTokenProvider | null = null; // Self-hosted GitHub App token minting
	private gitHubCommentService!: GitHubCommentService; // Service for posting comments back to GitHub PRs
	private cliRPCServer: CLIRPCServer | null = null; // CLI RPC server for CLI platform mode
	private configUpdater: ConfigUpdater | null = null; // Single config updater for configuration updates
	private persistenceManager!: PersistenceManager;
	private sharedApplicationServer!: SharedApplicationServer;
	private cyrusHome: string;
	private globalSessionRegistry!: GlobalSessionRegistry; // Centralized session storage across all repositories
	private configPath?: string; // Path to config.json file
	/** @internal - Exposed for testing only */
	public repositoryRouter!: RepositoryRouter; // Repository routing and selection
	private webhookRouter!: WebhookRouter; // Webhook/message dispatch + branch selection
	private gitService!: GitService;
	private activeWebhookCount = 0; // Track number of webhooks currently being processed
	/** Handler for AskUserQuestion tool invocations via Linear select signal */
	private askUserQuestionHandler!: AskUserQuestionHandler;
	/** User access control for whitelisting/blacklisting Linear users */
	private userAccessControl!: UserAccessControl;
	private logger: ILogger;
	// Extracted service modules
	private attachmentService!: AttachmentService;
	private runnerSelectionService!: RunnerSelectionService;
	private toolPermissionResolver!: ToolPermissionResolver;
	private mcpConfigService!: McpConfigService;
	private runnerConfigBuilder!: RunnerConfigBuilder;
	private activityPoster!: ActivityPoster;
	private configManager!: ConfigManager;
	private promptBuilder!: PromptBuilder;
	private gitHubUsernameResolver!: GitHubUsernameResolver;
	private promptAssembler!: PromptAssembler;
	private defaultSkillsDeployer!: DefaultSkillsDeployer;
	private skillsPluginResolver!: SkillsPluginResolver;
	private cyrusToolsHost!: CyrusToolsHost;
	/** Validates webhook source IPs against known provider allowlists */
	private webhookIpValidator!: WebhookIpValidator;
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
	/** Guards buildCollaborators() against double-construction. */
	private collaboratorsBuilt = false;

	constructor(config: EdgeWorkerConfig) {
		super();
		this.config = normalizeConfigPaths(config);
		this.cyrusHome = config.cyrusHome;
		this.logger = createLogger({ component: "EdgeWorker" });
		// Collaborators are constructed + wired by buildCollaborators(), driven
		// by the composeEdgeWorker() composition root — NOT here. The constructor
		// sets only primitive state, so there is no `new Collaborator()` in the
		// constructor body (Frozen decision #6). A worker built via
		// `new EdgeWorker(config)` alone is intentionally incomplete; always
		// construct through composeEdgeWorker().
	}

	/**
	 * Construct and wire every collaborator onto this worker — the composition
	 * root's build step.
	 *
	 * This is the second half of a two-phase construction: the constructor sets
	 * primitive state (config / cyrusHome / logger + the field-initialized state
	 * maps), then `composeEdgeWorker()` calls this to build the collaborator
	 * graph. Collaborators bind to this worker instance — their dependency
	 * closures read `this.<method>` / `this.<stateMap>` lazily — so they must be
	 * built *after* the instance exists. That is why construction is two-phase
	 * rather than a constructor that accepts a prebuilt collaborator bag.
	 *
	 * @internal Exposed for the composeEdgeWorker() composition root only.
	 *
	 * @param config the raw (un-normalized) config; the body reads it directly
	 *   for the fields that were historically consumed pre-normalization
	 *   (serverPort, linearWorkspaces, repositories, userAccessControl), while
	 *   `this.config` holds the path-normalized copy.
	 */
	buildCollaborators(config: EdgeWorkerConfig): void {
		if (this.collaboratorsBuilt) return;
		this.collaboratorsBuilt = true;
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
		};
		this.repositoryRouter = new RepositoryRouter(repositoryRouterDeps);
		this.gitService = new GitService({ cyrusHome: this.cyrusHome });

		// Initialize AskUserQuestion handler for elicitation via Linear select signal
		this.askUserQuestionHandler = new AskUserQuestionHandler({
			getIssueTracker: (linearWorkspaceId: string) => {
				return this.getIssueTrackerForWorkspace(linearWorkspaceId) ?? null;
			},
			// Re-read per question so config hot-reload takes effect without restart.
			getTimeoutMs: () =>
				questionTimeoutMsFromMinutes(this.config.askUserQuestionTimeoutMinutes),
		});

		// Initialize the webhook/message router. Every dep is a late-bound arrow
		// closure over `this` — CRITICAL: they bind to the heavy-body EdgeWorker
		// methods (initializeAgentRunner via startAgentSession, handleStopSignal,
		// handleGitHubWebhook, ...), NEVER to the thin delegator methods
		// (handleWebhook / handleAgentSessionCreatedWebhook /
		// handleUserPromptedAgentActivity), which would recurse forever.
		// Late binding also lets tests reassign a handler on the instance and have
		// the router pick it up (see EdgeWorker.status-endpoint.test.ts).
		const webhookRouterDeps: WebhookRouterDeps = {
			repositoryRouter: this.repositoryRouter,
			askUserQuestionHandler: this.askUserQuestionHandler,
			isParked: (issueId) => this.parkedRegistry.isParked(issueId),
			getCachedRepositories: (issueId) => this.getCachedRepositories(issueId),
			getRepositoryForSession: (agentSessionId) => {
				const session = this.agentSessionManager.getSession(agentSessionId);
				if (!session) return null;
				const repoId = this.sessionRepositories.get(agentSessionId);
				if (!repoId) return null;
				return this.repositories.get(repoId) ?? null;
			},
			cacheIssueRepositories: (issueId, repoIds) => {
				this.repositoryRouter.getIssueRepositoryCache().set(issueId, repoIds);
			},
			allRepositories: () => Array.from(this.repositories.values()),
			postSessionLostResponse: async (agentSessionId) => {
				await this.agentSessionManager.createResponseActivity(
					agentSessionId,
					"I couldn't process your message because the session configuration was lost. Please create a new session by mentioning me (@cyrus) in a new comment with your prompt.",
				);
			},
			checkUserAccess: (webhook, repo) => this.checkUserAccess(webhook, repo),
			handleBlockedUser: (webhook, repo, reason) =>
				this.handleBlockedUser(webhook, repo, reason),
			checkBlockedByDependencies: (agentSession, linearWorkspaceId) =>
				this.checkBlockedByDependencies(agentSession, linearWorkspaceId),
			parkSession: (
				webhook,
				repositories,
				blockingIssueIds,
				blockingIdentifiers,
				opts,
			) =>
				this.parkAgentSession(
					webhook,
					repositories,
					blockingIssueIds,
					blockingIdentifiers,
					opts,
				),
			startSession: (webhook, repositories, opts) =>
				this.startAgentSession(webhook, repositories, opts),
			continuePromptedActivity: (webhook, repositories) =>
				this.handleNormalPromptedActivity(webhook, repositories),
			stopSession: (webhook) => this.handleStopSignal(webhook),
			handleParkedReprompt: (webhook, issueId) =>
				this.handleParkedSessionReprompt(webhook, issueId),
			handleRepositorySelection: (webhook) =>
				this.handleRepositorySelectionResponse(webhook),
			handleAskUserQuestion: (webhook) =>
				this.handleAskUserQuestionResponse(webhook),
			handleUnassigned: (webhook) => this.handleIssueUnassignedWebhook(webhook),
			handleContentUpdate: (webhook) => this.handleIssueContentUpdate(webhook),
			handleStateChange: (webhook) => this.handleIssueStateChange(webhook),
			handleGitHubComment: (event) => this.handleGitHubWebhook(event),
			handleGitHubPush: (payload) => this.handleGitHubPushWebhook(payload),
			handleIssueTerminal: (message) =>
				this.handleIssueStateChangeMessage(message),
		};
		this.webhookRouter = new WebhookRouter(webhookRouterDeps, this.logger);

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
		const skipTunnel = config.platform === "cli"; // Skip Cloudflare tunnel in CLI mode
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
		);

		// Initialize repositories. Paths are already normalized by
		// `normalizeConfigPaths(config)` above, so use them directly.
		for (const repo of this.config.repositories) {
			if (repo.isActive !== false) {
				this.repositories.set(repo.id, repo);
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
						: new LinearIssueTrackerService(
								new LinearClient({
									accessToken: wsConfig.linearToken,
								}),
								this.buildOAuthConfig(linearWorkspaceId),
							);
				this.issueTrackers.set(linearWorkspaceId, issueTracker);
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

		// Initialize extracted service modules
		this.attachmentService = new AttachmentService(
			this.logger,
			this.cyrusHome,
			this.config.linearWorkspaces || {},
		);
		this.runnerSelectionService = new RunnerSelectionService(this.config);
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
			getCyrusToolsMcpUrl: () => this.cyrusToolsHost.getUrl(),
			createCyrusToolsOptions: (parentSessionId) =>
				this.cyrusToolsHost.createToolsOptions(parentSessionId),
		});
		// The in-process cyrus-tools MCP host. Constructed after McpConfigService
		// so it can consume it for context lookup + auth validation. The
		// getCyrusToolsMcpUrl/createCyrusToolsOptions lambdas above are lazy, so
		// the forward reference here is safe (both directions resolve at
		// request/build time, never during construction).
		// (In Phase G this construction + those two lambdas move into
		// composeEdgeWorker.)
		this.cyrusToolsHost = new CyrusToolsHost({
			getFastifyInstance: () =>
				this.sharedApplicationServer.getFastifyInstance(),
			getPort: () => {
				const s = this.sharedApplicationServer as {
					getPort?: () => number;
				};
				return typeof s.getPort === "function"
					? s.getPort()
					: this.config.serverPort || this.config.webhookPort || 3456;
			},
			mcpConfigService: this.mcpConfigService,
			getAllKnownSessions: () => this.getAllKnownSessions(),
			onChildSessionCreated: (childSessionId, parentSessionId) =>
				this.handleChildSessionMapping(childSessionId, parentSessionId),
			onFeedbackDelivery: (childSessionId, message) =>
				this.handleFeedbackDeliveryToChildSession(childSessionId, message),
			getFailureModesApiKey: () => process.env.CYRUS_API_KEY,
			getFailureModesBaseUrl: () => getCyrusAppUrl(),
		});
		this.runnerConfigBuilder = new RunnerConfigBuilder(
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
		this.gitHubUsernameResolver = new GitHubUsernameResolver(this.logger);
		this.promptBuilder = new PromptBuilder({
			logger: this.logger,
			repositories: this.repositories,
			issueTrackers: this.issueTrackers,
			gitService: this.gitService,
			gitHubUsernameResolver: this.gitHubUsernameResolver,
		});
		this.defaultSkillsDeployer = new DefaultSkillsDeployer(
			this.cyrusHome,
			this.logger,
		);
		this.skillsPluginResolver = new SkillsPluginResolver(
			this.cyrusHome,
			this.logger,
		);
		this.promptAssembler = new PromptAssembler({
			logger: this.logger,
			promptBuilder: this.promptBuilder,
			skillsPluginResolver: this.skillsPluginResolver,
			buildSkillSessionContext: (repo, issue, session) =>
				this.buildSkillSessionContext(repo, issue, session),
		});

		// Session split (Phase F): parked/warm/orchestration state machines.
		// (In Phase G this construction moves to composeEdgeWorker.)
		this.parkedRegistry = new ParkedSessionRegistry();
		// LRU cap over concurrently-warm idle Claude sessions. `0` (default when
		// `claudeMaxWarmIdleSessions` is unset) means unbounded — the keep-alive
		// window alone governs accumulation. Hot-reloaded on `configChanged`.
		this.warmSessionRegistry = new WarmSessionRegistry(
			this.config.claudeMaxWarmIdleSessions ?? 0,
			this.logger,
		);
		this.warmPool = new WarmSessionPool({
			agentSessionManager: this.agentSessionManager,
			// Warm and cold paths share the SAME AccessPolicy compute+adapter so
			// their home-directory denials can't drift (Frozen decision #2).
			accessPolicy: { compute, toClaudeToolPatterns },
			mcpConfigService: this.mcpConfigService,
			skillsPluginResolver: this.skillsPluginResolver,
			gitService: this.gitService,
			logger: this.logger,
			cyrusHome: this.cyrusHome,
			getConfig: () => this.config,
			getRepositoryForSession: (sessionId) => {
				const repoId = this.sessionRepositories.get(sessionId);
				return repoId ? this.repositories.get(repoId) : undefined;
			},
			buildAllowedTools: (repository) => this.buildAllowedTools(repository),
			buildDisallowedTools: (repository) =>
				this.buildDisallowedTools(repository),
		});
		this.sessionOrchestrator = new SessionOrchestrator({
			logger: this.logger,
			cyrusHome: this.cyrusHome,
			agentSessionManager: this.agentSessionManager,
			warmPool: this.warmPool,
			runnerConfigBuilder: this.runnerConfigBuilder,
			skillsPluginResolver: this.skillsPluginResolver,
			gitService: this.gitService,
			promptAssembler: this.promptAssembler,
			getConfig: () => this.config,
			getClaudeSessionStore: () => this.claudeSessionStore,
			getWarmSessionRegistry: () => this.warmSessionRegistry,
			getSandboxSettings: () => this.sdkSandboxSettings ?? undefined,
			getEgressCaCertPath: () => this.egressCaCertPath ?? undefined,
			createCyrusAgentSession: (
				sessionId,
				issue,
				repositories,
				agentSessionManager,
				linearWorkspaceId,
				baseBranchOverrides,
				routingMethod,
			) =>
				this.createCyrusAgentSession(
					sessionId,
					issue,
					repositories,
					agentSessionManager,
					linearWorkspaceId,
					baseBranchOverrides,
					routingMethod,
				),
			buildSessionPrompt: (
				isNewSession,
				session,
				fullIssue,
				repository,
				promptBody,
				attachmentManifest,
				commentAuthor,
				commentTimestamp,
			) =>
				this.buildSessionPrompt(
					isNewSession,
					session,
					fullIssue,
					repository,
					promptBody,
					attachmentManifest,
					commentAuthor,
					commentTimestamp,
				),
			determineSystemPromptFromLabels: (labels, repository) =>
				this.determineSystemPromptFromLabels(labels, repository),
			buildAllowedTools: (repositories, promptType) =>
				this.buildAllowedTools(repositories, promptType),
			buildDisallowedTools: (repositories, promptType) =>
				this.buildDisallowedTools(repositories, promptType),
			buildSkillSessionContext: (repository, fullIssue, session) =>
				this.buildSkillSessionContext(repository, fullIssue, session),
			resolveSkillRepoPaths: (repository, session) =>
				this.resolveSkillRepoPaths(repository, session),
			fetchFullIssueDetails: (issueId, workspaceId) =>
				this.fetchFullIssueDetails(issueId, workspaceId),
			fetchIssueLabels: (issue) => this.fetchIssueLabels(issue),
			createAskUserQuestionCallback: (sid, wid) =>
				this.createAskUserQuestionCallback(sid, wid),
			savePersistedState: () => this.savePersistedState(),
			postInstantAcknowledgment: (sessionId, linearWorkspaceId) =>
				this.postInstantAcknowledgment(sessionId, linearWorkspaceId),
			postSystemPromptSelectionThought: (
				sessionId,
				labels,
				linearWorkspaceId,
				repositoryId,
			) =>
				this.postSystemPromptSelectionThought(
					sessionId,
					labels,
					linearWorkspaceId,
					repositoryId,
				),
			emitSessionStarted: (issueId, issue, repositoryId) => {
				this.emit("session:started", issueId, issue, repositoryId);
				this.config.handlers?.onSessionStart?.(issueId, issue, repositoryId);
			},
			resumeSessionDelegate: (...args) => this.resumeAgentSession(...args),
		});

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

		// Reconcile sessions that were mid-flight when we last shut down. Their
		// in-memory runners are gone, so they'd otherwise linger as zombies that
		// show a working indicator in Linear forever and ignore stop signals.
		await this.reconcileInterruptedSessions();

		// Pre-warm the 30 most recent Claude sessions in the background
		// so their first query after restart has near-zero cold-start latency.
		// Disabled by default; opt in with CYRUS_ENABLE_WARM_SESSIONS=1.
		if (this.warmPool.isEnabled()) {
			this.warmPool.warmup(30).catch((err) => {
				this.logger.warn("Session warmup failed (non-fatal):", err);
			});
		}

		// Start config file watcher via ConfigManager
		this.configManager.on(
			"configChanged",
			async (changes: RepositoryChanges) => {
				this.updateLinearWorkspaceTokens(changes.newConfig);
				await this.removeDeletedRepositories(changes.removed);
				await this.updateModifiedRepositories(changes.modified);
				await this.addNewRepositories(changes.added);
				// Live-update sandbox / egress proxy settings
				await this.applySandboxConfigChanges(changes.newConfig);
				// `changes.newConfig` is reconcile's already-normalized `merged`.
				this.config = changes.newConfig;
				this.configManager.setConfig(changes.newConfig);
				this.runnerSelectionService.setConfig(changes.newConfig);
				this.toolPermissionResolver.setConfig(changes.newConfig);
				// Live-update the warm-idle-session LRU cap; lowering it evicts the
				// now-excess least-recently-used idle sessions immediately.
				this.warmSessionRegistry.setMaxIdleSessions(
					changes.newConfig.claudeMaxWarmIdleSessions ?? 0,
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

		// Start shared application server (this also starts Cloudflare tunnel if CLOUDFLARE_TOKEN is set)
		await this.sharedApplicationServer.start();
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

		// 2. Register the GitHub event transport unconditionally
		// It doesn't require repositories and must be available during onboarding
		// for webhook URL verification to succeed.
		this.registerGitHubEventTransport();

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
		await this.cyrusToolsHost.mount();
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

		// Listen for legacy GitHub webhook events (deprecated, kept for backward compatibility).
		// The WebhookRouter performs the push-vs-comment fan-out; the comment handler
		// (handleGitHubWebhook) owns its own activeWebhookCount shell. Kept
		// fire-and-forget (.catch, not awaited) so a slow handler never blocks the
		// transport.
		this.gitHubEventTransport.on("event", (event: GitHubWebhookEvent) => {
			this.webhookRouter.dispatchGitHubEvent(event).catch((error) => {
				this.logger.error(
					"Failed to handle GitHub webhook",
					error instanceof Error ? error : new Error(String(error)),
				);
			});
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
	): Promise<void> {
		this.activeWebhookCount++;

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

			// Check if another active session is already using this branch/workspace
			const existingSessions =
				agentSessionManager.getActiveSessionsByBranchName(branchRef);
			const firstExisting = existingSessions[0];
			if (firstExisting) {
				this.logger.warn(
					`Reusing workspace from active session ${firstExisting.id} — concurrent writes possible`,
				);
			}

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
			// `GITHUB_DEFAULT_ALLOWED_TOOLS`.
			const allowedTools =
				this.toolPermissionResolver.buildGithubAllowedTools(repository);
			const disallowedTools = this.buildDisallowedTools(repository);
			const allowedDirectories: string[] = [repository.repositoryPath];

			// Create agent runner using the standard config builder
			const { config: runnerConfig, runnerType } =
				await this.sessionOrchestrator.buildAgentRunnerConfig(
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

			const runner = this.sessionOrchestrator.createRunnerForType(
				runnerType,
				runnerConfig,
			);

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

				// When session completes, post the reply back to GitHub
				await this.postGitHubReply(event, runner, repository);
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
			this.activeWebhookCount--;
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

			return await this.gitService.createGitWorktree(
				syntheticIssue,
				[repository],
				{
					crossRepoSiblingRepositories: Array.from(this.repositories.values()),
				},
			);
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
			if (lastAssistantMessage && lastAssistantMessage.type === "assistant") {
				const textBlock = lastAssistantMessage.content.find(
					(block) => block.type === "text" && block.text,
				);
				if (textBlock?.type === "text" && textBlock.text) {
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

		return "idle";
	}

	/**
	 * Public accessor for the shared Fastify-based application server.
	 * Used by F1 to register test-only routes alongside production webhook routes.
	 */
	getSharedApplicationServer(): SharedApplicationServer {
		return this.sharedApplicationServer;
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

		// get all agent runners
		const agentRunners: IAgentRunner[] = [
			...this.agentSessionManager.getAllAgentRunners(),
		];

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
		this.cyrusToolsHost.stop();

		// Stop egress proxy
		if (this.egressProxy) {
			await this.egressProxy.stop();
			this.egressProxy = null;
			this.sdkSandboxSettings = null;
			this.egressCaCertPath = null;
		}

		// Stop shared application server (this also stops Cloudflare tunnel if running)
		await this.sharedApplicationServer.stop();
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
			const oldToken = oldWorkspaces[workspaceId]?.linearToken;
			const newToken = newWsConfig.linearToken;

			if (oldToken === newToken) continue;

			anyTokenChanged = true;

			// Update existing issue tracker in-place
			const issueTracker = this.issueTrackers.get(workspaceId);
			if (issueTracker) {
				(issueTracker as LinearIssueTrackerService).setAccessToken(newToken);
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

				// Paths already normalized by reconcile's normalizeConfigPaths.
				this.repositories.set(repo.id, repo);

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

				// Paths already normalized by reconcile's normalizeConfigPaths.
				this.repositories.set(repo.id, repo);

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
								`  🛑 Stopping session for issue ${session.issue?.id}`,
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
		this.logger.event("webhook_received", {
			source: "linear",
			action: webhookAction,
			type: webhookType,
			repoCount: repos.length,
		});

		// Log verbose webhook info if enabled
		if (process.env.CYRUS_WEBHOOK_DEBUG === "true") {
			this.logger.debug(
				`Full webhook payload:`,
				JSON.stringify(webhook, null, 2),
			);
		}

		try {
			// Route to specific webhook handlers via the WebhookRouter, which owns
			// the type -> handler dispatch table. The counter + try/catch shell
			// stays here so status-endpoint tests observe net-zero activeWebhookCount.
			await this.webhookRouter.dispatch(webhook, repos);
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
	// Linear, GitHub, and other platforms.
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
			// Route via the WebhookRouter's message-bus table. IssueStateChangeMessage
			// is the only type with real behavior; the others are near-no-op debug
			// traces that run in parallel with legacy webhook handlers (see
			// WebhookRouter.dispatchMessage).
			await this.webhookRouter.dispatchMessage(message);
		} catch (error) {
			this.logger.error(
				`Failed to process message: ${message.source}/${message.action}`,
				error,
			);
			// Don't re-throw message processing errors to prevent application crashes
		}
	}

	/**
	 * Handle issue state change message (terminal state reached).
	 * Stops active sessions and deletes worktrees for the issue.
	 */
	private async handleIssueStateChangeMessage(
		message: IssueStateChangeMessage,
	): Promise<void> {
		this.logger.info(
			`[MessageBus] Issue reached terminal state: ${message.workItemIdentifier}`,
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

		// Post a response activity to each stopped session's Linear thread,
		// then remove the session so subsequent prompts don't find stale state.
		for (const session of sessions) {
			await this.agentSessionManager.createResponseActivity(
				session.id,
				`Session stopped — ${message.workItemIdentifier} was marked as Done or Canceled.`,
			);
			this.agentSessionManager.removeSession(session.id);
		}

		// Build the set of repositories involved with this issue so per-repo
		// cyrus-teardown.sh scripts (if present) can run before worktrees are
		// removed. Source-of-truth is the session manager: each session's
		// repositoryId maps to a configured RepositoryConfig.
		const repoIds = new Set<string>();
		for (const session of sessions) {
			const repoId = this.sessionRepositories.get(session.id);
			if (repoId) repoIds.add(repoId);
		}
		const teardownRepositories: RepositoryConfig[] = [];
		for (const repoId of repoIds) {
			const repo = this.repositories.get(repoId);
			if (repo) teardownRepositories.push(repo);
		}

		// Delete worktrees for this issue, keyed by the Linear issue identifier.
		await this.gitService.deleteWorktree(message.workItemIdentifier, {
			repositories: teardownRepositories,
		});

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
				await this.gitService.fetchBlockingIssues(fullIssue);
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

		// Drop this blocker from every parked entry; the registry returns the
		// issue IDs whose blocker list is now empty (ready to wake).
		const sessionsToWake = this.parkedRegistry.resolveBlocker(completedIssueId);

		// Wake up unblocked sessions
		for (const blockedIssueId of sessionsToWake) {
			const parked = this.parkedRegistry.wake(blockedIssueId);
			if (!parked) continue;

			this.logger.info(
				`Waking parked session for issue ${parked.agentSession.issue?.identifier} — all blockers resolved`,
			);

			// Post activity about waking up
			await this.postThought(
				parked.agentSession.id,
				parked.linearWorkspaceId,
				`All blocking dependencies are now resolved — starting work.`,
			);

			// Replay the normal startSession flow
			try {
				await this.sessionOrchestrator.startSession({
					agentSession: parked.agentSession,
					repositories: parked.repositories,
					linearWorkspaceId: parked.linearWorkspaceId,
					guidance: parked.guidance,
					commentBody: parked.commentBody,
					baseBranchOverrides: parked.baseBranchOverrides,
					routingMethod: parked.routingMethod,
				});
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
		const parked = this.parkedRegistry.get(issueId);
		if (!parked) return;

		const blockResult = await this.checkBlockedByDependencies(
			parked.agentSession,
			parked.linearWorkspaceId,
		);

		if (blockResult.blocked) {
			// Still blocked — update the parked entry and re-post status
			this.parkedRegistry.setBlockers(issueId, blockResult.blockingIssueIds);
			const blockerList = blockResult.blockingIdentifiers
				.map((id) => `**${id}**`)
				.join(", ");
			await this.postThought(
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
		this.parkedRegistry.wake(issueId);
		this.logger.info(
			`Re-prompt cleared blockers for ${parked.agentSession.issue?.identifier} — waking session`,
		);

		await this.postThought(
			parked.agentSession.id,
			parked.linearWorkspaceId,
			`Blocking dependencies are now resolved — starting work.`,
		);

		try {
			await this.sessionOrchestrator.startSession({
				agentSession: parked.agentSession,
				repositories: parked.repositories,
				linearWorkspaceId: parked.linearWorkspaceId,
				guidance: parked.guidance,
				commentBody: parked.commentBody,
				baseBranchOverrides: parked.baseBranchOverrides,
				routingMethod: parked.routingMethod,
			});
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
	 * Resolve the activity sink for a workspace, falling back to a no-op sink so
	 * every activity-post call site can funnel through the single
	 * {@link IActivitySink.post} path.
	 */
	private getSinkForWorkspace(workspaceId: string): IActivitySink {
		return (
			this.activitySinks.get(workspaceId) ?? new NoopActivitySink(workspaceId)
		);
	}

	/**
	 * Post an activity through the workspace's sink, swallowing/logging failures
	 * (mirrors the former ActivityPoster wrappers so a tracker error never
	 * aborts the surrounding webhook flow). Returns the activity id or null.
	 */
	private async postActivityViaSink(
		workspaceId: string,
		sessionId: string,
		activity: Activity,
		label: string,
	): Promise<string | null> {
		try {
			const result = await this.getSinkForWorkspace(workspaceId).post(
				sessionId,
				activity,
			);
			return result.activityId ?? null;
		} catch (error) {
			this.logger.error(`Error creating ${label}:`, error);
			return null;
		}
	}

	/**
	 * Post a plain thought through the workspace's activity sink.
	 */
	private async postThought(
		sessionId: string,
		workspaceId: string,
		body: string,
	): Promise<void> {
		await this.postActivityViaSink(
			workspaceId,
			sessionId,
			{ type: "thought", body },
			"thought",
		);
	}

	/**
	 * Get the Linear API token for a workspace from workspace-level config.
	 */
	private getLinearTokenForWorkspace(linearWorkspaceId: string): string | null {
		const workspaceConfig = this.config.linearWorkspaces?.[linearWorkspaceId];
		if (!workspaceConfig) {
			return null; // CLI platform or unconfigured workspace
		}
		return workspaceConfig.linearToken;
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
					onRepoSetupHookEvent: async (event) => {
						await this.postActivityViaSink(
							linearWorkspaceId,
							sessionId,
							formatRepoSetupHookActivity(event),
							"repository setup hook",
						);
					},
				})
			: await this.gitService.createGitWorktree(fullIssue, repositories, {
					baseBranchOverrides,
					crossRepoSiblingRepositories: Array.from(this.repositories.values()),
					onRepoSetupHookEvent: async (event) => {
						await this.postActivityViaSink(
							linearWorkspaceId,
							sessionId,
							formatRepoSetupHookActivity(event),
							"repository setup hook",
						);
					},
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
		}));

		agentSessionManager.createCyrusAgentSession(
			sessionId,
			issue.id,
			issueMinimal,
			workspace,
			"linear",
			repositoryContexts,
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
				...getReadParentDirectories(repositories),
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
	/** @internal - retained as a test-callable delegator; not used internally. */
	async handleAgentSessionCreatedWebhook(
		webhook: AgentSessionCreatedWebhook,
		repos: RepositoryConfig[],
	): Promise<void> {
		// Thin delegator: the cache/route/needs_selection/selected branching and
		// the access/blocked-by/park decision now live in WebhookRouter.
		// Retained (same signature) so tests that call this via (worker as any)
		// keep working. The router's parkSession/startSession deps bind to the
		// heavy bodies below (parkAgentSession / startAgentSession), NOT to this
		// delegator — see the WebhookRouterDeps wiring in the constructor.
		return this.webhookRouter.routeCreatedWebhook(webhook, repos);
	}

	/**
	 * Start a new agent session (heavy body). Bound as WebhookRouterDeps.startSession.
	 */
	private async startAgentSession(
		webhook: AgentSessionCreatedWebhook,
		repositories: RepositoryConfig[],
		opts: { baseBranchOverrides?: Map<string, string>; routingMethod?: string },
	): Promise<void> {
		const { agentSession, guidance } = webhook;
		const commentBody = agentSession.comment?.body;
		const linearWorkspaceId = webhook.organizationId;

		// Initialize agent runner using shared logic (pass full repositories array)
		await this.sessionOrchestrator.startSession({
			agentSession,
			repositories,
			linearWorkspaceId,
			guidance,
			commentBody,
			baseBranchOverrides: opts.baseBranchOverrides,
			routingMethod: opts.routingMethod,
		});
	}

	/**
	 * Park an agent session behind blocked-by dependencies (heavy body).
	 * Bound as WebhookRouterDeps.parkSession — creates no worktree or runner.
	 */
	private async parkAgentSession(
		webhook: AgentSessionCreatedWebhook,
		repositories: RepositoryConfig[],
		blockingIssueIds: string[],
		blockingIdentifiers: string[],
		opts: { baseBranchOverrides?: Map<string, string>; routingMethod?: string },
	): Promise<void> {
		const { agentSession, guidance } = webhook;
		const commentBody = agentSession.comment?.body;
		const linearWorkspaceId = webhook.organizationId;
		const parkedIssueId = agentSession.issue!.id;

		this.parkedRegistry.park(parkedIssueId, {
			agentSession,
			repositories,
			linearWorkspaceId,
			guidance,
			commentBody,
			baseBranchOverrides: opts.baseBranchOverrides,
			routingMethod: opts.routingMethod,
			blockingIssueIds,
		});

		// Post acknowledgment to the Linear agent session
		const blockerList = blockingIdentifiers.map((id) => `**${id}**`).join(", ");
		await this.postThought(
			agentSession.id,
			linearWorkspaceId,
			`Blocked by ${blockerList} — will start automatically when ${blockingIdentifiers.length === 1 ? "it is" : "they are"} resolved.`,
		);

		this.logger.info(
			`Session parked: issue ${agentSession.issue!.identifier} is blocked by ${blockingIdentifiers.join(", ")}`,
		);
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
			this.lastStopTimeBySession.delete(agentSessionId);
			await this.agentSessionManager.createResponseActivity(
				agentSessionId,
				isDoubleStop
					? `I've fully stopped working on ${issueTitle}.\n\n**Stop Signal:** Received from ${senderName} (second stop)\n**Action Taken:** Session terminated`
					: `I've stopped working on ${issueTitle}.\n\n**Stop Signal:** Received from ${senderName}\n**Action Taken:** Session terminated`,
			);
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

		// Initialize agent runner with the selected repository (wrapped in array)
		// routingMethod="user-selected" will be included in the combined routing activity
		// Use organizationId from webhook as the Linear-native workspace ID source
		await this.sessionOrchestrator.startSession({
			agentSession,
			repositories: [repository],
			linearWorkspaceId: webhook.organizationId,
			guidance,
			commentBody,
			baseBranchOverrides: undefined,
			routingMethod: "user-selected",
		});
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
			return;
		}

		if (!webhook.agentActivity) {
			this.logger.warn("Cannot handle prompted activity without agentActivity");
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
	/** @internal - retained as a test-callable delegator; not used internally. */
	async handleUserPromptedAgentActivity(
		webhook: AgentSessionPromptedWebhook,
	): Promise<void> {
		// Thin delegator: the 5-way branch selection (stop / parked / pending
		// selection / ask-question / normal) plus the Branch-3 repo-cache
		// resolution + fallback ladder + access check now live in
		// WebhookRouter.routePromptedActivity. Retained (same signature) so tests
		// that call this via (worker as any) keep working. The router's terminal
		// deps bind to the heavy bodies (handleStopSignal,
		// handleParkedSessionReprompt, handleRepositorySelectionResponse,
		// handleAskUserQuestionResponse, handleNormalPromptedActivity), NOT to
		// this delegator — see the WebhookRouterDeps wiring in the constructor.
		return this.webhookRouter.routePromptedActivity(webhook);
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
	 * Handle Claude session error.
	 *
	 * Thin delegator to {@link SessionOrchestrator.handleSessionError} — retained
	 * (same signature) so existing tests that call `(edgeWorker as any)
	 * .handleClaudeError` keep working until Phase G. TODO(Phase G): delete.
	 * @internal - retained for test compatibility only.
	 */
	async handleClaudeError(
		error: Error,
		sessionId?: string,
		repositoryId?: string,
	): Promise<void> {
		return this.sessionOrchestrator.handleSessionError(
			error,
			sessionId,
			repositoryId,
		);
	}

	/**
	 * Fetch issue labels for a given issue
	 */
	private async fetchIssueLabels(issue: Issue): Promise<string[]> {
		return this.gitService.fetchIssueLabels(issue);
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
	 * - Single-repo / GitHub-mention sessions: the session worktree, which is
	 *   the same path the SDK uses as cwd to load skill definitions.
	 *
	 * The single-repo path MUST be the worktree (`session.workspace.path`), not
	 * `repository.repositoryPath`. Cyrus never advances the base clone's working
	 * tree (it only `git fetch`es and cuts each worktree from `origin/<base>`),
	 * so the base clone is a frozen snapshot from whenever the repo was
	 * registered. Globbing its `.claude/skills/` produces a stale allow-list,
	 * while the SDK loads skill definitions from the fresh worktree — any skill
	 * committed after registration loads but is rejected as "not in this
	 * session's skills allowlist". Keying off the worktree keeps the allow-list
	 * source and the definition source identical. See cyrusagents/cyrus#1336.
	 * (v0.2.66 / #1332 fixed the same base-clone-vs-worktree bug for
	 * cyrus-setup.sh/teardown hooks; skills were missed.)
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
		const worktreePath = session?.workspace?.path;
		if (typeof worktreePath === "string" && worktreePath.length > 0) {
			return [worktreePath];
		}
		return [repository.repositoryPath];
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

	/**
	 * Aggregator over every place active sessions live in this process.
	 * Today: the primary AgentSessionManager (issue sessions). New session
	 * origins should be added here so downstream consumers (currently
	 * CyrusToolsHost.resolveSessionFromCwd, injected via the getAllKnownSessions
	 * callback) keep working without modification — single open extension point
	 * (OCP), single responsibility (SRP: this method's only job is "where do
	 * sessions live?", separate from "how do we match one by cwd?").
	 */
	private getAllKnownSessions(): CyrusAgentSession[] {
		return [...this.agentSessionManager.getAllSessions()];
	}

	private handleChildSessionMapping(
		childSessionId: string,
		parentSessionId: string,
	): void {
		console.log(
			`[EdgeWorker] Agent session created: ${childSessionId}, mapping to parent ${parentSessionId}`,
		);
		this.globalSessionRegistry.setParentSession(
			childSessionId,
			parentSessionId,
		);
		console.log(
			`[EdgeWorker] Parent-child mapping registered in GlobalSessionRegistry`,
		);
	}

	private async handleFeedbackDeliveryToChildSession(
		childSessionId: string,
		message: string,
	): Promise<boolean> {
		console.log(
			`[EdgeWorker] Processing feedback delivery to child session ${childSessionId}`,
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
			console.error(
				`[EdgeWorker] Child session ${childSessionId} not found in any repository`,
			);
			return false;
		}

		// Get the child session
		const childSession = this.agentSessionManager.getSession(childSessionId);
		if (!childSession) {
			console.error(`[EdgeWorker] Child session ${childSessionId} not found`);
			return false;
		}

		console.log(
			`[EdgeWorker] Found child session - Issue: ${childSession.issueId}`,
		);

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

			const activityId = await this.postActivityDirect(
				issueTracker,
				{
					agentSessionId: childSessionId,
					content: { type: "thought", body: feedbackThought },
				},
				"feedback receipt thought",
			);
			if (activityId) {
				console.log(
					`[EdgeWorker] Posted feedback receipt thought for child session ${childSessionId}`,
				);
			}
		}

		const feedbackPrompt = `## Received feedback from orchestrator\n\n---\n\n${message}\n\n---`;

		console.log(
			`[EdgeWorker] Handling feedback delivery to child session ${childSessionId}`,
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
				console.log(
					`[EdgeWorker] Child session ${childSessionId} completed processing feedback`,
				);
			})
			.catch((error) => {
				console.error(
					`[EdgeWorker] Failed to process feedback in child session:`,
					error,
				);
			});

		console.log(
			`[EdgeWorker] Feedback delivered successfully to child session ${childSessionId}`,
		);
		return true;
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
		const assembly = await this.promptAssembler.assemble(input);

		// Log metadata for debugging
		this.logger.debug(
			`Built prompt - components: ${assembly.metadata.components.join(", ")}, type: ${assembly.metadata.promptType}`,
		);

		return assembly.userPrompt;
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
			// Note: We use linearAgentSessionId (from closure) instead of the passed sessionId
			// because the passed sessionId is the Claude session ID, not the Linear agent session ID
			return this.askUserQuestionHandler.handleAskUserQuestion(
				input,
				linearAgentSessionId,
				organizationId,
				signal,
			);
		};
	}

	/**
	 * Build disallowed tools list following the same hierarchy as allowed tools.
	 * Accepts single or multiple repositories (intersection for multi-repo).
	 *
	 * The verbose, rarely-used Linear MCP tools are appended here via
	 * `withLinearMcpPruned` so they are removed from the model's context
	 * (DEV-140). This is the single chokepoint every session path funnels
	 * through (issue, warm-pool, multi-repo), so the prune applies uniformly
	 * regardless of per-repo `disallowedTools` config. The Linear server is
	 * still eager-loaded (`alwaysLoad`, see `McpConfigService`); pruning trims
	 * its ~47-tool surface down to the essentials Cyrus actually uses. The local
	 * `cyrus-tools` server remains available on demand instead of being eager.
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
		return withLinearMcpPruned(
			this.toolPermissionResolver.buildDisallowedTools(
				repositories,
				promptType,
			),
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
	 * After restoring persisted state, transition any session that was still
	 * "working" or "awaiting input" when we shut down to a terminal error
	 * state (its runner did not survive the restart), tell the user, and
	 * persist the correction so it can't resurrect on the next boot.
	 */
	private async reconcileInterruptedSessions(): Promise<void> {
		const interrupted = this.agentSessionManager.markInterruptedSessions();
		if (interrupted.length === 0) {
			return;
		}

		// Best-effort user notice. A restart is not a session error per se — the
		// transcript is preserved and a follow-up comment resumes it — so phrase
		// it as recoverable. Failures here (network, missing sink) must never
		// block startup.
		await Promise.all(
			interrupted.map(async (sessionId) => {
				try {
					await this.agentSessionManager.createErrorActivity(
						sessionId,
						"This session was interrupted when the agent restarted and did not finish. Comment on this issue to resume where it left off.",
					);
				} catch (error) {
					this.logger.warn(
						`Failed to post interruption notice for session ${sessionId}:`,
						error,
					);
				}
			}),
		);

		// Persist the reconciled (Error) statuses so a crash before the next
		// natural save doesn't bring the zombies back.
		await this.savePersistedState();
		this.logger.info(
			`Reconciled ${interrupted.length} interrupted session(s) after restart`,
		);
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
		// Route through the single sink post path. These call sites already have
		// an issue tracker resolved, so wrap it in an ad-hoc LinearActivitySink.
		const { agentSessionId, content, ephemeral, signalMetadata } =
			input as AgentActivityCreateInput & {
				ephemeral?: boolean;
				signalMetadata?: Record<string, unknown>;
			};
		const activity = {
			...(content as unknown as Activity),
			...(ephemeral !== undefined && { ephemeral }),
			...(signalMetadata && { signalMetadata }),
		} as Activity;
		try {
			const result = await new LinearActivitySink(issueTracker, "adhoc").post(
				agentSessionId,
				activity,
			);
			return result.activityId ?? null;
		} catch (error) {
			this.logger.error(`Error creating ${label}:`, error);
			return null;
		}
	}

	/**
	 * Post instant acknowledgment thought when agent session is created
	 */
	private async postInstantAcknowledgment(
		sessionId: string,
		linearWorkspaceId: string,
	): Promise<void> {
		await this.postThought(
			sessionId,
			linearWorkspaceId,
			"I've received your request and I'm starting to work on it. Let me analyze the issue and prepare my approach.",
		);
	}

	/**
	 * Post parent resume acknowledgment thought when parent session is resumed from child
	 */
	private async postParentResumeAcknowledgment(
		sessionId: string,
		linearWorkspaceId: string,
	): Promise<void> {
		await this.postThought(
			sessionId,
			linearWorkspaceId,
			"Resuming from child session",
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
		await this.postActivityViaSink(
			linearWorkspaceId,
			sessionId,
			formatRoutingThought(repoLines, routingMethod),
			"routing",
		);
	}

	/**
	 * Handle prompt with streaming check — thin delegator to
	 * {@link SessionOrchestrator.handlePromptWithStreamingCheck}.
	 *
	 * Retained (same signature) because tests spy this method on the EdgeWorker
	 * instance, and the orchestrator's resume path routes back through this
	 * instance's {@link resumeAgentSession} (via `resumeSessionDelegate`).
	 * TODO(Phase G): delete.
	 *
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
		return this.sessionOrchestrator.handlePromptWithStreamingCheck(
			session,
			repository,
			sessionId,
			agentSessionManager,
			promptBody,
			attachmentManifest,
			isNewSession,
			additionalAllowedDirs,
			logContext,
			linearWorkspaceId,
			commentAuthor,
			commentTimestamp,
		);
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
		const repository = Array.from(this.repositories.values()).find(
			(r) => r.id === repositoryId,
		);
		if (!repository) return;
		const activity = formatLabelRoleThought(labels, repository);
		if (!activity) return;
		await this.postActivityViaSink(
			linearWorkspaceId,
			sessionId,
			activity,
			"system prompt selection",
		);
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
		return this.sessionOrchestrator.resumeSession(
			session,
			repository,
			sessionId,
			agentSessionManager,
			promptBody,
			attachmentManifest,
			isNewSession,
			additionalAllowedDirectories,
			linearWorkspaceId,
			maxTurns,
			commentAuthor,
			commentTimestamp,
		);
	}

	/**
	 * Post instant acknowledgment thought when receiving prompted webhook
	 */
	private async postInstantPromptedAcknowledgment(
		sessionId: string,
		linearWorkspaceId: string,
		isStreaming: boolean,
	): Promise<void> {
		await this.postThought(
			sessionId,
			linearWorkspaceId,
			isStreaming
				? "I've queued up your message as guidance"
				: "Getting started on that...",
		);
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

/**
 * Composition root for the edge worker.
 *
 * Constructs the `EdgeWorker` and wires its collaborator graph. This is the
 * single blessed way to create a worker: the constructor sets only primitive
 * state and does not `new` any collaborator (Frozen decision #6), so a worker
 * produced by `new EdgeWorker(config)` alone is intentionally incomplete —
 * always go through `composeEdgeWorker()`.
 *
 * Construction is two-phase because collaborators bind to the worker instance
 * (their dependency closures read `this.<method>` / `this.<stateMap>` lazily):
 * the instance is created first, then `buildCollaborators(config)` wires the
 * graph against it.
 */
export function composeEdgeWorker(config: EdgeWorkerConfig): EdgeWorker {
	const worker = new EdgeWorker(config);
	worker.buildCollaborators(config);
	return worker;
}
