/**
 * Linear Message Translator
 *
 * Translates Linear webhook payloads into unified internal messages for the
 * internal message bus.
 *
 * @module linear-event-transport/LinearMessageTranslator
 */

import { randomUUID } from "node:crypto";
import type { AgentActivitySignal } from "@linear/sdk";
import type { LinearWebhookPayload } from "@linear/sdk/webhooks";
import type {
	ContentUpdateMessage,
	GuidanceItem,
	IMessageTranslator,
	LinearContentUpdatePlatformData,
	LinearPlatformRef,
	LinearSessionStartPlatformData,
	LinearStopSignalPlatformData,
	LinearUnassignPlatformData,
	LinearUserPromptPlatformData,
	SessionStartMessage,
	StopSignalMessage,
	TranslationContext,
	TranslationResult,
	UnassignMessage,
	UserPromptMessage,
} from "cyrus-core";
import {
	type AgentSessionCreatedWebhook,
	type AgentSessionPromptedWebhook,
	type IssueUnassignedWebhook,
	type IssueUpdateWebhook,
	isAgentSessionCreatedWebhook,
	isAgentSessionPromptedWebhook,
	isIssueTitleOrDescriptionUpdateWebhook,
	isIssueUnassignedWebhook,
	type Webhook,
} from "cyrus-core";

// Helper type for safely accessing nested properties that may not exist in webhook types
type SafeRecord = Record<string, unknown>;

/**
 * Translates Linear webhook payloads into internal messages.
 */
export class LinearMessageTranslator
	implements IMessageTranslator<LinearWebhookPayload>
{
	/**
	 * Check if this translator can handle the given webhook.
	 */
	canTranslate(webhook: unknown): webhook is LinearWebhookPayload {
		if (!webhook || typeof webhook !== "object") {
			return false;
		}

		const w = webhook as Record<string, unknown>;

		// Linear webhooks have specific type/action combinations
		return (
			typeof w.type === "string" &&
			typeof w.action === "string" &&
			(w.type === "AgentSessionEvent" ||
				w.type === "AppUserNotification" ||
				w.type === "Issue")
		);
	}

	/**
	 * Translate a Linear webhook into an internal message.
	 */
	translate(
		webhook: LinearWebhookPayload,
		context?: TranslationContext,
	): TranslationResult {
		// Cast to our Webhook union type for type guards
		const w = webhook as unknown as Webhook;

		if (isAgentSessionCreatedWebhook(w)) {
			return this.translateAgentSessionCreated(w, context);
		}

		if (isAgentSessionPromptedWebhook(w)) {
			return this.translateAgentSessionPrompted(w, context);
		}

		if (isIssueUnassignedWebhook(w)) {
			return this.translateIssueUnassigned(w, context);
		}

		if (isIssueTitleOrDescriptionUpdateWebhook(w)) {
			return this.translateIssueUpdate(w, context);
		}

		return {
			success: false,
			reason: `Unsupported webhook type: ${webhook.type}/${webhook.action}`,
		};
	}

	/**
	 * Translate AgentSessionCreatedWebhook to SessionStartMessage.
	 */
	private translateAgentSessionCreated(
		webhook: AgentSessionCreatedWebhook,
		context?: TranslationContext,
	): TranslationResult {
		const { agentSession, guidance, organizationId, createdAt } = webhook;

		if (!agentSession.issue) {
			return {
				success: false,
				reason: "AgentSessionCreated webhook missing issue data",
			};
		}

		const issue = agentSession.issue;
		const comment = agentSession.comment;

		// Determine initial prompt from comment body
		const AGENT_SESSION_MARKER = "This thread is for an agent session";
		const commentBody = comment?.body;
		const isMentionTriggered =
			commentBody && !commentBody.includes(AGENT_SESSION_MARKER);
		const initialPrompt = isMentionTriggered
			? (commentBody ?? "")
			: (issue.description ?? "");

		// Build platform data
		const platformData: LinearSessionStartPlatformData = {
			agentSession: this.buildAgentSessionRef(agentSession),
			issue: this.buildIssueRef(issue as SafeRecord),
			comment: comment
				? this.buildCommentRef(comment as SafeRecord)
				: undefined,
			guidance: guidance?.map((g) => this.buildGuidanceItem(g as SafeRecord)),
			isMentionTriggered: !!isMentionTriggered,
			linearApiToken: context?.linearApiToken,
		};

		// Extract labels if available
		const issueWithLabels = issue as SafeRecord;
		const labels = Array.isArray(issueWithLabels.labels)
			? issueWithLabels.labels.map((l: SafeRecord) => String(l.name || ""))
			: undefined;

		const message: SessionStartMessage = {
			id: randomUUID(),
			source: "linear",
			action: "session_start",
			receivedAt: this.toISOString(createdAt),
			organizationId,
			sessionKey: agentSession.id,
			workItemId: issue.id,
			workItemIdentifier: issue.identifier,
			author: this.extractAuthorFromSession(agentSession),
			initialPrompt,
			title: issue.title,
			description: issue.description ?? undefined,
			labels,
			platformData,
		};

		return { success: true, message };
	}

	/**
	 * Translate AgentSessionPromptedWebhook to UserPromptMessage or StopSignalMessage.
	 */
	private translateAgentSessionPrompted(
		webhook: AgentSessionPromptedWebhook,
		_context?: TranslationContext,
	): TranslationResult {
		const { agentSession, agentActivity, organizationId, createdAt } = webhook;

		if (!agentSession.issue) {
			return {
				success: false,
				reason: "AgentSessionPrompted webhook missing issue data",
			};
		}

		// Check if this is a stop signal
		if (agentActivity?.signal === "stop") {
			return this.translateStopSignal(webhook);
		}

		const issue = agentSession.issue;

		// Extract content from agentActivity
		const content = agentActivity?.content?.body ?? "";

		// Build platform data
		const platformData: LinearUserPromptPlatformData = {
			agentActivity: this.buildAgentActivityRef(agentActivity),
			agentSession: this.buildAgentSessionRef(agentSession),
		};

		const message: UserPromptMessage = {
			id: randomUUID(),
			source: "linear",
			action: "user_prompt",
			receivedAt: this.toISOString(createdAt),
			organizationId,
			sessionKey: agentSession.id,
			workItemId: issue.id,
			workItemIdentifier: issue.identifier,
			author: this.extractAuthorFromActivity(agentActivity),
			content,
			platformData,
		};

		return { success: true, message };
	}

	/**
	 * Translate AgentSessionPromptedWebhook with stop signal to StopSignalMessage.
	 */
	private translateStopSignal(
		webhook: AgentSessionPromptedWebhook,
	): TranslationResult {
		const { agentSession, agentActivity, organizationId, createdAt } = webhook;

		if (!agentSession.issue) {
			return {
				success: false,
				reason: "Stop signal webhook missing issue data",
			};
		}

		const issue = agentSession.issue;

		// Build platform data
		const platformData: LinearStopSignalPlatformData = {
			agentActivity: this.buildAgentActivityRef(agentActivity),
			agentSession: this.buildAgentSessionRef(agentSession),
		};

		const message: StopSignalMessage = {
			id: randomUUID(),
			source: "linear",
			action: "stop_signal",
			receivedAt: this.toISOString(createdAt),
			organizationId,
			sessionKey: agentSession.id,
			workItemId: issue.id,
			workItemIdentifier: issue.identifier,
			platformData,
		};

		return { success: true, message };
	}

	/**
	 * Translate IssueUnassignedWebhook to UnassignMessage.
	 */
	private translateIssueUnassigned(
		webhook: IssueUnassignedWebhook,
		_context?: TranslationContext,
	): TranslationResult {
		const { notification, organizationId, createdAt } = webhook;
		const issue = notification.issue;

		if (!issue) {
			return {
				success: false,
				reason: "IssueUnassigned webhook missing issue data",
			};
		}

		// Build platform data
		const platformData: LinearUnassignPlatformData = {
			issue: this.buildIssueRef(issue as SafeRecord),
			issueUrl: issue.url,
		};

		const message: UnassignMessage = {
			id: randomUUID(),
			source: "linear",
			action: "unassign",
			receivedAt: this.toISOString(createdAt),
			organizationId,
			// For unassign, we don't have a session key, use issue ID
			sessionKey: issue.id,
			workItemId: issue.id,
			workItemIdentifier: issue.identifier,
			platformData,
		};

		return { success: true, message };
	}

	/**
	 * Translate IssueUpdateWebhook to ContentUpdateMessage.
	 */
	private translateIssueUpdate(
		webhook: IssueUpdateWebhook,
		_context?: TranslationContext,
	): TranslationResult {
		const { data: issueData, updatedFrom, organizationId, createdAt } = webhook;

		if (!updatedFrom) {
			return {
				success: false,
				reason: "IssueUpdate webhook missing updatedFrom data",
			};
		}

		// Build changes object
		const changes: ContentUpdateMessage["changes"] = {};

		if ("title" in updatedFrom) {
			changes.previousTitle = updatedFrom.title as string | undefined;
			changes.newTitle = issueData.title;
		}

		if ("description" in updatedFrom) {
			changes.previousDescription = updatedFrom.description as
				| string
				| undefined;
			changes.newDescription = issueData.description ?? undefined;
		}

		if ("attachments" in updatedFrom) {
			changes.attachmentsChanged = true;
		}

		// Build platform data
		const platformData: LinearContentUpdatePlatformData = {
			issue: this.buildIssueRef(issueData as SafeRecord),
			updatedFrom,
		};

		const message: ContentUpdateMessage = {
			id: randomUUID(),
			source: "linear",
			action: "content_update",
			receivedAt: this.toISOString(createdAt),
			organizationId,
			// For content updates, we don't have a session key, use issue ID
			sessionKey: issueData.id,
			workItemId: issueData.id,
			workItemIdentifier: issueData.identifier,
			changes,
			platformData,
		};

		return { success: true, message };
	}

	// ============================================================================
	// HELPER METHODS
	// ============================================================================

	/**
	 * Convert createdAt (Date or string) to ISO string.
	 */
	private toISOString(value: Date | string | undefined): string {
		if (!value) return new Date().toISOString();
		if (typeof value === "string") return value;
		return value.toISOString();
	}

	/**
	 * Build agent session reference from webhook data.
	 */
	private buildAgentSessionRef(
		session: AgentSessionCreatedWebhook["agentSession"],
	): LinearPlatformRef["agentSession"] {
		const sessionRaw = session as SafeRecord;
		const issueRaw = session.issue as SafeRecord | undefined;

		return {
			id: session.id,
			status: session.status,
			type: session.type ?? undefined,
			externalLink: (sessionRaw.externalLink as string) ?? undefined,
			creatorId: session.creatorId ?? undefined,
			comment: session.comment
				? {
						id: session.comment.id,
						body: session.comment.body ?? undefined,
					}
				: undefined,
			issue: issueRaw ? this.buildIssueRef(issueRaw) : this.emptyIssueRef(),
		};
	}

	/**
	 * Build issue reference from webhook issue data.
	 * Uses SafeRecord to handle fields that may not exist in all webhook types.
	 */
	private buildIssueRef(issue: SafeRecord): LinearPlatformRef["issue"] {
		const team = issue.team as SafeRecord | undefined;
		const project = issue.project as SafeRecord | undefined;
		const labels = issue.labels as SafeRecord[] | undefined;

		return {
			id: String(issue.id || ""),
			identifier: String(issue.identifier || ""),
			title: String(issue.title || ""),
			description: (issue.description as string) ?? undefined,
			url: String(issue.url || ""),
			branchName: (issue.branchName as string) ?? undefined,
			team: team
				? {
						id: String(team.id || ""),
						name: (team.name as string) ?? undefined,
						key: (team.key as string) ?? undefined,
					}
				: undefined,
			project: project
				? {
						id: String(project.id || ""),
						name: (project.name as string) ?? undefined,
						key: (project.key as string) ?? undefined,
					}
				: undefined,
			labels: labels?.map((l) => ({
				id: String(l.id || ""),
				name: String(l.name || ""),
			})),
		};
	}

	/**
	 * Create an empty issue ref for cases where issue data is missing.
	 */
	private emptyIssueRef(): LinearPlatformRef["issue"] {
		return {
			id: "",
			identifier: "",
			title: "",
			url: "",
		};
	}

	/**
	 * Build comment reference from webhook comment data.
	 */
	private buildCommentRef(comment: SafeRecord): LinearPlatformRef["comment"] {
		const user = comment.user as SafeRecord | undefined;

		return {
			id: String(comment.id || ""),
			body: (comment.body as string) ?? undefined,
			user: user
				? {
						id: String(user.id || ""),
						name: (user.name as string) ?? undefined,
						displayName: (user.displayName as string) ?? undefined,
						email: (user.email as string) ?? undefined,
					}
				: undefined,
		};
	}

	/**
	 * Build agent activity reference from webhook data.
	 */
	private buildAgentActivityRef(
		activity: AgentSessionPromptedWebhook["agentActivity"],
	): LinearPlatformRef["agentActivity"] {
		const activityRaw = activity as SafeRecord | undefined;
		const content = activityRaw?.content as SafeRecord | undefined;

		return {
			id: (activityRaw?.id as string) ?? "",
			type: (activityRaw?.type as string) ?? undefined,
			signal: (activityRaw?.signal as AgentActivitySignal) ?? undefined,
			content: content
				? {
						type: (content.type as string) ?? undefined,
						body: (content.body as string) ?? undefined,
					}
				: undefined,
		};
	}

	/**
	 * Build guidance item from webhook guidance rule.
	 */
	private buildGuidanceItem(rule: SafeRecord): GuidanceItem {
		return {
			id: String(rule.id || randomUUID()),
			prompt: String(rule.body || ""),
		};
	}

	/**
	 * Extract author from agent session (for session start).
	 */
	private extractAuthorFromSession(
		session: AgentSessionCreatedWebhook["agentSession"],
	): SessionStartMessage["author"] | undefined {
		const commentRaw = session.comment as SafeRecord | undefined;
		const user = commentRaw?.user as SafeRecord | undefined;
		if (!user) return undefined;

		return {
			id: String(user.id || ""),
			name: String(user.displayName || user.name || "Unknown"),
			email: (user.email as string) ?? undefined,
		};
	}

	/**
	 * Extract author from agent activity (for prompts).
	 */
	private extractAuthorFromActivity(
		activity: AgentSessionPromptedWebhook["agentActivity"],
	): UserPromptMessage["author"] | undefined {
		const activityRaw = activity as SafeRecord | undefined;
		const content = activityRaw?.content as SafeRecord | undefined;
		const user = content?.user as SafeRecord | undefined;
		if (!user) return undefined;

		return {
			id: String(user.id || ""),
			name: String(user.displayName || user.name || "Unknown"),
			email: (user.email as string) ?? undefined,
		};
	}
}
