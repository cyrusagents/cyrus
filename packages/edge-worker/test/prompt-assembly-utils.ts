/**
 * Prompt Assembly Test Utilities
 *
 * Provides a human-readable DSL for testing EdgeWorker.assemblePrompt() method.
 */

import type { RepositoryConfig } from "cyrus-core";
import { expect } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";
import type { EdgeWorkerConfig } from "../src/types.js";

/**
 * Create an EdgeWorker instance for testing
 */
export function createTestWorker(
	repositories: RepositoryConfig[] = [],
	linearWorkspaceSlug?: string,
): EdgeWorker {
	// Create mock IssueTrackerServices for each repository
	const issueTrackers = new Map();
	for (const repo of repositories) {
		// Create a minimal mock IssueTrackerService with required methods
		const mockIssueTracker = {
			getComments: () => Promise.resolve([]),
			getComment: () => Promise.resolve(null),
			getIssueLabels: () => Promise.resolve([]),
			getClient: () => ({}),
			client: {
				rawRequest: () => Promise.resolve({ data: { comment: { body: "" } } }),
			},
		};
		issueTrackers.set(repo.id, mockIssueTracker as any);
	}

	const config: EdgeWorkerConfig = {
		cyrusHome: "/tmp/test-cyrus-home",
		defaultModel: "sonnet",
		linearWorkspaceSlug,
		repositories,
		issueTrackers,
		mcpServers: {},
	};
	return new EdgeWorker(config);
}

/**
 * Scenario builder for test cases - provides human-readable DSL
 */
export class PromptScenario {
	private worker: EdgeWorker;
	private input: any = {};
	private expectedUserPrompt?: string;
	private expectedSystemPrompt?: string;
	private expectedComponents?: string[];
	private expectedPromptType?: string;

	constructor(worker: EdgeWorker) {
		this.worker = worker;
	}

	// ===== Input Builders =====

	streamingSession() {
		this.input.isStreaming = true;
		this.input.isNewSession = false;
		return this;
	}

	continuationSession() {
		this.input.isStreaming = false;
		this.input.isNewSession = false;
		return this;
	}

	newSession() {
		this.input.isStreaming = false;
		this.input.isNewSession = true;
		return this;
	}

	assignmentBased() {
		this.input.isMentionTriggered = false;
		this.input.isLabelBasedPromptRequested = false;
		return this;
	}

	mentionTriggered() {
		this.input.isMentionTriggered = true;
		this.input.isLabelBasedPromptRequested = false;
		return this;
	}

	labelBasedPromptCommand() {
		this.input.isMentionTriggered = true;
		this.input.isLabelBasedPromptRequested = true;
		return this;
	}

	withUserComment(comment: string) {
		this.input.userComment = comment;
		return this;
	}

	withCommentAuthor(author: string) {
		this.input.commentAuthor = author;
		return this;
	}

	withCommentTimestamp(timestamp: string) {
		this.input.commentTimestamp = timestamp;
		return this;
	}

	withAttachments(manifest: string) {
		this.input.attachmentManifest = manifest;
		return this;
	}

	withLabels(...labels: string[]) {
		this.input.labels = labels;
		return this;
	}

	withSession(session: any) {
		this.input.session = session;
		return this;
	}

	withIssue(issue: any) {
		this.input.fullIssue = issue;
		return this;
	}

	withRepository(repo: any) {
		this.input.repository = repo;
		// Also ensure the worker has an IssueTrackerService for this repository
		if (!(this.worker as any).issueTrackers.has(repo.id)) {
			const mockIssueTracker = {
				getComments: () => Promise.resolve([]),
				getComment: () => Promise.resolve(null),
				getIssueLabels: () => Promise.resolve([]),
				getClient: () => ({}),
				client: {
					rawRequest: () =>
						Promise.resolve({ data: { comment: { body: "" } } }),
				},
			};
			(this.worker as any).issueTrackers.set(repo.id, mockIssueTracker);
		}
		return this;
	}

	withGuidance(guidance: any[]) {
		this.input.guidance = guidance;
		return this;
	}

	withAgentSession(agentSession: any) {
		this.input.agentSession = agentSession;
		return this;
	}

	withMentionTriggered(triggered: boolean) {
		this.input.isMentionTriggered = triggered;
		return this;
	}

	// ===== Expectation Builders =====

	expectUserPrompt(prompt: string) {
		this.expectedUserPrompt = prompt;
		return this;
	}

	expectSystemPrompt(prompt: string | undefined) {
		this.expectedSystemPrompt = prompt;
		return this;
	}

	expectComponents(...components: string[]) {
		this.expectedComponents = components;
		return this;
	}

	expectPromptType(type: string) {
		this.expectedPromptType = type;
		return this;
	}

	// ===== Execution =====

	async build() {
		return await (this.worker as any).assemblePrompt(this.input);
	}

	async verify() {
		const result = await (this.worker as any).assemblePrompt(this.input);

		if (this.expectedUserPrompt !== undefined) {
			expect(result.userPrompt).toBe(this.expectedUserPrompt);
		}

		if (this.expectedSystemPrompt !== undefined) {
			expect(result.systemPrompt).toBe(this.expectedSystemPrompt);
		}

		if (this.expectedComponents) {
			expect(result.metadata.components).toEqual(this.expectedComponents);
		}

		if (this.expectedPromptType) {
			expect(result.metadata.promptType).toBe(this.expectedPromptType);
		}

		return result;
	}
}

/**
 * Start building a test scenario
 */
export function scenario(worker: EdgeWorker): PromptScenario {
	return new PromptScenario(worker);
}
