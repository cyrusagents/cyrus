import { describe, expect, it } from "vitest";
import {
	isAgentSessionCreatedWebhook,
	isCommentCreateWebhook,
	isIssueDeletedWebhook,
	type Webhook,
} from "../src/issue-tracker/types.js";

describe("isCommentCreateWebhook", () => {
	it("returns true for Comment/create entity webhooks", () => {
		const webhook = {
			type: "Comment",
			action: "create",
			organizationId: "org-1",
			createdAt: new Date(),
			data: {
				id: "c1",
				body: "hi",
				createdAt: "2026-04-24T20:00:00.000Z",
				updatedAt: "2026-04-24T20:00:00.000Z",
				reactionData: {},
				parentId: "root-1",
				issueId: "issue-1",
			},
		} as unknown as Webhook;

		expect(isCommentCreateWebhook(webhook)).toBe(true);
	});

	it("returns false for Comment updates and removes", () => {
		for (const action of ["update", "remove"]) {
			const webhook = {
				type: "Comment",
				action,
				data: {},
			} as unknown as Webhook;
			expect(isCommentCreateWebhook(webhook)).toBe(false);
		}
	});

	it("returns false for non-Comment entity webhooks", () => {
		const issueWebhook = {
			type: "Issue",
			action: "create",
			data: {},
		} as unknown as Webhook;
		expect(isCommentCreateWebhook(issueWebhook)).toBe(false);

		const agentSessionWebhook = {
			type: "AgentSessionEvent",
			action: "created",
		} as unknown as Webhook;
		expect(isCommentCreateWebhook(agentSessionWebhook)).toBe(false);
		expect(isAgentSessionCreatedWebhook(agentSessionWebhook)).toBe(true);
	});

	it("does not collide with issue deletion guard", () => {
		const webhook = {
			type: "Issue",
			action: "remove",
			data: { id: "x" },
		} as unknown as Webhook;
		expect(isCommentCreateWebhook(webhook)).toBe(false);
		expect(isIssueDeletedWebhook(webhook)).toBe(true);
	});
});
