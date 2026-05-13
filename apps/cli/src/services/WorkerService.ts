import { getCyrusAppUrl } from "cyrus-cloudflare-tunnel-client";
import type { EdgeWorkerConfig, Issue, RepositoryConfig } from "cyrus-core";
import type { GitService, SharedApplicationServer } from "cyrus-edge-worker";
import { EdgeWorker } from "cyrus-edge-worker";
import { SlackEventTransport } from "cyrus-slack-event-transport";
import { DEFAULT_SERVER_PORT, parsePort } from "../config/constants.js";
import type { Workspace } from "../config/types.js";
import type { ConfigService } from "./ConfigService.js";
import type { Logger } from "./Logger.js";

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
		private cyrusHome: string,
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
			footerLines: (appUrl) => [
				"Your Cyrus instance is ready to receive configuration.",
				`Complete setup at: ${appUrl}/onboarding`,
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
			footerLines: (appUrl) =>
				process.env.LINEAR_CLIENT_ID
					? ["Add a repository with: cyrus self-add-repo <git-url>"]
					: [
							`Waiting for repository configuration from ${appUrl}`,
							`Add repositories at: ${appUrl}/repos`,
						],
		});
	}

	/**
	 * Shared infrastructure for modes that run the config-update server without
	 * an EdgeWorker (setup-waiting, idle). Only the banner text differs between
	 * modes, so callers supply just the mode-specific lines.
	 */
	private async startPreWorkerServer(banner: {
		headerLine: string;
		footerLines: (appUrl: string) => string[];
	}): Promise<void> {
		const { SharedApplicationServer } = await import("cyrus-edge-worker");
		const { ConfigUpdater } = await import("cyrus-config-updater");

		const isExternalHost =
			process.env.CYRUS_HOST_EXTERNAL?.toLowerCase().trim() === "true";
		const serverPort = parsePort(
			process.env.CYRUS_SERVER_PORT,
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
			this.cyrusHome,
			() => process.env.CYRUS_API_KEY || "",
		);
		configUpdater.register();

		this.logger.info("✅ Config updater registered");
		this.logger.info(
			"   Routes: /api/update/cyrus-config, /api/update/cyrus-env,",
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
		for (const line of banner.footerLines(getCyrusAppUrl())) {
			this.logger.info(line);
		}
		this.logger.divider(70);
	}

	/**
	 * Register webhook endpoints that don't require repositories.
	 * Called from both idle and setup-waiting modes so that external services
	 * (e.g. Slack URL verification) can reach Cyrus during onboarding.
	 */
	private registerWebhookTransports(server: SharedApplicationServer): void {
		const isExternalHost =
			process.env.CYRUS_HOST_EXTERNAL?.toLowerCase().trim() === "true";
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
			process.env.CYRUS_HOST_EXTERNAL?.toLowerCase().trim() === "true";

		// Load config once for model defaults
		const edgeConfig = this.configService.load();

		// Build EdgeWorker configuration. Layering, in order:
		//   1. Spread the entire on-disk EdgeConfig — every field added to
		//      EdgeConfigSchema flows through automatically. This avoids the
		//      whitelist-rot bug where a new config field (e.g. memoryGate,
		//      maxConcurrentRunners) gets loaded from disk but silently
		//      dropped because it isn't listed here.
		//   2. Override with caller-provided / runtime-only fields.
		//   3. Apply env-var precedence for fields where env wins over disk.
		const config: EdgeWorkerConfig = {
			...edgeConfig,

			// Caller-provided + runtime-only fields
			version: this.version,
			repositories,
			cyrusHome: this.cyrusHome,
			webhookBaseUrl: process.env.CYRUS_BASE_URL,
			serverPort: parsePort(process.env.CYRUS_SERVER_PORT, DEFAULT_SERVER_PORT),
			serverHost: isExternalHost ? "0.0.0.0" : "localhost",
			ngrokAuthToken,
			handlers: {
				createWorkspace: async (
					issue: Issue,
					repositories: RepositoryConfig[],
					options?: { baseBranchOverrides?: Map<string, string> },
				): Promise<Workspace> => {
					return this.gitService.createGitWorktree(issue, repositories, {
						globalSetupScript: edgeConfig.global_setup_script,
						baseBranchOverrides: options?.baseBranchOverrides,
					});
				},
				onOAuthCallback,
			},

			// Env-var precedence (env wins over disk; legacy keys still accepted)
			defaultAllowedTools:
				process.env.ALLOWED_TOOLS?.split(",").map((t) => t.trim()) ||
				edgeConfig.defaultAllowedTools ||
				[],
			defaultDisallowedTools:
				process.env.DISALLOWED_TOOLS?.split(",").map((t) => t.trim()) ||
				edgeConfig.defaultDisallowedTools,
			claudeDefaultModel:
				process.env.CYRUS_CLAUDE_DEFAULT_MODEL ||
				process.env.CYRUS_DEFAULT_MODEL ||
				edgeConfig.claudeDefaultModel ||
				edgeConfig.defaultModel,
			claudeDefaultFallbackModel:
				process.env.CYRUS_CLAUDE_DEFAULT_FALLBACK_MODEL ||
				process.env.CYRUS_DEFAULT_FALLBACK_MODEL ||
				edgeConfig.claudeDefaultFallbackModel ||
				edgeConfig.defaultFallbackModel,
			geminiDefaultModel:
				process.env.CYRUS_GEMINI_DEFAULT_MODEL || edgeConfig.geminiDefaultModel,
			codexDefaultModel:
				process.env.CYRUS_CODEX_DEFAULT_MODEL || edgeConfig.codexDefaultModel,
			defaultRunner:
				(process.env.CYRUS_DEFAULT_RUNNER as
					| "claude"
					| "gemini"
					| "codex"
					| "cursor"
					| undefined) || edgeConfig.defaultRunner,
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
