import type { UserAccessControlConfig, UserIdentifier } from "miko-core";

/**
 * Result of an access check operation.
 */
export type AccessCheckResult =
	| { allowed: true }
	| { allowed: false; reason: string };

/**
 * Default message shown when a user is blocked and blockBehavior is 'comment'.
 * Supports template variables:
 * - {{userName}} - The user's display name
 * - {{userId}} - The user's Linear ID
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
	return false;
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
 * User access control manager for Linear user whitelisting/blacklisting.
 *
 * Access Check Logic:
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
	 * Get the effective block behavior for a repository.
	 * Repo config overrides global config.
	 * @param repositoryId - The repository ID
	 * @returns 'silent' or 'comment'
	 */
	getBlockBehavior(repositoryId: string): "silent" | "comment" {
		const repoConfig = this.repoConfigs.get(repositoryId);

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
	 * @param repositoryId - The repository ID
	 * @returns The block message to display
	 */
	getBlockMessage(repositoryId: string): string {
		const repoConfig = this.repoConfigs.get(repositoryId);

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
