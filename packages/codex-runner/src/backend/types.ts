import type { EventEmitter } from "node:events";
import type {
	ApprovalMode,
	ModelReasoningEffort,
	SandboxMode,
	WebSearchMode,
} from "@openai/codex-sdk";
import type { CodexConfigOverrides } from "../types.js";

/**
 * Backend-neutral item shape consumed by {@link CodexEventMapper}.
 *
 * The {@link AppServerCodexBackend} translates the app-server protocol's
 * camelCase item payloads into this normalized shape. The mapper depends only
 * on this type — never on a concrete transport's wire format (Dependency
 * Inversion).
 */
export type NormalizedCodexItem =
	| { type: "agent_message"; id: string; text: string }
	| { type: "reasoning"; id: string; text?: string }
	| { type: "user_message"; id: string }
	| {
			type: "command_execution";
			id: string;
			command: string;
			aggregated_output: string;
			exit_code?: number;
			status: "in_progress" | "completed" | "failed";
	  }
	| {
			type: "file_change";
			id: string;
			changes: { path: string; kind: "add" | "delete" | "update" }[];
			status: "completed" | "failed";
	  }
	| {
			type: "mcp_tool_call";
			id: string;
			server: string;
			tool: string;
			arguments: unknown;
			result?: { content?: unknown[]; structured_content?: unknown };
			error?: { message: string };
			status: "in_progress" | "completed" | "failed";
	  }
	| {
			type: "web_search";
			id: string;
			query: string;
			action?: Record<string, unknown>;
	  }
	| {
			type: "todo_list";
			id: string;
			items: { text: string; completed: boolean }[];
	  }
	| { type: "error"; id: string; message: string }
	| { type: "unknown"; id: string };

/** Token usage for a completed turn, in backend-neutral form. */
export interface NormalizedUsage {
	input_tokens: number;
	output_tokens: number;
	cached_input_tokens: number;
}

/**
 * Backend-neutral lifecycle/stream event. Both backends emit this; the mapper
 * turns it into Cyrus `SDKMessage`s.
 */
export type NormalizedCodexEvent =
	| { kind: "thread-started"; threadId: string }
	| { kind: "turn-started" }
	| { kind: "item-started"; item: NormalizedCodexItem }
	| { kind: "item-completed"; item: NormalizedCodexItem }
	| { kind: "turn-completed"; usage: NormalizedUsage }
	| { kind: "turn-failed"; message: string }
	| { kind: "error"; message: string };

/** A single piece of user input for a turn or a steer. */
export type CodexUserInput =
	| { type: "text"; text: string }
	| { type: "local_image"; path: string };

/**
 * Transport-neutral sandbox policy. Mirrors the subset of the app-server
 * `SandboxPolicy` Cyrus uses; the backend adds the wire-specific constants
 * (`includePlatformDefaults`, `excludeSlashTmp`, etc.) when serializing. Reads
 * are an allow-list (`readableRoots`) — anything outside is denied.
 */
export type CodexSandboxPolicy =
	| { type: "dangerFullAccess" }
	| { type: "readOnly"; readableRoots: string[]; networkAccess: boolean }
	| {
			type: "workspaceWrite";
			writableRoots: string[];
			readableRoots: string[];
			networkAccess: boolean;
	  };

/**
 * Resolved per-thread sandbox decision.
 * - `workspace-mode`: the coarse Codex sandbox mode (broad reads, writes limited
 *   to cwd + `writableRoots` + tmp). The default when there are no explicit Cyrus
 *   sandbox settings — sent via `thread/start.sandbox` + config.
 * - `policy`: a granular structured policy (restricted reads) derived from Cyrus
 *   sandbox settings — sent via `turn/start.sandboxPolicy` (persists per-thread).
 */
export type ResolvedCodexSandbox =
	| {
			kind: "workspace-mode";
			mode: SandboxMode;
			writableRoots: string[];
			networkAccess: boolean;
	  }
	| { kind: "policy"; policy: CodexSandboxPolicy };

/**
 * Fully-resolved, transport-neutral run configuration produced by
 * {@link CodexConfigBuilder}; the backend maps it onto `thread/start` +
 * `turn/start` params for the app-server.
 */
export interface ResolvedCodexConfig {
	model?: string;
	sandbox: ResolvedCodexSandbox;
	workingDirectory?: string;
	approvalPolicy: ApprovalMode;
	skipGitRepoCheck: boolean;
	modelReasoningEffort?: ModelReasoningEffort;
	webSearchMode?: WebSearchMode;
	/** Maps to Codex `developer_instructions` (appended system prompt). */
	developerInstructions?: string;
	/** Global Codex config overrides (e.g. `mcp_servers`). */
	configOverrides?: CodexConfigOverrides;
	/** Environment override; when set the child does not inherit ambient env. */
	env?: Record<string, string>;
	codexHome: string;
	codexPath?: string;
	outputSchema?: unknown;
	/** Existing thread id to resume rather than start fresh. */
	resumeSessionId?: string;
}

/** Events emitted by a {@link CodexBackend}. */
export interface CodexBackendEvents {
	event: (event: NormalizedCodexEvent) => void;
}

export declare interface CodexBackend {
	on<K extends keyof CodexBackendEvents>(
		event: K,
		listener: CodexBackendEvents[K],
	): this;
	emit<K extends keyof CodexBackendEvents>(
		event: K,
		...args: Parameters<CodexBackendEvents[K]>
	): boolean;
}

/**
 * Transport strategy for driving Codex.
 *
 * Implementations are responsible only for (a) establishing/maintaining a
 * Codex session and (b) translating their wire protocol into
 * {@link NormalizedCodexEvent}s. Config assembly, skill staging, MCP
 * translation, and SDKMessage mapping live in dedicated collaborators.
 */
export interface CodexBackend extends EventEmitter {
	/**
	 * Whether this backend can inject input into an already-running turn
	 * (`turn/steer`). When false, mid-turn input must be delivered as a new turn.
	 */
	readonly supportsSteer: boolean;

	/**
	 * Open the session: connect/spawn as needed, then start or resume the thread.
	 * Resolves with the resolved thread id (may differ from a requested resume id
	 * only if the backend allocates one). Implementations should emit a
	 * `thread-started` event when the id is known.
	 */
	open(config: ResolvedCodexConfig): Promise<{ threadId: string }>;

	/**
	 * Run a single turn with the given input. Resolves when the turn reaches a
	 * terminal state (a `turn-completed` or `turn-failed` event has been emitted).
	 */
	runTurn(input: CodexUserInput[]): Promise<void>;

	/**
	 * Inject input into the currently-active turn. Only present when
	 * {@link supportsSteer} is true. Rejects if no turn is active.
	 */
	steer?(input: CodexUserInput[]): Promise<void>;

	/** Whether a turn is currently in flight. */
	isTurnActive(): boolean;

	/** Cancel the active turn (if any) without tearing down the session. */
	interrupt(): Promise<void>;

	/** Tear down the session and release all resources. */
	close(): Promise<void>;
}
