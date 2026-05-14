/**
 * Tests for the Project-level webhook type guards (Workstream A1/A2).
 */

import { describe, expect, it } from "vitest";
import {
	isProjectDescriptionUpdateWebhook,
	isProjectUpdateWebhook,
	isProjectWebhook,
	type Webhook,
} from "../src/issue-tracker/types.js";

const projectUpdateWebhook = (action: string): Webhook =>
	({
		type: "ProjectUpdate",
		action,
		createdAt: new Date().toISOString(),
		organizationId: "org-1",
		data: {
			id: "pu-1",
			body: "Status update",
			projectId: "proj-1",
			project: { id: "proj-1", name: "Proj", url: "https://linear.app/p" },
			userId: "user-1",
		},
	}) as unknown as Webhook;

const projectWebhook = (
	action: string,
	updatedFrom?: Record<string, unknown>,
): Webhook =>
	({
		type: "Project",
		action,
		createdAt: new Date().toISOString(),
		organizationId: "org-1",
		updatedFrom,
		data: {
			id: "proj-1",
			name: "Proj",
			description: "Current description",
		},
	}) as unknown as Webhook;

const issueWebhook = (): Webhook =>
	({
		type: "Issue",
		action: "update",
		createdAt: new Date().toISOString(),
		organizationId: "org-1",
		data: { id: "issue-1" },
	}) as unknown as Webhook;

describe("isProjectUpdateWebhook", () => {
	it("matches ProjectUpdate webhooks regardless of action", () => {
		expect(isProjectUpdateWebhook(projectUpdateWebhook("create"))).toBe(true);
		expect(isProjectUpdateWebhook(projectUpdateWebhook("update"))).toBe(true);
		expect(isProjectUpdateWebhook(projectUpdateWebhook("remove"))).toBe(true);
	});

	it("does not match Project or Issue webhooks", () => {
		expect(isProjectUpdateWebhook(projectWebhook("update"))).toBe(false);
		expect(isProjectUpdateWebhook(issueWebhook())).toBe(false);
	});
});

describe("isProjectWebhook", () => {
	it("matches Project webhooks", () => {
		expect(isProjectWebhook(projectWebhook("update"))).toBe(true);
		expect(isProjectWebhook(projectWebhook("create"))).toBe(true);
	});

	it("does not match ProjectUpdate or Issue webhooks", () => {
		expect(isProjectWebhook(projectUpdateWebhook("create"))).toBe(false);
		expect(isProjectWebhook(issueWebhook())).toBe(false);
	});
});

describe("isProjectDescriptionUpdateWebhook", () => {
	it("matches a Project update whose description changed", () => {
		expect(
			isProjectDescriptionUpdateWebhook(
				projectWebhook("update", { description: "Old description" }),
			),
		).toBe(true);
	});

	it("ignores Project updates where the description did not change", () => {
		expect(
			isProjectDescriptionUpdateWebhook(
				projectWebhook("update", { name: "Old name" }),
			),
		).toBe(false);
	});

	it("ignores Project updates with no updatedFrom diff", () => {
		expect(isProjectDescriptionUpdateWebhook(projectWebhook("update"))).toBe(
			false,
		);
	});

	it("ignores Project create events (no diff)", () => {
		expect(
			isProjectDescriptionUpdateWebhook(
				projectWebhook("create", { description: "Old" }),
			),
		).toBe(false);
	});

	it("does not match ProjectUpdate webhooks", () => {
		expect(
			isProjectDescriptionUpdateWebhook(projectUpdateWebhook("update")),
		).toBe(false);
	});
});
