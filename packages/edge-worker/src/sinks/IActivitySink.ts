import type { AgentActivityContent, AgentPlanStep } from "cyrus-core";

/**
 * String literal type for activity signals.
 * Maps to platform-specific signal enums (e.g., Linear's AgentActivitySignal).
 */
export type ActivitySignal = "auth" | "select" | "stop" | "continue";

/**
 * Options for posting an activity.
 */
export interface ActivityPostOptions {
	/** Whether the activity is ephemeral (disappears when replaced by next activity) */
	ephemeral?: boolean;
	/** Signal modifier for how the activity should be interpreted */
	signal?: ActivitySignal;
	/** Additional metadata for the signal */
	signalMetadata?: Record<string, unknown>;
}

/**
 * Result of posting an activity.
 */
export interface ActivityPostResult {
	/** The ID of the created activity, if available */
	activityId?: string;
}

/**
 * Interface for activity sinks that receive and process agent session activities.
 *
 * IActivitySink decouples activity posting from IIssueTrackerService, enabling
 * multiple activity sinks (Linear workspaces, GitHub, etc.) to receive session
 * activities based on session context.
 *
 * Implementations should:
 * - Provide a unique identifier (workspace ID, org ID, etc.)
 * - Support posting activities to agent sessions
 * - Support creating new agent sessions on issues
 */
export interface IActivitySink {
	/**
	 * Unique identifier for this sink (e.g., Linear workspace ID, GitHub org ID).
	 * Used by GlobalSessionRegistry to route activities to the correct sink.
	 */
	readonly id: string;

	/**
	 * Post an activity to an existing agent session.
	 *
	 * @param sessionId - The agent session ID to post to
	 * @param activity - The activity content (thought, action, response, error, etc.)
	 * @param options - Optional settings for ephemeral, signal, signalMetadata
	 * @returns Promise that resolves with the result of the activity post
	 */
	postActivity(
		sessionId: string,
		activity: AgentActivityContent,
		options?: ActivityPostOptions,
	): Promise<ActivityPostResult>;

	/**
	 * Create a new agent session on an issue.
	 *
	 * @param issueId - The issue ID to attach the session to
	 * @returns Promise that resolves with the created session ID
	 */
	createAgentSession(issueId: string): Promise<string>;

	/**
	 * Update the agent session plan (progress checklist).
	 * Optional: only implemented by platforms that support agent session plans (e.g. Linear).
	 *
	 * @param sessionId - The agent session ID to update
	 * @param plan - Full plan array to replace the current plan
	 */
	updatePlan?(sessionId: string, plan: AgentPlanStep[]): Promise<void>;

	/**
	 * Close/complete the associated issue after a successful session with no PR.
	 * Optional: only implemented by platforms that support issue state transitions (e.g. Linear).
	 *
	 * @param issueId - The issue ID to transition to the completed state
	 */
	closeIssue?(issueId: string): Promise<void>;
}
