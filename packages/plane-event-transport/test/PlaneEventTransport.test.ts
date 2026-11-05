import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PlaneEventTransport } from "../src/PlaneEventTransport.js";
import type { PlaneAgentWebhookPayload } from "../src/types.js";

const SECRET = "plane_wh_test_secret";

function setup(secret = SECRET) {
	const routes: Record<
		string,
		(req: unknown, reply: unknown) => Promise<void>
	> = {};
	const fastify = {
		post: vi.fn((path: string, handler: never) => {
			routes[`POST ${path}`] = handler;
		}),
		get: vi.fn((path: string, handler: never) => {
			routes[`GET ${path}`] = handler;
		}),
	};
	const transport = new PlaneEventTransport({
		fastifyServer: fastify as never,
		webhookSecret: secret,
		onInstall: (query) => `saved ${query.app_installation_id}`,
	});
	transport.register();
	const events: PlaneAgentWebhookPayload[] = [];
	transport.on("event", (e) => events.push(e));
	return { routes, events };
}

function reply() {
	const r = {
		code: vi.fn().mockReturnThis(),
		send: vi.fn().mockReturnThis(),
		type: vi.fn().mockReturnThis(),
	};
	return r;
}

const payload = {
	type: "agent_run",
	action: "created",
	agent_run: { id: "run-1", issue: "wi-1", project: "p-1" },
};

function post(
	routes: ReturnType<typeof setup>["routes"],
	body: unknown,
	signature?: string,
) {
	const raw = JSON.stringify(body);
	const r = reply();
	return routes["POST /plane-webhook"]!(
		{
			body,
			rawBody: raw,
			headers: {
				"x-plane-signature":
					signature ?? createHmac("sha256", SECRET).update(raw).digest("hex"),
			},
		},
		r,
	).then(() => r);
}

describe("PlaneEventTransport", () => {
	it("emits signed agent-run webhooks and answers 200 at once", async () => {
		const { routes, events } = setup();
		const r = await post(routes, payload);
		expect(r.code).toHaveBeenCalledWith(200);
		expect(events).toEqual([payload]);
	});

	it("unwraps the envelope Plane actually sends", async () => {
		const { routes, events } = setup();
		const prompt = {
			type: "agent_run_activity",
			action: "prompted",
			agent_run: { id: "run-1", issue: "wi-1", project: "p-1" },
			agent_run_activity: {
				id: "a-1",
				content: { type: "prompt", body: "hi" },
			},
			comment_id: "c-1",
		};
		// As built by Plane's webhook_send_task: the outer action is "created"
		// even for prompts.
		const envelope = {
			event: "agent_run_user_prompt",
			action: "created",
			webhook_id: "wh-1",
			workspace_id: "ws-1",
			data: prompt,
			activity: prompt,
		};
		const r = await post(routes, envelope);
		expect(r.code).toHaveBeenCalledWith(200);
		expect(events).toEqual([prompt]);
	});

	it("rejects a bad signature without emitting", async () => {
		const { routes, events } = setup();
		const r = await post(routes, payload, "deadbeef");
		expect(r.code).toHaveBeenCalledWith(401);
		expect(events).toEqual([]);
	});

	it("acknowledges but ignores other Plane events", async () => {
		const { routes, events } = setup();
		const r = await post(routes, { event: "workitem.updated", data: {} });
		expect(r.code).toHaveBeenCalledWith(200);
		expect(events).toEqual([]);
	});

	it("hands the install redirect's installation id to onInstall", async () => {
		const { routes } = setup();
		const r = reply();
		await routes["GET /plane-oauth/callback"]!(
			{ query: { app_installation_id: "inst-9", code: "c" } },
			r,
		);
		expect(r.send).toHaveBeenCalledWith("saved inst-9");
	});
});
