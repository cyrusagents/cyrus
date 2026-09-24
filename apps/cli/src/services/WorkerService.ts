import type {
	EdgeWorkerConfig,
	Issue,
	RepoSetupHookEventHandler,
	RepositoryConfig,
} from "miko-core";
import type { GitService, SharedApplicationServer } from "miko-edge-worker";
import { EdgeWorker } from "miko-edge-worker";
import { SlackEventTransport } from "miko-slack-event-transport";
import { DEFAULT_SERVER_PORT, parsePort } from "../config/constants.js";
import type { Workspace } from "../config/types.js";
import type { ConfigService } from "./ConfigService.js";
import type { Logger } from "./Logger.js";

function parseToolEnv(value: string | undefined): string[] | undefined {
	const tools = value
		?.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);
	return tools && tools.length > 0 ? tools : undefined;
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
	if (value === undefined) {
		return undefined;
	}
	return value.toLowerCase().trim() === "true";
}

/**
 * Service responsible for EdgeWorker and Cloudflare tunnel management
 */
export class WorkerService {
	private edgeWorker: EdgeWorker | null = null;
	private setupWaitingServer: any = null; // SharedApplicationServer instance during setup waiting mode
	private isShuttingDown = false;

	constructor(
		private configService: ConfigService,
		private gitService: GitService,
		private mikoHome: string,
		private logger: Logger,
		private version?: string,
	) {}

	/**
	 * Get the EdgeWorker instance
	 */
	getEdgeWorker(): EdgeWorker | null {
		return this.edgeWorker;
	}

	/**
	 * Get the server port from EdgeWorker
	 */
	getServerPort(): number {
		return this.edgeWorker?.getServerPort() || DEFAULT_SERVER_PORT;
	}

	/**
	 * Start setup waiting mode - server infrastructure only, no EdgeWorker
	 * Used after initial authentication while waiting for server configuration
	 */
	async startSetupWaitingMode(): Promise<void> {
		await this.startPreWorkerServer({
			headerLine: "⏳ Waiting for configuration from server...",
			footerLines: [
				"Configure ~/.miko/config.json and add repositories with miko self-add-repo <git-url>.",
			],
		});
	}

	/**
	 * Start idle mode - server infrastructure only, no EdgeWorker
	 * Used after onboarding when no repositories are configured
	 */
	async startIdleMode(): Promise<void> {
		await this.startPreWorkerServer({
			headerLine: "⏸️  No repositories configured",
			footerLines: ["Add a repository with: miko self-add-repo <git-url>"],
		});
	}

	/**
	 * Shared infrastructure for modes that run the config-update server without
	 * an EdgeWorker (setup-waiting, idle). Only the banner text differs between
	 * modes, so callers supply just the mode-specific lines.
	 */
	private async startPreWorkerServer(banner: {
		headerLine: string;
		footerLines: string[];
	}): Promise<void> {
		const { SharedApplicationServer } = await import("miko-edge-worker");
		const { ConfigUpdater } = await import("miko-config-updater");

		const isExternalHost =
			process.env.MIKO_HOST_EXTERNAL?.toLowerCase().trim() === "true";
		const serverPort = parsePort(
			process.env.MIKO_SERVER_PORT,
			DEFAULT_SERVER_PORT,
		);
		const serverHost = isExternalHost ? "0.0.0.0" : "localhost";

		this.setupWaitingServer = new SharedApplicationServer(
			serverPort,
			serverHost,
		);
		this.setupWaitingServer.initializeFastify();

		const configUpdater = new ConfigUpdater(
			this.setupWaitingServer.getFastifyInstance(),
			this.mikoHome,
			() => process.env.MIKO_API_KEY || "",
		);
		configUpdater.register();

		this.logger.info("✅ Config updater registered");
		this.logger.info(
			"   Routes: /api/update/miko-config, /api/update/miko-env,",
		);
		this.logger.info(
			"           /api/update/repository, /api/update/test-mcp, /api/update/configure-mcp",
		);

		this.registerWebhookTransports(this.setupWaitingServer);

		// Starts Cloudflare tunnel too, if CLOUDFLARE_TOKEN is set.
		await this.setupWaitingServer.start();

		this.logger.raw("");
		this.logger.divider(70);
		this.logger.info(banner.headerLine);
		this.logger.info(`🔗 Server running on port ${serverPort}`);

		if (process.env.CLOUDFLARE_TOKEN) {
			this.logger.info("🌩️  Cloudflare tunnel: Active");
		}

		this.logger.info("📡 Config updater: Ready");
		this.logger.raw("");
		for (const line of banner.footerLines) {
			this.logger.info(line);
		}
		this.logger.divider(70);
	}

	/**
	 * Register webhook endpoints that don't require repositories.
	 * Called from both idle and setup-waiting modes so that external services
	 * (e.g. Slack URL verification) can reach Miko during onboarding.
	 */
	private registerWebhookTransports(server: SharedApplicationServer): void {
		const isExternalHost =
			process.env.MIKO_HOST_EXTERNAL?.toLowerCase().trim() === "true";
		const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;
		const hasSlackSigningSecret =
			slackSigningSecret != null && slackSigningSecret !== "";

		if (isExternalHost && hasSlackSigningSecret) {
			const slackTransport = new SlackEventTransport({
				fastifyServer: server.getFastifyInstance(),
				verificationMode: "direct",
				secret: slackSigningSecret,
			});
			slackTransport.register();
			this.logger.info("✅ Slack webhook registered");
		}
	}

	/**
	 * Stop the setup waiting mode or idle mode server
	 * Must be called before starting EdgeWorker to avoid port conflicts
	 */
	async stopWaitingServer(): Promise<void> {
		if (this.setupWaitingServer) {
			this.logger.info("🛑 Stopping waiting server...");
			await this.setupWaitingServer.stop();
			this.setupWaitingServer = null;
			this.logger.info("✅ Waiting server stopped");
		}
	}

	/**
	 * Start the EdgeWorker with given configuration
	 */
	async startEdgeWorker(params: {
		repositories: RepositoryConfig[];
		ngrokAuthToken?: string;
		onOAuthCallback?: (
			token: string,
			workspaceId: string,
			workspaceName: string,
		) => Promise<void>;
	}): Promise<void> {
		const { repositories, ngrokAuthToken, onOAuthCallback } = params;

		// Determine if using external host
		const isExternalHost =
			process.env.MIKO_HOST_EXTERNAL?.toLowerCase().trim() === "true";

		// Load config once for model defaults
		const edgeConfig = this.configService.load();

		// Create EdgeWorker configuration.
		//
		// EdgeWorkerConfig = EdgeConfig & EdgeWorkerRuntimeConfig, so the whole
		// file config is spread first: every persisted field flows through to
		// the EdgeWorker automatically, and a newly added EdgeConfig field can
		// never be silently dropped at startup again (that bit us with
		// `strictMcpConfig` — CYPACK-1478). Only fields that need env-var
		// precedence, computed values, or call-parameter overrides may be
		// assigned explicitly below the spread; plain pass-throughs must NOT be
		// listed here.
		const config: EdgeWorkerConfig = {
			...edgeConfig,
			version: this.version,
			repositories,
			mikoHome: this.mikoHome,
			linearAllowedTools:
				parseToolEnv(process.env.LINEAR_ALLOWED_TOOLS) ??
				edgeConfig.linearAllowedTools,
			defaultDisallowedTools:
				parseToolEnv(process.env.DISALLOWED_TOOLS) ??
				edgeConfig.defaultDisallowedTools,
			// Model configuration: environment variables take precedence over config file.
			// Legacy env vars/keys are still accepted for backwards compatibility.
			claudeDefaultModel:
				process.env.MIKO_CLAUDE_DEFAULT_MODEL ||
				process.env.MIKO_DEFAULT_MODEL ||
				edgeConfig.claudeDefaultModel ||
				edgeConfig.defaultModel,
			claudeDefaultFallbackModel:
				process.env.MIKO_CLAUDE_DEFAULT_FALLBACK_MODEL ||
				process.env.MIKO_DEFAULT_FALLBACK_MODEL ||
				edgeConfig.claudeDefaultFallbackModel ||
				edgeConfig.defaultFallbackModel,
			geminiDefaultModel:
				process.env.MIKO_GEMINI_DEFAULT_MODEL || edgeConfig.geminiDefaultModel,
			codexDefaultModel:
				process.env.MIKO_CODEX_DEFAULT_MODEL || edgeConfig.codexDefaultModel,
			opencodeDefaultModel:
				process.env.MIKO_OPENCODE_DEFAULT_MODEL ||
				edgeConfig.opencodeDefaultModel,
			opencodeDefaultFallbackModel:
				process.env.MIKO_OPENCODE_DEFAULT_FALLBACK_MODEL ||
				edgeConfig.opencodeDefaultFallbackModel,
			grokDefaultModel:
				process.env.MIKO_GROK_DEFAULT_MODEL || edgeConfig.grokDefaultModel,
			grokDefaultFallbackModel:
				process.env.MIKO_GROK_DEFAULT_FALLBACK_MODEL ||
				edgeConfig.grokDefaultFallbackModel,
			inferOpenCodeRunnerFromProviderModel:
				parseBooleanEnv(
					process.env.MIKO_INFER_OPENCODE_RUNNER_FROM_PROVIDER_MODEL,
				) ?? edgeConfig.inferOpenCodeRunnerFromProviderModel,
			defaultRunner:
				(process.env.MIKO_DEFAULT_RUNNER as
					| "claude"
					| "gemini"
					| "codex"
					| "cursor"
					| "opencode"
					| "grok"
					| undefined) || edgeConfig.defaultRunner,
			webhookBaseUrl: process.env.MIKO_BASE_URL,
			serverPort: parsePort(process.env.MIKO_SERVER_PORT, DEFAULT_SERVER_PORT),
			serverHost: isExternalHost ? "0.0.0.0" : "localhost",
			ngrokAuthToken,
			handlers: {
				createWorkspace: async (
					issue: Issue,
					repositories: RepositoryConfig[],
					options?: {
						baseBranchOverrides?: Map<string, string>;
						onRepoSetupHookEvent?: RepoSetupHookEventHandler;
					},
				): Promise<Workspace> => {
					return this.gitService.createGitWorktree(issue, repositories, {
						globalSetupScript: edgeConfig.global_setup_script,
						baseBranchOverrides: options?.baseBranchOverrides,
						onRepoSetupHookEvent: options?.onRepoSetupHookEvent,
					});
				},
				onOAuthCallback,
			},
		};

		// Create and start EdgeWorker
		this.edgeWorker = new EdgeWorker(config);

		// Set config path for dynamic reloading
		const configPath = this.configService.getConfigPath();
		this.edgeWorker.setConfigPath(configPath);

		// Set up event handlers
		this.setupEventHandlers();

		// Start the worker
		await this.edgeWorker.start();

		this.logger.success("Edge worker started successfully");
	}

	/**
	 * Set up event handlers for EdgeWorker
	 */
	private setupEventHandlers(): void {
		if (!this.edgeWorker) return;

		// Session events
		this.edgeWorker.on(
			"session:started",
			(issueId: string, _issue: Issue, repositoryId: string) => {
				this.logger.info(
					`Started session for issue ${issueId} in repository ${repositoryId}`,
				);
			},
		);

		this.edgeWorker.on(
			"session:ended",
			(issueId: string, exitCode: number | null, repositoryId: string) => {
				this.logger.info(
					`Session for issue ${issueId} ended with exit code ${exitCode} in repository ${repositoryId}`,
				);
			},
		);

		// Connection events
		this.edgeWorker.on("connected", (token: string) => {
			this.logger.success(
				`Connected to proxy with token ending in ...${token.slice(-4)}`,
			);
		});

		this.edgeWorker.on("disconnected", (token: string, reason?: string) => {
			this.logger.error(
				`Disconnected from proxy (token ...${token.slice(-4)}): ${
					reason || "Unknown reason"
				}`,
			);
		});

		// Error events
		this.edgeWorker.on("error", (error: Error) => {
			this.logger.error(`EdgeWorker error: ${error.message}`);
		});
	}

	/**
	 * Stop the EdgeWorker
	 */
	async stop(): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;

		this.logger.info("\nShutting down edge worker...");

		// Stop setup waiting mode server if still running
		if (this.setupWaitingServer) {
			await this.setupWaitingServer.stop();
			this.setupWaitingServer = null;
		}

		// Stop edge worker (includes stopping shared application server and Cloudflare tunnel)
		if (this.edgeWorker) {
			await this.edgeWorker.stop();
		}

		this.logger.info("Shutdown complete");
	}
}
