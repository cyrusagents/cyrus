import type { UserAccessControlConfig, UserIdentifier } from "cyrus-core";

/**
 * Result of an access check operation.
 */
export type AccessCheckResult =
	| { allowed: true }
	| { allowed: false; reason: string };

/**
 * Default message shown when a user is blocked and blockBehavior is 'comment'.
 * Supports template variables:
 * - {{userName}} - The user's display name (an @mention on Slack)
 * - {{userId}} - The user's Linear or Slack ID
 */
export const DEFAULT_BLOCK_MESSAGE =
	"{{userName}}, you are not authorized to delegate issues to this agent.";

/**
 * Checks if a user matches a given identifier.
 * @param userId - The user's Linear ID
 * @param userEmail - The user's email address
 * @param identifier - The identifier to match against
 * @returns true if the user matches the identifier
 */
function userMatchesIdentifier(
	userId: string | undefined,
	userEmail: string | undefined,
	identifier: UserIdentifier,
): boolean {
	if (typeof identifier === "string") {
		// String is treated as user ID
		return userId === identifier;
	}
	if ("id" in identifier) {
		return userId === identifier.id;
	}
	if ("email" in identifier) {
		// Case-insensitive email comparison
		return userEmail?.toLowerCase() === identifier.email.toLowerCase();
	}
	// A slackId entry only ever matches a Slack user (see checkSlackAccess)
	return false;
}

/**
 * Checks if an identifier is a Slack user ID entry.
 * @param identifier - The identifier to inspect
 * @returns true if the identifier is a `{ slackId }` object
 */
function isSlackIdentifier(
	identifier: UserIdentifier,
): identifier is { slackId: string } {
	return typeof identifier === "object" && "slackId" in identifier;
}

/**
 * Checks if a Slack user matches any slackId entry in a list.
 * @param slackUserId - The user's Slack ID (e.g. "U012AB3CD")
 * @param identifiers - List of identifiers to check against
 * @returns true if any slackId entry equals the user's Slack ID
 */
function slackUserMatchesAny(
	slackUserId: string | undefined,
	identifiers: UserIdentifier[],
): boolean {
	return (
		slackUserId !== undefined &&
		identifiers.some(
			(identifier) =>
				isSlackIdentifier(identifier) && identifier.slackId === slackUserId,
		)
	);
}

/**
 * Checks if a user matches any identifier in a list.
 * @param userId - The user's Linear ID
 * @param userEmail - The user's email address
 * @param identifiers - List of identifiers to check against
 * @returns true if the user matches any identifier
 */
function userMatchesAny(
	userId: string | undefined,
	userEmail: string | undefined,
	identifiers: UserIdentifier[],
): boolean {
	return identifiers.some((identifier) =>
		userMatchesIdentifier(userId, userEmail, identifier),
	);
}

/**
 * User access control manager for user whitelisting/blacklisting.
 *
 * Linear delegations go through checkAccess, Slack sessions through
 * checkSlackAccess; both share the same configured lists.
 *
 * Access Check Logic (Linear):
 * 1. Build effective blocklist: global blockedUsers + repo blockedUsers (union)
 * 2. Check if user matches any entry in effective blocklist -> BLOCKED
 * 3. Determine effective allowlist:
 *    - If repo has allowedUsers -> use repo allowlist only
 *    - Else if global has allowedUsers -> use global allowlist
 *    - Else -> no allowlist (everyone allowed)
 * 4. If effective allowlist exists and user NOT in it -> BLOCKED
 * 5. Otherwise -> ALLOWED
 */
export class UserAccessControl {
	private globalConfig: UserAccessControlConfig | undefined;
	private repoConfigs: Map<string, UserAccessControlConfig | undefined>;

	/**
	 * Creates a new UserAccessControl instance.
	 * @param globalConfig - Global access control configuration
	 * @param repoConfigs - Map of repository ID to repository-specific access control config
	 */
	constructor(
		globalConfig: UserAccessControlConfig | undefined,
		repoConfigs: Map<string, UserAccessControlConfig | undefined>,
	) {
		this.globalConfig = globalConfig;
		this.repoConfigs = repoConfigs;
	}

	/**
	 * Check if a user is allowed to delegate issues to a specific repository.
	 * @param userId - The user's Linear ID
	 * @param userEmail - The user's email address
	 * @param repositoryId - The target repository ID
	 * @returns AccessCheckResult indicating if access is allowed
	 */
	checkAccess(
		userId: string | undefined,
		userEmail: string | undefined,
		repositoryId: string,
	): AccessCheckResult {
		const repoConfig = this.repoConfigs.get(repositoryId);

		// Step 1: Build effective blocklist (global + repo, union)
		const effectiveBlocklist: UserIdentifier[] = [
			...(this.globalConfig?.blockedUsers ?? []),
			...(repoConfig?.blockedUsers ?? []),
		];

		// Step 2: Check if user is in blocklist
		if (
			effectiveBlocklist.length > 0 &&
			userMatchesAny(userId, userEmail, effectiveBlocklist)
		) {
			return {
				allowed: false,
				reason: "User is in blocklist",
			};
		}

		// Step 3: Determine effective allowlist
		// Repo allowlist OVERRIDES global (not merged)
		let effectiveAllowlist: UserIdentifier[] | undefined;
		if (repoConfig?.allowedUsers !== undefined) {
			effectiveAllowlist = repoConfig.allowedUsers;
		} else if (this.globalConfig?.allowedUsers !== undefined) {
			effectiveAllowlist = this.globalConfig.allowedUsers;
		}

		// Step 4: If allowlist exists, check if user is in it
		if (effectiveAllowlist !== undefined) {
			// Empty allowlist means no one is allowed
			if (effectiveAllowlist.length === 0) {
				return {
					allowed: false,
					reason: "No users are allowed (empty allowlist)",
				};
			}

			if (!userMatchesAny(userId, userEmail, effectiveAllowlist)) {
				return {
					allowed: false,
					reason: "User is not in allowlist",
				};
			}
		}

		// Step 5: User is allowed
		return { allowed: true };
	}

	/**
	 * Check if a Slack user is allowed to prompt the agent.
	 *
	 * Slack sessions are not bound to a repository, so only the global config
	 * applies. Only `{ slackId }` entries match a Slack user: an allowlist
	 * without any does not restrict Slack, an empty one still denies everyone.
	 * @param slackUserId - The user's Slack ID (e.g. "U012AB3CD")
	 * @returns AccessCheckResult indicating if access is allowed
	 */
	checkSlackAccess(slackUserId: string | undefined): AccessCheckResult {
		const blockedUsers = this.globalConfig?.blockedUsers ?? [];
		if (slackUserMatchesAny(slackUserId, blockedUsers)) {
			return { allowed: false, reason: "User is in blocklist" };
		}

		const allowedUsers = this.globalConfig?.allowedUsers;
		if (allowedUsers === undefined) {
			return { allowed: true };
		}

		if (allowedUsers.length === 0) {
			return {
				allowed: false,
				reason: "No users are allowed (empty allowlist)",
			};
		}

		if (!allowedUsers.some(isSlackIdentifier)) {
			return { allowed: true };
		}

		if (!slackUserMatchesAny(slackUserId, allowedUsers)) {
			return { allowed: false, reason: "User is not in allowlist" };
		}

		return { allowed: true };
	}

	/**
	 * Get the effective block behavior for a repository.
	 * Repo config overrides global config.
	 * @param repositoryId - The repository ID; omit for sessions not bound to a
	 *   repository (chat sessions), which use the global config only
	 * @returns 'silent' or 'comment'
	 */
	getBlockBehavior(repositoryId?: string): "silent" | "comment" {
		const repoConfig =
			repositoryId === undefined
				? undefined
				: this.repoConfigs.get(repositoryId);

		// Repo blockBehavior overrides global
		if (repoConfig?.blockBehavior !== undefined) {
			return repoConfig.blockBehavior;
		}

		if (this.globalConfig?.blockBehavior !== undefined) {
			return this.globalConfig.blockBehavior;
		}

		// Default to silent
		return "silent";
	}

	/**
	 * Get the effective block message for a repository.
	 * Repo config overrides global config.
	 * @param repositoryId - The repository ID; omit for sessions not bound to a
	 *   repository (chat sessions), which use the global config only
	 * @returns The block message to display
	 */
	getBlockMessage(repositoryId?: string): string {
		const repoConfig =
			repositoryId === undefined
				? undefined
				: this.repoConfigs.get(repositoryId);

		// Repo blockMessage overrides global
		if (repoConfig?.blockMessage !== undefined) {
			return repoConfig.blockMessage;
		}

		if (this.globalConfig?.blockMessage !== undefined) {
			return this.globalConfig.blockMessage;
		}

		// Default message
		return DEFAULT_BLOCK_MESSAGE;
	}

	/**
	 * Check if any access control is configured (either globally or for any repository).
	 * Useful for short-circuiting when no access control is needed.
	 * @returns true if any access control configuration exists
	 */
	hasAnyConfiguration(): boolean {
		// Check global config
		if (
			this.globalConfig?.allowedUsers !== undefined ||
			this.globalConfig?.blockedUsers !== undefined
		) {
			return true;
		}

		// Check repo configs
		for (const config of this.repoConfigs.values()) {
			if (
				config?.allowedUsers !== undefined ||
				config?.blockedUsers !== undefined
			) {
				return true;
			}
		}

		return false;
	}
}
