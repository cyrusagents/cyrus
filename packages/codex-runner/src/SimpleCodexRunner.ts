import type { SDKMessage } from "miko-core";
import {
	NoResponseError,
	SessionError,
	type SimpleAgentQueryOptions,
	SimpleAgentRunner,
} from "miko-simple-agent-runner";
import { CodexRunner } from "./CodexRunner.js";

/**
 * Concrete implementation using CodexRunner from miko-codex-runner package.
 *
 * This implementation uses the Codex SDK to execute queries and
 * constrains the responses to an enumerated set.
 * Uses structured outputs (outputSchema) for reliable response parsing.
 */
export class SimpleCodexRunner<T extends string> extends SimpleAgentRunner<T> {
	/**
	 * Build a JSON Schema that constrains the model output to the valid responses.
	 */
	private buildOutputSchema(): Record<string, unknown> {
		return {
			type: "object",
			properties: {
				classification: {
					type: "string",
					enum: Array.from(this.validResponseSet),
				},
			},
			required: ["classification"],
			additionalProperties: false,
		};
	}

	/**
	 * Execute the agent using CodexRunner
	 */
	protected async executeAgent(
		prompt: string,
		options?: SimpleAgentQueryOptions,
	): Promise<SDKMessage[]> {
		const messages: SDKMessage[] = [];
		let sessionError: Error | null = null;

		// Build the full prompt with context if provided
		const fullPrompt = options?.context
			? `${options.context}\n\n${prompt}`
			: prompt;

		// Create CodexRunner with configuration
		const runner = new CodexRunner({
			workingDirectory: this.config.workingDirectory,
			mikoHome: this.config.mikoHome,
			model: this.config.model,
			fallbackModel: this.config.fallbackModel,
			maxTurns: this.config.maxTurns,
			appendSystemPrompt: this.buildSystemPrompt(),
			// Limit tools for simple queries
			disallowedTools: options?.allowFileReading
				? []
				: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
			allowedDirectories: options?.allowedDirectories,
			outputSchema: this.buildOutputSchema(),
		});

		// Set up event handlers
		runner.on("message", (message) => {
			messages.push(message);
			this.handleMessage(message);
		});

		runner.on("error", (error) => {
			sessionError = error;
		});

		runner.on("complete", () => {
			this.emitProgress({ type: "validating", response: "complete" });
		});

		try {
			this.emitProgress({ type: "started", sessionId: null });
			await runner.start(fullPrompt);

			// Update session ID in progress events
			const sessionId = messages[0]?.session_id || null;
			if (sessionId) {
				this.emitProgress({ type: "started", sessionId });
			}

			if (sessionError) {
				throw new SessionError(sessionError, messages);
			}

			return messages;
		} catch (error) {
			if (error instanceof Error) {
				throw error;
			}
			throw new SessionError(new Error(String(error)), messages);
		}
	}

	/**
	 * Extract the final response from the last assistant message.
	 * Handles both structured JSON output and plain text responses.
	 */
	protected extractResponse(messages: SDKMessage[]): string {
		// Find the last assistant message with text content
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (!message) continue;

			if (
				message.type === "assistant" &&
				"message" in message &&
				message.message?.content
			) {
				// Extract text from content blocks
				for (const block of message.message.content) {
					if (
						typeof block === "object" &&
						block !== null &&
						"type" in block &&
						block.type === "text" &&
						"text" in block
					) {
						const text = (block.text as string).trim();
						// Try parsing as structured JSON output first
						const parsed = this.tryParseStructuredResponse(text);
						if (parsed) {
							this.emitProgress({
								type: "response-detected",
								candidateResponse: parsed,
							});
							return parsed;
						}
						// Fall back to plain text cleaning
						const cleaned = this.cleanResponse(text);
						if (cleaned) {
							this.emitProgress({
								type: "response-detected",
								candidateResponse: cleaned,
							});
							return cleaned;
						}
					}
				}
			}
		}

		throw new NoResponseError(messages);
	}

	/**
	 * Try to parse a structured JSON response (from outputSchema).
	 * Returns the classification value if valid, null otherwise.
	 */
	private tryParseStructuredResponse(text: string): string | null {
		try {
			const parsed = JSON.parse(text);
			if (
				parsed &&
				typeof parsed === "object" &&
				typeof parsed.classification === "string"
			) {
				const value = parsed.classification.trim();
				if (this.isValidResponse(value)) {
					return value;
				}
			}
		} catch {
			// Not JSON, fall through to plain text parsing
		}
		return null;
	}

	/**
	 * Clean the response text to extract the actual value
	 */
	private cleanResponse(text: string): string {
		// Remove markdown code blocks
		let cleaned = text.replace(/```[\s\S]*?```/g, "");

		// Remove inline code
		cleaned = cleaned.replace(/`([^`]+)`/g, "$1");

		// Remove quotes
		cleaned = cleaned.replace(/^["']|["']$/g, "");

		// Trim whitespace
		cleaned = cleaned.trim();

		// If the response is multi-line, try to find a valid response on any line
		const lines = cleaned.split("\n").map((l) => l.trim());
		for (const line of lines) {
			if (this.isValidResponse(line)) {
				return line;
			}
		}

		// Return the cleaned text (will be validated by caller)
		return cleaned;
	}

	/**
	 * Handle incoming messages for progress events
	 */
	private handleMessage(message: SDKMessage): void {
		if (
			message.type === "assistant" &&
			"message" in message &&
			message.message?.content
		) {
			for (const block of message.message.content) {
				if (typeof block === "object" && block !== null && "type" in block) {
					if (block.type === "text" && "text" in block) {
						this.emitProgress({ type: "thinking", text: block.text as string });
					} else if (
						block.type === "tool_use" &&
						"name" in block &&
						"input" in block
					) {
						this.emitProgress({
							type: "tool-use",
							toolName: block.name as string,
							input: block.input,
						});
					}
				}
			}
		}
	}
}
