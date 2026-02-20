import type {
	AgentRunnerConfig,
	AgentSessionInfo,
	SDKMessage,
} from "cyrus-core";

export type CursorJsonEvent = Record<string, unknown>;

export interface CursorRunnerConfig extends AgentRunnerConfig {
	/** Path to cursor-agent CLI binary (defaults to `cursor-agent` in PATH) */
	cursorPath?: string;
	/** API key override for Cursor CLI authentication */
	cursorApiKey?: string;
	/** Sandbox mode for Cursor tool execution */
	sandbox?: "enabled" | "disabled";
	/** Approval policy for Cursor tool/shell execution */
	askForApproval?: "never" | "on-request" | "on-failure" | "untrusted";
	/** Automatically approve all MCP servers when running headless */
	approveMcps?: boolean;
	/** Expected cursor-agent version (validated before run; mismatch posts error to Linear) */
	cursorAgentVersion?: string;
}

export interface CursorSessionInfo extends AgentSessionInfo {
	sessionId: string | null;
}

export interface CursorRunnerEvents {
	message: (message: SDKMessage) => void;
	error: (error: Error) => void;
	complete: (messages: SDKMessage[]) => void;
	streamEvent: (event: CursorJsonEvent) => void;
}
