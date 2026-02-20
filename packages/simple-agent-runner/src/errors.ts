import type { SDKMessage } from "cyrus-core";

/**
 * Error codes for SimpleAgentRunner operations
 */
export enum SimpleAgentErrorCode {
	/** Agent returned a response not in the valid set */
	INVALID_RESPONSE = "INVALID_RESPONSE",

	/** Agent execution timed out */
	TIMEOUT = "TIMEOUT",

	/** Agent failed to produce any response */
	NO_RESPONSE = "NO_RESPONSE",

	/** Agent session encountered an error */
	SESSION_ERROR = "SESSION_ERROR",

	/** Configuration is invalid */
	INVALID_CONFIG = "INVALID_CONFIG",

	/** Agent was aborted */
	ABORTED = "ABORTED",

	/** Agent exceeded maximum turns without response */
	MAX_TURNS_EXCEEDED = "MAX_TURNS_EXCEEDED",
}

/**
 * Base error class for SimpleAgentRunner errors
 */
export class SimpleAgentError extends Error {
	constructor(
		public readonly code: SimpleAgentErrorCode,
		message: string,
		public readonly details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "SimpleAgentError";

		// Maintain proper stack trace in V8
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, SimpleAgentError);
		}
	}

	/**
	 * Create a formatted error message with details
	 */
	toDetailedString(): string {
		let msg = `${this.name} [${this.code}]: ${this.message}`;
		if (this.details && Object.keys(this.details).length > 0) {
			msg += `\nDetails: ${JSON.stringify(this.details, null, 2)}`;
		}
		return msg;
	}
}

/**
 * Error thrown when agent returns an invalid response
 */
export class InvalidResponseError extends SimpleAgentError {
	constructor(
		public readonly receivedResponse: string,
		public readonly validResponses: readonly string[],
	) {
		super(
			SimpleAgentErrorCode.INVALID_RESPONSE,
			`Agent returned invalid response: "${receivedResponse}". Valid responses: [${validResponses.join(", ")}]`,
			{ receivedResponse, validResponses },
		);
		this.name = "InvalidResponseError";
	}
}

/**
 * Error thrown when agent execution times out
 */
export class TimeoutError extends SimpleAgentError {
	constructor(
		public readonly timeoutMs: number,
		public readonly partialMessages?: SDKMessage[],
	) {
		super(
			SimpleAgentErrorCode.TIMEOUT,
			`Agent execution timed out after ${timeoutMs}ms`,
			{ timeoutMs, messageCount: partialMessages?.length },
		);
		this.name = "TimeoutError";
	}
}

/**
 * Error thrown when agent produces no response
 */
export class NoResponseError extends SimpleAgentError {
	constructor(public readonly messages: SDKMessage[]) {
		super(
			SimpleAgentErrorCode.NO_RESPONSE,
			"Agent completed without producing a valid response",
			{ messageCount: messages.length },
		);
		this.name = "NoResponseError";
	}
}

/**
 * Error thrown when max turns exceeded
 */
export class MaxTurnsExceededError extends SimpleAgentError {
	constructor(
		public readonly maxTurns: number,
		public readonly messages: SDKMessage[],
	) {
		super(
			SimpleAgentErrorCode.MAX_TURNS_EXCEEDED,
			`Agent exceeded maximum turns (${maxTurns}) without valid response`,
			{ maxTurns, messageCount: messages.length },
		);
		this.name = "MaxTurnsExceededError";
	}
}

/**
 * Error thrown when session encounters an error
 */
export class SessionError extends SimpleAgentError {
	constructor(
		public readonly cause: Error,
		public readonly messages?: SDKMessage[],
	) {
		super(
			SimpleAgentErrorCode.SESSION_ERROR,
			`Agent session error: ${cause.message}`,
			{ cause: cause.message, stack: cause.stack },
		);
		this.name = "SessionError";
	}
}
