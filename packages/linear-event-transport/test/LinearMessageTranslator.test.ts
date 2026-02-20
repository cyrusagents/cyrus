import type { LinearWebhookPayload } from "@linear/sdk/webhooks";
import type { LinearSessionStartPlatformData } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { LinearMessageTranslator } from "../src/LinearMessageTranslator.js";

describe("LinearMessageTranslator", () => {
	const translator = new LinearMessageTranslator();

	describe("canTranslate", () => {
		it("should return true for AgentSessionEvent webhooks", () => {
			const webhook = {
				type: "AgentSessionEvent",
				action: "created",
			};
			expect(translator.canTranslate(webhook)).toBe(true);
		});

		it("should return true for AppUserNotification webhooks", () => {
			const webhook = {
				type: "AppUserNotification",
				action: "issueUnassignedFromYou",
			};
			expect(translator.canTranslate(webhook)).toBe(true);
		});

		it("should return true for Issue webhooks", () => {
			const webhook = {
				type: "Issue",
				action: "update",
			};
			expect(translator.canTranslate(webhook)).toBe(true);
		});

		it("should return false for null", () => {
			expect(translator.canTranslate(null)).toBe(false);
		});

		it("should return false for undefined", () => {
			expect(translator.canTranslate(undefined)).toBe(false);
		});

		it("should return false for non-object", () => {
			expect(translator.canTranslate("string")).toBe(false);
		});

		it("should return false for unsupported types", () => {
			const webhook = {
				type: "Comment",
				action: "create",
			};
			expect(translator.canTranslate(webhook)).toBe(false);
		});
	});

	describe("translate - AgentSessionCreated", () => {
		it("should translate AgentSessionCreated webhook to SessionStartMessage", () => {
			const webhook: LinearWebhookPayload = {
				type: "AgentSessionEvent",
				action: "created",
				organizationId: "org-123",
				createdAt: "2025-01-27T12:00:00Z",
				agentSession: {
					id: "session-123",
					status: "processing",
					type: "delegation",
					issue: {
						id: "issue-123",
						identifier: "DEF-123",
						title: "Test Issue",
						description: "Test description",
						url: "https://linear.app/test/DEF-123",
						team: {
							id: "team-123",
							name: "Test Team",
							key: "TEST",
						},
						labels: [
							{ id: "label-1", name: "bug" },
							{ id: "label-2", name: "priority" },
						],
					},
					comment: {
						id: "comment-123",
						body: "This thread is for an agent session. Please work on this.",
						user: {
							id: "user-123",
							name: "Test User",
							displayName: "Test User",
							email: "test@example.com",
						},
					},
				},
				guidance: [
					{
						id: "guidance-1",
						body: "Always write tests",
					},
				],
			} as unknown as LinearWebhookPayload;

			const result = translator.translate(webhook);

			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.message.action).toBe("session_start");
			expect(result.message.source).toBe("linear");
			expect(result.message.organizationId).toBe("org-123");
			expect(result.message.sessionKey).toBe("session-123");
			expect(result.message.workItemId).toBe("issue-123");
			expect(result.message.workItemIdentifier).toBe("DEF-123");
			expect(result.message.receivedAt).toBe("2025-01-27T12:00:00Z");

			// Session start specific fields
			const sessionStart = result.message;
			if (sessionStart.action !== "session_start") return;

			expect(sessionStart.title).toBe("Test Issue");
			expect(sessionStart.description).toBe("Test description");
			expect(sessionStart.labels).toEqual(["bug", "priority"]);
			// Delegation (not mention) - should use issue description as initial prompt
			expect(sessionStart.initialPrompt).toBe("Test description");

			// Platform data (narrow type for Linear-specific properties)
			const platformData =
				sessionStart.platformData as LinearSessionStartPlatformData;
			expect(platformData.isMentionTriggered).toBe(false);
			expect(platformData.agentSession.id).toBe("session-123");
			expect(platformData.issue.id).toBe("issue-123");
			expect(platformData.guidance).toHaveLength(1);
			expect(platformData.guidance?.[0].prompt).toBe("Always write tests");
		});

		it("should detect mention-triggered sessions", () => {
			const webhook: LinearWebhookPayload = {
				type: "AgentSessionEvent",
				action: "created",
				organizationId: "org-123",
				createdAt: "2025-01-27T12:00:00Z",
				agentSession: {
					id: "session-123",
					status: "processing",
					issue: {
						id: "issue-123",
						identifier: "DEF-123",
						title: "Test Issue",
						description: "Original issue description",
						url: "https://linear.app/test/DEF-123",
					},
					comment: {
						id: "comment-123",
						body: "@cyrus please help me with this",
						user: {
							id: "user-123",
							name: "Test User",
						},
					},
				},
			} as unknown as LinearWebhookPayload;

			const result = translator.translate(webhook);

			expect(result.success).toBe(true);
			if (!result.success) return;

			const sessionStart = result.message;
			if (sessionStart.action !== "session_start") return;

			// Mention trigger - should use comment body as initial prompt
			expect(sessionStart.initialPrompt).toBe(
				"@cyrus please help me with this",
			);

			// Platform data (narrow type for Linear-specific properties)
			const platformData =
				sessionStart.platformData as LinearSessionStartPlatformData;
			expect(platformData.isMentionTriggered).toBe(true);
		});

		it("should fail when issue is missing", () => {
			const webhook: LinearWebhookPayload = {
				type: "AgentSessionEvent",
				action: "created",
				organizationId: "org-123",
				createdAt: "2025-01-27T12:00:00Z",
				agentSession: {
					id: "session-123",
					status: "processing",
					issue: null,
				},
			} as unknown as LinearWebhookPayload;

			const result = translator.translate(webhook);

			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.reason).toContain("missing issue");
		});
	});

	describe("translate - AgentSessionPrompted (UserPrompt)", () => {
		it("should translate AgentSessionPrompted webhook to UserPromptMessage", () => {
			const webhook: LinearWebhookPayload = {
				type: "AgentSessionEvent",
				action: "prompted",
				organizationId: "org-123",
				createdAt: "2025-01-27T12:00:00Z",
				agentSession: {
					id: "session-123",
					status: "processing",
					issue: {
						id: "issue-123",
						identifier: "DEF-123",
						title: "Test Issue",
						url: "https://linear.app/test/DEF-123",
					},
				},
				agentActivity: {
					id: "activity-123",
					content: {
						body: "Please also add logging",
						user: {
							id: "user-123",
							name: "Test User",
							displayName: "Test User",
						},
					},
				},
			} as unknown as LinearWebhookPayload;

			const result = translator.translate(webhook);

			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.message.action).toBe("user_prompt");
			expect(result.message.source).toBe("linear");
			expect(result.message.sessionKey).toBe("session-123");
			expect(result.message.workItemIdentifier).toBe("DEF-123");

			const userPrompt = result.message;
			if (userPrompt.action !== "user_prompt") return;

			expect(userPrompt.content).toBe("Please also add logging");
			expect(userPrompt.author?.name).toBe("Test User");
		});
	});

	describe("translate - AgentSessionPrompted (StopSignal)", () => {
		it("should translate stop signal to StopSignalMessage", () => {
			const webhook: LinearWebhookPayload = {
				type: "AgentSessionEvent",
				action: "prompted",
				organizationId: "org-123",
				createdAt: "2025-01-27T12:00:00Z",
				agentSession: {
					id: "session-123",
					status: "processing",
					issue: {
						id: "issue-123",
						identifier: "DEF-123",
						title: "Test Issue",
						url: "https://linear.app/test/DEF-123",
					},
				},
				agentActivity: {
					id: "activity-123",
					signal: "stop",
				},
			} as unknown as LinearWebhookPayload;

			const result = translator.translate(webhook);

			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.message.action).toBe("stop_signal");
			expect(result.message.source).toBe("linear");
			expect(result.message.sessionKey).toBe("session-123");
		});
	});

	describe("translate - IssueUnassigned", () => {
		it("should translate IssueUnassigned webhook to UnassignMessage", () => {
			const webhook: LinearWebhookPayload = {
				type: "AppUserNotification",
				action: "issueUnassignedFromYou",
				organizationId: "org-123",
				createdAt: "2025-01-27T12:00:00Z",
				notification: {
					issue: {
						id: "issue-123",
						identifier: "DEF-123",
						title: "Test Issue",
						url: "https://linear.app/test/DEF-123",
					},
				},
			} as unknown as LinearWebhookPayload;

			const result = translator.translate(webhook);

			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.message.action).toBe("unassign");
			expect(result.message.source).toBe("linear");
			expect(result.message.workItemId).toBe("issue-123");
			expect(result.message.workItemIdentifier).toBe("DEF-123");
		});

		it("should fail when issue is missing", () => {
			const webhook: LinearWebhookPayload = {
				type: "AppUserNotification",
				action: "issueUnassignedFromYou",
				organizationId: "org-123",
				createdAt: "2025-01-27T12:00:00Z",
				notification: {
					issue: null,
				},
			} as unknown as LinearWebhookPayload;

			const result = translator.translate(webhook);

			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.reason).toContain("missing issue");
		});
	});

	describe("translate - IssueUpdate", () => {
		it("should translate IssueUpdate webhook with title change to ContentUpdateMessage", () => {
			const webhook: LinearWebhookPayload = {
				type: "Issue",
				action: "update",
				organizationId: "org-123",
				createdAt: "2025-01-27T12:00:00Z",
				data: {
					id: "issue-123",
					identifier: "DEF-123",
					title: "New Title",
					url: "https://linear.app/test/DEF-123",
				},
				updatedFrom: {
					title: "Old Title",
				},
			} as unknown as LinearWebhookPayload;

			const result = translator.translate(webhook);

			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.message.action).toBe("content_update");
			expect(result.message.source).toBe("linear");
			expect(result.message.workItemIdentifier).toBe("DEF-123");

			const contentUpdate = result.message;
			if (contentUpdate.action !== "content_update") return;

			expect(contentUpdate.changes.previousTitle).toBe("Old Title");
			expect(contentUpdate.changes.newTitle).toBe("New Title");
			expect(contentUpdate.changes.previousDescription).toBeUndefined();
			expect(contentUpdate.changes.newDescription).toBeUndefined();
		});

		it("should translate IssueUpdate webhook with description change", () => {
			const webhook: LinearWebhookPayload = {
				type: "Issue",
				action: "update",
				organizationId: "org-123",
				createdAt: "2025-01-27T12:00:00Z",
				data: {
					id: "issue-123",
					identifier: "DEF-123",
					title: "Same Title",
					description: "New description",
					url: "https://linear.app/test/DEF-123",
				},
				updatedFrom: {
					description: "Old description",
				},
			} as unknown as LinearWebhookPayload;

			const result = translator.translate(webhook);

			expect(result.success).toBe(true);
			if (!result.success) return;

			const contentUpdate = result.message;
			if (contentUpdate.action !== "content_update") return;

			expect(contentUpdate.changes.previousDescription).toBe("Old description");
			expect(contentUpdate.changes.newDescription).toBe("New description");
		});

		it("should detect attachments changes", () => {
			const webhook: LinearWebhookPayload = {
				type: "Issue",
				action: "update",
				organizationId: "org-123",
				createdAt: "2025-01-27T12:00:00Z",
				data: {
					id: "issue-123",
					identifier: "DEF-123",
					title: "Same Title",
					url: "https://linear.app/test/DEF-123",
				},
				updatedFrom: {
					attachments: [],
				},
			} as unknown as LinearWebhookPayload;

			const result = translator.translate(webhook);

			expect(result.success).toBe(true);
			if (!result.success) return;

			const contentUpdate = result.message;
			if (contentUpdate.action !== "content_update") return;

			expect(contentUpdate.changes.attachmentsChanged).toBe(true);
		});
	});

	describe("translate - unsupported webhooks", () => {
		it("should return failure for unsupported webhook types", () => {
			const webhook: LinearWebhookPayload = {
				type: "Comment",
				action: "create",
			} as unknown as LinearWebhookPayload;

			const result = translator.translate(webhook);

			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.reason).toContain("Unsupported webhook type");
		});
	});
});
