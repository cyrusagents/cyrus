import crypto from "node:crypto";
import { cwd } from "node:process";
import type { SDKSystemMessage } from "cyrus-claude-runner";
import type {
	SDKAssistantMessage,
	SDKMessage,
	SDKResultMessage,
	SDKUserMessage,
} from "cyrus-core";
import type {
	GeminiInitEvent,
	GeminiMessageEvent,
	GeminiStreamEvent,
} from "./types.js";

/**
 * Create a minimal BetaMessage for assistant responses
 *
 * Since we're adapting from Gemini CLI to Claude SDK format, we create
 * a minimal valid BetaMessage structure with placeholder values for fields
 * that Gemini doesn't provide (model, usage, etc.).
 */
function createBetaMessage(
	content: string | Array<Record<string, unknown>>,
	messageId: string = crypto.randomUUID(),
): SDKAssistantMessage["message"] {
	// Type assertion needed because we're constructing content blocks from Gemini format
	// which has the same structure but TypeScript can't verify the runtime types
	const contentBlocks = (typeof content === "string"
		? [{ type: "text", text: content }]
		: content) as unknown as SDKAssistantMessage["message"]["content"];

	return {
		id: messageId,
		type: "message" as const,
		role: "assistant" as const,
		content: contentBlocks,
		model: "gemini-3" as const,
		stop_reason: null,
		stop_sequence: null,
		usage: {
			input_tokens: 0,
			output_tokens: 0,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
			cache_creation: null,
			server_tool_use: null,
			service_tier: null,
			inference_geo: null,
			iterations: null,
		},
		container: null,
		context_management: null,
	};
}

/**
 * Convert a Gemini stream event to cyrus-core SDKMessage format
 *
 * This adapter maps Gemini CLI's streaming events to the cyrus-core SDKMessage
 * format, allowing GeminiRunner to implement the IAgentRunner interface.
 *
 * NOTE: This adapter is stateless and creates a separate SDK message for each event.
 * For delta messages (message events with delta: true), the caller (GeminiRunner)
 * should accumulate multiple delta events into a single message before emitting.
 *
 * @param event - Gemini CLI stream event
 * @param sessionId - Current session ID (may be null initially)
 * @param lastAssistantMessage - Last assistant message for result coercion (optional)
 * @returns SDKMessage or null if event type doesn't map to a message
 */
export function geminiEventToSDKMessage(
	event: GeminiStreamEvent,
	sessionId: string | null,
	lastAssistantMessage?: SDKAssistantMessage | null,
): SDKMessage | null {
	switch (event.type) {
		case "message": {
			const messageEvent = event as GeminiMessageEvent;
			if (messageEvent.role === "user") {
				const userMessage: SDKUserMessage = {
					type: "user",
					message: {
						role: "user",
						content: messageEvent.content,
					},
					parent_tool_use_id: null,
					session_id: sessionId || "pending",
				};
				return userMessage;
			} else {
				// Assistant message - create full BetaMessage structure
				const assistantMessage: SDKAssistantMessage = {
					type: "assistant",
					message: createBetaMessage(messageEvent.content),
					parent_tool_use_id: null,
					uuid: crypto.randomUUID(),
					session_id: sessionId || "pending",
				};
				return assistantMessage;
			}
		}

		case "init": {
			const initEvent = event as GeminiInitEvent;
			const systemMessage: SDKSystemMessage = {
				type: "system",
				subtype: "init",
				agents: undefined,
				apiKeySource: "user",
				claude_code_version: "gemini-adapter",
				cwd: cwd(),
				tools: [],
				mcp_servers: [],
				model: initEvent.model,
				permissionMode: "default",
				slash_commands: [],
				output_style: "default",
				skills: [],
				plugins: [],
				uuid: crypto.randomUUID(),
				session_id: initEvent.session_id,
			};
			return systemMessage;
		}

		case "tool_use": {
			// Map to Claude's tool_use format
			// NOTE: Use tool_id from Gemini CLI, not generated client-side
			const toolUseMessage: SDKAssistantMessage = {
				type: "assistant",
				message: createBetaMessage([
					{
						type: "tool_use",
						id: event.tool_id, // Use tool_id from Gemini CLI
						name: event.tool_name,
						input: event.parameters,
					},
				]),
				parent_tool_use_id: null,
				uuid: crypto.randomUUID(),
				session_id: sessionId || "pending",
			};
			return toolUseMessage;
		}

		case "tool_result": {
			// Map to Claude's tool_result format
			// NOTE: Use tool_id from Gemini (matches tool_use event)
			// Handle both success (output) and error cases
			let content: string;
			let isError = false;

			if (event.status === "error" && event.error) {
				// Format error message
				content = `Error: ${event.error.message}`;
				if (event.error.code) {
					content += ` (code: ${event.error.code})`;
				}
				if (event.error.type) {
					content += ` [${event.error.type}]`;
				}
				isError = true;
			} else if (event.output !== undefined) {
				// Success case with output
				content = event.output;
			} else {
				// Fallback for empty success
				content = "Success";
			}

			const toolResultMessage: SDKUserMessage = {
				type: "user",
				message: {
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: event.tool_id, // Use tool_id from Gemini CLI
							content: content,
							is_error: isError,
						},
					],
				},
				parent_tool_use_id: null,
				session_id: sessionId || "pending",
			};
			return toolResultMessage;
		}

		case "result": {
			// Final result event - map to SDKResultMessage
			// Contains stats and final status (success or error)
			const stats = event.stats || {};
			const durationMs = stats.duration_ms || 0;

			if (event.status === "success") {
				// Extract result content from last assistant message if available
				// This ensures the result contains the actual final output, not just metadata
				let resultContent = "Session completed successfully";
				if (lastAssistantMessage?.message?.content) {
					const content = lastAssistantMessage.message.content;
					if (Array.isArray(content) && content.length > 0) {
						const textBlock = content.find((block) => block.type === "text");
						if (textBlock && "text" in textBlock) {
							resultContent = textBlock.text;
						}
					}
				}

				const resultMessage: SDKResultMessage = {
					type: "result",
					subtype: "success",
					duration_ms: durationMs,
					duration_api_ms: 0, // Gemini doesn't separate API time
					is_error: false,
					num_turns: stats.tool_calls || 0, // Use tool calls as proxy for turns
					result: resultContent,
					stop_reason: null,
					total_cost_usd: 0, // Gemini doesn't provide cost info
					usage: {
						input_tokens: stats.input_tokens || 0,
						output_tokens: stats.output_tokens || 0,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation: {
							ephemeral_1h_input_tokens: 0,
							ephemeral_5m_input_tokens: 0,
						},
						server_tool_use: {
							web_fetch_requests: 0,
							web_search_requests: 0,
						},
						service_tier: "standard" as const,
						inference_geo: "",
						iterations: [],
					},
					modelUsage: {},
					permission_denials: [],
					uuid: crypto.randomUUID(),
					session_id: sessionId || "pending",
				};
				return resultMessage;
			} else {
				// Error case
				const errorMessage: SDKResultMessage = {
					type: "result",
					subtype: "error_during_execution",
					duration_ms: durationMs,
					duration_api_ms: 0,
					is_error: true,
					num_turns: stats.tool_calls || 0,
					stop_reason: null,
					errors: [event.error?.message || "Unknown error"],
					total_cost_usd: 0,
					usage: {
						input_tokens: stats.input_tokens || 0,
						output_tokens: stats.output_tokens || 0,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation: {
							ephemeral_1h_input_tokens: 0,
							ephemeral_5m_input_tokens: 0,
						},
						server_tool_use: {
							web_fetch_requests: 0,
							web_search_requests: 0,
						},
						service_tier: "standard" as const,
						inference_geo: "",
						iterations: [],
					},
					modelUsage: {},
					permission_denials: [],
					uuid: crypto.randomUUID(),
					session_id: sessionId || "pending",
				};
				return errorMessage;
			}
		}

		case "error": {
			// Non-fatal error event - map to error result message
			const errorMessage: SDKResultMessage = {
				type: "result",
				subtype: "error_during_execution",
				duration_ms: 0,
				duration_api_ms: 0,
				is_error: true,
				num_turns: 0,
				stop_reason: null,
				errors: [event.message],
				total_cost_usd: 0,
				usage: {
					input_tokens: 0,
					output_tokens: 0,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation: {
						ephemeral_1h_input_tokens: 0,
						ephemeral_5m_input_tokens: 0,
					},
					server_tool_use: {
						web_fetch_requests: 0,
						web_search_requests: 0,
					},
					service_tier: "standard" as const,
					inference_geo: "",
					iterations: [],
				},
				modelUsage: {},
				permission_denials: [],
				uuid: crypto.randomUUID(),
				session_id: sessionId || "pending",
			};
			return errorMessage;
		}

		default:
			return null;
	}
}

/**
 * Create a Cyrus Core SDK UserMessage from a plain string prompt
 *
 * Helper function to create properly formatted SDKUserMessage objects
 * for the Gemini CLI input.
 *
 * @param content - The prompt text
 * @param sessionId - Current session ID (may be null for initial message)
 * @returns Formatted SDKUserMessage
 */
export function createUserMessage(
	content: string,
	sessionId: string | null,
): SDKUserMessage {
	return {
		type: "user",
		message: {
			role: "user",
			content: content,
		},
		parent_tool_use_id: null,
		session_id: sessionId || "pending",
	};
}

/**
 * Extract session ID from Gemini init event
 *
 * @param event - Gemini stream event
 * @returns Session ID if event is init type, null otherwise
 */
export function extractSessionId(event: GeminiStreamEvent): string | null {
	if (event.type === "init") {
		return event.session_id;
	}
	return null;
}
