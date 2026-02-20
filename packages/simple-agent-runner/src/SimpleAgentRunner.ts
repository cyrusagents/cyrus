import type { ISimpleAgentRunner, SDKMessage } from "cyrus-core";
import {
	InvalidResponseError,
	SimpleAgentError,
	SimpleAgentErrorCode,
} from "./errors.js";
import type {
	AgentProgressEvent,
	SimpleAgentQueryOptions,
	SimpleAgentResult,
	SimpleAgentRunnerConfig,
} from "./types.js";

/**
 * Abstract base class for simple agent runners that return enumerated responses.
 *
 * This class provides the core validation and flow control logic, while
 * concrete implementations provide the actual agent execution.
 */
export abstract class SimpleAgentRunner<T extends string>
	implements ISimpleAgentRunner<T>
{
	protected readonly config: SimpleAgentRunnerConfig<T>;
	protected readonly validResponseSet: Set<T>;

	constructor(config: SimpleAgentRunnerConfig<T>) {
		this.validateConfig(config);
		this.config = config;
		this.validResponseSet = new Set(config.validResponses);
	}

	/**
	 * Execute the agent with the given prompt and return a validated response.
	 *
	 * @param prompt - The question or instruction for the agent
	 * @param options - Optional query configuration
	 * @returns A validated response from the enumerated set
	 * @throws {InvalidResponseError} If agent returns invalid response
	 * @throws {TimeoutError} If execution times out
	 * @throws {NoResponseError} If agent produces no response
	 * @throws {SessionError} If underlying session fails
	 */
	async query(
		prompt: string,
		options?: SimpleAgentQueryOptions,
	): Promise<SimpleAgentResult<T>> {
		const startTime = Date.now();

		try {
			// Set up timeout if configured
			const timeoutPromise = this.config.timeoutMs
				? new Promise<never>((_, reject) => {
						setTimeout(() => {
							reject(
								new SimpleAgentError(
									SimpleAgentErrorCode.TIMEOUT,
									`Operation timed out after ${this.config.timeoutMs}ms`,
								),
							);
						}, this.config.timeoutMs);
					})
				: null;

			// Execute the agent (delegated to concrete implementation)
			const executionPromise = this.executeAgent(prompt, options);

			// Race between execution and timeout
			const messages = timeoutPromise
				? await Promise.race([executionPromise, timeoutPromise])
				: await executionPromise;

			// Extract and validate response
			const response = this.extractResponse(messages);

			if (!this.isValidResponse(response)) {
				throw new InvalidResponseError(
					response,
					Array.from(this.validResponseSet),
				);
			}

			const durationMs = Date.now() - startTime;

			// Extract session metadata
			const sessionId = messages[0]?.session_id || null;
			const resultMessage = messages.find((m) => m.type === "result");
			const costUSD =
				resultMessage?.type === "result"
					? resultMessage.total_cost_usd
					: undefined;

			return {
				response: response as T,
				messages,
				sessionId,
				durationMs,
				costUSD,
			};
		} catch (error) {
			if (error instanceof SimpleAgentError) {
				throw error;
			}

			throw new SimpleAgentError(
				SimpleAgentErrorCode.SESSION_ERROR,
				error instanceof Error ? error.message : String(error),
				{ originalError: error },
			);
		}
	}

	/**
	 * Validate the configuration
	 */
	private validateConfig(config: SimpleAgentRunnerConfig<T>): void {
		if (!config.validResponses || config.validResponses.length === 0) {
			throw new SimpleAgentError(
				SimpleAgentErrorCode.INVALID_CONFIG,
				"validResponses must be a non-empty array",
			);
		}

		// Check for duplicates
		const uniqueResponses = new Set(config.validResponses);
		if (uniqueResponses.size !== config.validResponses.length) {
			throw new SimpleAgentError(
				SimpleAgentErrorCode.INVALID_CONFIG,
				"validResponses contains duplicate values",
			);
		}

		if (!config.cyrusHome) {
			throw new SimpleAgentError(
				SimpleAgentErrorCode.INVALID_CONFIG,
				"cyrusHome is required",
			);
		}
	}

	/**
	 * Check if a response is valid
	 */
	protected isValidResponse(response: string): response is T {
		return this.validResponseSet.has(response as T);
	}

	/**
	 * Build the complete system prompt
	 */
	protected buildSystemPrompt(): string {
		const basePrompt = this.config.systemPrompt || "";
		const validResponsesStr = Array.from(this.validResponseSet)
			.map((r) => `"${r}"`)
			.join(", ");

		const constraintPrompt = `
IMPORTANT: You must respond with EXACTLY one of the following values:
${validResponsesStr}

Your final response MUST be one of these exact strings, with no additional text, explanation, or formatting.
Do not use markdown, code blocks, or quotes around your response.
Simply output the chosen value as your final answer.
`;

		return `${basePrompt}\n\n${constraintPrompt}`;
	}

	/**
	 * Emit a progress event if callback is configured
	 */
	protected emitProgress(event: AgentProgressEvent): void {
		if (this.config.onProgress) {
			this.config.onProgress(event);
		}
	}

	/**
	 * Abstract method: Execute the agent and return messages.
	 * Concrete implementations must provide this.
	 */
	protected abstract executeAgent(
		prompt: string,
		options?: SimpleAgentQueryOptions,
	): Promise<SDKMessage[]>;

	/**
	 * Abstract method: Extract the final response from messages.
	 * Concrete implementations must provide this.
	 */
	protected abstract extractResponse(messages: SDKMessage[]): string;
}
