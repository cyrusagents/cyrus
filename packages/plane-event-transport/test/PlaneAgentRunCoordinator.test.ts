import { describe, expect, it, vi } from "vitest";
import {
	type LinearShapedAgentSessionWebhook,
	PlaneAgentRunCoordinator,
} from "../src/PlaneAgentRunCoordinator.js";
import type {
	PlaneAgentRunCreatedPayload,
	PlaneAgentRunPromptedPayload,
} from "../src/types.js";

function fakeTracker() {
	return {
		workspaceKey: "plane:acme",
		rememberWorkItem: vi.fn(),
		fetchComment: vi.fn(async (id: string) => ({
			id,
			body: "@cyrus fix the login",
		})),
		fetchUser: vi.fn(async (id: string) => ({
			id,
			name: "Ada",
			email: "i@x.com",
		})),
		fetchIssue: vi.fn(async (id: string) => ({
			id,
			identifier: "WEB-12",
			title: "Login broken",
			url: "http://plane/acme/browse/WEB-12/",
			team: Promise.resolve({ id: "p-1", key: "WEB", name: "Web App" }),
		})),
		api: {
			getRun: vi.fn(async (id: string) => ({
				id,
				issue: "wi-1",
				project: "p-1",
				creator: "u-1",
			})),
		},
	};
}

function setup(known: string[] = []) {
	const tracker = fakeTracker();
	const dispatched: LinearShapedAgentSessionWebhook[] = [];
	const coordinator = new PlaneAgentRunCoordinator({
		tracker: tracker as never,
		isKnownSession: (id) => known.includes(id),
		dispatch: (w) => {
			dispatched.push(w);
		},
	});
	return { coordinator, dispatched, tracker };
}

const run = {
	id: "run-1",
	issue: "wi-1",
	project: "p-1",
	creator: "u-1",
	comment: "c-1",
	trigger_type: "mention",
};
const created: PlaneAgentRunCreatedPayload = {
	type: "agent_run",
	action: "created",
	agent_run: run,
	comment_id: "c-1",
};
function prompted(
	body: string,
	comment: string | null,
	signal?: "stop",
): PlaneAgentRunPromptedPayload {
	return {
		type: "agent_run_activity",
		action: "prompted",
		agent_run: run,
		agent_run_activity: {
			id: `a-${body}`,
			agent_run: "run-1",
			type: "prompt",
			content: { type: "prompt", body },
			comment,
			actor: "u-1",
			...(signal && { signal }),
		},
	};
}

describe("PlaneAgentRunCoordinator", () => {
	it("starts one session when created arrives before the mention's prompt", async () => {
		const { coordinator, dispatched } = setup();
		await coordinator.handle(created);
		await coordinator.handle(prompted("@cyrus fix the login", "c-1"));
		expect(dispatched.map((w) => w.action)).toEqual(["created"]);
		const session = dispatched[0]!.agentSession as Record<string, any>;
		expect(dispatched[0]!.organizationId).toBe("plane:acme");
		expect(session.id).toBe("run-1");
		expect(session.issue).toMatchObject({
			id: "wi-1",
			identifier: "WEB-12",
			team: { key: "WEB" },
		});
		expect(session.comment).toEqual({
			id: "c-1",
			body: "@cyrus fix the login",
		});
		expect(session.creator).toEqual({
			id: "u-1",
			name: "Ada",
			email: "i@x.com",
		});
	});

	it("starts one session when the prompt arrives first", async () => {
		const { coordinator, dispatched } = setup();
		await coordinator.handle(prompted("@cyrus fix the login", "c-1"));
		await coordinator.handle(created);
		expect(dispatched.map((w) => w.action)).toEqual(["created"]);
		expect((dispatched[0]!.agentSession as any).comment.body).toBe(
			"@cyrus fix the login",
		);
	});

	it("turns later comments into prompted, and keeps the stop signal", async () => {
		const { coordinator, dispatched } = setup();
		await coordinator.handle(created);
		await coordinator.handle(prompted("@cyrus fix the login", "c-1"));
		await coordinator.handle(prompted("also check signup", "c-2"));
		await coordinator.handle(prompted("stop", "c-3", "stop"));
		expect(dispatched.map((w) => w.action)).toEqual([
			"created",
			"prompted",
			"prompted",
		]);
		expect(dispatched[1]!.agentActivity).toMatchObject({
			content: { type: "prompt", body: "also check signup" },
			sourceCommentId: "c-2",
		});
		expect((dispatched[2]!.agentActivity as any).signal).toBe("stop");
	});

	it("treats prompts for a session Cyrus already has (e.g. after a restart) as prompted", async () => {
		const { coordinator, dispatched } = setup(["run-1"]);
		await coordinator.handle(prompted("continue please", "c-5"));
		expect(dispatched.map((w) => w.action)).toEqual(["prompted"]);
	});

	it("handles events for one run in order even when dispatch is slow", async () => {
		const tracker = fakeTracker();
		const order: string[] = [];
		const coordinator = new PlaneAgentRunCoordinator({
			tracker: tracker as never,
			isKnownSession: () => false,
			dispatch: async (w) => {
				await new Promise((r) =>
					setTimeout(r, w.action === "created" ? 20 : 0),
				);
				order.push(w.action);
			},
		});
		await Promise.all([
			coordinator.handle(created),
			coordinator.handle(prompted("@cyrus fix the login", "c-1")),
			coordinator.handle(prompted("follow-up", "c-2")),
		]);
		expect(order).toEqual(["created", "prompted"]);
	});

	it("treats an assignment as a delegation: no comment, Plane's generated prompt dropped", async () => {
		const { coordinator, dispatched, tracker } = setup();
		// As Plane sends it: the run's comment is Plane's "launched against"
		// note, and the starting prompt has no comment.
		const assigned = {
			...run,
			comment: "c-launch",
			trigger_type: "assignment",
		};
		await coordinator.handle({
			...created,
			agent_run: assigned,
			comment_id: "c-launch",
		});
		await coordinator.handle({
			...prompted("Act on this work item WEB-12: Login broken", null),
			agent_run: assigned,
		});
		expect(dispatched.map((w) => w.action)).toEqual(["created"]);
		expect((dispatched[0]!.agentSession as any).comment).toBeUndefined();
		expect(tracker.fetchComment).not.toHaveBeenCalled();
	});

	it("starts a delegation when an assignment's prompt arrives first", async () => {
		const { coordinator, dispatched } = setup();
		const assigned = {
			...run,
			comment: "c-launch",
			trigger_type: "assignment",
		};
		await coordinator.handle({
			...prompted("Act on this work item WEB-12: Login broken", null),
			agent_run: assigned,
		});
		await coordinator.handle({ ...created, agent_run: assigned });
		expect(dispatched.map((w) => w.action)).toEqual(["created"]);
		expect((dispatched[0]!.agentSession as any).comment).toBeUndefined();
	});

	it("passes replies on as plain text (e.g. a chosen option)", async () => {
		const { coordinator, dispatched } = setup();
		await coordinator.handle(created);
		await coordinator.handle(prompted("@cyrus fix the login", "c-1"));
		await coordinator.handle(
			prompted(
				'<p class="editor-paragraph-block" data-id="x">web-frontend</p>',
				"c-2",
			),
		);
		expect(dispatched[1]!.agentActivity).toMatchObject({
			content: { type: "prompt", body: "web-frontend" },
		});
	});
});
