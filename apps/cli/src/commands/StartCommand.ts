import type { EdgeConfig } from "miko-core";
import { BaseCommand } from "./ICommand.js";

/**
 * Start command - main entry point for starting the edge worker
 */
export class StartCommand extends BaseCommand {
	async execute(_args: string[]): Promise<void> {
		try {
			// Load edge configuration
			const edgeConfig = this.app.config.load();
			const repositories = edgeConfig.repositories || [];

			// Always start the EdgeWorker — it handles zero repos gracefully.
			// Webhook transports (Slack, GitHub) register regardless of repos
			// so URL verification and event reception work during onboarding.
			await this.app.worker.startEdgeWorker({
				repositories,
			});

			// Display server information
			const serverPort = this.app.worker.getServerPort();

			this.logger.raw("");
			this.logger.divider(70);
			this.logger.info(`📌 Version: ${this.app.version}`);
			this.logger.info(`🔗 Server running on port ${serverPort}`);

			if (process.env.CLOUDFLARE_TOKEN) {
				this.logger.info("🌩️  Cloudflare tunnel: Active");
			}

			if (repositories.length > 0) {
				this.logger.info(`\n📦 Managing ${repositories.length} repositories:`);
				repositories.forEach((repo: EdgeConfig["repositories"][number]) => {
					this.logger.info(`   • ${repo.name} (${repo.repositoryPath})`);
				});
			} else {
				this.logger.info("\n⏸️  No repositories configured");
				this.logger.info("   Add one with: miko self-add-repo <git-url>");
			}
			this.logger.divider(70);

			// Setup signal handlers for graceful shutdown
			this.app.setupSignalHandlers();
		} catch (error: any) {
			this.logger.error(`Failed to start edge application: ${error.message}`);

			// Provide helpful error guidance
			if (error.message?.includes("CLOUDFLARE_TOKEN")) {
				this.logger.info("\n💡 Cloudflare tunnel requires:");
				this.logger.info("   - CLOUDFLARE_TOKEN environment variable");
				this.logger.info(
					"   - Configure your tunnel: https://one.dash.cloudflare.com/",
				);
			} else if (error.message?.includes("Failed to connect")) {
				this.logger.info("\n💡 Connection issues can occur when:");
				this.logger.info("   - Linear OAuth tokens have expired");
				this.logger.info("   - The Linear API is temporarily unavailable");
				this.logger.info("   - Your network connection is having issues");
			}

			await this.app.shutdown();
			process.exit(1);
		}
	}
}
