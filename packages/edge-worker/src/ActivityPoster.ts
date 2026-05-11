import type {
	AgentActivityCreateInput,
	EnvironmentConfig,
	IIssueTrackerService,
	ILogger,
	RepositoryConfig,
} from "cyrus-core";

export class ActivityPoster {
	private issueTrackers: Map<string, IIssueTrackerService>;
	private repositories: Map<string, RepositoryConfig>;
	private logger: ILogger;

	constructor(
		issueTrackers: Map<string, IIssueTrackerService>,
		repositories: Map<string, RepositoryConfig>,
		logger: ILogger,
	) {
		this.issueTrackers = issueTrackers;
		this.repositories = repositories;
		this.logger = logger;
	}

	async postActivityDirect(
		issueTracker: IIssueTrackerService,
		input: AgentActivityCreateInput,
		label: string,
	): Promise<string | null> {
		try {
			const result = await issueTracker.createAgentActivity(input);
			if (result.success) {
				if (result.agentActivity) {
					const activity = await result.agentActivity;
					this.logger.debug(`Created ${label} activity ${activity.id}`);
					return activity.id;
				}
				this.logger.debug(`Created ${label}`);
				return null;
			}
			this.logger.error(`Failed to create ${label}:`, result);
			return null;
		} catch (error) {
			this.logger.error(`Error creating ${label}:`, error);
			return null;
		}
	}

	async postThoughtActivity(
		sessionId: string,
		workspaceId: string,
		body: string,
	): Promise<void> {
		const issueTracker = this.issueTrackers.get(workspaceId);
		if (!issueTracker) {
			this.logger.warn(`No issue tracker found for workspace ${workspaceId}`);
			return;
		}

		await this.postActivityDirect(
			issueTracker,
			{
				agentSessionId: sessionId,
				content: { type: "thought", body },
			},
			"thought activity",
		);
	}

	async postInstantAcknowledgment(
		sessionId: string,
		workspaceId: string,
	): Promise<void> {
		const issueTracker = this.issueTrackers.get(workspaceId);
		if (!issueTracker) {
			this.logger.warn(`No issue tracker found for workspace ${workspaceId}`);
			return;
		}

		await this.postActivityDirect(
			issueTracker,
			{
				agentSessionId: sessionId,
				content: {
					type: "thought",
					body: "I've received your request and I'm starting to work on it. Let me analyze the issue and prepare my approach.",
				},
			},
			"instant acknowledgment",
		);
	}

	async postParentResumeAcknowledgment(
		sessionId: string,
		workspaceId: string,
	): Promise<void> {
		const issueTracker = this.issueTrackers.get(workspaceId);
		if (!issueTracker) {
			this.logger.warn(`No issue tracker found for workspace ${workspaceId}`);
			return;
		}

		await this.postActivityDirect(
			issueTracker,
			{
				agentSessionId: sessionId,
				content: { type: "thought", body: "Resuming from child session" },
			},
			"parent resume acknowledgment",
		);
	}

	async postRoutingActivity(
		sessionId: string,
		workspaceId: string,
		repoLines: string[],
		routingMethod?: string,
	): Promise<void> {
		const issueTracker = this.issueTrackers.get(workspaceId);
		if (!issueTracker) {
			this.logger.warn(`No issue tracker found for workspace ${workspaceId}`);
			return;
		}

		const methodDisplayMap: Record<string, string> = {
			"user-selected": "User selection",
			"description-tag": "[repo=...] tag",
			"label-based": "Label routing",
			"project-based": "Project routing",
			"team-based": "Team routing",
			"team-prefix": "Team prefix routing",
			"catch-all": "Catch-all",
			"workspace-fallback": "Workspace fallback",
		};
		const methodDisplay = routingMethod
			? (methodDisplayMap[routingMethod] ?? routingMethod)
			: undefined;

		const header = methodDisplay
			? `**Routing** (${methodDisplay})`
			: "**Routing**";

		const body = `${header}\n${repoLines.join("\n")}`;

		await this.postActivityDirect(
			issueTracker,
			{
				agentSessionId: sessionId,
				content: {
					type: "thought",
					body,
				},
			},
			"routing",
		);
	}

	/**
	 * Post a Linear activity announcing that an environment config was
	 * matched and bound to the session. Renders only the fields the
	 * environment actually customized so the activity stays scannable.
	 *
	 * @param sessionId       Linear agent session ID.
	 * @param workspaceId     Linear workspace ID for routing the activity.
	 * @param env             The environment config that was matched.
	 * @param acceptedOverrides Inline `env=name$K=V` overrides accepted
	 *                        from the issue description (already filtered
	 *                        against `env.allowInlineOverrides`).
	 */
	async postEnvironmentBindingActivity(
		sessionId: string,
		workspaceId: string,
		env: EnvironmentConfig,
		acceptedOverrides: Record<string, string> = {},
	): Promise<void> {
		const issueTracker = this.issueTrackers.get(workspaceId);
		if (!issueTracker) {
			this.logger.warn(`No issue tracker found for workspace ${workspaceId}`);
			return;
		}

		const lines = ActivityPoster.formatEnvironmentBindingLines(
			env,
			acceptedOverrides,
		);
		const header = env.isolated
			? `**Environment** \`${env.name ?? "(unnamed)"}\` (isolated)`
			: `**Environment** \`${env.name ?? "(unnamed)"}\``;
		const body = lines.length > 0 ? `${header}\n${lines.join("\n")}` : header;

		await this.postActivityDirect(
			issueTracker,
			{
				agentSessionId: sessionId,
				content: { type: "thought", body },
			},
			"environment binding",
		);
	}

	/**
	 * Pure formatter (static for testability) that turns an env config
	 * into a list of human-readable bullet lines covering only the
	 * fields that have been customized. Kept separate from
	 * `postEnvironmentBindingActivity` so unit tests can assert on the
	 * rendered text without mocking issue trackers.
	 */
	static formatEnvironmentBindingLines(
		env: EnvironmentConfig,
		acceptedOverrides: Record<string, string> = {},
	): string[] {
		const lines: string[] = [];
		if (env.description) lines.push(`- ${env.description}`);
		if (env.systemPrompt) lines.push("- System prompt: from env (inline)");
		else if (env.systemPromptPath)
			lines.push(`- System prompt: file \`${env.systemPromptPath}\``);
		if (env.allowedTools !== undefined)
			lines.push(`- Allowed tools: ${env.allowedTools.length} entries`);
		if (env.disallowedTools !== undefined)
			lines.push(`- Disallowed tools: ${env.disallowedTools.length} entries`);
		if (env.mcpConfigPath !== undefined) {
			const paths = Array.isArray(env.mcpConfigPath)
				? env.mcpConfigPath.length
				: 1;
			lines.push(`- MCP config: ${paths} path(s) (replaces repo defaults)`);
		}
		if (env.sandbox) lines.push("- Sandbox: env override");
		if (env.plugins?.length || env.skills?.length) {
			const total = (env.plugins?.length ?? 0) + (env.skills?.length ?? 0);
			lines.push(`- Plugins/skills: ${total} entries`);
		}
		if (env.claudeSettingSources !== undefined) {
			lines.push(
				env.claudeSettingSources.length === 0
					? "- Claude settings sources: none (fully isolated)"
					: `- Claude settings sources: ${env.claudeSettingSources.join(", ")}`,
			);
		}
		if (env.env && Object.keys(env.env).length > 0) {
			lines.push(
				`- Env variables: ${Object.keys(env.env).length} (${Object.keys(env.env).sort().join(", ")})`,
			);
		}
		if (env.allowInlineOverrides?.length) {
			lines.push(
				`- Allowed inline overrides: ${env.allowInlineOverrides.join(", ")}`,
			);
		}
		const acceptedKeys = Object.keys(acceptedOverrides).sort();
		if (acceptedKeys.length > 0) {
			lines.push(`- Inline overrides accepted: ${acceptedKeys.join(", ")}`);
		}
		if (env.repositories?.length) {
			lines.push(`- Read-only repositories: ${env.repositories.join(", ")}`);
		}
		if (env.gitWorktrees !== undefined) {
			lines.push(
				env.gitWorktrees.length === 0
					? "- Git worktrees: none (no-git workspace)"
					: `- Git worktrees: ${env.gitWorktrees.join(", ")}`,
			);
		}
		if (env.restrictHomeDirectoryReads === false) {
			lines.push("- Home-directory read restriction: disabled");
		}
		if (env.strictToolPermissions === false) {
			lines.push("- Strict tool permissions: disabled (legacy rubber-stamp)");
		}
		return lines;
	}

	async postSystemPromptSelectionThought(
		sessionId: string,
		labels: string[],
		workspaceId: string,
		repositoryId: string,
	): Promise<void> {
		const issueTracker = this.issueTrackers.get(workspaceId);
		if (!issueTracker) {
			this.logger.warn(`No issue tracker found for workspace ${workspaceId}`);
			return;
		}

		// Determine which prompt type was selected and which label triggered it
		let selectedPromptType: string | null = null;
		let triggerLabel: string | null = null;
		const repository = Array.from(this.repositories.values()).find(
			(r) => r.id === repositoryId,
		);

		if (repository?.labelPrompts) {
			// Check debugger labels
			const debuggerConfig = repository.labelPrompts.debugger;
			const debuggerLabels = Array.isArray(debuggerConfig)
				? debuggerConfig
				: debuggerConfig?.labels;
			const debuggerLabel = debuggerLabels?.find((label) =>
				labels.includes(label),
			);
			if (debuggerLabel) {
				selectedPromptType = "debugger";
				triggerLabel = debuggerLabel;
			} else {
				// Check builder labels
				const builderConfig = repository.labelPrompts.builder;
				const builderLabels = Array.isArray(builderConfig)
					? builderConfig
					: builderConfig?.labels;
				const builderLabel = builderLabels?.find((label) =>
					labels.includes(label),
				);
				if (builderLabel) {
					selectedPromptType = "builder";
					triggerLabel = builderLabel;
				} else {
					// Check scoper labels
					const scoperConfig = repository.labelPrompts.scoper;
					const scoperLabels = Array.isArray(scoperConfig)
						? scoperConfig
						: scoperConfig?.labels;
					const scoperLabel = scoperLabels?.find((label) =>
						labels.includes(label),
					);
					if (scoperLabel) {
						selectedPromptType = "scoper";
						triggerLabel = scoperLabel;
					} else {
						// Check orchestrator labels
						const orchestratorConfig = repository.labelPrompts.orchestrator;
						const orchestratorLabels = Array.isArray(orchestratorConfig)
							? orchestratorConfig
							: (orchestratorConfig?.labels ?? ["orchestrator"]);
						const orchestratorLabel = orchestratorLabels?.find((label) =>
							labels.includes(label),
						);
						if (orchestratorLabel) {
							selectedPromptType = "orchestrator";
							triggerLabel = orchestratorLabel;
						}
					}
				}
			}
		}

		// Only post if a role was actually triggered
		if (!selectedPromptType || !triggerLabel) {
			return;
		}

		await this.postActivityDirect(
			issueTracker,
			{
				agentSessionId: sessionId,
				content: {
					type: "thought",
					body: `Entering '${selectedPromptType}' mode because of the '${triggerLabel}' label. I'll follow the ${selectedPromptType} process...`,
				},
			},
			"system prompt selection",
		);
	}

	async postInstantPromptedAcknowledgment(
		sessionId: string,
		workspaceId: string,
		isStreaming: boolean,
	): Promise<void> {
		const issueTracker = this.issueTrackers.get(workspaceId);
		if (!issueTracker) {
			this.logger.warn(`No issue tracker found for workspace ${workspaceId}`);
			return;
		}

		const message = isStreaming
			? "I've queued up your message as guidance"
			: "Getting started on that...";

		await this.postActivityDirect(
			issueTracker,
			{
				agentSessionId: sessionId,
				content: { type: "thought", body: message },
			},
			"prompted acknowledgment",
		);
	}

	async postComment(
		issueId: string,
		body: string,
		workspaceId: string,
		parentId?: string,
	): Promise<void> {
		const issueTracker = this.issueTrackers.get(workspaceId);
		if (!issueTracker) {
			throw new Error(`No issue tracker found for workspace ${workspaceId}`);
		}
		const commentInput: { body: string; parentId?: string } = {
			body,
		};
		// Add parent ID if provided (for reply)
		if (parentId) {
			commentInput.parentId = parentId;
		}
		await issueTracker.createComment(issueId, commentInput);
	}
}
