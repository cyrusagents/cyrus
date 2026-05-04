import {
	isIssueStateIdUpdateWebhook,
	isIssueTitleOrDescriptionUpdateWebhook,
} from "cyrus-core";
import { describe, expect, it } from "vitest";

describe("isIssueStateIdUpdateWebhook type guard", () => {
	it("returns true for an Issue update webhook with stateId in updatedFrom", () => {
		const webhook = {
			type: "Issue",
			action: "update",
			data: {
				id: "issue-1",
				identifier: "TEST-1",
				title: "Test Issue",
				stateId: "state-new",
			},
			updatedFrom: {
				stateId: "state-old",
			},
			organizationId: "org-1",
			createdAt: "2025-01-01T00:00:00Z",
		};

		expect(isIssueStateIdUpdateWebhook(webhook as any)).toBe(true);
	});

	it("returns false for an Issue update webhook without stateId in updatedFrom", () => {
		const webhook = {
			type: "Issue",
			action: "update",
			data: {
				id: "issue-1",
				identifier: "TEST-1",
				title: "Test Issue",
			},
			updatedFrom: {
				title: "Old Title",
			},
			organizationId: "org-1",
			createdAt: "2025-01-01T00:00:00Z",
		};

		expect(isIssueStateIdUpdateWebhook(webhook as any)).toBe(false);
	});

	it("returns false for non-Issue webhook types", () => {
		const webhook = {
			type: "AgentSessionEvent",
			action: "created",
		};

		expect(isIssueStateIdUpdateWebhook(webhook as any)).toBe(false);
	});

	it("returns false for Issue webhook without updatedFrom", () => {
		const webhook = {
			type: "Issue",
			action: "update",
			data: {
				id: "issue-1",
			},
		};

		expect(isIssueStateIdUpdateWebhook(webhook as any)).toBe(false);
	});

	it("returns false for Issue create/remove actions", () => {
		const webhook = {
			type: "Issue",
			action: "create",
			data: {
				id: "issue-1",
			},
			updatedFrom: {
				stateId: "state-old",
			},
		};

		expect(isIssueStateIdUpdateWebhook(webhook as any)).toBe(false);
	});

	it("does not conflict with isIssueTitleOrDescriptionUpdateWebhook", () => {
		// A webhook with BOTH stateId and title changes should match both guards
		const webhook = {
			type: "Issue",
			action: "update",
			data: {
				id: "issue-1",
				identifier: "TEST-1",
				title: "New Title",
				stateId: "state-new",
			},
			updatedFrom: {
				title: "Old Title",
				stateId: "state-old",
			},
			organizationId: "org-1",
			createdAt: "2025-01-01T00:00:00Z",
		};

		expect(isIssueStateIdUpdateWebhook(webhook as any)).toBe(true);
		expect(isIssueTitleOrDescriptionUpdateWebhook(webhook as any)).toBe(true);
	});

	it("handles stateId-only changes (not title/description)", () => {
		const webhook = {
			type: "Issue",
			action: "update",
			data: {
				id: "issue-1",
				identifier: "TEST-1",
				title: "Test Issue",
				stateId: "state-completed",
			},
			updatedFrom: {
				stateId: "state-started",
			},
			organizationId: "org-1",
			createdAt: "2025-01-01T00:00:00Z",
		};

		// Should match state change but NOT title/description
		expect(isIssueStateIdUpdateWebhook(webhook as any)).toBe(true);
		expect(isIssueTitleOrDescriptionUpdateWebhook(webhook as any)).toBe(false);
	});
});
