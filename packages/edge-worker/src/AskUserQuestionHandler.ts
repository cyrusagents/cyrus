/**
 * Handler for AskUserQuestion tool invocations using Linear's select signal.
 *
 * This handler bridges the Claude SDK's AskUserQuestion tool with Linear's
 * agent elicitation API. When Claude uses the AskUserQuestion tool, this handler:
 * 1. Posts an elicitation activity to Linear with the question and options
 * 2. Stores the pending question with a promise resolver
 * 3. Waits for the "prompted" webhook event from Linear
 * 4. Resolves the promise with the user's response
 *
 * The handler follows the same pattern as RepositoryRouter for pending selections,
 * but is specifically designed for user questions during agent execution.
 *
 * @see {@link https://linear.app/developers/agent-signals#select}
 */

import type {
	AskUserQuestion,
	AskUserQuestionAnswers,
	AskUserQuestionInput,
	AskUserQuestionResult,
	IIssueTrackerService,
	ILogger,
} from "cyrus-core";
import { AgentActivitySignal, createLogger } from "cyrus-core";

/**
 * Pending question data stored while awaiting user response
 */
interface PendingQuestion {
	/** The question being asked */
	question: AskUserQuestion;
	/** Promise resolver called when user responds */
	resolve: (result: AskUserQuestionResult) => void;
	/** AbortSignal for cancellation */
	signal: AbortSignal;
}

/**
 * Dependencies required by AskUserQuestionHandler
 */
export interface AskUserQuestionHandlerDeps {
	/**
	 * Get issue tracker for a workspace
	 * @param organizationId - Linear organization/workspace ID
	 */
	getIssueTracker: (organizationId: string) => IIssueTrackerService | null;
}

/**
 * Configuration for AskUserQuestionHandler
 */
export interface AskUserQuestionHandlerConfig {
	/**
	 * Maximum time (in milliseconds) to wait for a user's response before
	 * giving up and unblocking the agent.
	 *
	 * A pending question is otherwise only resolved by a "prompted" webhook or
	 * by the session's AbortSignal. If that webhook is never delivered — for
	 * example when the user replies in a way that never produces an
	 * elicitation-response event — the Claude subprocess stays blocked on the
	 * tool result indefinitely. This timeout bounds that wait so the agent can
	 * proceed instead of deadlocking.
	 *
	 * Set to `0` to disable the timeout and wait indefinitely (legacy behavior).
	 * Defaults to {@link DEFAULT_QUESTION_TIMEOUT_MS}.
	 */
	timeoutMs?: number;
}

/**
 * Default time to wait for a user's response before unblocking the agent.
 * 30 minutes: long enough for an attentive user, short enough to avoid a
 * session hanging for hours on a lost response webhook.
 */
export const DEFAULT_QUESTION_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Handler for presenting AskUserQuestion tool calls to users via Linear's select signal.
 *
 * Usage:
 * 1. Create handler instance with dependencies
 * 2. Call `handleAskUserQuestion()` when Claude uses the AskUserQuestion tool
 * 3. The handler posts an elicitation to Linear and returns a promise
 * 4. When the "prompted" webhook arrives, call `handleUserResponse()` to resolve the promise
 */
export class AskUserQuestionHandler {
	private deps: AskUserQuestionHandlerDeps;
	private logger: ILogger;
	private timeoutMs: number;

	/**
	 * Map of agent session ID to pending question data.
	 * Used to track questions awaiting user response.
	 */
	private pendingQuestions: Map<string, PendingQuestion> = new Map();

	constructor(
		deps: AskUserQuestionHandlerDeps,
		config?: AskUserQuestionHandlerConfig,
		logger?: ILogger,
	) {
		this.deps = deps;
		this.timeoutMs = config?.timeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS;
		this.logger =
			logger ?? createLogger({ component: "AskUserQuestionHandler" });
	}

	/**
	 * Handle an AskUserQuestion tool call by presenting it to the user via Linear.
	 *
	 * This method:
	 * 1. Validates the input (only 1 question allowed)
	 * 2. Posts an elicitation activity to Linear with the select signal
	 * 3. Returns a promise that resolves when the user responds
	 *
	 * @param input - The AskUserQuestion tool input (must contain exactly 1 question)
	 * @param linearAgentSessionId - Linear agent session ID (for tracking and API calls)
	 * @param organizationId - Linear organization/workspace ID
	 * @param signal - AbortSignal for cancellation
	 * @returns Promise resolving to the user's answer or denial
	 */
	async handleAskUserQuestion(
		input: AskUserQuestionInput,
		linearAgentSessionId: string,
		organizationId: string,
		signal: AbortSignal,
	): Promise<AskUserQuestionResult> {
		// Validate: only 1 question at a time
		if (!input.questions || input.questions.length !== 1) {
			this.logger.error(
				`Invalid input: expected exactly 1 question, got ${input.questions?.length ?? 0}`,
			);
			return {
				answered: false,
				message:
					"Only one question at a time is supported. Please ask each question separately.",
			};
		}

		const question = input.questions[0]!;
		this.logger.debug(
			`Handling question for session ${linearAgentSessionId}: ${question.header}`,
		);

		// Check if already cancelled
		if (signal.aborted) {
			return {
				answered: false,
				message: "Operation was cancelled",
			};
		}

		// Get issue tracker
		const issueTracker = this.deps.getIssueTracker(organizationId);
		if (!issueTracker) {
			this.logger.error(
				`No issue tracker found for organization ${organizationId}`,
			);
			return {
				answered: false,
				message: "Issue tracker not available",
			};
		}

		// Check for existing pending question for this session
		if (this.pendingQuestions.has(linearAgentSessionId)) {
			this.logger.warn(
				`Replacing existing pending question for session ${linearAgentSessionId}`,
			);
			this.cancelPendingQuestion(
				linearAgentSessionId,
				"Replaced by new question",
			);
		}

		// Create the options for Linear's select signal
		// Include an "Other" option to allow free-form input
		const options = question.options.map((opt) => ({
			value: opt.label,
		}));
		// Add "Other" option for free-form input
		options.push({ value: "Other" });

		// Build the elicitation body
		// Include the question text and option descriptions for context
		const optionsText = question.options
			.map((opt) => `• **${opt.label}**: ${opt.description}`)
			.join("\n");

		const elicitationBody = `${question.question}\n\n${optionsText}`;

		// Post elicitation to Linear
		try {
			await issueTracker.createAgentActivity({
				agentSessionId: linearAgentSessionId,
				content: {
					type: "elicitation",
					body: elicitationBody,
				},
				signal: AgentActivitySignal.Select,
				signalMetadata: { options },
			});

			this.logger.debug(
				`Posted elicitation with ${options.length} options for session ${linearAgentSessionId}`,
			);
		} catch (error) {
			const errorMessage = (error as Error).message || String(error);
			this.logger.error(`Failed to post elicitation: ${errorMessage}`);
			return {
				answered: false,
				message: `Failed to present question to user: ${errorMessage}`,
			};
		}

		// Create promise to wait for user response.
		// The promise is resolved by exactly one of three paths, all funneled
		// through `finalize`: a user response, session abort, or timeout. A
		// timeout is essential — without it a lost "prompted" webhook leaves the
		// Claude subprocess blocked on this tool result forever.
		return new Promise<AskUserQuestionResult>((resolve) => {
			let settled = false;
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			// Declared before `finalize` so `finalize` can detach the listener
			// without a forward reference; assigned below.
			let abortHandler: () => void;

			// Single resolution path: clear the timeout, detach the abort
			// listener, drop the pending entry, and resolve exactly once.
			const finalize = (result: AskUserQuestionResult) => {
				if (settled) {
					return;
				}
				settled = true;
				if (timeoutId !== undefined) {
					clearTimeout(timeoutId);
				}
				signal.removeEventListener("abort", abortHandler);
				this.pendingQuestions.delete(linearAgentSessionId);
				resolve(result);
			};

			// Setup abort handler for session cancellation
			abortHandler = () => {
				this.logger.debug(
					`Question cancelled for session ${linearAgentSessionId}`,
				);
				finalize({
					answered: false,
					message: "Operation was cancelled",
				});
			};
			signal.addEventListener("abort", abortHandler, { once: true });

			// Guard against a never-delivered response webhook deadlocking the
			// tool call. On timeout, unblock the agent with a denial that tells
			// it to proceed rather than hang.
			if (this.timeoutMs > 0) {
				timeoutId = setTimeout(() => {
					const minutes = Math.round(this.timeoutMs / 60000);
					this.logger.warn(
						`AskUserQuestion for session ${linearAgentSessionId} timed out after ${this.timeoutMs}ms with no response`,
					);
					finalize({
						answered: false,
						message: `No response was received within ${minutes} minute(s). Proceed using your best judgment (for example, your recommended default), and ask again later if you still need the user's decision.`,
					});
				}, this.timeoutMs);
				// Don't let this timer keep the process alive on its own.
				timeoutId.unref?.();
			}

			// Store pending question
			this.pendingQuestions.set(linearAgentSessionId, {
				question,
				resolve: finalize,
				signal,
			});
		});
	}

	/**
	 * Handle user response from the "prompted" webhook event.
	 *
	 * This method is called when Linear sends an AgentSessionPrompted webhook
	 * in response to a select signal elicitation.
	 *
	 * @param linearAgentSessionId - Linear agent session ID
	 * @param selectedValue - The value selected by the user (option label or free text)
	 * @returns true if a pending question was resolved, false if no pending question found
	 */
	handleUserResponse(
		linearAgentSessionId: string,
		selectedValue: string,
	): boolean {
		const pendingQuestion = this.pendingQuestions.get(linearAgentSessionId);
		if (!pendingQuestion) {
			this.logger.debug(
				`No pending question found for session ${linearAgentSessionId}`,
			);
			return false;
		}

		this.logger.debug(
			`User responded to question for session ${linearAgentSessionId}: ${selectedValue}`,
		);

		// Build the answers map
		// The key is the question text, the value is the selected option
		const answers: AskUserQuestionAnswers = {
			[pendingQuestion.question.question]: selectedValue,
		};

		// Resolve the pending promise
		pendingQuestion.resolve({
			answered: true,
			answers,
		});

		return true;
	}

	/**
	 * Check if there's a pending question for this agent session.
	 *
	 * @param linearAgentSessionId - Linear agent session ID
	 * @returns true if there's a pending question
	 */
	hasPendingQuestion(linearAgentSessionId: string): boolean {
		return this.pendingQuestions.has(linearAgentSessionId);
	}

	/**
	 * Cancel a pending question.
	 *
	 * @param linearAgentSessionId - Linear agent session ID
	 * @param reason - Reason for cancellation
	 */
	cancelPendingQuestion(linearAgentSessionId: string, reason: string): void {
		const pendingQuestion = this.pendingQuestions.get(linearAgentSessionId);
		if (pendingQuestion) {
			this.logger.debug(
				`Cancelling pending question for session ${linearAgentSessionId}: ${reason}`,
			);
			pendingQuestion.resolve({
				answered: false,
				message: reason,
			});
		}
	}

	/**
	 * Get the number of pending questions (for debugging/monitoring).
	 */
	get pendingCount(): number {
		return this.pendingQuestions.size;
	}
}
