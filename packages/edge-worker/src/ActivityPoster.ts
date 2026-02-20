import type {
	AgentActivityCreateInput,
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

	async postInstantAcknowledgment(
		sessionId: string,
		repositoryId: string,
	): Promise<void> {
		const issueTracker = this.issueTrackers.get(repositoryId);
		if (!issueTracker) {
			this.logger.warn(`No issue tracker found for repository ${repositoryId}`);
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
		repositoryId: string,
	): Promise<void> {
		const issueTracker = this.issueTrackers.get(repositoryId);
		if (!issueTracker) {
			this.logger.warn(`No issue tracker found for repository ${repositoryId}`);
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

	async postRepositorySelectionActivity(
		sessionId: string,
		repositoryId: string,
		repositoryName: string,
		selectionMethod:
			| "description-tag"
			| "label-based"
			| "project-based"
			| "team-based"
			| "team-prefix"
			| "catch-all"
			| "workspace-fallback"
			| "user-selected",
	): Promise<void> {
		const issueTracker = this.issueTrackers.get(repositoryId);
		if (!issueTracker) {
			this.logger.warn(`No issue tracker found for repository ${repositoryId}`);
			return;
		}

		let methodDisplay: string;
		if (selectionMethod === "user-selected") {
			methodDisplay = "selected by user";
		} else if (selectionMethod === "description-tag") {
			methodDisplay = "matched via [repo=...] tag in issue description";
		} else if (selectionMethod === "label-based") {
			methodDisplay = "matched via label-based routing";
		} else if (selectionMethod === "project-based") {
			methodDisplay = "matched via project-based routing";
		} else if (selectionMethod === "team-based") {
			methodDisplay = "matched via team-based routing";
		} else if (selectionMethod === "team-prefix") {
			methodDisplay = "matched via team prefix routing";
		} else if (selectionMethod === "catch-all") {
			methodDisplay = "matched via catch-all routing";
		} else {
			methodDisplay = "matched via workspace fallback";
		}

		await this.postActivityDirect(
			issueTracker,
			{
				agentSessionId: sessionId,
				content: {
					type: "thought",
					body: `Repository "${repositoryName}" has been ${methodDisplay}.`,
				},
			},
			"repository selection",
		);
	}

	async postSystemPromptSelectionThought(
		sessionId: string,
		labels: string[],
		repositoryId: string,
	): Promise<void> {
		const issueTracker = this.issueTrackers.get(repositoryId);
		if (!issueTracker) {
			this.logger.warn(`No issue tracker found for repository ${repositoryId}`);
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
		repositoryId: string,
		isStreaming: boolean,
	): Promise<void> {
		const issueTracker = this.issueTrackers.get(repositoryId);
		if (!issueTracker) {
			this.logger.warn(`No issue tracker found for repository ${repositoryId}`);
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
		repositoryId: string,
		parentId?: string,
	): Promise<void> {
		// Get the issue tracker for this repository
		const issueTracker = this.issueTrackers.get(repositoryId);
		if (!issueTracker) {
			throw new Error(`No issue tracker found for repository ${repositoryId}`);
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
