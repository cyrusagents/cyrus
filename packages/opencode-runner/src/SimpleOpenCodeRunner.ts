import type { SDKMessage } from "cyrus-core";
import {
	NoResponseError,
	SessionError,
	type SimpleAgentQueryOptions,
	SimpleAgentRunner,
} from "cyrus-simple-agent-runner";
import { OpenCodeRunner } from "./OpenCodeRunner.js";

export class SimpleOpenCodeRunner<
	T extends string,
> extends SimpleAgentRunner<T> {
	protected async executeAgent(
		prompt: string,
		options?: SimpleAgentQueryOptions,
	): Promise<SDKMessage[]> {
		const messages: SDKMessage[] = [];
		let sessionError: Error | null = null;
		const fullPrompt = options?.context
			? `${options.context}\n\n${prompt}`
			: prompt;

		const runner = new OpenCodeRunner({
			workingDirectory: this.config.workingDirectory,
			cyrusHome: this.config.cyrusHome,
			model: this.config.model,
			fallbackModel: this.config.fallbackModel,
			maxTurns: this.config.maxTurns,
			appendSystemPrompt: this.buildSystemPrompt(),
			disallowedTools: options?.allowFileReading
				? []
				: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
			allowedDirectories: options?.allowedDirectories,
		});

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

	protected extractResponse(messages: SDKMessage[]): string {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (
				message?.type === "assistant" &&
				"message" in message &&
				message.message?.content
			) {
				for (const block of message.message.content) {
					if (
						typeof block === "object" &&
						block !== null &&
						"type" in block &&
						block.type === "text" &&
						"text" in block
					) {
						const cleaned = this.cleanResponse(String(block.text));
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

	private cleanResponse(text: string): string {
		const cleaned = text
			.replace(/```[\s\S]*?```/g, "")
			.replace(/`([^`]+)`/g, "$1")
			.replace(/^["']|["']$/g, "")
			.trim();

		for (const line of cleaned.split("\n").map((line) => line.trim())) {
			if (this.isValidResponse(line)) {
				return line;
			}
		}

		return cleaned;
	}

	private handleMessage(message: SDKMessage): void {
		if (
			message.type !== "assistant" ||
			!("message" in message) ||
			!message.message?.content
		) {
			return;
		}

		for (const block of message.message.content) {
			if (typeof block !== "object" || block === null || !("type" in block)) {
				continue;
			}
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
