/**
 * Type definitions for the procedure analysis system
 */

/**
 * Definition of a single subroutine in a procedure
 */
export interface SubroutineDefinition {
	/** Unique identifier for the subroutine */
	name: string;

	/** Path to the prompt file (relative to edge-worker/src/prompts/) */
	promptPath: string;

	/** Whether this subroutine should run in single-turn mode (maxTurns: 1) */
	singleTurn?: boolean;

	/** Human-readable description of what this subroutine does */
	description: string;

	/** Whether this subroutine should skip posting to Linear activity stream */
	skipLinearPost?: boolean;

	/** Whether to suppress posting thoughts/actions (still posts final summary) */
	suppressThoughtPosting?: boolean;

	/** Whether this subroutine requires user approval before advancing to next step */
	requiresApproval?: boolean;

	/** Tools that should be explicitly disallowed during this subroutine */
	disallowedTools?: readonly string[];

	/**
	 * Whether to disallow ALL tool usage during this subroutine.
	 * When true, the agent will only produce text output without any tool calls.
	 * This is useful for summary subroutines where tool usage would cause
	 * the session to appear "hanging" to users in Linear.
	 */
	disallowAllTools?: boolean;

	/**
	 * Whether this subroutine uses the validation loop with retry logic.
	 * When true, the subroutine output is parsed as ValidationResult and
	 * the validation-fixer subroutine is run on failures (up to maxIterations).
	 */
	usesValidationLoop?: boolean;
}

/**
 * Complete definition of a procedure (sequence of subroutines)
 */
export interface ProcedureDefinition {
	/** Unique identifier for the procedure */
	name: string;

	/** Human-readable description of when to use this procedure */
	description: string;

	/** Ordered list of subroutines to execute */
	subroutines: SubroutineDefinition[];
}

/**
 * Validation loop state for subroutines that use retry logic
 */
export interface ValidationLoopMetadata {
	/** Current iteration (1-based) */
	iteration: number;
	/** Whether the loop is in fixer mode (running validation-fixer) */
	inFixerMode: boolean;
	/** Results from each validation attempt */
	attempts: Array<{
		iteration: number;
		pass: boolean;
		reason: string;
		timestamp: number;
	}>;
}

/**
 * Procedure metadata stored in session.metadata.procedure
 */
export interface ProcedureMetadata {
	/** Name of the active procedure */
	procedureName: string;

	/** Current position in the subroutine sequence (0-indexed) */
	currentSubroutineIndex: number;

	/** History of completed subroutines */
	subroutineHistory: Array<{
		subroutine: string;
		completedAt: number;
		claudeSessionId: string | null;
		geminiSessionId: string | null;
		codexSessionId?: string | null;
		/** The result text from the completed subroutine (if available) */
		result?: string;
	}>;

	/** State for validation loop (when current subroutine uses usesValidationLoop) */
	validationLoop?: ValidationLoopMetadata;
}

/**
 * Request classification types for analysis decisions
 */
export type RequestClassification =
	| "question"
	| "documentation"
	| "transient"
	| "planning"
	| "code"
	| "debugger"
	| "orchestrator"
	| "user-testing"
	| "release";

/**
 * Result of procedure analysis decision
 */
export interface ProcedureAnalysisDecision {
	/** Classification of the request */
	classification: RequestClassification;

	/** Selected procedure to execute */
	procedure: ProcedureDefinition;

	/** Reasoning for the classification (for debugging) */
	reasoning?: string;
}
