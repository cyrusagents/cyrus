/**
 * AgentPlanManager — manages Linear Agent Session plan (checklist) updates.
 *
 * Linear's Agent API supports a plan checklist that renders in the Agent Session
 * panel. Each step has a `content` string and a `status` of one of the four
 * recognized values. The plan must always be sent as a full replacement array —
 * individual step updates are not supported.
 *
 * This module maintains per-session plan state and emits full-plan updates to
 * Linear whenever a step changes. Errors are logged but never propagate — a
 * failed plan update must never fail the underlying job.
 *
 * @module AgentPlanManager
 */

import { createLogger, type ILogger } from "cyrus-core";

/**
 * The valid status values for an agent plan step.
 */
export type AgentPlanStepStatus =
	| "pending"
	| "inProgress"
	| "completed"
	| "canceled";

/**
 * A single step in the agent's execution plan.
 */
export interface AgentPlanStep {
	content: string;
	status: AgentPlanStepStatus;
}

/**
 * The standard 5-step plan used for every Cyrus session.
 * Steps map to observable stages in the execution flow.
 */
export const PLAN_STEP_LABELS = [
	"Read context",
	"Plan approach",
	"Implement changes",
	"Run tests",
	"Open PR",
] as const;

export type PlanStepIndex = 0 | 1 | 2 | 3 | 4;

/**
 * Manages plan state per session and posts updates to Linear via the provided callback.
 *
 * @example
 * ```typescript
 * const planManager = new AgentPlanManager(
 *   (id, plan) => issueTracker.updateAgentSessionPlan(id, plan),
 *   logger,
 * );
 *
 * // Session starts
 * await planManager.updateStep(sessionId, 0, 'inProgress');
 *
 * // After reading context
 * await planManager.updateStep(sessionId, 0, 'completed');
 * await planManager.updateStep(sessionId, 1, 'inProgress');
 *
 * // Session done
 * await planManager.completePlan(sessionId);
 * ```
 */
export class AgentPlanManager {
	private readonly plans: Map<string, AgentPlanStep[]> = new Map();
	private readonly logger: ILogger;

	constructor(
		private readonly updateFn: (
			sessionId: string,
			plan: AgentPlanStep[],
		) => Promise<void>,
		logger?: ILogger,
	) {
		this.logger = logger ?? createLogger({ component: "AgentPlanManager" });
	}

	/**
	 * Initialise a fresh plan for a session (all steps pending).
	 * Does NOT post to Linear — call updateStep to trigger the first post.
	 */
	private ensurePlan(sessionId: string): AgentPlanStep[] {
		let plan = this.plans.get(sessionId);
		if (!plan) {
			plan = PLAN_STEP_LABELS.map((content) => ({
				content,
				status: "pending" as AgentPlanStepStatus,
			}));
			this.plans.set(sessionId, plan);
		}
		return plan;
	}

	/**
	 * Update a single step's status and post the full plan to Linear.
	 * Never throws — errors are logged.
	 *
	 * @param sessionId - Linear agent session ID
	 * @param stepIndex - 0-based index into PLAN_STEP_LABELS
	 * @param status - New status for the step
	 */
	async updateStep(
		sessionId: string,
		stepIndex: PlanStepIndex,
		status: AgentPlanStepStatus,
	): Promise<void> {
		const plan = this.ensurePlan(sessionId);
		const step = plan[stepIndex];
		if (!step) {
			this.logger.warn(
				`AgentPlanManager: step index ${stepIndex} out of range for session ${sessionId}`,
			);
			return;
		}
		step.status = status;
		await this.postPlan(sessionId, plan);
	}

	/**
	 * Mark all remaining pending or inProgress steps as completed.
	 * Called when the session finishes successfully.
	 */
	async completePlan(sessionId: string): Promise<void> {
		const plan = this.ensurePlan(sessionId);
		for (const step of plan) {
			if (step.status === "pending" || step.status === "inProgress") {
				step.status = "completed";
			}
		}
		await this.postPlan(sessionId, plan);
	}

	/**
	 * Remove plan state for a session (cleanup after session ends).
	 */
	clearPlan(sessionId: string): void {
		this.plans.delete(sessionId);
	}

	/**
	 * Post the full plan array to Linear. Errors are caught and logged.
	 */
	private async postPlan(
		sessionId: string,
		plan: AgentPlanStep[],
	): Promise<void> {
		try {
			await this.updateFn(sessionId, plan);
		} catch (error) {
			this.logger.error(
				`AgentPlanManager: failed to post plan update for session ${sessionId}:`,
				error,
			);
		}
	}
}
