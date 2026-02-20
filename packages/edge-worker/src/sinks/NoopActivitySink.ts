import type { AgentActivityContent } from "cyrus-core";
import type {
	ActivityPostOptions,
	ActivityPostResult,
	IActivitySink,
} from "./IActivitySink.js";

/**
 * A no-op activity sink that silently discards all activities.
 * Used for platforms like Slack where activities are not posted to an external tracker.
 */
export class NoopActivitySink implements IActivitySink {
	readonly id: string;

	constructor(id = "noop") {
		this.id = id;
	}

	async postActivity(
		_sessionId: string,
		_activity: AgentActivityContent,
		_options?: ActivityPostOptions,
	): Promise<ActivityPostResult> {
		return {};
	}

	async createAgentSession(_issueId: string): Promise<string> {
		return "";
	}
}
