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
 * Header transform rule for egress proxy.
 * Injects or overrides HTTP headers on outgoing requests to a specific domain.
 * Follows the Vercel Sandbox Firewall transform interface.
 *
 * @see https://vercel.com/docs/vercel-sandbox/concepts/firewall
 */
const HeaderTransformSchema = z.object({
	/** Headers to inject/override on outgoing requests */
	headers: z.record(z.string(), z.string()),
});

/**
 * Per-domain allow rule with optional header transforms.
 * When transforms are specified, TLS is terminated for that domain
 * so headers can be inspected and modified (credentials brokering).
 */
const DomainRuleSchema = z.array(
	z.object({
		transform: z.array(HeaderTransformSchema).optional(),
	}),
);

/**
 * Network policy for egress sandboxing.
 * Controls which domains/subnets Bash-spawned subprocesses (git, gh, npm,
 * curl, etc.) can reach and enables per-domain header injection
 * (credentials brokering).
 *
 * Three modes (following Vercel Sandbox Firewall conventions):
 * - **allow-all**: No networkPolicy set — unrestricted access (default)
 * - **deny-all**: networkPolicy set with no `allow` rules — blocks all traffic
 * - **user-defined**: networkPolicy with `allow` rules — deny-all by default,
 *   only explicitly listed domains are reachable
 *
 * Scope: Claude Code's sandbox network proxy only intercepts traffic from
 * Bash tool subprocesses. It does NOT apply to Claude's own inference API
 * calls, MCP server traffic, or built-in file tools (Read/Edit/Write).
 *
 * @see https://docs.anthropic.com/en/docs/claude-code/security#sandbox
 * @see https://vercel.com/docs/vercel-sandbox/concepts/firewall#network-policies
 */
export const NetworkPolicySchema = z.object({
	/**
	 * Network policy preset. When set, pre-populates the allow list with
	 * a curated set of domains. Additional `allow` rules are merged on top.
	 *
	 * - `"trusted"`: ~200 domains matching Claude Code on the web's default
	 *   allowlist — package registries, version control, cloud platforms,
	 *   container registries, dev tools, and monitoring services.
	 *
	 * @see https://docs.anthropic.com/en/docs/claude-code/claude-code-on-the-web#default-allowed-domains
	 */
	preset: z.enum(["trusted"]).optional(),

	/**
	 * Domain allow rules with optional transforms.
	 * When present, all unlisted domains are denied (deny-all default).
	 * Keys are domain patterns:
	 * - Exact match: "api.example.com"
	 * - Wildcard subdomain: "*.example.com" (matches any subdomain, NOT parent)
	 * - Wildcard segment: "www.*.com" (matches one segment)
	 *
	 * When a preset is also set, these rules are merged on top of the
	 * preset's domains (custom rules take precedence).
	 */
	allow: z.record(z.string(), DomainRuleSchema).optional(),

	/** Subnet-based rules */
	subnets: z
		.object({
			/** IP ranges to allow (bypasses domain matching) */
			allow: z.array(z.string()).optional(),
			/** IP ranges to deny (takes precedence over all allow rules) */
			deny: z.array(z.string()).optional(),
		})
		.optional(),
});

/**
 * Sandbox configuration for network egress control.
 * Configures the egress proxy that intercepts outbound traffic from
 * Bash-spawned subprocesses in agent sessions.
 *
 * When enabled, the proxy starts on EdgeWorker boot and sandbox
 * network ports are passed to the Claude Agent SDK per-session.
 * Only Bash tool commands (git, gh, npm, curl, etc.) route through
 * the proxy — Claude's inference API, MCP servers, and built-in
 * file tools are unaffected.
 *
 * @see https://docs.anthropic.com/en/docs/claude-code/security#sandbox
 */
export const SandboxConfigSchema = z.object({
	/**
	 * Enable or disable the egress proxy.
	 * When true, the proxy starts on EdgeWorker boot and sandbox network ports
	 * are passed to Claude Agent SDK sessions to route traffic through it.
	 * @default false
	 */
	enabled: z.boolean().optional(),

	/** HTTP proxy port for SDK sandbox.network.httpProxyPort */
	httpProxyPort: z.number().optional().default(9080),

	/** SOCKS proxy port for SDK sandbox.network.socksProxyPort */
	socksProxyPort: z.number().optional().default(9081),

	/**
	 * Network policy controlling allowed domains, transforms, and subnets.
	 * If omitted, all traffic is allowed (passthrough mode with logging).
	 */
	networkPolicy: NetworkPolicySchema.optional(),

	/**
	 * Whether the CA certificate has been trusted system-wide (e.g., via
	 * `sudo security add-trusted-cert` on macOS). When true, per-session
	 * CA cert env vars (NODE_EXTRA_CA_CERTS, GIT_SSL_CAINFO, etc.) are
	 * skipped — the OS cert store handles trust for all tools.
	 * @default false
	 */
	systemWideCert: z.boolean().optional(),

	/**
	 * Log all proxied requests (method, URL, domain, status).
	 * @default true
	 */
	logRequests: z.boolean().optional(),
});

/**
 * Memory-pressure gate configuration — a single intuitive knob.
 *
 * Accepts:
 *   - `false` (or omitted): gate disabled.
 *   - `true`: gate enabled at the default pressure threshold (0.85).
 *   - `number` in (0, 1]: gate enabled at that pressure threshold
 *     (e.g. `0.85` rejects new sessions when memory pressure exceeds 85%).
 *
 * "Pressure" is the worst of three normalized dimensions: process RSS as
 * a fraction of system memory, V8 heap usage as a fraction of the heap
 * size limit, and system memory used as a fraction of total. Using a
 * single percentage keeps the knob portable across host sizes (no
 * absolute-MB threshold to retune).
 *
 * Uses only cross-platform Node APIs (os.totalmem, os.freemem,
 * process.memoryUsage, v8.getHeapStatistics), so behavior is identical
 * on Linux and macOS.
 */
export const MemoryGateConfigSchema = z.union([
	z.boolean(),
	z
		.number()
		.gt(0, "memoryGate threshold must be greater than 0")
		.lte(1, "memoryGate threshold must be at most 1"),
]);

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

	/** Default Cursor model to use across all repositories (e.g., "composer-2", "gpt-5.4") */
	cursorDefaultModel: z.string().optional(),

	/** Default Cursor fallback model if primary Cursor model is unavailable */
	cursorDefaultFallbackModel: z.string().optional(),

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
	 * Sandbox configuration for network egress control.
	 * When enabled, starts an egress proxy and configures Claude Code to route
	 * all agent network traffic through it for inspection and filtering.
	 */
	sandbox: SandboxConfigSchema.optional(),

	/**
	 * Memory-pressure gate. When enabled, checks host memory before
	 * spawning a new agent runner and rejects with a user-facing
	 * message when the host is under pressure.
	 */
	memoryGate: MemoryGateConfigSchema.optional(),

	/**
	 * Maximum number of concurrent agent runners allowed across the
	 * edge worker. When the cap is reached, new webhook-triggered
	 * sessions are rejected with a user-facing "retry later" message.
	 * Omit or set to 0 to disable the cap.
	 */
	maxConcurrentRunners: z.number().int().nonnegative().optional(),
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
export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;
export type MemoryGateConfig = z.infer<typeof MemoryGateConfigSchema>;
export type NetworkPolicy = z.infer<typeof NetworkPolicySchema>;
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
