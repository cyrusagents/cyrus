import type {
	AgentActivityCreateInput,
	IIssueTrackerService,
	ILogger,
	RepoSetupHookEvent,
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

	async postRepoSetupHookActivity(
		sessionId: string,
		workspaceId: string,
		event: RepoSetupHookEvent,
	): Promise<void> {
		const issueTracker = this.issueTrackers.get(workspaceId);
		if (!issueTracker) {
			this.logger.warn(`No issue tracker found for workspace ${workspaceId}`);
			return;
		}

		const parameter = event.repositoryName
			? `Repository setup hook for ${event.repositoryName}`
			: "Repository setup hook";

		await this.postActivityDirect(
			issueTracker,
			{
				agentSessionId: sessionId,
				content: {
					type: "action",
					action: event.scriptName,
					parameter,
					result: this.formatRepoSetupHookResult(event),
				},
			},
			"repository setup hook",
		);
	}

	private formatRepoSetupHookResult(event: RepoSetupHookEvent): string {
		if (event.status === "started") {
			return "Started.";
		}

		const duration = this.formatDuration(event.durationMs);
		if (event.status === "succeeded") {
			return `Succeeded${duration ? ` in ${duration}` : ""}.`;
		}

		const lines = [
			`Failed${duration ? ` after ${duration}` : ""}: ${event.errorMessage ?? "setup hook exited unsuccessfully"}`,
		];
		if (typeof event.exitCode === "number") {
			lines.push(`Exit code: ${event.exitCode}`);
		}
		if (event.signal) {
			lines.push(`Signal: ${event.signal}`);
		}

		const stdoutTail = this.escapeCodeFence(event.stdoutTail?.trim());
		const stderrTail = this.escapeCodeFence(event.stderrTail?.trim());
		if (stdoutTail) {
			lines.push("", "Stdout tail:", "```", stdoutTail, "```");
		}
		if (stderrTail) {
			lines.push("", "Stderr tail:", "```", stderrTail, "```");
		}
		const hint = this.formatRepoSetupHookFailureHint(event);
		if (hint) {
			lines.push("", hint);
		}
		return lines.join("\n");
	}

	private formatRepoSetupHookFailureHint(
		event: RepoSetupHookEvent,
	): string | null {
		const output = [event.errorMessage, event.stdoutTail, event.stderrTail]
			.filter((value): value is string => Boolean(value))
			.join("\n")
			.toLowerCase();

		if (!this.looksLikeSudoFailure(output)) {
			return null;
		}

		return "The setup script does not run with sudo privileges. Keep `cyrus-setup.sh` to repo-local setup. For hosted Cyrus, add required npm or apt packages in the Cyrus Dashboard at Settings > Packages (`/settings/packages`); for self-hosted Cyrus, preinstall privileged dependencies in the runtime or host.";
	}

	private looksLikeSudoFailure(output: string): boolean {
		return [
			/sudo:/,
			/no tty present/,
			/a password is required/,
			/not in the sudoers file/,
			/must be run as root/,
			/permission denied.*sudo/,
		].some((pattern) => pattern.test(output));
	}

	private formatDuration(durationMs?: number): string | null {
		if (typeof durationMs !== "number") return null;
		if (durationMs < 1_000) return `${durationMs}ms`;
		return `${(durationMs / 1_000).toFixed(1)}s`;
	}

	private escapeCodeFence(value?: string): string {
		return value?.replace(/```/g, "'''") ?? "";
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
