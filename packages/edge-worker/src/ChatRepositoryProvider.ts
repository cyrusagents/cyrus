import type { RepositoryConfig } from "cyrus-core";

/**
 * Abstraction for accessing the current set of chat-accessible repositories.
 *
 * SlackChatAdapter and ChatSessionHandler depend on this interface rather than
 * a frozen array, so they always read the live repository state at the moment
 * a session is built — no refresh/notification wiring needed.
 */
export interface ChatRepositoryProvider {
	/** Current repository paths available for chat sessions */
	getRepositoryPaths(): string[];
	/** Default repository for MCP config sourcing (V1: first available) */
	getDefaultRepository(): RepositoryConfig | undefined;
	/** Default Linear workspace ID for MCP config (V1: first configured) */
	getDefaultLinearWorkspaceId(): string | undefined;
	/**
	 * Pick the repository whose `teamKeys` intersects with the given project's
	 * teams. Used for Project Update sessions so the persona/appendInstruction
	 * matches the team a project belongs to (relevant for cross-team agents
	 * like Iris where each repo holds a different mode). Returns the first
	 * intersecting repo, or `undefined` if none match.
	 *
	 * Optional for back-compat with simpler test providers that don't model
	 * project routing.
	 */
	getRepositoryForProject?(
		projectTeamKeys: string[],
	): RepositoryConfig | undefined;
}

/**
 * Live implementation backed by EdgeWorker's repository map and config.
 *
 * Reads are computed on demand from the underlying collections, so any
 * runtime config changes (add/update/remove) are automatically visible
 * to the next chat session without explicit notification.
 */
export class LiveChatRepositoryProvider implements ChatRepositoryProvider {
	constructor(
		private readonly repositories: Map<string, RepositoryConfig>,
		private readonly getLinearWorkspaces: () => Record<string, unknown>,
	) {}

	getRepositoryPaths(): string[] {
		return Array.from(this.repositories.values()).map(
			(repo) => repo.repositoryPath,
		);
	}

	getDefaultRepository(): RepositoryConfig | undefined {
		return Array.from(this.repositories.values())[0];
	}

	getDefaultLinearWorkspaceId(): string | undefined {
		return Object.keys(this.getLinearWorkspaces())[0];
	}

	getRepositoryForProject(
		projectTeamKeys: string[],
	): RepositoryConfig | undefined {
		if (!projectTeamKeys || projectTeamKeys.length === 0) return undefined;
		const wanted = new Set(projectTeamKeys.map((k) => k.toUpperCase()));
		for (const repo of this.repositories.values()) {
			const keys = (repo as { teamKeys?: string[] }).teamKeys;
			if (!Array.isArray(keys) || keys.length === 0) continue;
			for (const key of keys) {
				if (typeof key === "string" && wanted.has(key.toUpperCase())) {
					return repo;
				}
			}
		}
		return undefined;
	}
}
