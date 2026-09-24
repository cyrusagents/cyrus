import type {
	AgentRunnerConfig,
	AgentSessionInfo,
	SDKMessage,
} from "miko-core";

export interface GrokRunnerConfig extends AgentRunnerConfig {
	/** Path to the grok CLI binary (defaults to `grok` on PATH). */
	grokPath?: string;
	/** Extra environment variables for the Grok child process. */
	env?: Record<string, string | undefined>;
	/**
	 * Optional maximum time the Grok child may remain silent before it is
	 * terminated. Disabled by default. Set to 0 to explicitly disable.
	 */
	inactivityTimeoutMs?: number;
}

export interface GrokSessionInfo extends AgentSessionInfo {
	sessionId: string | null;
}

export interface GrokRunnerEvents {
	message: (message: SDKMessage) => void;
	error: (error: Error) => void;
	complete: (messages: SDKMessage[]) => void;
}
