/**
 * ProcedureAnalyzer - Intelligent analysis of agent sessions to determine procedures
 *
 * Uses a SimpleAgentRunner (Claude, Gemini, Codex, or Cursor) to analyze requests
 * and determine which procedure (sequence of subroutines) should be executed.
 */

import { SimpleCodexRunner } from "cyrus-codex-runner";
import {
	type CyrusAgentSession,
	createLogger,
	type ILogger,
	type ISimpleAgentRunner,
} from "cyrus-core";
import { SimpleCursorRunner } from "cyrus-cursor-runner";
import { SimpleGeminiRunner } from "cyrus-gemini-runner";
import { SimpleClaudeRunner } from "cyrus-simple-agent-runner";
import { getProcedureForClassification, PROCEDURES } from "./registry.js";
import type {
	ProcedureAnalysisDecision,
	ProcedureDefinition,
	ProcedureMetadata,
	RequestClassification,
	SubroutineDefinition,
} from "./types.js";

export type SimpleRunnerType = "claude" | "gemini" | "codex" | "cursor";

export interface ProcedureAnalyzerConfig {
	cyrusHome: string;
	model?: string;
	timeoutMs?: number;
	runnerType?: SimpleRunnerType; // Default: "claude"
	logger?: ILogger;
}

export class ProcedureAnalyzer {
	private analysisRunner: ISimpleAgentRunner<RequestClassification>;
	private procedures: Map<string, ProcedureDefinition> = new Map();
	private logger: ILogger;

	constructor(config: ProcedureAnalyzerConfig) {
		this.logger =
			config.logger ?? createLogger({ component: "ProcedureAnalyzer" });

		// Determine which runner to use
		const runnerType = config.runnerType || "claude";

		// Use runner-specific default models if not provided
		const defaultModels: Record<
			SimpleRunnerType,
			{ model: string; fallback: string }
		> = {
			claude: { model: "haiku", fallback: "sonnet" },
			gemini: {
				model: "gemini-2.5-flash-lite",
				fallback: "gemini-2.0-flash-exp",
			},
			codex: { model: "gpt-5", fallback: "gpt-5" },
			cursor: { model: "gpt-5", fallback: "gpt-5" },
		};
		const defaults = defaultModels[runnerType];

		// Create runner configuration
		const runnerConfig = {
			validResponses: [
				"question",
				"documentation",
				"transient",
				"planning",
				"code",
				"debugger",
				"orchestrator",
				"user-testing",
				"release",
			] as const,
			cyrusHome: config.cyrusHome,
			model: config.model || defaults.model,
			fallbackModel: defaults.fallback,
			systemPrompt: this.buildAnalysisSystemPrompt(),
			maxTurns: 1,
			timeoutMs: config.timeoutMs || 10000,
		};

		// Initialize the appropriate runner based on type
		this.analysisRunner =
			runnerType === "claude"
				? new SimpleClaudeRunner(runnerConfig)
				: runnerType === "gemini"
					? new SimpleGeminiRunner(runnerConfig)
					: runnerType === "codex"
						? new SimpleCodexRunner(runnerConfig)
						: new SimpleCursorRunner(runnerConfig);

		// Load all predefined procedures from registry
		this.loadPredefinedProcedures();
	}

	/**
	 * Build the system prompt for request analysis and classification
	 */
	private buildAnalysisSystemPrompt(): string {
		return `You are a request classifier for a software agent system.

Analyze the Linear issue request and classify it into ONE of these categories:

**question**: User is asking a question, seeking information, or requesting explanation.
- Examples: "How does X work?", "What is the purpose of Y?", "Explain the architecture"

**documentation**: User wants documentation, markdown, or comments edited (no code changes).
- Examples: "Update the README", "Add docstrings to functions", "Fix typos in docs"

**transient**: Request involves MCP tools, temporary files, or no codebase interaction.
- Examples: "Search the web for X", "Generate a diagram", "Use Linear MCP to check issues"

**planning**: Request has vague requirements, needs clarification, or asks for an implementation plan.
- Examples: "Can you help with the authentication system?", "I need to improve performance", "Add a new feature for user management"
- Use when requirements are unclear, missing details, or user asks for a plan/proposal
- DO NOT use if the request has clear, specific requirements (use "code" instead)
- DO NOT use for adding/writing tests, fixing tests, or other test-related work (use "code" instead)

**debugger**: User EXPLICITLY requests the full debugging workflow with reproduction and approval.
- ONLY use this if the user specifically asks for: "debug this with approval workflow", "reproduce the bug first", "show me the root cause before fixing"
- DO NOT use for regular bug reports - those should use "code"
- Examples: "Debug this issue and get my approval before fixing", "Reproduce the authentication bug with approval checkpoint"

**orchestrator**: User EXPLICITLY requests decomposition into sub-issues with specialized agent delegation.
- ONLY use this if the user specifically asks for: "break this into sub-issues", "orchestrate this work", "use sub-agents", "delegate to specialized agents"
- DO NOT use for regular complex work - those should use "code"
- Examples: "Orchestrate this feature with sub-issues", "Break this down and delegate to specialized agents", "Create sub-tasks for this epic"

**code**: Request involves code changes with clear, specific requirements (DEFAULT for most work).
- Examples: "Fix bug in X", "Add feature Y", "Refactor module Z", "Implement new API endpoint", "Fix the login issue"
- Use this for ALL standard bug fixes and features with clear requirements
- Use this for ALL test-related work: "Add unit tests", "Fix failing tests", "Write test coverage", etc.
- Use this when user explicitly says "Classify as full development", "classify as code", or similar

**user-testing**: User EXPLICITLY requests a manual testing or user testing session.
- ONLY use this if the user specifically asks for: "test this for me", "run a testing session", "perform user testing", "manual testing"
- Examples: "Test the login flow manually", "Run user testing on the checkout feature", "Help me test this integration"
- DO NOT use for automated test writing (use "code" instead)
- This is for interactive, user-guided testing sessions

**release**: User EXPLICITLY requests a release, publish, or deployment workflow.
- ONLY use this if the user specifically asks for: "release", "publish", "deploy to npm", "create a release", "publish packages"
- Examples: "Release the new version", "Publish to npm", "Create a new release", "Deploy version 1.2.0"
- DO NOT use for regular code changes that mention versions (use "code" instead)
- This is for executing the full release/publish workflow

IMPORTANT: Respond with ONLY the classification word, nothing else.`;
	}

	/**
	 * Load predefined procedures from registry
	 */
	private loadPredefinedProcedures(): void {
		for (const [name, procedure] of Object.entries(PROCEDURES)) {
			this.procedures.set(name, procedure);
		}
	}

	/**
	 * Analyze a request and determine which procedure to use
	 */
	async determineRoutine(
		requestText: string,
	): Promise<ProcedureAnalysisDecision> {
		try {
			// Classify the request using analysis runner
			const result = await this.analysisRunner.query(
				`Classify this Linear issue request:\n\n${requestText}`,
			);

			const classification = result.response;

			// Get procedure name for this classification
			const procedureName = getProcedureForClassification(classification);

			// Get procedure definition
			const procedure = this.procedures.get(procedureName);

			if (!procedure) {
				throw new Error(`Procedure "${procedureName}" not found in registry`);
			}

			return {
				classification,
				procedure,
				reasoning: `Classified as "${classification}" → using procedure "${procedureName}"`,
			};
		} catch (error) {
			// Fallback to full-development on error
			this.logger.info("Error during analysis:", error);
			const fallbackProcedure = this.procedures.get("full-development");

			if (!fallbackProcedure) {
				throw new Error("Fallback procedure 'full-development' not found");
			}

			return {
				classification: "code",
				procedure: fallbackProcedure,
				reasoning: `Fallback to full-development due to error: ${error}`,
			};
		}
	}

	/**
	 * Get the next subroutine for a session
	 * Returns null if procedure is complete
	 */
	getNextSubroutine(session: CyrusAgentSession): SubroutineDefinition | null {
		const procedureMetadata = session.metadata?.procedure as
			| ProcedureMetadata
			| undefined;

		if (!procedureMetadata) {
			// No procedure metadata - session doesn't use procedures
			return null;
		}

		const procedure = this.procedures.get(procedureMetadata.procedureName);

		if (!procedure) {
			this.logger.error(
				`Procedure "${procedureMetadata.procedureName}" not found`,
			);
			return null;
		}

		const nextIndex = procedureMetadata.currentSubroutineIndex + 1;

		if (nextIndex >= procedure.subroutines.length) {
			// Procedure complete
			return null;
		}

		return procedure.subroutines[nextIndex] ?? null;
	}

	/**
	 * Get the current subroutine for a session
	 */
	getCurrentSubroutine(
		session: CyrusAgentSession,
	): SubroutineDefinition | null {
		const procedureMetadata = session.metadata?.procedure as
			| ProcedureMetadata
			| undefined;

		if (!procedureMetadata) {
			return null;
		}

		const procedure = this.procedures.get(procedureMetadata.procedureName);

		if (!procedure) {
			return null;
		}

		const currentIndex = procedureMetadata.currentSubroutineIndex;

		if (currentIndex < 0 || currentIndex >= procedure.subroutines.length) {
			return null;
		}

		return procedure.subroutines[currentIndex] ?? null;
	}

	/**
	 * Initialize procedure metadata for a new session
	 */
	initializeProcedureMetadata(
		session: CyrusAgentSession,
		procedure: ProcedureDefinition,
	): void {
		if (!session.metadata) {
			session.metadata = {};
		}

		session.metadata.procedure = {
			procedureName: procedure.name,
			currentSubroutineIndex: 0,
			subroutineHistory: [],
		} satisfies ProcedureMetadata;
	}

	/**
	 * Record subroutine completion and advance to next
	 */
	advanceToNextSubroutine(
		session: CyrusAgentSession,
		sessionId: string | null,
		result?: string,
	): void {
		const procedureMetadata = session.metadata?.procedure as
			| ProcedureMetadata
			| undefined;

		if (!procedureMetadata) {
			throw new Error("Cannot advance: session has no procedure metadata");
		}

		const currentSubroutine = this.getCurrentSubroutine(session);

		if (currentSubroutine) {
			// Determine which type of session ID this is
			const isCodexSession = session.codexSessionId !== undefined;
			const isGeminiSession =
				!isCodexSession && session.geminiSessionId !== undefined;

			// Record completion with the appropriate session ID
			procedureMetadata.subroutineHistory.push({
				subroutine: currentSubroutine.name,
				completedAt: Date.now(),
				claudeSessionId: isGeminiSession || isCodexSession ? null : sessionId,
				geminiSessionId: isGeminiSession ? sessionId : null,
				codexSessionId: isCodexSession ? sessionId : null,
				...(result !== undefined && { result }),
			});
		}

		// Advance index
		procedureMetadata.currentSubroutineIndex++;
	}

	/**
	 * Get the result from the last completed subroutine in the history.
	 * Returns null if there is no history or no result stored.
	 */
	getLastSubroutineResult(session: CyrusAgentSession): string | null {
		const procedureMetadata = session.metadata?.procedure as
			| ProcedureMetadata
			| undefined;

		if (!procedureMetadata) {
			return null;
		}

		const history = procedureMetadata.subroutineHistory;
		if (history.length === 0) {
			return null;
		}

		return history[history.length - 1]?.result ?? null;
	}

	/**
	 * Check if procedure is complete
	 */
	isProcedureComplete(session: CyrusAgentSession): boolean {
		return this.getNextSubroutine(session) === null;
	}

	/**
	 * Register a custom procedure
	 */
	registerProcedure(procedure: ProcedureDefinition): void {
		this.procedures.set(procedure.name, procedure);
	}

	/**
	 * Get procedure by name
	 */
	getProcedure(name: string): ProcedureDefinition | undefined {
		return this.procedures.get(name);
	}
}
