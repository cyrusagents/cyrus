import { existsSync, mkdirSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import {
	type ErrorReporter,
	NoopErrorReporter,
	type RepositoryConfig,
} from "atmiko-core";
import { GitService, SharedApplicationServer } from "atmiko-edge-worker";
import dotenv from "dotenv";
import { DEFAULT_SERVER_PORT, parsePort } from "./config/constants.js";
import { ConfigService } from "./services/ConfigService.js";
import { Logger } from "./services/Logger.js";
import { WorkerService } from "./services/WorkerService.js";
import { getDefaultReposDir } from "./utils/getDefaultReposDir.js";
import { getDefaultWorktreesDir } from "./utils/getDefaultWorktreesDir.js";

/**
 * Main application context providing access to services
 */
export class Application {
	public readonly config: ConfigService;
	public readonly git: GitService;
	public readonly worker: WorkerService;
	public readonly logger: Logger;
	public readonly version: string;
	public readonly errorReporter: ErrorReporter;
	private envWatcher?: ReturnType<typeof watch>;
	private configWatcher?: ReturnType<typeof watch>;
	private isInSetupWaitingMode = false;
	private isInIdleMode = false;
	private readonly envFilePath: string;

	constructor(
		public readonly atmikoHome: string,
		customEnvPath?: string,
		version?: string,
		errorReporter: ErrorReporter = new NoopErrorReporter(),
	) {
		// Initialize logger first
		this.logger = new Logger();

		// Store version
		this.version = version || "unknown";

		// Error reporter (Sentry or noop). Injected so tests can supply a fake.
		this.errorReporter = errorReporter;

		// Determine the env file path: use custom path if provided, otherwise default to ~/.atmiko/.env
		this.envFilePath = customEnvPath || join(atmikoHome, ".env");

		// Ensure required directories exist
		this.ensureRequiredDirectories();

		// Load environment variables from the determined env file path
		this.loadEnvFile();

		// Watch .env file for changes and reload
		this.setupEnvFileWatcher();

		// Initialize services
		this.config = new ConfigService(atmikoHome, this.logger);
		this.git = new GitService({ atmikoHome }, this.logger);
		this.worker = new WorkerService(
			this.config,
			this.git,
			atmikoHome,
			this.logger,
			this.version,
		);
	}

	/**
	 * Load environment variables from the configured env file path
	 */
	private loadEnvFile(): void {
		if (existsSync(this.envFilePath)) {
			dotenv.config({ path: this.envFilePath, override: true });
			this.logger.info(
				`🔧 Loaded environment variables from ${this.envFilePath}`,
			);
		}
	}

	/**
	 * Setup file watcher for .env file to reload on changes
	 */
	private setupEnvFileWatcher(): void {
		// Only watch if file exists
		if (!existsSync(this.envFilePath)) {
			return;
		}

		try {
			this.envWatcher = watch(this.envFilePath, (eventType) => {
				if (eventType === "change") {
					this.logger.info("🔄 .env file changed, reloading...");
					this.loadEnvFile();
				}
			});

			this.logger.info(
				`👀 Watching .env file for changes: ${this.envFilePath}`,
			);
		} catch (error) {
			this.logger.error(`❌ Failed to watch .env file: ${error}`);
		}
	}

	/**
	 * Ensure required Atmiko directories exist
	 * Creates repos dir (ATMIKO_REPOS_DIR or ~/.atmiko/repos),
	 * worktrees dir (ATMIKO_WORKTREES_DIR or ~/.atmiko/worktrees),
	 * and ~/.atmiko/mcp-configs
	 */
	private ensureRequiredDirectories(): void {
		const requiredDirs = [
			getDefaultReposDir(this.atmikoHome),
			getDefaultWorktreesDir(this.atmikoHome),
			join(this.atmikoHome, "mcp-configs"),
		];

		for (const dirPath of requiredDirs) {
			if (!existsSync(dirPath)) {
				try {
					mkdirSync(dirPath, { recursive: true });
					this.logger.info(`📁 Created directory: ${dirPath}`);
				} catch (error) {
					this.logger.error(
						`❌ Failed to create directory ${dirPath}: ${error}`,
					);
					throw error;
				}
			}
		}
	}

	/** Return an explicitly configured, operator-owned OAuth proxy. */
	getProxyUrl(): string {
		const proxyUrl = process.env.PROXY_URL?.trim();
		if (!proxyUrl) {
			throw new Error(
				"Configure your own PROXY_URL or authenticate with atmiko self-auth-linear.",
			);
		}
		return proxyUrl;
	}

	/**
	 * Create a temporary SharedApplicationServer for OAuth
	 */
	async createTempServer(): Promise<SharedApplicationServer> {
		const serverPort = parsePort(
			process.env.ATMIKO_SERVER_PORT,
			DEFAULT_SERVER_PORT,
		);
		return new SharedApplicationServer(serverPort);
	}

	/**
	 * Enable setup waiting mode and start watching config.json for repositories
	 */
	enableSetupWaitingMode(): void {
		this.isInSetupWaitingMode = true;
		this.startConfigWatcher();
	}

	/**
	 * Enable idle mode (post-onboarding, no repositories) and start watching config.json
	 */
	enableIdleMode(): void {
		this.isInIdleMode = true;
		this.startConfigWatcher();
	}

	/**
	 * Setup file watcher for config.json to detect when repositories are added
	 */
	private startConfigWatcher(): void {
		const configPath = this.config.getConfigPath();

		// Create empty config file if it doesn't exist
		if (!existsSync(configPath)) {
			try {
				const configDir = dirname(configPath);
				if (!existsSync(configDir)) {
					mkdirSync(configDir, { recursive: true });
				}
				// Create empty config with empty repositories array
				this.config.save({ repositories: [] });
				this.logger.info(`📝 Created empty config file: ${configPath}`);
			} catch (error) {
				this.logger.error(`❌ Failed to create config file: ${error}`);
				return;
			}
		}

		try {
			this.configWatcher = watch(configPath, async (eventType) => {
				if (
					eventType === "change" &&
					(this.isInSetupWaitingMode || this.isInIdleMode)
				) {
					this.logger.info(
						"🔄 Configuration file changed, checking for repositories...",
					);

					// Reload config and check if repositories were added
					const edgeConfig = this.config.load();
					const repositories = edgeConfig.repositories || [];

					if (repositories.length > 0) {
						this.logger.success("✅ Configuration received!");
						this.logger.info(
							`📦 Starting edge worker with ${repositories.length} repository(ies)...`,
						);

						// Remove ATMIKO_SETUP_PENDING flag from .env (only in setup waiting mode)
						if (this.isInSetupWaitingMode) {
							await this.removeSetupPendingFlag();
						}

						// Transition to normal operation mode
						await this.transitionToNormalMode(repositories);
					}
				}
			});

			this.logger.info(
				`👀 Watching config.json for repository configuration: ${configPath}`,
			);
		} catch (error) {
			this.logger.error(`❌ Failed to watch config.json: ${error}`);
		}
	}

	/**
	 * Remove ATMIKO_SETUP_PENDING flag from .env file
	 */
	private async removeSetupPendingFlag(): Promise<void> {
		const { readFile, writeFile } = await import("node:fs/promises");
		const envPath = join(this.atmikoHome, ".env");

		if (!existsSync(envPath)) {
			return;
		}

		try {
			const envContent = await readFile(envPath, "utf-8");
			const updatedContent = envContent
				.split("\n")
				.filter((line) => !line.startsWith("ATMIKO_SETUP_PENDING="))
				.join("\n");

			await writeFile(envPath, updatedContent, "utf-8");
			this.logger.info("✅ Removed ATMIKO_SETUP_PENDING flag from .env");

			// Reload environment variables
			this.loadEnvFile();
		} catch (error) {
			this.logger.error(
				`❌ Failed to remove ATMIKO_SETUP_PENDING flag: ${error}`,
			);
		}
	}

	/**
	 * Transition from setup waiting mode to normal operation
	 */
	private async transitionToNormalMode(
		repositories: RepositoryConfig[],
	): Promise<void> {
		try {
			this.isInSetupWaitingMode = false;
			this.isInIdleMode = false;

			// Close config watcher
			if (this.configWatcher) {
				this.configWatcher.close();
				this.configWatcher = undefined;
			}

			// Stop the setup waiting mode or idle mode server before starting EdgeWorker
			await this.worker.stopWaitingServer();

			// Start the EdgeWorker with the new configuration
			await this.worker.startEdgeWorker({
				repositories,
			});

			// Display server information
			const serverPort = this.worker.getServerPort();

			this.logger.raw("");
			this.logger.divider(70);
			this.logger.success("Edge worker started successfully");
			this.logger.info(`📌 Version: ${this.version}`);
			this.logger.info(`🔗 Server running on port ${serverPort}`);

			if (process.env.CLOUDFLARE_TOKEN) {
				this.logger.info("🌩️  Cloudflare tunnel: Active");
			}

			this.logger.info(`\n📦 Managing ${repositories.length} repositories:`);
			repositories.forEach((repo) => {
				this.logger.info(`   • ${repo.name} (${repo.repositoryPath})`);
			});
			this.logger.divider(70);
		} catch (error) {
			this.logger.error(`❌ Failed to transition to normal mode: ${error}`);
			process.exit(1);
		}
	}

	/**
	 * Handle graceful shutdown
	 */
	async shutdown(): Promise<void> {
		// Close .env file watcher
		if (this.envWatcher) {
			this.envWatcher.close();
		}

		// Close config file watcher
		if (this.configWatcher) {
			this.configWatcher.close();
		}

		await this.worker.stop();

		// Flush any buffered Sentry events before exiting
		await this.errorReporter.flush(2000).catch(() => false);

		process.exit(0);
	}

	/**
	 * Setup process signal handlers
	 */
	setupSignalHandlers(): void {
		process.on("SIGINT", () => {
			this.logger.info("\nReceived SIGINT, shutting down gracefully...");
			void this.shutdown();
		});

		process.on("SIGTERM", () => {
			this.logger.info("\nReceived SIGTERM, shutting down gracefully...");
			void this.shutdown();
		});

		// Handle uncaught exceptions and unhandled promise rejections.
		// Logger.error forwards the Error arg to the global ErrorReporter, so we
		// don't need to call captureException explicitly here.
		process.on("uncaughtException", (error) => {
			this.logger.error(
				`🚨 Uncaught Exception: ${error.message} (type: ${error.constructor.name}). This error was caught by the global handler, preventing application crash.`,
				error,
			);

			// Attempt graceful shutdown but don't wait indefinitely
			this.shutdown().finally(() => {
				this.logger.error("Process exiting due to uncaught exception");
				process.exit(1);
			});
		});

		process.on("unhandledRejection", (reason, promise) => {
			const error =
				reason instanceof Error ? reason : new Error(String(reason));
			this.logger.error(
				`🚨 Unhandled Promise Rejection at: ${promise}. This rejection was caught by the global handler, continuing operation.`,
				error,
			);
			// Don't exit for promise rejections — they might be recoverable.
		});
	}
}
