/**
 * PrompterCredentialService — per-prompter credential resolution for
 * multi-user self-hosted Cyrus (CYPACK-1502).
 *
 * Thin, EdgeWorker-facing wrapper over the pure helpers in
 * `cyrus-core/prompter-credentials`. Owns:
 *   - the "is the feature on" check (non-empty `linearUsers`)
 *   - extracting the triggering human from Linear webhooks
 *   - deciding which mapped user a new session should be pinned to
 *   - re-resolving that user's secrets every time a runner is built (new
 *     session or resume) so rotated tokens are picked up without a restart
 *   - installing the per-session git credential helper
 *
 * It never logs secret values; callers post its `message`/`note` strings to
 * Linear verbatim.
 */

import {
	type AgentSessionCreatedWebhook,
	type AgentSessionPromptedWebhook,
	type CyrusAgentSession,
	collectEnvRefNames,
	decideFollowUpPrompt,
	decideSessionCredentialUser,
	ensurePrompterGitCredentialHelper,
	type FollowUpDecision,
	type ILogger,
	isPrompterCredentialsEnabled,
	type LinearUserConfig,
	type PrompterCredentialPolicy,
	type PrompterDecision,
	type PrompterIdentity,
	type ResolvedPrompterCredentials,
	resolveLinearUserCredentials,
	resolvePrompterCredentialPolicy,
	type SessionPrompter,
} from "cyrus-core";

export interface PrompterCredentialServiceConfig {
	linearUsers?: Record<string, LinearUserConfig>;
	prompterCredentialPolicy?: PrompterCredentialPolicy;
}

/**
 * Thrown by {@link PrompterCredentialService.resolveForSession} when a
 * pinned session's mapping can no longer be resolved (user removed, file
 * deleted, env var unset). EdgeWorker posts `message` to Linear and does
 * not start the runner.
 */
export class PrompterCredentialError extends Error {
	constructor(
		message: string,
		public readonly linearUserId: string | undefined,
	) {
		super(message);
		this.name = "PrompterCredentialError";
	}
}

export class PrompterCredentialService {
	private config: PrompterCredentialServiceConfig;
	private helperPath: string | null = null;
	private readonly credentialEnvNames = new Set<string>();

	constructor(
		config: PrompterCredentialServiceConfig,
		private readonly cyrusHome: string,
		private readonly logger: ILogger,
	) {
		this.config = config;
		for (const name of collectEnvRefNames(config.linearUsers)) {
			this.credentialEnvNames.add(name);
		}
	}

	/** Hot-reload entry point (ConfigManager `configChanged`). */
	updateConfig(config: PrompterCredentialServiceConfig): void {
		this.config = config;
		for (const name of collectEnvRefNames(config.linearUsers)) {
			this.credentialEnvNames.add(name);
		}
	}

	/** True when at least one Linear user is mapped. */
	isEnabled(): boolean {
		return isPrompterCredentialsEnabled(this.config.linearUsers);
	}

	get policy() {
		return resolvePrompterCredentialPolicy(
			this.config.prompterCredentialPolicy,
		);
	}

	private get linearUsers(): Record<string, LinearUserConfig> {
		return this.config.linearUsers ?? {};
	}

	displayNameFor(linearUserId: string): string {
		return this.linearUsers[linearUserId]?.displayName || linearUserId;
	}

	/**
	 * The human who triggered a `created` webhook (the assigner or the
	 * @mentioner). Undefined when Linear sent no creator.
	 */
	static prompterFromCreatedWebhook(
		webhook: AgentSessionCreatedWebhook,
	): PrompterIdentity | undefined {
		const creator = webhook.agentSession.creator;
		const id = creator?.id ?? webhook.agentSession.creatorId ?? undefined;
		if (!id) return undefined;
		return {
			linearUserId: id,
			name: creator?.name ?? undefined,
			email: creator?.email ?? undefined,
		};
	}

	/**
	 * The human who sent a follow-up prompt: Linear puts the author on the
	 * activity (`agentActivity.userId`); the fetched comment author is the
	 * second source. When neither is present the sender is UNKNOWN and this
	 * returns undefined — it never assumes the session creator sent it, so a
	 * legacy payload cannot impersonate the pinned user.
	 */
	static prompterFromPromptedWebhook(
		webhook: AgentSessionPromptedWebhook,
		commentUser?: { id?: string; name?: string; email?: string } | null,
	): PrompterIdentity | undefined {
		const activityUserId = webhook.agentActivity?.userId ?? undefined;
		if (activityUserId) {
			const sameAsCreator = webhook.agentSession.creator?.id === activityUserId;
			return {
				linearUserId: activityUserId,
				name: sameAsCreator
					? (webhook.agentSession.creator?.name ?? commentUser?.name)
					: commentUser?.name,
				email: sameAsCreator
					? (webhook.agentSession.creator?.email ?? commentUser?.email)
					: commentUser?.email,
			};
		}
		if (commentUser?.id) {
			return {
				linearUserId: commentUser.id,
				name: commentUser.name,
				email: commentUser.email,
			};
		}
		return undefined;
	}

	/**
	 * Whether the "creator" is Cyrus itself (delegating a sub-issue it
	 * created) rather than a human.
	 */
	static isNonHumanCreator(
		webhook: AgentSessionCreatedWebhook | AgentSessionPromptedWebhook,
		prompter: PrompterIdentity | undefined,
	): boolean {
		if (!prompter) return true;
		return (
			prompter.linearUserId === webhook.appUserId ||
			prompter.linearUserId === webhook.agentSession.appUserId
		);
	}

	/**
	 * Decide the credential user for a NEW Linear session. Returns `null`
	 * when the feature is off (zero behaviour change).
	 */
	decideForNewSession(input: {
		prompter: PrompterIdentity | undefined;
		isNonHuman: boolean;
		parentSession?: CyrusAgentSession;
	}): PrompterDecision | null {
		if (!this.isEnabled()) return null;
		return decideSessionCredentialUser({
			linearUsers: this.linearUsers,
			policy: this.config.prompterCredentialPolicy,
			prompter: input.prompter,
			isNonHuman: input.isNonHuman,
			parentCredentialUserId: input.parentSession?.prompter?.credentialUserId,
		});
	}

	/** Build the `SessionPrompter` to pin on a session from a decision. */
	static pinFromDecision(
		decision: Extract<PrompterDecision, { action: "use-user" | "host" }>,
		prompter: PrompterIdentity | undefined,
	): SessionPrompter {
		if (decision.action === "host") {
			return {
				linearUserId: prompter?.linearUserId ?? "",
				name: prompter?.name,
				email: prompter?.email,
				source: "host",
				hostReason: decision.reason,
			};
		}
		return {
			linearUserId: prompter?.linearUserId ?? decision.linearUserId,
			name: prompter?.name,
			email: prompter?.email,
			credentialUserId: decision.linearUserId,
			source: decision.source,
		};
	}

	/** Secret-free thought text announcing which credentials a session uses. */
	describePin(pin: SessionPrompter): string {
		if (pin.source === "host" || !pin.credentialUserId) {
			return `Running with the host machine's credentials (${pin.hostReason ?? "operator policy"}). Commits, pushes and PRs from this session will be attributed to the host's GitHub identity.`;
		}
		const who = this.displayNameFor(pin.credentialUserId);
		const inherited =
			pin.source === "parent"
				? " (inherited from the parent issue's session)"
				: "";
		return `Running as ${who}${inherited}. This session uses their Claude access and GitHub account. Commits, pushes and pull requests will be attributed to ${who}.`;
	}

	/**
	 * Decide what to do with a follow-up prompt on an EXISTING session.
	 * Returns `null` when the feature is off.
	 */
	decideForFollowUp(input: {
		session: CyrusAgentSession;
		prompter: PrompterIdentity | undefined;
	}): FollowUpDecision | null {
		// A session that already carries a pin is governed by it even if the
		// mapping has since been emptied (fail closed — see resolveForSession).
		if (!this.isEnabled() && !input.session.prompter) return null;
		return decideFollowUpPrompt({
			linearUsers: this.linearUsers,
			policy: this.config.prompterCredentialPolicy,
			sessionPrompter: input.session.prompter,
			prompter: input.prompter,
		});
	}

	/**
	 * Resolve the secrets for a session pinned to a mapped user. Called on
	 * EVERY runner build (new + resume) so rotation is picked up. Returns
	 * `undefined` when the session is not pinned (host credentials apply —
	 * only reachable through an explicit `host` policy or a session that
	 * predates the mapping) or the feature is off.
	 *
	 * @throws PrompterCredentialError when the pin can no longer be resolved.
	 */
	resolveForSession(
		session: CyrusAgentSession,
	): ResolvedPrompterCredentials | undefined {
		const pin = session.prompter;
		// No pin: nothing to resolve (the caller applies the backstop policy
		// when the feature is on). A pin ALWAYS resolves — independent of how
		// many users are currently mapped — so removing the last mapped user
		// turns that user's sessions into refusals, never into host sessions.
		if (!pin) return undefined;
		if (pin.source === "host" || !pin.credentialUserId) {
			this.logger.info(
				`Session ${session.id} runs with host credentials (${pin.hostReason ?? "operator policy"})`,
			);
			return undefined;
		}
		const result = resolveLinearUserCredentials(
			pin.credentialUserId,
			this.linearUsers[pin.credentialUserId],
			{
				gitCredentialHelperPath: this.ensureHelper(),
				additionalOmitEnv: this.allEnvRefNames(),
			},
		);
		if (!result.ok) {
			throw new PrompterCredentialError(
				`Cannot run this session under ${this.displayNameFor(pin.credentialUserId)}'s credentials: ${result.message}. Fix the mapping with \`cyrus add-user\` / \`cyrus check-users\` and prompt the session again.`,
				pin.credentialUserId,
			);
		}
		this.logger.info(
			`Session ${session.id} runs as Linear user ${result.credentials.displayName} (claude:${result.credentials.claudeCredentialKind}#${result.credentials.fingerprints.claude} github:${result.credentials.github.login ?? "?"}#${result.credentials.fingerprints.github})`,
		);
		return result.credentials;
	}

	/**
	 * Check that a pin's secrets are readable RIGHT NOW, before any worktree
	 * or runner exists. Returns a secret-free problem description, or null.
	 * Host pins have nothing to validate.
	 */
	validatePin(pin: SessionPrompter): string | null {
		if (pin.source === "host" || !pin.credentialUserId) return null;
		const result = resolveLinearUserCredentials(
			pin.credentialUserId,
			this.linearUsers[pin.credentialUserId],
			{ gitCredentialHelperPath: this.ensureHelper() },
		);
		if (result.ok) return null;
		return `Cannot run this session under ${this.displayNameFor(pin.credentialUserId)}'s credentials: ${result.message}. Fix the mapping with \`cyrus add-user\` / \`cyrus check-users\`, then start a new session.`;
	}

	/**
	 * Env reference names seen since startup, including removed mappings whose
	 * values may still exist in process.env until the operator restarts Cyrus.
	 * Stripped from every session's child env (pinned or host) so one user's
	 * secret in `~/.cyrus/.env` is never visible to another user's agent.
	 */
	allEnvRefNames(): string[] {
		return [...this.credentialEnvNames].sort();
	}

	/** Install the git credential helper once per process (idempotent on disk). */
	ensureHelper(): string {
		if (!this.helperPath) {
			this.helperPath = ensurePrompterGitCredentialHelper(this.cyrusHome);
		}
		return this.helperPath;
	}

	/**
	 * Short, secret-free description for activities/logs, e.g.
	 * "Ada (claude:oauthToken#1a2b3c4d, github:ada#9f8e7d6c)".
	 */
	static describe(c: ResolvedPrompterCredentials): string {
		return `${c.displayName} (claude:${c.claudeCredentialKind}#${c.fingerprints.claude}, github:${c.github.login ?? "token"}#${c.fingerprints.github})`;
	}
}
