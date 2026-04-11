// NOTE: This feature is called "readiness check" or "brief validation" in user-facing
// contexts (logs, Linear comments). The term "pre-flight" is reserved for the
// Claude Chat session startup sequence. See BRI-1121 naming note:
// https://linear.app/brilliantio/issue/BRI-1121/cyrus-issue-readiness-classifier-pre-flight-gate
/**
 * IssueReadinessClassifier — Pre-flight gate for Cyrus agent sessions.
 *
 * Runs a cheap Haiku pass against the issue title + description before the main
 * workflow begins. Issues that lack enough information to proceed are rejected
 * early with a comment explaining what is missing, preventing wasted work.
 *
 * Design goals:
 *  - < 500 tokens input, < 200 tokens output per call
 *  - Generous threshold: only reject genuinely unworkable issues
 *  - Decisions logged for prompt tuning
 */

import { type ILogger, createLogger } from "cyrus-core";
import type { ISimpleAgentRunner } from "cyrus-core";
import { SimpleClaudeRunner } from "cyrus-simple-agent-runner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReadinessClassification =
	| "pass"
	| "fail-vague"
	| "fail-no-files"
	| "fail-no-criteria"
	| "fail-ambiguous";

export interface ReadinessDecision {
	pass: boolean;
	classification: ReadinessClassification;
	/** Human-readable explanation, suitable for posting to Linear. */
	reason: string;
}

export interface ReadinessClassifierConfig {
	/** Cyrus home directory (required by SimpleClaudeRunner). */
	cyrusHome: string;
	/** Claude model to use. Defaults to "haiku" for cost efficiency. */
	model?: string;
	/** Timeout in milliseconds. Defaults to 15 000. */
	timeoutMs?: number;
	/**
	 * Override the default system prompt.
	 * Must instruct the model to respond with one of the ReadinessClassification values.
	 */
	customPrompt?: string;
	logger?: ILogger;
}

// ---------------------------------------------------------------------------
// Human-readable reasons for each failure classification
// ---------------------------------------------------------------------------

const FAIL_REASONS: Record<Exclude<ReadinessClassification, "pass">, string> = {
	"fail-vague":
		"The task description is too vague — there is no clear, actionable request that an agent can start on.",
	"fail-no-files":
		"The task appears to involve editing specific files, but no file paths or locations were provided.",
	"fail-no-criteria":
		"No acceptance criteria or verification method is described — it would be impossible to confirm when the task is complete.",
	"fail-ambiguous":
		"The issue contains contradictions or ambiguities that would force the agent to guess at intent.",
};

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

export class IssueReadinessClassifier {
	private runner: ISimpleAgentRunner<ReadinessClassification>;
	private logger: ILogger;

	constructor(config: ReadinessClassifierConfig) {
		this.logger = config.logger ?? createLogger({ component: "IssueReadinessClassifier" });

		this.runner = new SimpleClaudeRunner<ReadinessClassification>({
			validResponses: [
				"pass",
				"fail-vague",
				"fail-no-files",
				"fail-no-criteria",
				"fail-ambiguous",
			] as const,
			cyrusHome: config.cyrusHome,
			model: config.model ?? "haiku",
			fallbackModel: "sonnet",
			systemPrompt: config.customPrompt ?? this.buildDefaultSystemPrompt(),
			maxTurns: 1,
			timeoutMs: config.timeoutMs ?? 15000,
		});
	}

	/**
	 * Assess whether an issue is ready for autonomous work.
	 *
	 * @param issueTitle    - The issue title.
	 * @param issueDescription - The issue description (may be empty).
	 * @param labels        - Labels attached to the issue (lowercase strings).
	 * @returns A ReadinessDecision indicating pass/fail and the reason.
	 */
	async assess(
		issueTitle: string,
		issueDescription: string,
		labels: string[],
	): Promise<ReadinessDecision> {
		const labelList = labels.length > 0 ? labels.join(", ") : "(none)";
		const prompt = [
			`Title: ${issueTitle}`,
			issueDescription ? `Description:\n${issueDescription}` : "Description: (empty)",
			`Labels: ${labelList}`,
		].join("\n\n");

		try {
			const result = await this.runner.query(prompt);
			const classification = result.response;

			const decision: ReadinessDecision = {
				pass: classification === "pass",
				classification,
				reason:
					classification === "pass"
						? "Issue passed pre-flight readiness check."
						: FAIL_REASONS[classification],
			};

			this.logger.info(
				`[readiness-classifier] ${classification.toUpperCase()} — ${decision.reason} ` +
				`(issue: "${issueTitle}", durationMs: ${result.durationMs}, costUSD: ${result.costUSD?.toFixed(5) ?? "n/a"})`,
			);

			return decision;
		} catch (error) {
			// On classifier failure, default to pass so we never silently block work
			this.logger.warn(
				`[readiness-classifier] Classifier error, defaulting to PASS: ${error instanceof Error ? error.message : String(error)}`,
			);
			return {
				pass: true,
				classification: "pass",
				reason: "Classifier encountered an error; defaulting to pass.",
			};
		}
	}

	// -------------------------------------------------------------------------
	// Prompt
	// -------------------------------------------------------------------------

	private buildDefaultSystemPrompt(): string {
		return `You are a pre-flight readiness classifier for software development issues assigned to an autonomous coding agent.

Your job: decide whether this Linear issue contains enough information for the agent to begin work confidently, without needing to ask follow-up questions.

Classify the issue as EXACTLY ONE of the following:

**pass**
The issue is clear enough to proceed. Even terse one-liners pass if the intent is unambiguous.
Examples that PASS: "Fix the typo in README.md line 47", "Add unit tests for the login module", "Remove the deprecated /v1/users endpoint".

**fail-vague**
The task has no actionable request — it is a wish, a vague area of concern, or an empty description with no specifics.
Examples: "Improve performance", "Look into the auth system", "Something is broken".

**fail-no-files**
The task clearly requires editing, creating, or deleting specific files but provides zero file paths or locations, making it impossible to start without guessing.
Only use this when file identity is genuinely unclear — not when a feature description naturally implies which module to change.

**fail-no-criteria**
There is no way to verify when the task is done. No expected behaviour, no test to run, no output to check, no acceptance criteria of any kind.
Only use this for tasks where success is genuinely undefined, not for tasks where the definition of done is implied by the request.

**fail-ambiguous**
The issue contains direct contradictions (e.g., "add X" and "remove X" in the same brief) or uses terms so ambiguous that any implementation would be a coin flip.

---

IMPORTANT GUIDELINES:
- The threshold is intentionally generous. When in doubt, prefer **pass**.
- Short issues are fine. Length alone is never a reason to fail.
- Implementation details being left to the agent is expected and fine.
- Only fail when the issue is genuinely unworkable as written.

Respond with ONLY the classification word (pass, fail-vague, fail-no-files, fail-no-criteria, or fail-ambiguous). Nothing else.`;
	}
}
