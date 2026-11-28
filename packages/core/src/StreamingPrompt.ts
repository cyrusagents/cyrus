import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * Streaming prompt controller that implements AsyncIterable<SDKUserMessage>
 *
 * Provides a queue-based async iterator for streaming user messages to agent runners.
 * Used by both ClaudeRunner and GeminiRunner for streaming input support.
 */
export class StreamingPrompt {
	private messageQueue: SDKUserMessage[] = [];
	private resolvers: Array<(value: IteratorResult<SDKUserMessage>) => void> =
		[];
	private isComplete = false;
	private sessionId: string | null;

	constructor(sessionId: string | null, initialPrompt?: string) {
		this.sessionId = sessionId;
		if (initialPrompt) {
			this.addMessage(initialPrompt);
		}
	}

	updateSessionId(sessionId: string): void {
		this.sessionId = sessionId;
	}

	addMessage(content: string, options?: { isSynthetic?: boolean }): void {
		if (this.isComplete) {
			throw new Error("Cannot add message to completed stream");
		}

		const message: SDKUserMessage = {
			type: "user",
			message: {
				role: "user",
				content: content,
			},
			parent_tool_use_id: null,
			session_id: this.sessionId || "pending",
			...(options?.isSynthetic ? { isSynthetic: true } : {}),
		};

		this.messageQueue.push(message);
		this.processQueue();
	}

	complete(): void {
		this.isComplete = true;
		this.processQueue();
	}

	get completed(): boolean {
		return this.isComplete;
	}

	private processQueue(): void {
		while (
			this.resolvers.length > 0 &&
			(this.messageQueue.length > 0 || this.isComplete)
		) {
			const resolver = this.resolvers.shift()!;

			if (this.messageQueue.length > 0) {
				const message = this.messageQueue.shift()!;
				resolver({ value: message, done: false });
			} else if (this.isComplete) {
				resolver({ value: undefined, done: true });
			}
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		return {
			next: (): Promise<IteratorResult<SDKUserMessage>> => {
				return new Promise((resolve) => {
					if (this.messageQueue.length > 0) {
						const message = this.messageQueue.shift()!;
						resolve({ value: message, done: false });
					} else if (this.isComplete) {
						resolve({ value: undefined, done: true });
					} else {
						this.resolvers.push(resolve);
					}
				});
			},
		};
	}
}
