import { z } from "zod";

/**
 * Supported runner/harness types for agent execution.
 */
export const RunnerTypeSchema = z.enum(["claude", "gemini", "codex", "cursor"]);
export type RunnerType = z.infer<typeof RunnerTypeSchema>;

/**
 * User identifier for access control matching.
 * Supports multiple formats for flexibility:
 * - String: treated as user ID (e.g., "usr_abc123")
 * - Object with id: explicit user ID match
 * - Object with email: email-based match
 */
export const UserIdentifierSchema = z.union([
	z.string(), // Treated as user ID
	z.object({ id: z.string() }), // Explicit user ID
	z.object({ email: z.string() }), // Email address
]);

/**
 * User access control configuration for whitelisting/blacklisting users.
 */
export const UserAccessControlConfigSchema = z.object({
	/**
	 * Users allowed to delegate issues.
	 * If specified, ONLY these users can trigger Cyrus sessions.
	 * Empty array means no one is allowed (effectively disables Cyrus).
	 * Omitting this field means everyone is allowed (unless blocked).
	 */
	allowedUsers: z.array(UserIdentifierSchema).optional(),

	/**
	 * Users blocked from delegating issues.
	 * These users cannot trigger Cyrus sessions.
	 * Takes precedence over allowedUsers.
	 */
	blockedUsers: z.array(UserIdentifierSchema).optional(),

	/**
	 * What happens when a blocked user tries to delegate.
	 * - 'silent': Ignore the webhook quietly (default)
	 * - 'comment': Post an activity explaining the user is not authorized
	 */
	blockBehavior: z.enum(["silent", "comment"]).optional(),

	/**
	 * Custom message to post when blockBehavior is 'comment'.
	 * Defaults to: "You are not authorized to delegate issues to this agent."
	 */
	blockMessage: z.string().optional(),
});

/**
 * Tool restriction options for label-based prompts
 */
const ToolRestrictionSchema = z.union([
	z.array(z.string()),
	z.literal("readOnly"),
	z.literal("safe"),
	z.literal("all"),
	z.literal("coordinator"),
]);

/**
 * Label prompt configuration with optional tool restrictions.
 * Accepts either:
 * - Simple form: string[] (e.g., ["Bug", "Fix"])
 * - Complex form: { labels: string[], allowedTools?: ..., disallowedTools?: ... }
 */
const LabelPromptConfigSchema = z.union([
	// Simple form: just an array of label strings
	z.array(z.string()),
	// Complex form: object with labels and optional tool restrictions
	z.object({
		labels: z.array(z.string()),
		allowedTools: ToolRestrictionSchema.optional(),
		disallowedTools: z.array(z.string()).optional(),
	}),
]);

/**
 * Graphite label configuration (labels only, no tool restrictions).
 * Accepts either:
 * - Simple form: string[] (e.g., ["Bug", "Fix"])
 * - Complex form: { labels: string[] }
 */
const GraphiteLabelConfigSchema = z.union([
	z.array(z.string()),
	z.object({
		labels: z.array(z.string()),
	}),
]);

/**
 * Label-based system prompt configuration
 */
const LabelPromptsSchema = z.object({
	debugger: LabelPromptConfigSchema.optional(),
	builder: LabelPromptConfigSchema.optional(),
	scoper: LabelPromptConfigSchema.optional(),
	orchestrator: LabelPromptConfigSchema.optional(),
	"graphite-orchestrator": LabelPromptConfigSchema.optional(),
	graphite: GraphiteLabelConfigSchema.optional(),
});

/**
 * Prompt type defaults configuration
 */
const PromptTypeDefaultsSchema = z.object({
	allowedTools: ToolRestrictionSchema.optional(),
	disallowedTools: z.array(z.string()).optional(),
});

/**
 * Global defaults for prompt types
 */
const PromptDefaultsSchema = z.object({
	debugger: PromptTypeDefaultsSchema.optional(),
	builder: PromptTypeDefaultsSchema.optional(),
	scoper: PromptTypeDefaultsSchema.optional(),
	orchestrator: PromptTypeDefaultsSchema.optional(),
	"graphite-orchestrator": PromptTypeDefaultsSchema.optional(),
});

/**
 * Configuration for a Linear workspace's credentials.
 * Keyed by workspace ID in EdgeConfig.linearWorkspaces.
 */
export const LinearWorkspaceConfigSchema = z.object({
	linearToken: z.string(),
	linearRefreshToken: z.string().optional(),
	/** Linear workspace URL slug (e.g., "ceedar" from "https://linear.app/ceedar/...") */
	linearWorkspaceSlug: z.string().optional(),
	/** Human-readable workspace name (e.g., "Ceedar") */
	linearWorkspaceName: z.string().optional(),
});

/**
 * Configuration for a single repository/workspace pair
 */
export const RepositoryConfigSchema = z.object({
	// Repository identification
	id: z.string(),
	name: z.string(),

	// Git configuration
	repositoryPath: z.string(),
	baseBranch: z.string(),
	githubUrl: z.string().optional(),
	gitlabUrl: z.string().optional(),

	// Linear configuration (optional — repos may operate without Linear, e.g. via Slack or GitHub)
	linearWorkspaceId: z.string().optional(),
	teamKeys: z.array(z.string()).optional(),
	routingLabels: z.array(z.string()).optional(),
	projectKeys: z.array(z.string()).optional(),

	/** @deprecated Use EdgeConfig.linearWorkspaces[workspaceId].linearToken */
	linearToken: z.string().optional(),
	/** @deprecated Use EdgeConfig.linearWorkspaces[workspaceId].linearRefreshToken */
	linearRefreshToken: z.string().optional(),
	/** @deprecated Use EdgeConfig.linearWorkspaces[workspaceId].linearWorkspaceName */
	linearWorkspaceName: z.string().optional(),

	// Workspace configuration
	workspaceBaseDir: z.string(),

	// Optional settings
	isActive: z.boolean().optional(),
	promptTemplatePath: z.string().optional(),
	allowedTools: z.array(z.string()).optional(),
	disallowedTools: z.array(z.string()).optional(),
	mcpConfigPath: z.union([z.string(), z.array(z.string())]).optional(),
	appendInstruction: z.string().optional(),
	model: z.string().optional(),
	fallbackModel: z.string().optional(),

	// Label-based system prompt configuration
	labelPrompts: LabelPromptsSchema.optional(),

	// Repository-specific user access control
	userAccessControl: UserAccessControlConfigSchema.optional(),
});

/**
 * Edge configuration - the serializable configuration stored in ~/.cyrus/config.json
 *
 * This schema defines all settings that can be persisted to disk.
 * It contains global settings that apply across all repositories,
 * plus the array of repository-specific configurations.
 */
export const EdgeConfigSchema = z.object({
	/** Array of repository configurations */
	repositories: z.array(RepositoryConfigSchema),

	/**
	 * Linear workspace credentials keyed by workspace ID.
	 * Centralizes tokens that were previously duplicated per-repository.
	 */
	linearWorkspaces: z
		.record(z.string(), LinearWorkspaceConfigSchema)
		.optional(),

	/** @deprecated Migrated into linearWorkspaces entries. */
	linearWorkspaceSlug: z.string().optional(),

	/** Ngrok auth token for tunnel creation */
	ngrokAuthToken: z.string().optional(),

	/** Stripe customer ID for billing */
	stripeCustomerId: z.string().optional(),

	/** Default Claude model to use across all repositories (e.g., "opus", "sonnet", "haiku") */
	claudeDefaultModel: z.string().optional(),

	/** Default Claude fallback model if primary Claude model is unavailable */
	claudeDefaultFallbackModel: z.string().optional(),

	/** Default Gemini model to use across all repositories (e.g., "gemini-2.5-pro") */
	geminiDefaultModel: z.string().optional(),

	/** Default Codex model to use across all repositories (e.g., "gpt-5.3-codex", "gpt-5.2-codex") */
	codexDefaultModel: z.string().optional(),

	/**
	 * Default runner/harness to use when no runner is specified via labels or description tags.
	 * If omitted, auto-detected from available API keys (if exactly one is configured),
	 * otherwise falls back to "claude".
	 */
	defaultRunner: RunnerTypeSchema.optional(),

	/**
	 * @deprecated Use claudeDefaultModel instead.
	 * Legacy field retained for backwards compatibility and migrated on load.
	 */
	defaultModel: z.string().optional(),

	/**
	 * @deprecated Use claudeDefaultFallbackModel instead.
	 * Legacy field retained for backwards compatibility and migrated on load.
	 */
	defaultFallbackModel: z.string().optional(),

	/** Optional path to global setup script that runs for all repositories */
	global_setup_script: z.string().optional(),

	/** Default tools to allow across all repositories */
	defaultAllowedTools: z.array(z.string()).optional(),

	/** Tools to explicitly disallow across all repositories */
	defaultDisallowedTools: z.array(z.string()).optional(),

	/**
	 * Whether to trigger agent sessions when issue title, description, or attachments are updated.
	 * When enabled, the agent receives context showing what changed (old vs new values).
	 * Defaults to true if not specified.
	 */
	issueUpdateTrigger: z.boolean().optional(),

	/**
	 * Global user access control settings.
	 * Applied to all repositories unless overridden.
	 */
	userAccessControl: UserAccessControlConfigSchema.optional(),

	/** Global defaults for prompt types (tool restrictions per prompt type) */
	promptDefaults: PromptDefaultsSchema.optional(),

	/**
	 * Pre-flight readiness classifier configuration.
	 * Runs a cheap Claude pass before the main workflow to gate issues that
	 * lack enough information for autonomous work.
	 */
	readinessClassifier: z
		.object({
			/**
			 * Whether the classifier is enabled.
			 * Defaults to true when this object is present.
			 */
			enabled: z.boolean().optional(),

			/**
			 * Claude model to use for classification.
			 * Defaults to "haiku" for cost efficiency.
			 */
			model: z.string().optional(),

			/**
			 * Linear display name or @-handle of the user to tag in failure comments.
			 * Defaults to "@paul".
			 */
			notifyUser: z.string().optional(),

			/**
			 * Override the default classifier system prompt.
			 * Must instruct the model to respond with one of:
			 * pass | fail-vague | fail-no-files | fail-no-criteria | fail-ambiguous
			 */
			customPrompt: z.string().optional(),
		})
		.optional(),
});

/**
 * Payload version of RepositoryConfigSchema for incoming API requests.
 * Makes workspaceBaseDir optional since the handler applies a default.
 */
export const RepositoryConfigPayloadSchema = RepositoryConfigSchema.extend({
	workspaceBaseDir: z.string().optional(),
});

/**
 * Payload version of EdgeConfigSchema for incoming API requests.
 * Uses RepositoryConfigPayloadSchema which has optional workspaceBaseDir.
 */
export const EdgeConfigPayloadSchema = EdgeConfigSchema.extend({
	repositories: z.array(RepositoryConfigPayloadSchema),
});

/**
 * Migrate an EdgeConfig from the legacy per-repo token format to the
 * workspace-keyed format.
 *
 * Old format: each repository has linearToken and linearRefreshToken.
 * New format: linearWorkspaces at EdgeConfig level keyed by workspace ID,
 * repositories no longer carry tokens.
 *
 * This function is idempotent — if linearWorkspaces already exists, it
 * returns the config unchanged.
 */
export function migrateEdgeConfig(
	raw: Record<string, unknown>,
): Record<string, unknown> {
	// Already migrated or no repositories — nothing to do
	if (raw.linearWorkspaces || !Array.isArray(raw.repositories)) {
		return raw;
	}

	const repos = raw.repositories as Record<string, unknown>[];
	const hasLegacyTokens = repos.some((r) => typeof r.linearToken === "string");

	if (!hasLegacyTokens) {
		return raw;
	}

	// Build workspace map from per-repo tokens
	const linearWorkspaces: Record<
		string,
		{
			linearToken: string;
			linearRefreshToken?: string;
			linearWorkspaceSlug?: string;
			linearWorkspaceName?: string;
		}
	> = {};

	// Grab the top-level slug (if present) so it can be folded into each workspace
	const globalSlug = raw.linearWorkspaceSlug as string | undefined;

	for (const repo of repos) {
		const workspaceId = repo.linearWorkspaceId as string | undefined;
		const token = repo.linearToken as string | undefined;
		if (workspaceId && token) {
			// First repo with this workspace wins (they should all have the same token)
			if (!linearWorkspaces[workspaceId]) {
				linearWorkspaces[workspaceId] = {
					linearToken: token,
					...(typeof repo.linearRefreshToken === "string"
						? { linearRefreshToken: repo.linearRefreshToken }
						: {}),
					...(globalSlug ? { linearWorkspaceSlug: globalSlug } : {}),
					...(typeof repo.linearWorkspaceName === "string"
						? { linearWorkspaceName: repo.linearWorkspaceName }
						: {}),
				};
			}
		}
	}

	// Strip legacy token fields and workspace name from repositories
	const migratedRepos = repos.map((repo) => {
		const {
			linearToken: _linearToken,
			linearRefreshToken: _linearRefreshToken,
			linearWorkspaceName: _linearWorkspaceName,
			...rest
		} = repo;
		return rest;
	});

	const { linearWorkspaceSlug: _slug, ...rest } = raw;

	return {
		...rest,
		repositories: migratedRepos,
		linearWorkspaces,
	};
}

// Infer types from schemas
export type UserIdentifier = z.infer<typeof UserIdentifierSchema>;
export type UserAccessControlConfig = z.infer<
	typeof UserAccessControlConfigSchema
>;
export type LinearWorkspaceConfig = z.infer<typeof LinearWorkspaceConfigSchema>;
export type RepositoryConfig = z.infer<typeof RepositoryConfigSchema>;
export type EdgeConfig = z.infer<typeof EdgeConfigSchema>;
export type RepositoryConfigPayload = z.infer<
	typeof RepositoryConfigPayloadSchema
>;
export type EdgeConfigPayload = z.infer<typeof EdgeConfigPayloadSchema>;

/**
 * Assert that a repository has a Linear workspace ID and return it.
 * Use this in code paths that are only reached for Linear-linked repositories
 * (e.g. webhook handlers routed via workspace ID).
 */
export function requireLinearWorkspaceId(repo: RepositoryConfig): string {
	if (!repo.linearWorkspaceId) {
		throw new Error(
			`Repository "${repo.name}" is not linked to a Linear workspace`,
		);
	}
	return repo.linearWorkspaceId;
}
