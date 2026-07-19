import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
	ClaudeRunnerConfig,
	SandboxSettings,
	SessionStore,
	WarmSessionRegistry,
} from "cyrus-claude-runner";
import { ClaudeRunner } from "cyrus-claude-runner";
import { CodexRunner } from "cyrus-codex-runner";
import type {
	AgentActivityCreateInput,
	AgentMessage,
	AgentRunnerConfig,
	AgentSessionCreatedWebhook,
	CyrusAgentSession,
	EdgeWorkerConfig,
	EffortLevel,
	IAgentRunner,
	IIssueTrackerService,
	ILogger,
	Issue,
	IssueMinimal,
	RepositoryConfig,
	RunnerType,
} from "cyrus-core";
import {
	DEFAULT_CLAUDE_SESSION_KEEP_ALIVE_MINUTES,
	getReadParentDirectories,
	requireLinearWorkspaceId,
} from "cyrus-core";
import { CursorRunner } from "cyrus-cursor-runner";
import type {
	GitHubAppTokenProvider,
	GitHubCommentService,
	GitHubCommentWebhookEvent,
	GitHubWebhookEvent,
} from "cyrus-github-event-transport";
import {
	extractCommentId,
	extractPRNumber,
	extractRepoFullName,
	extractRepoName,
	extractRepoOwner,
} from "cyrus-github-event-transport";
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
import type { IActivitySink } from "./sinks/IActivitySink.js";
import type { PromptType } from "./ToolPermissionResolver.js";
import type { AgentSessionData } from "./types.js";
import type { WarmSessionPool } from "./WarmSessionPool.js";

/** System-prompt-from-labels result (subset of PromptBuilder's return). */
export interface SystemPromptResult {
	prompt: string;
	version?: string;
	type?: PromptType;
	/** Model requested by the matched label-prompt config (complex form). */
	model?: string;
	/** Reasoning effort requested by the matched label-prompt config (Claude-only). */
	effort?: EffortLevel;
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

/** Bundle of everything the GitHub acting spine needs (was the tail of `EdgeWorker.handleGitHubWebhook`). */
export interface StartGitHubSessionRequest {
	event: GitHubCommentWebhookEvent;
	repository: RepositoryConfig;
	workspace: { path: string; isGitWorktree: boolean };
	branchRef: string;
	baseBranchRef: string | null;
	prNumber: number;
	sessionKey: string;
	prTitle: string | null;
	taskInstructions: string;
	systemPrompt: string;
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
		previousSessionSummary?: string,
	): Promise<string>;
	/**
	 * Cold-resume summarize-and-restart hook. When a Claude session is resumed
	 * after its keep-alive window and the stored transcript is estimated to be
	 * larger than `claudeColdResumeSummarizeThresholdTokens`, this summarizes the
	 * prior transcript with a one-shot Haiku call and returns the summary so the
	 * caller can start a fresh session seeded with it instead of replaying the
	 * whole transcript into the prompt cache. Returns `undefined` when the
	 * feature is disabled, not applicable, or on any failure (so the caller falls
	 * through to a normal resume — this must never break a resume that would
	 * otherwise succeed). Never clears `session.claudeSessionId`.
	 */
	maybeSummarizeColdResume(
		session: CyrusAgentSession,
		linearAgentSessionId: string,
		claudeSessionId: string,
		linearWorkspaceId: string,
	): Promise<string | undefined>;
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
	/** Collapses the two-step session-id -> repo-id -> repo lookup used to resolve a session's repository. */
	getRepositoryForSession(sessionId: string): RepositoryConfig | undefined;
	getIssueTracker(workspaceId: string): IIssueTrackerService | undefined;
	/**
	 * Post the "Resuming from child session" acknowledgment thought. Kept on
	 * EdgeWorker (it routes through postThought/sink) and exposed as a callback,
	 * mirroring {@link SessionOrchestratorDeps.postInstantAcknowledgment}.
	 */
	postParentResumeAcknowledgment(
		sessionId: string,
		linearWorkspaceId: string,
	): Promise<void>;
	/**
	 * Post an activity directly via an ad-hoc `LinearActivitySink`. Kept on
	 * EdgeWorker (it owns the sink wrap + error logging) and exposed as a callback.
	 */
	postActivityDirect(
		issueTracker: IIssueTrackerService,
		input: AgentActivityCreateInput,
		label: string,
	): Promise<string | null>;
	/**
	 * Getter (not a snapshot) — the App token provider is assigned lazily at
	 * runtime once GitHub App credentials are configured, so a value captured
	 * at construction time would always be null.
	 */
	getGitHubAppTokenProvider(): GitHubAppTokenProvider | null;
	getAllRepositories(): RepositoryConfig[];
	/** Assigned before the orchestrator is constructed; threaded as a direct field (not a getter). */
	gitHubCommentService: GitHubCommentService;
	setSessionRepository(sessionId: string, repositoryId: string): void;
	getActivitySinkForRepo(repositoryId: string): IActivitySink | undefined;
	buildGithubAllowedTools(repository: RepositoryConfig): string[];
	/**
	 * Raw-emit only — unlike {@link SessionOrchestratorDeps.emitSessionStarted},
	 * this MUST NOT also invoke `config.handlers.onSessionStart`. The GitHub
	 * acting spine has always emitted the event alone; reusing the Linear
	 * `emitSessionStarted` dep here would silently add a handler invocation
	 * for GitHub sessions.
	 */
	emitGitHubSessionStarted(
		issueId: string,
		issue: Issue,
		repositoryId: string,
	): void;
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
 * Range the Claude CLI accepts for `settings.autoCompactWindow`. Its own schema
 * is `number().int().min(1e5).max(1e6).catch(undefined)` — a value outside this
 * range fails validation and is **silently discarded**, so the session compacts
 * at the model's native window as if the setting had never been passed.
 * Verified empirically: a 40000 window let a Sonnet session reach 154k tokens
 * without compacting, while 100000 compacted it at 70k.
 */
const MIN_AUTO_COMPACT_WINDOW = 100_000;
const MAX_AUTO_COMPACT_WINDOW = 1_000_000;

/**
 * Drop an out-of-range auto-compaction window, loudly. The SDK would drop it
 * silently, leaving an operator to believe a knob is capping context cost when
 * it is doing nothing at all.
 */
export function resolveAutoCompactWindow(
	window: number | undefined,
	logger: ILogger,
): number | undefined {
	if (window === undefined) return undefined;
	if (window < MIN_AUTO_COMPACT_WINDOW || window > MAX_AUTO_COMPACT_WINDOW) {
		logger.warn(
			`Ignoring claudeAutoCompactWindow=${window}: the Claude SDK only accepts ` +
				`${MIN_AUTO_COMPACT_WINDOW}–${MAX_AUTO_COMPACT_WINDOW} and silently discards ` +
				`anything else, so sessions would compact at the model's native window.`,
		);
		return undefined;
	}
	return window;
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
		const isMentionTriggered = Boolean(
			commentBody && !commentBody.includes(AGENT_SESSION_MARKER),
		);
		const userComment = isMentionTriggered ? (commentBody ?? "") : "";
		// Check if the comment contains the /label-based-prompt command
		const isLabelBasedPromptRequested = commentBody?.includes(
			"/label-based-prompt",
		);

		const agentSessionManager = this.deps.agentSessionManager;

		// Post instant acknowledgment thought. Fire-and-forget: it swallows its
		// own errors internally and nothing downstream depends on it, so there
		// is no reason to block session creation on the round-trip.
		void this.deps
			.postInstantAcknowledgment(sessionId, linearWorkspaceId)
			.catch((error) => {
				log.warn(`Instant acknowledgment failed: ${(error as Error).message}`);
			});

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
			// Labels were fetched during session creation (overlapped with workspace
			// provisioning) and are needed here for system prompt and runner selection.
			labels,
		} = sessionData;

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
				userComment,
				attachmentManifest: attachmentResult.manifest,
				guidance: guidance || undefined,
				agentSession,
				labels,
				isNewSession: true,
				isStreaming: false, // Not yet streaming
				isMentionTriggered,
				isLabelBasedPromptRequested: isLabelBasedPromptRequested || false,
				resolvedBaseBranches: sessionData.workspace.resolvedBaseBranches,
				linearWorkspaceId,
			};

			// Use unified prompt assembly
			const assembly = await this.deps.promptAssembler.assemble(input);

			// Get systemPromptVersion for tracking (TODO: add to PromptAssembly metadata)
			let systemPromptVersion: string | undefined;
			let promptType: PromptType | undefined;
			// Model/effort a matched label-prompt requests. Undefined for
			// mention-triggered sessions that skip label routing.
			let labelPromptModel: string | undefined;
			let labelPromptEffort: EffortLevel | undefined;

			if (!isMentionTriggered || isLabelBasedPromptRequested) {
				const systemPromptResult =
					await this.deps.determineSystemPromptFromLabels(labels, primaryRepo);
				systemPromptVersion = systemPromptResult?.version;
				promptType = systemPromptResult?.type;
				labelPromptModel = systemPromptResult?.model;
				labelPromptEffort = systemPromptResult?.effort;

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

			// Reasoning effort precedence: label-prompt → repository → global
			// default. Undefined preserves the SDK default (`high`). Claude-only;
			// the config builder guards it per runner type.
			const effort =
				labelPromptEffort ??
				primaryRepo.effort ??
				this.deps.getConfig().claudeDefaultEffort;

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
					labelPromptModel, // Label-prompt model → selector precedence
					effort, // Resolved reasoning effort (Claude-only)
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
		// (Claude, Cursor, or Codex — whichever originally created the session).
		const existingRunnerSessionId =
			session.claudeSessionId ??
			session.cursorSessionId ??
			session.codexSessionId;
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
		const labelPromptModel = systemPromptResult?.model;
		// Reasoning effort precedence: label-prompt → repository → global default.
		// Undefined preserves the SDK default (`high`). Claude-only.
		const effort =
			systemPromptResult?.effort ??
			repository.effort ??
			this.deps.getConfig().claudeDefaultEffort;

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
				// Opt-in read-only access to the repo's parent directory (sibling
				// folders). Routed through the shared helper so resumed/follow-up
				// sessions get the SAME read scope as fresh ones — no drift.
				...getReadParentDirectories([repository]),
				...additionalAllowedDirectories,
				...this.deps.gitService.getGitMetadataDirectoriesForWorkspace(
					session.workspace,
				),
			]),
		];

		const resumeSessionId = needsNewSession
			? undefined
			: existingRunnerSessionId;

		// Cold-resume summarize-and-restart: when we would resume a Claude session
		// whose stored transcript is too large, replace the full-transcript resume
		// with a Haiku summary + fresh session. `maybeSummarizeColdResume` returns
		// undefined (falling through to a normal resume) unless the feature is
		// enabled, this is a Claude resume, and the transcript exceeds the
		// configured threshold. It NEVER clears `session.claudeSessionId` — runner
		// pinning and the init-message rebind both still depend on it being set.
		let effectiveResumeSessionId = resumeSessionId;
		let buildAsNewSession = isNewSession;
		let previousSessionSummary: string | undefined;
		if (
			!needsNewSession &&
			session.claudeSessionId &&
			resumeSessionId === session.claudeSessionId
		) {
			const summary = await this.deps.maybeSummarizeColdResume(
				session,
				sessionId,
				session.claudeSessionId,
				resolvedWorkspaceId,
			);
			if (summary) {
				effectiveResumeSessionId = undefined;
				buildAsNewSession = true;
				previousSessionSummary = summary;
			}
		}

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
				effectiveResumeSessionId,
				labels, // Always pass labels to preserve model override
				fullIssue.description || undefined, // Description tags can override label selectors
				maxTurns, // Pass maxTurns if specified
				resolvedWorkspaceId,
				this.deps.buildSkillSessionContext(repository, fullIssue, session),
				labelPromptModel, // Label-prompt model → selector precedence
				effort, // Resolved reasoning effort (Claude-only)
			);

		// Create the appropriate runner based on session state
		const runner = this.createRunnerForType(runnerType, runnerConfig);

		// Store runner
		agentSessionManager.addAgentRunner(sessionId, runner);

		// Save state
		await this.deps.savePersistedState();

		// Prepare the full prompt
		const fullPrompt = await this.deps.buildSessionPrompt(
			buildAsNewSession,
			session,
			fullIssue,
			repository,
			promptBody,
			attachmentManifest,
			commentAuthor,
			commentTimestamp,
			previousSessionSummary,
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
	 * Handle resuming a parent session when a child session completes
	 * This is the core logic used by the resume parent session callback
	 * Extracted to reduce duplication between constructor and addNewRepositories
	 */
	async handleResumeParentSession(
		parentSessionId: string,
		prompt: string,
		childSessionId: string,
	): Promise<void> {
		const log = this.deps.logger.withContext({ sessionId: parentSessionId });
		log.info(
			`Child session completed, resuming parent session ${parentSessionId}`,
		);

		// Find parent session from the single session manager
		log.debug(`Looking up parent session ${parentSessionId}`);
		const parentSession =
			this.deps.agentSessionManager.getSession(parentSessionId);
		const parentRepo = this.deps.getRepositoryForSession(parentSessionId);
		const parentAgentSessionManager = this.deps.agentSessionManager;

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
		const childSession =
			this.deps.agentSessionManager.getSession(childSessionId);
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

		await this.deps.postParentResumeAcknowledgment(
			parentSessionId,
			parentWorkspaceId,
		);

		// Post thought showing child result receipt
		// Use parent's issue tracker since we're posting to the parent's session
		const issueTracker = this.deps.getIssueTracker(parentWorkspaceId);
		if (issueTracker && childSession) {
			const childIssueIdentifier =
				childSession.issue?.identifier || childSession.issueId;
			const resultThought = `Received result from sub-issue ${childIssueIdentifier}:\n\n---\n\n${prompt}\n\n---`;

			await this.deps.postActivityDirect(
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
		 * Model from the matched label-prompt config (complex form's `model`).
		 * Forwarded to the runner-selection service as one model-precedence input;
		 * the service — not this method — resolves the final model.
		 */
		labelPromptModel?: string,
		/**
		 * Resolved reasoning effort (label-prompt → repository → `claudeDefaultEffort`).
		 * Claude runner only; ignored for Cursor/Codex.
		 */
		effort?: EffortLevel,
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
			// Label-prompt model, folded into model precedence by the selector.
			labelPromptModel,
			// Resolved reasoning effort (Claude runner only; the builder guards it).
			effort,
			maxTurns,
			// Global early auto-compaction window (Claude runner only). Caps the
			// per-turn re-read context tax on long multi-subroutine sessions by
			// forcing the SDK to compact well before the model's full window.
			autoCompactWindow: resolveAutoCompactWindow(
				config.claudeAutoCompactWindow,
				this.deps.logger,
			),
			// Tool-output caps (Claude runner only). Bound how much a single
			// oversized Bash/MCP result can bloat the transcript — and every
			// subsequent prompt-cache write. Unset preserves the CLI defaults.
			bashMaxOutputLength: config.claudeBashMaxOutputLength,
			mcpMaxOutputTokens: config.claudeMcpMaxOutputTokens,
			// Model for the read-only `explore` subagent (Claude runner only).
			// Unset registers no such agent, so delegation keeps inheriting the
			// session model — today's behavior.
			subagentModel: config.claudeSubagentModel,
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
			case "codex":
				return new CodexRunner(config);
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

	/**
	 * Resolve a GitHub API token from (in priority order):
	 * 1. Forwarded installation token from CYHOST (cloud/proxy mode)
	 * 2. Self-minted installation token from GitHub App credentials (self-hosted)
	 * 3. Personal access token from GITHUB_TOKEN env var (fallback)
	 */
	async resolveGitHubToken(
		event: GitHubWebhookEvent,
	): Promise<string | undefined> {
		if (event.installationToken) return event.installationToken;
		const gitHubAppTokenProvider = this.deps.getGitHubAppTokenProvider();
		if (gitHubAppTokenProvider) {
			try {
				return await gitHubAppTokenProvider.getToken();
			} catch (error) {
				this.deps.logger.warn(
					"Failed to mint GitHub App installation token, falling back to GITHUB_TOKEN",
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		}
		return process.env.GITHUB_TOKEN;
	}

	/**
	 * Create a git worktree for a GitHub PR branch.
	 * If the worktree already exists for this branch, reuse it.
	 */
	async createGitHubWorkspace(
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

			return await this.deps.gitService.createGitWorktree(
				syntheticIssue,
				[repository],
				{
					crossRepoSiblingRepositories: this.deps.getAllRepositories(),
				},
			);
		} catch (error) {
			this.deps.logger.error(
				`Failed to create GitHub workspace for PR #${prNumber}`,
				error instanceof Error ? error : new Error(String(error)),
			);
			return null;
		}
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
				this.deps.logger.warn("Cannot post GitHub reply: no PR number");
				return;
			}

			// Resolve GitHub token (installation token > App token > PAT)
			const token = await this.resolveGitHubToken(event);
			if (!token) {
				this.deps.logger.warn(
					"Cannot post GitHub reply: no installation token or GITHUB_TOKEN configured",
				);
				this.deps.logger.debug(
					`Would have posted reply to ${owner}/${repo}#${prNumber} (comment ${commentId}): ${summary}`,
				);
				return;
			}

			if (event.eventType === "pull_request_review_comment") {
				// Reply to the specific review comment thread
				await this.deps.gitHubCommentService.postReviewCommentReply({
					token,
					owner,
					repo,
					pullNumber: prNumber,
					commentId,
					body: summary,
				});
			} else {
				// Post as a regular issue comment on the PR
				await this.deps.gitHubCommentService.postIssueComment({
					token,
					owner,
					repo,
					issueNumber: prNumber,
					body: summary,
				});
			}

			this.deps.logger.info(
				`Posted GitHub reply to ${owner}/${repo}#${prNumber}`,
			);
		} catch (error) {
			this.deps.logger.error(
				"Failed to post GitHub reply",
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	/**
	 * The GitHub acting spine (was the tail of `EdgeWorker.handleGitHubWebhook`):
	 * create a synthetic internal agent session for the PR, register the
	 * session->repo mapping and activity sink, derive GitHub allowed/disallowed
	 * tools, build and start the runner, then post the reply back to GitHub
	 * once the session completes.
	 */
	async startGitHubSession(req: StartGitHubSessionRequest): Promise<void> {
		const {
			event,
			repository,
			workspace,
			branchRef,
			baseBranchRef,
			prNumber,
			sessionKey,
			prTitle,
			taskInstructions,
			systemPrompt,
		} = req;
		const agentSessionManager = this.deps.agentSessionManager;
		const repoFullName = extractRepoFullName(event);

		// Check if another active session is already using this branch/workspace
		const existingSessions =
			agentSessionManager.getActiveSessionsByBranchName(branchRef);
		const firstExisting = existingSessions[0];
		if (firstExisting) {
			this.deps.logger.warn(
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
		this.deps.setSessionRepository(githubSessionId, repository.id);
		const activitySink = this.deps.getActivitySinkForRepo(repository.id);
		if (activitySink) {
			agentSessionManager.setActivitySink(githubSessionId, activitySink);
		}

		const session = agentSessionManager.getSession(githubSessionId);
		if (!session) {
			this.deps.logger.error(
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

		// Build allowed tools using the GitHub platform resolver, which honors
		// `githubAllowedTools` on the workspace config and falls back to
		// `GITHUB_DEFAULT_ALLOWED_TOOLS`.
		const allowedTools = this.deps.buildGithubAllowedTools(repository);
		const disallowedTools = this.deps.buildDisallowedTools(repository);
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
				this.deps.buildSkillSessionContext(repository, undefined, session),
				undefined, // labelPromptModel (no Linear labels for GitHub PRs)
				undefined, // effort (GitHub PR sessions use SDK default)
				"github", // sessionPlatform → uses githubMcpConfigs override
			);

		const runner = this.createRunnerForType(runnerType, runnerConfig);

		// Store the runner in the session manager
		agentSessionManager.addAgentRunner(githubSessionId, runner);

		// Save persisted state
		await this.deps.savePersistedState();

		this.deps.emitGitHubSessionStarted(
			sessionKey,
			issueMinimal as unknown as Issue,
			repository.id,
		);

		this.deps.logger.info(
			`Starting ${runnerType} runner for GitHub PR ${repoFullName}#${prNumber}`,
		);

		// Start the session and handle completion
		try {
			const sessionInfo = await runner.start(taskInstructions);
			this.deps.logger.info(`GitHub session started: ${sessionInfo.sessionId}`);

			// When session completes, post the reply back to GitHub
			await this.postGitHubReply(event, runner, repository);
		} catch (error) {
			this.deps.logger.error(
				`GitHub session error for ${repoFullName}#${prNumber}`,
				error instanceof Error ? error : new Error(String(error)),
			);
		} finally {
			await this.deps.savePersistedState();
		}
	}
}
