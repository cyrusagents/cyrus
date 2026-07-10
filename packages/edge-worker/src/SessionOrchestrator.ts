import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
	ClaudeRunnerConfig,
	SandboxSettings,
	SessionStore,
	WarmSessionRegistry,
} from "cyrus-claude-runner";
import { ClaudeRunner } from "cyrus-claude-runner";
import type {
	AgentMessage,
	AgentRunnerConfig,
	AgentSessionCreatedWebhook,
	CyrusAgentSession,
	EdgeWorkerConfig,
	IAgentRunner,
	ILogger,
	Issue,
	RepositoryConfig,
	RunnerType,
} from "cyrus-core";
import {
	DEFAULT_CLAUDE_SESSION_KEEP_ALIVE_MINUTES,
	requireLinearWorkspaceId,
} from "cyrus-core";
import { CursorRunner } from "cyrus-cursor-runner";
import type { AgentSessionManager } from "./AgentSessionManager.js";
import type { GitService } from "./GitService.js";
import type { PromptAssembler } from "./prompt-assembly/PromptAssembler.js";
import type { PromptAssemblyInput } from "./prompt-assembly/types.js";
import type {
	RunnerConfig,
	RunnerConfigBuilder,
} from "./RunnerConfigBuilder.js";
import type {
	SkillSessionContext,
	SkillsPluginResolver,
} from "./SkillsPluginResolver.js";
import type { PromptType } from "./ToolPermissionResolver.js";
import type { AgentSessionData } from "./types.js";
import type { WarmSessionPool } from "./WarmSessionPool.js";

/** System-prompt-from-labels result (subset of PromptBuilder's return). */
export interface SystemPromptResult {
	prompt: string;
	version?: string;
	type?: PromptType;
}

/** Bundle of everything needed to start a fresh session (was the positional param list of `initializeAgentRunner`). */
export interface StartSessionRequest {
	agentSession: AgentSessionCreatedWebhook["agentSession"];
	repositories: RepositoryConfig[];
	linearWorkspaceId: string;
	guidance?: AgentSessionCreatedWebhook["guidance"];
	commentBody?: string | null;
	baseBranchOverrides?: Map<string, string>;
	routingMethod?: string;
}

/**
 * Injected collaborators for {@link SessionOrchestrator}. Prompt assembly
 * (Phase E) and tool derivation (Phase D) still live on EdgeWorker in Phase F,
 * so they are reached through callbacks here. Every callback that wraps an
 * EdgeWorker method is passed as an arrow closure reading `this.<method>` at
 * call time so instance spies in tests intercept correctly.
 */
export interface SessionOrchestratorDeps {
	logger: ILogger;
	cyrusHome: string;
	agentSessionManager: AgentSessionManager;
	warmPool: WarmSessionPool;
	runnerConfigBuilder: RunnerConfigBuilder;
	skillsPluginResolver: SkillsPluginResolver;
	gitService: GitService;
	promptAssembler: PromptAssembler;
	getConfig(): EdgeWorkerConfig;
	getClaudeSessionStore(): SessionStore | null;
	/**
	 * Shared LRU registry bounding concurrently-warm idle Claude sessions.
	 * Forwarded to each Claude runner so it can register/de-register as idle.
	 */
	getWarmSessionRegistry(): WarmSessionRegistry;
	getSandboxSettings(): SandboxSettings | undefined;
	getEgressCaCertPath(): string | undefined;

	createCyrusAgentSession(
		sessionId: string,
		issue: { id: string; identifier: string },
		repositories: RepositoryConfig[],
		agentSessionManager: AgentSessionManager,
		linearWorkspaceId: string,
		baseBranchOverrides?: Map<string, string>,
		routingMethod?: string,
	): Promise<AgentSessionData>;
	buildSessionPrompt(
		isNewSession: boolean,
		session: CyrusAgentSession,
		fullIssue: Issue,
		repository: RepositoryConfig,
		promptBody: string,
		attachmentManifest?: string,
		commentAuthor?: string,
		commentTimestamp?: string,
	): Promise<string>;
	determineSystemPromptFromLabels(
		labels: string[],
		repository: RepositoryConfig,
	): Promise<SystemPromptResult | undefined>;
	buildAllowedTools(
		repositories: RepositoryConfig | RepositoryConfig[],
		promptType?: PromptType,
	): string[];
	buildDisallowedTools(
		repositories: RepositoryConfig | RepositoryConfig[],
		promptType?: PromptType,
	): string[];
	buildSkillSessionContext(
		repository: RepositoryConfig,
		fullIssue?: Issue,
		session?: CyrusAgentSession,
	): SkillSessionContext;
	resolveSkillRepoPaths(
		repository: RepositoryConfig,
		session?: CyrusAgentSession,
	): string[];
	fetchFullIssueDetails(
		issueId: string,
		workspaceId: string,
	): Promise<Issue | null>;
	fetchIssueLabels(issue: Issue): Promise<string[]>;
	createAskUserQuestionCallback(
		linearAgentSessionId: string,
		organizationId: string,
	): AgentRunnerConfig["onAskUserQuestion"];
	savePersistedState(): Promise<void>;
	postInstantAcknowledgment(
		sessionId: string,
		linearWorkspaceId: string,
	): Promise<void>;
	postSystemPromptSelectionThought(
		sessionId: string,
		labels: string[],
		linearWorkspaceId: string,
		repositoryId: string,
	): Promise<void>;
	emitSessionStarted(issueId: string, issue: Issue, repositoryId: string): void;
	/**
	 * Resume delegate. Wired by EdgeWorker to its (spy-able) `resumeAgentSession`
	 * so that {@link SessionOrchestrator.handlePromptWithStreamingCheck}'s resume
	 * path still routes through the EdgeWorker method the tests spy on.
	 */
	resumeSessionDelegate(
		session: CyrusAgentSession,
		repository: RepositoryConfig,
		sessionId: string,
		agentSessionManager: AgentSessionManager,
		promptBody: string,
		attachmentManifest?: string,
		isNewSession?: boolean,
		additionalAllowedDirectories?: string[],
		linearWorkspaceId?: string,
		maxTurns?: number,
		commentAuthor?: string,
		commentTimestamp?: string,
	): Promise<void>;
}

/**
 * Idle keep-alive window in ms, or `undefined` when the session should shut
 * down as soon as its turn ends. Keep-alive is on by default; an explicit `0`
 * in the config opts out (the schema's `??` merge preserves a disk `0`).
 */
function resolveSessionKeepAliveMs(
	config: EdgeWorkerConfig,
): number | undefined {
	const minutes =
		config.claudeSessionKeepAliveMinutes ??
		DEFAULT_CLAUDE_SESSION_KEEP_ALIVE_MINUTES;
	return minutes > 0 ? minutes * 60_000 : undefined;
}

/**
 * Owns agent-session runner creation and message wiring: starting a fresh
 * session, resuming/continuing one, the add-to-stream-vs-resume decision, runner
 * config assembly (incl. onMessage/onError/onAskUserQuestion wiring), and the
 * ClaudeRunner/CursorRunner factory. Extracted out of EdgeWorker; all cross-phase
 * collaborators (prompt assembly, tool derivation, session-state store) are
 * reached through the injected {@link SessionOrchestratorDeps}.
 */
export class SessionOrchestrator {
	/**
	 * In-flight resume chains, keyed by agent session id. Two resumes for one
	 * session must not overlap: `resumeSessionInner` awaits several times (issue
	 * fetch, state save, prompt build) between registering a runner and starting
	 * it, and `stop()` on a runner that has not started yet is a no-op. Overlapping
	 * resumes therefore used to leave two live subprocesses, each re-writing the
	 * whole conversation to the prompt cache. Serializing them lets the second
	 * resume observe the first's running runner and take the streaming fast path.
	 */
	private resumeChains: Map<string, Promise<void>> = new Map();

	constructor(private readonly deps: SessionOrchestratorDeps) {}

	/**
	 * Start a fresh agent runner for an agent session (was
	 * `EdgeWorker.initializeAgentRunner`).
	 */
	async startSession(req: StartSessionRequest): Promise<void> {
		const {
			agentSession,
			repositories,
			linearWorkspaceId,
			guidance,
			commentBody,
			baseBranchOverrides,
			routingMethod,
		} = req;
		const sessionId = agentSession.id;
		const { issue } = agentSession;

		if (!issue) {
			this.deps.logger.warn("Cannot initialize Claude runner without issue");
			return;
		}

		const primaryRepo = repositories[0]!;

		const log = this.deps.logger.withContext({
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

		const agentSessionManager = this.deps.agentSessionManager;

		// Post instant acknowledgment thought
		await this.deps.postInstantAcknowledgment(sessionId, linearWorkspaceId);

		// Create the session using the shared method (pass full repositories array)
		const sessionData = await this.deps.createCyrusAgentSession(
			sessionId,
			issue,
			repositories,
			agentSessionManager,
			linearWorkspaceId,
			baseBranchOverrides,
			routingMethod,
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
		const labels = await this.deps.fetchIssueLabels(fullIssue);

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
			const assembly = await this.deps.promptAssembler.assemble(input);

			// Get systemPromptVersion for tracking (TODO: add to PromptAssembly metadata)
			let systemPromptVersion: string | undefined;
			let promptType: PromptType | undefined;

			if (!isMentionTriggered || isLabelBasedPromptRequested) {
				const systemPromptResult =
					await this.deps.determineSystemPromptFromLabels(labels, primaryRepo);
				systemPromptVersion = systemPromptResult?.version;
				promptType = systemPromptResult?.type;

				// Post thought about system prompt selection
				if (assembly.systemPrompt) {
					await this.deps.postSystemPromptSelectionThought(
						sessionId,
						labels,
						linearWorkspaceId,
						primaryRepo.id,
					);
				}
			}

			// Build allowed tools list with Linear MCP tools (now with prompt type context)
			const allowedTools = this.deps.buildAllowedTools(
				repositories,
				promptType,
			);
			const disallowedTools = this.deps.buildDisallowedTools(
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
					this.deps.buildSkillSessionContext(primaryRepo, fullIssue, session),
				);

			log.debug(
				`Label-based runner selection for new session: ${runnerType} (session ${sessionId})`,
			);

			const runner = this.createRunnerForType(runnerType, runnerConfig);

			// Store runner by comment ID
			agentSessionManager.addAgentRunner(sessionId, runner);

			// Save state after mapping changes
			await this.deps.savePersistedState();

			// Emit events using full issue (core Issue type)
			this.deps.emitSessionStarted(fullIssue.id, fullIssue, primaryRepo.id);

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
			// is received via handleSessionMessage() callback
		} catch (error) {
			log.error(`Error in prompt building/starting:`, error);
			throw error;
		}
	}

	/**
	 * Resume or create an agent session with the given prompt (was
	 * `EdgeWorker.resumeAgentSession`). Positional signature is preserved 1:1 so
	 * the EdgeWorker delegator is a straight forward.
	 *
	 * Resumes for the same session run one at a time; see {@link resumeChains}.
	 */
	async resumeSession(
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
		const prev = this.resumeChains.get(sessionId) ?? Promise.resolve();
		const next = prev.then(() =>
			this.resumeSessionInner(
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
			),
		);
		// Swallow errors in the stored chain so one failed resume does not reject
		// every later resume for this session; `next` still rejects for the caller.
		const chained = next.catch(() => undefined);
		this.resumeChains.set(sessionId, chained);
		// Drop the entry once this resume is the last one queued, so the map does
		// not grow with every session the worker has ever handled.
		void chained.then(() => {
			if (this.resumeChains.get(sessionId) === chained) {
				this.resumeChains.delete(sessionId);
			}
		});
		return next;
	}

	/**
	 * Actual resume implementation. Invoked only via the per-session chain in
	 * {@link resumeSession} so at most one runs for a given session at a time.
	 */
	private async resumeSessionInner(
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
		const log = this.deps.logger.withContext({ sessionId });
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
			let appended = false;
			try {
				existingRunner.addStreamMessage(fullPrompt);
				appended = true;
			} catch (error) {
				log.warn(
					`Streaming message rejected for ${sessionId}; falling back to resume`,
					{ error: error instanceof Error ? error.message : String(error) },
				);
			}
			if (appended) {
				// Kept outside the catch: a status-update failure must not be
				// mistaken for a rejected message and trigger a needless resume.
				await agentSessionManager.markSessionActive(sessionId);
				return;
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
		const fullIssue = await this.deps.fetchFullIssueDetails(
			issueIdForResume,
			resolvedWorkspaceId,
		);
		if (!fullIssue) {
			log.error(`Failed to fetch full issue details for ${issueIdForResume}`);
			throw new Error(
				`Failed to fetch full issue details for ${issueIdForResume}`,
			);
		}

		// Fetch issue labels early to determine runner type
		const labels = await this.deps.fetchIssueLabels(fullIssue);

		// Determine whether to resume based on the existing runner session ID
		// (Claude or Cursor — whichever originally created the session).
		const existingRunnerSessionId =
			session.claudeSessionId ?? session.cursorSessionId;
		const hasExistingSession =
			!isNewSession && Boolean(existingRunnerSessionId);
		const needsNewSession = isNewSession || !hasExistingSession;

		// Fetch system prompt based on labels

		const systemPromptResult = await this.deps.determineSystemPromptFromLabels(
			labels,
			repository,
		);
		const systemPrompt = systemPromptResult?.prompt;
		const promptType = systemPromptResult?.type;

		// Build allowed and disallowed tools lists
		const allowedTools = this.deps.buildAllowedTools(repository, promptType);
		const disallowedTools = this.deps.buildDisallowedTools(
			repository,
			promptType,
		);

		// Set up attachments directory
		const workspaceFolderName = basename(session.workspace.path);
		const attachmentsDir = join(
			this.deps.cyrusHome,
			workspaceFolderName,
			"attachments",
		);
		await mkdir(attachmentsDir, { recursive: true });

		const allowedDirectories = [
			...new Set([
				attachmentsDir,
				repository.repositoryPath,
				...additionalAllowedDirectories,
				...this.deps.gitService.getGitMetadataDirectoriesForWorkspace(
					session.workspace,
				),
			]),
		];

		const resumeSessionId = needsNewSession
			? undefined
			: existingRunnerSessionId;

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
				this.deps.buildSkillSessionContext(repository, fullIssue, session),
			);

		// Create the appropriate runner based on session state
		const runner = this.createRunnerForType(runnerType, runnerConfig);

		// Store runner
		agentSessionManager.addAgentRunner(sessionId, runner);

		// Save state
		await this.deps.savePersistedState();

		// Prepare the full prompt
		const fullPrompt = await this.deps.buildSessionPrompt(
			isNewSession,
			session,
			fullIssue,
			repository,
			promptBody,
			attachmentManifest,
			commentAuthor,
			commentTimestamp,
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
			throw error;
		}
	}

	/**
	 * Handle a prompt: append to an active stream when possible, otherwise resume
	 * (was `EdgeWorker.handlePromptWithStreamingCheck`). Returns `true` when the
	 * message was added to the stream, `false` when the session was resumed.
	 */
	async handlePromptWithStreamingCheck(
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
		const log = this.deps.logger.withContext({ sessionId });
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
			// race window between "still running" and "turn finished". Fall
			// through to the resume path so the comment is never dropped. Claude's
			// streaming input never throws here, so this is effectively a no-op.
			let appended = false;
			try {
				existingRunner.addStreamMessage(fullPrompt);
				appended = true;
			} catch (error) {
				log.warn(
					`Streaming message rejected for ${sessionId}; falling back to resume (${logContext})`,
					{ error: error instanceof Error ? error.message : String(error) },
				);
			}
			if (appended) {
				// The turn may have completed the session while the runner idled
				// warm; it is working again. Kept outside the catch above so a
				// status-update failure is never mistaken for a rejected message.
				await agentSessionManager.markSessionActive(sessionId);
				return true; // Message added to stream
			}
		}

		// Not streaming (or streaming was rejected) - resume/start session
		log.debug(`Resuming Claude session for ${sessionId} (${logContext})`);

		await this.deps.resumeSessionDelegate(
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
	 * Build agent runner configuration with common settings (was
	 * `EdgeWorker.buildAgentRunnerConfig`). Delegates to RunnerConfigBuilder for
	 * shared config assembly and attaches a pre-warmed session when available.
	 */
	async buildAgentRunnerConfig(
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
		sessionPlatform: "linear" | "github" = "linear",
	): Promise<{ config: RunnerConfig; runnerType: RunnerType }> {
		const log = this.deps.logger.withContext({
			sessionId,
			platform: session.issueContext?.trackerId,
			issueIdentifier: session.issueContext?.issueIdentifier,
		});

		// Resolve plugins once so we can also derive the per-session scoped
		// skill allow-list from the same filesystem snapshot.
		const plugins = await this.deps.skillsPluginResolver.resolve();
		const resolvedSkillContext: SkillSessionContext = skillContext ?? {
			repositoryId: repository.id,
			repoPaths: this.deps.resolveSkillRepoPaths(repository, session),
		};
		const allowedSkillNames =
			await this.deps.skillsPluginResolver.discoverSkillNames(
				plugins,
				resolvedSkillContext,
			);

		const config = this.deps.getConfig();
		const result = this.deps.runnerConfigBuilder.buildIssueConfig({
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
			// Global early auto-compaction window (Claude runner only). Caps the
			// per-turn re-read context tax on long multi-subroutine sessions by
			// forcing the SDK to compact well before the model's full window.
			autoCompactWindow: config.claudeAutoCompactWindow,
			// Idle keep-alive window (Claude runner only). Keeps a finished session
			// alive briefly so a follow-up comment appends to the live conversation
			// rather than resuming — a resume re-writes the whole transcript to the
			// prompt cache. On by default; `0` opts out.
			sessionKeepAliveMs: resolveSessionKeepAliveMs(config),
			// Shared LRU registry that caps concurrently-warm idle sessions. The
			// cap itself lives on the registry (hot-reloaded on config change);
			// the runner only needs the reference to register itself as idle.
			warmSessionRegistry: this.deps.getWarmSessionRegistry(),
			// Per-platform MCP config paths — GitHub gets the `githubMcpConfigs`
			// knob (single-repo PR contexts); Linear gets `linearMcpConfigs`.
			// Not a blanket override: the builder uses `repository.mcpConfigPath`
			// when this repo has its own `allowedTools` override (so the repo's
			// permission rules and MCP server set travel as a unit), and only
			// falls through to this list when the repo inherits the platform
			// allow-list.
			platformMcpConfigOverrides:
				sessionPlatform === "linear"
					? config.linearMcpConfigs
					: config.githubMcpConfigs,
			linearWorkspaceId,
			cyrusHome: this.deps.cyrusHome,
			logger: log,
			plugins,
			skills: allowedSkillNames,
			sandboxSettings: this.deps.getSandboxSettings(),
			egressCaCertPath: this.deps.getEgressCaCertPath(),
			onMessage: (message: AgentMessage) => {
				this.handleSessionMessage(sessionId, message);
			},
			onError: (error: Error) =>
				this.handleSessionError(error, sessionId, repository.id),
			createAskUserQuestionCallback: (sid, wid) =>
				this.deps.createAskUserQuestionCallback(sid, wid)!,
			requireLinearWorkspaceId,
		});

		// Attach pre-warmed session if available (only for Claude runner).
		// acquireWarm is a no-op (returns undefined) when warm sessions are
		// disabled or no slot exists.
		const warm = this.deps.warmPool.acquireWarm(sessionId);
		if (result.runnerType === "claude" && warm) {
			(result.config as ClaudeRunnerConfig).warmSession = warm;
			log.debug("Attaching pre-warmed session to runner config");
		}

		return result;
	}

	/**
	 * Instantiate the appropriate runner for the given type (was
	 * `EdgeWorker.createRunnerForType`).
	 */
	createRunnerForType(
		runnerType: RunnerType,
		config: RunnerConfig,
	): IAgentRunner {
		switch (runnerType) {
			case "claude": {
				// Inject the hosted SessionStore at the last moment so it only
				// attaches to Claude runners (the field is Claude-specific).
				const store = this.deps.getClaudeSessionStore();
				const claudeConfig: ClaudeRunnerConfig = store
					? { ...config, sessionStore: store }
					: config;
				return new ClaudeRunner(claudeConfig, this.deps.warmPool.isEnabled());
			}
			case "cursor":
				return new CursorRunner(config);
			default:
				throw new Error(`Unknown runner type: ${runnerType satisfies never}`);
		}
	}

	/** onMessage wiring target — forwards to AgentSessionManager ingestion. */
	async handleSessionMessage(
		sessionId: string,
		message: AgentMessage,
	): Promise<void> {
		await this.deps.agentSessionManager.handleClaudeMessage(sessionId, message);
	}

	/**
	 * onError wiring target (was `EdgeWorker.handleClaudeError`). Silently ignores
	 * AbortError (user-initiated stop) and graceful SIGTERM; for a genuine crash
	 * it surfaces the failure to the tracker, reclaims the warm slot, and persists
	 * the terminal transition.
	 */
	async handleSessionError(
		error: Error,
		sessionId?: string,
		repositoryId?: string,
	): Promise<void> {
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
		this.deps.logger.error("Unhandled claude error:", {
			error,
			sessionId,
			repositoryId,
		});

		// A genuine runner crash (subprocess died, stream errored, non-143 exit)
		// never produces a `result` message, so `completeSession` never runs.
		// Without surfacing it here the Linear issue stays "In Progress" with a
		// dead runner and the user sees nothing. When we know which session
		// crashed, tell the user and transition it to a terminal error state.
		if (!sessionId) {
			return;
		}
		try {
			await this.deps.agentSessionManager.failSession(
				sessionId,
				`The agent session ended unexpectedly and could not continue.\n\n\`${error.message}\`\n\nComment on this issue to start a new session.`,
			);
		} catch (failError) {
			this.deps.logger.error(
				"Failed to surface runner crash to Linear:",
				failError,
			);
		}

		// Reclaim the pre-warmed slot so a crashed session doesn't leak a warm
		// instance or hand a stale one to a later resume.
		this.deps.warmPool.release(sessionId);

		// Persist the Error transition so a restart doesn't resurrect a zombie
		// Active session with no runner.
		await this.deps.savePersistedState();
	}
}
