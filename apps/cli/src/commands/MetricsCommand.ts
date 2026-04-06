import { SessionMetricsService } from "cyrus-edge-worker";
import { BaseCommand } from "./ICommand.js";

/**
 * Metrics command — read and summarise the local session metrics JSONL log.
 *
 * Usage: cyrus metrics
 */
export class MetricsCommand extends BaseCommand {
	async execute(_args: string[]): Promise<void> {
		const summary = await SessionMetricsService.summarize(this.app.cyrusHome);
		console.log(summary);
	}
}
