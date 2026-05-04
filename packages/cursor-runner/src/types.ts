import type {
	AgentRunnerConfig,
	AgentSessionInfo,
	SDKMessage,
} from "cyrus-core";
import type { CursorSandboxInput } from "./sandbox.js";

export interface CursorRunnerConfig extends AgentRunnerConfig {
	/** API key for Cursor SDK authentication (falls back to CURSOR_API_KEY env). */
	cursorApiKey?: string;

	/**
	 * Sandbox settings, structurally compatible with Cyrus / Claude SDK
	 * `SandboxSettings`. When `enabled: true`, the runner engages Cursor's
	 * `local.sandboxOptions` and writes a `.cursor/sandbox.json` policy
	 * mirroring `filesystem.allowRead/Write` and `network.allowed/deniedDomains`.
	 * If the Cyrus egress proxy is active (`network.httpProxyPort` set), the
	 * runner also adds `127.0.0.1` to the network allow-list and sets the
	 * proxy env vars on `process.env` so child shell tools route through it.
	 */
	sandboxSettings?: CursorSandboxInput;

	/**
	 * Path to the egress proxy CA cert bundle. When set, the runner exports
	 * `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, etc. into `process.env` so
	 * sandboxed child processes trust the MITM-intercepting proxy.
	 */
	egressCaCertPath?: string;
}

export interface CursorSessionInfo extends AgentSessionInfo {
	/** The SDK agentId (local-prefix `agent-<uuid>`). */
	sessionId: string | null;
}

export interface CursorRunnerEvents {
	message: (message: SDKMessage) => void;
	error: (error: Error) => void;
	complete: (messages: SDKMessage[]) => void;
}
