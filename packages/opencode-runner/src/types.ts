import type {
	AgentRunnerConfig,
	AgentSessionInfo,
	SDKMessage,
} from "cyrus-core";

export type OpenCodeJsonEvent =
	| OpenCodeStepStartEvent
	| OpenCodeTextEvent
	| OpenCodeToolUseEvent
	| OpenCodeStepFinishEvent;

export interface OpenCodeRunnerConfig extends AgentRunnerConfig {
	/** Path to opencode CLI binary (defaults to `opencode` in PATH). */
	openCodePath?: string;
	/** Title passed to `opencode run --title`. */
	title?: string;
	/** Optional OpenCode agent name passed with `--agent`. */
	agent?: string;
	/** Extra environment variables for the OpenCode child process. */
	env?: Record<string, string | undefined>;
	/** OpenCode CLI config/state/cache scope. Defaults to inheriting parent env. */
	opencodeStateScope?: "inherit" | "shared" | "repository";
	/** Stable key used when opencodeStateScope is repository. */
	opencodeStateKey?: string;
}

export interface OpenCodeSessionInfo extends AgentSessionInfo {
	sessionId: string | null;
}

export interface OpenCodeRunnerEvents {
	message: (message: SDKMessage) => void;
	error: (error: Error) => void;
	complete: (messages: SDKMessage[]) => void;
	streamEvent: (event: OpenCodeJsonEvent) => void;
}

export interface OpenCodeStepStartEvent {
	type: "step_start";
	sessionID?: string;
	sessionId?: string;
	session_id?: string;
}

export interface OpenCodeTextEvent {
	type: "text";
	part?: {
		text?: string;
	};
}

export interface OpenCodeToolUseEvent {
	type: "tool_use";
	part?: {
		tool?: string;
		callID?: string;
		callId?: string;
		call_id?: string;
		state?: {
			status?: string;
			input?: unknown;
			output?: unknown;
			metadata?: unknown;
			error?: unknown;
		};
	};
}

export interface OpenCodeStepFinishEvent {
	type: "step_finish";
	reason?: string;
	stopReason?: string;
	stop_reason?: string;
	result?: unknown;
	output?: unknown;
	message?: unknown;
	cost?: number;
	totalCostUSD?: number;
	total_cost_usd?: number;
	usage?: {
		inputTokens?: number;
		input_tokens?: number;
		outputTokens?: number;
		output_tokens?: number;
		cacheReadTokens?: number;
		cache_read_input_tokens?: number;
		cacheWriteTokens?: number;
		cache_creation_input_tokens?: number;
	};
}
