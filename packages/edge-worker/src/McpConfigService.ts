import type { LinearClient } from "@linear/sdk";
import type { McpServerConfig } from "atmiko-claude-runner";
import type { IIssueTrackerService, RepositoryConfig } from "atmiko-core";
import {
	type AtmikoToolsOptions,
	createAtmikoToolsServer,
} from "atmiko-mcp-tools";

type AtmikoToolsMcpContextEntry = {
	contextId: string;
	linearToken: string;
	linearClient: LinearClient;
	parentSessionId?: string;
	prebuiltServer?: ReturnType<typeof createAtmikoToolsServer>;
	createdAt: number;
};

/**
 * Dependencies injected into McpConfigService from the EdgeWorker.
 */
export interface McpConfigServiceDeps {
	/** Retrieve the stored Linear API token for a workspace */
	getLinearTokenForWorkspace: (workspaceId: string) => string | null;
	/** Retrieve the issue tracker service for a workspace (must expose getClient()) */
	getIssueTracker: (
		workspaceId: string,
	) => (IIssueTrackerService & { getClient?: () => LinearClient }) | undefined;
	/** Get the HTTP URL where the atmiko-tools MCP endpoint is registered */
	getAtmikoToolsMcpUrl: () => string;
	/** Factory that creates AtmikoToolsOptions with session callbacks */
	createAtmikoToolsOptions: (parentSessionId?: string) => AtmikoToolsOptions;
}

/**
 * Single source of truth for MCP server configuration assembly.
 *
 * Handles:
 * - Building inline MCP server configs (Linear, atmiko-tools, Slack)
 * - Merging file-based MCP config paths from repositories
 * - Atmiko-tools MCP context lifecycle management
 *
 * Both EdgeWorker (issue sessions) and ChatSessionHandler (chat sessions)
 * consume this service instead of duplicating MCP config logic.
 */
export class McpConfigService {
	private deps: McpConfigServiceDeps;
	private contexts = new Map<string, AtmikoToolsMcpContextEntry>();

	constructor(deps: McpConfigServiceDeps) {
		this.deps = deps;
	}

	/**
	 * Build MCP configuration with automatic Linear server injection and atmiko-tools over Fastify MCP.
	 * Workspace-level servers (Linear, atmiko-tools, Slack) are configured once using workspace-level token.
	 *
	 * Whether the agent can actually CALL into any of these servers is gated
	 * by the per-platform allowed-tools array (`teams.{linear,slack,github}_allowed_tools`),
	 * not by anything done here — so it's safe to always spin them up when
	 * their underlying transport credentials exist (Slack inline via
	 * `SLACK_BOT_TOKEN`, Linear via the workspace's Linear token, etc.).
	 *
	 * @param repoId - Repository ID for MCP context scoping
	 * @param linearWorkspaceId - Linear workspace ID (from webhook.organizationId or repo config)
	 * @param parentSessionId - Parent session ID for atmiko-tools context
	 */
	buildMcpConfig(
		repoId: string,
		linearWorkspaceId: string,
		parentSessionId?: string,
	): Record<string, McpServerConfig> {
		const contextId = this.buildContextId(repoId, parentSessionId);

		// Prebuild one SDK server for this context so callback wiring remains deterministic.
		const linearToken = this.deps.getLinearTokenForWorkspace(linearWorkspaceId);
		const issueTracker = this.deps.getIssueTracker(linearWorkspaceId);
		if (!linearToken || !issueTracker?.getClient) {
			// CLI platform mode — no Linear client available, return config without atmiko-tools
			const mcpConfig: Record<string, McpServerConfig> = {
				"atmiko-docs": {
					type: "http",
					url: "https://github.com/nexmoe/atmiko/blob/main/docs/CONFIG_FILE.md",
				},
			};
			return mcpConfig;
		}
		const linearClient = issueTracker.getClient();
		const prebuiltServer = createAtmikoToolsServer(
			linearClient,
			this.deps.createAtmikoToolsOptions(parentSessionId),
		);

		this.contexts.set(contextId, {
			contextId,
			linearToken,
			linearClient,
			parentSessionId,
			prebuiltServer,
			createdAt: Date.now(),
		});
		this.pruneContexts();

		const atmikoToolsAuthorizationHeader = this.getAuthorizationHeaderValue();

		// Workspace-level MCP servers — configured once regardless of repo count
		// https://linear.app/docs/mcp
		const mcpConfig: Record<string, McpServerConfig> = {
			linear: {
				type: "http",
				url: "https://mcp.linear.app/mcp",
				headers: {
					Authorization: `Bearer ${linearToken}`,
				},
			},
			"atmiko-tools": {
				type: "http",
				url: this.deps.getAtmikoToolsMcpUrl(),
				headers: {
					"x-atmiko-mcp-context-id": contextId,
					...(atmikoToolsAuthorizationHeader
						? {
								Authorization: atmikoToolsAuthorizationHeader,
							}
						: {}),
				},
			},
			"atmiko-docs": {
				type: "http",
				url: "https://github.com/nexmoe/atmiko/blob/main/docs/CONFIG_FILE.md",
			},
		};

		// Inject the Slack MCP server whenever SLACK_BOT_TOKEN is available —
		// per-platform availability is enforced upstream by the allowed-tools
		// array. https://github.com/korotovsky/slack-mcp-server
		const slackBotToken = process.env.SLACK_BOT_TOKEN?.trim();
		if (slackBotToken) {
			mcpConfig.slack = {
				command: "npx",
				args: ["-y", "slack-mcp-server@1.2.3", "--transport", "stdio"],
				env: {
					SLACK_MCP_XOXB_TOKEN: slackBotToken,
				},
			};
		}

		return mcpConfig;
	}

	/**
	 * Merge mcpConfigPath from multiple repositories into a single list.
	 * For same-name .mcp.json servers across repos, last wins (handled by Claude's merge behavior).
	 */
	buildMergedMcpConfigPath(
		repositories: RepositoryConfig | RepositoryConfig[],
	): string | string[] | undefined {
		const repoArray = Array.isArray(repositories)
			? repositories
			: [repositories];

		if (repoArray.length === 1) {
			return repoArray[0]!.mcpConfigPath;
		}

		// Collect all mcpConfigPaths from each repo into a flat list
		const allPaths: string[] = [];
		for (const repo of repoArray) {
			if (!repo.mcpConfigPath) continue;
			if (Array.isArray(repo.mcpConfigPath)) {
				allPaths.push(...repo.mcpConfigPath);
			} else {
				allPaths.push(repo.mcpConfigPath);
			}
		}

		if (allPaths.length === 0) return undefined;
		if (allPaths.length === 1) return allPaths[0];
		return allPaths;
	}

	/**
	 * Look up a stored atmiko-tools MCP context by its ID.
	 * Used by the MCP endpoint handler to retrieve prebuilt servers.
	 */
	getContext(contextId: string): AtmikoToolsMcpContextEntry | undefined {
		return this.contexts.get(contextId);
	}

	/**
	 * Clear the prebuilt server from a context entry (after first use).
	 */
	clearPrebuiltServer(contextId: string): void {
		const context = this.contexts.get(contextId);
		if (context) {
			context.prebuiltServer = undefined;
		}
	}

	/**
	 * Clear all stored contexts. Used during shutdown.
	 */
	clearAllContexts(): void {
		this.contexts.clear();
	}

	/**
	 * Get the authorization header value for atmiko-tools MCP requests.
	 */
	getAuthorizationHeaderValue(): string | undefined {
		const apiKey = process.env.ATMIKO_API_KEY?.trim();
		if (!apiKey) {
			return undefined;
		}
		return `Bearer ${apiKey}`;
	}

	/**
	 * Validate an incoming authorization header against the expected value.
	 */
	isAuthorizationValid(rawAuthorizationHeader: unknown): boolean {
		const expectedHeader = this.getAuthorizationHeaderValue();
		if (!expectedHeader) {
			return true;
		}

		const authorizationHeader = Array.isArray(rawAuthorizationHeader)
			? rawAuthorizationHeader[0]
			: rawAuthorizationHeader;

		return authorizationHeader === expectedHeader;
	}

	private buildContextId(repoId: string, parentSessionId?: string): string {
		if (parentSessionId) {
			return `${repoId}:${parentSessionId}`;
		}

		return `${repoId}:anon:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
	}

	private pruneContexts(maxEntries: number = 500): void {
		if (this.contexts.size <= maxEntries) {
			return;
		}

		const entriesByAge = Array.from(this.contexts.entries()).sort(
			(a, b) => a[1].createdAt - b[1].createdAt,
		);

		const pruneCount = this.contexts.size - maxEntries;
		for (let i = 0; i < pruneCount; i++) {
			const entry = entriesByAge[i];
			if (!entry) {
				break;
			}
			const [contextId] = entry;
			this.contexts.delete(contextId);
		}
	}
}
