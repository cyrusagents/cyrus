import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ZulipEventTransportConfig,
	ZulipOutgoingWebhookPayload,
	ZulipWebhookEvent,
} from "../src/types.js";
import { ZulipEventTransport } from "../src/ZulipEventTransport.js";

const TOKEN = "abcdefghijklmnopqrstuvwxyz012345";

function createMockFastify() {
	const routes: Record<
		string,
		(request: unknown, reply: unknown) => Promise<void>
	> = {};
	return {
		post: vi.fn((path: string, ...args: unknown[]) => {
			const handler = (args.length === 1 ? args[0] : args[1]) as (
				request: unknown,
				reply: unknown,
			) => Promise<void>;
			routes[path] = handler;
		}),
		routes,
	};
}

function createMockReply() {
	return {
		code: vi.fn().mockReturnThis(),
		send: vi.fn().mockReturnThis(),
	};
}

function buildPayload(
	overrides: Partial<ZulipOutgoingWebhookPayload> = {},
): ZulipOutgoingWebhookPayload {
	return {
		token: TOKEN,
		bot_email: "impala-bot@example.zulipchat.com",
		bot_full_name: "Impala",
		data: "@**Impala** what changed in the parser?",
		trigger: "mention",
		message: {
			id: 4242,
			type: "stream",
			content: "@**Impala** what changed in the parser?",
			sender_id: 7,
			sender_email: "nate@example.com",
			sender_full_name: "Nate",
			subject: "parser rewrite",
			stream_id: 99,
			display_recipient: "engineering",
			timestamp: 1_760_000_000,
		},
		...overrides,
	};
}

async function dispatch(
	transport: ZulipEventTransport,
	fastify: ReturnType<typeof createMockFastify>,
	body: unknown,
) {
	transport.register();
	const reply = createMockReply();
	await fastify.routes["/zulip-webhook"]({ body }, reply);
	return reply;
}

describe("ZulipEventTransport", () => {
	let fastify: ReturnType<typeof createMockFastify>;
	let config: ZulipEventTransportConfig;

	beforeEach(() => {
		vi.clearAllMocks();
		fastify = createMockFastify();
		config = {
			fastifyServer:
				fastify as unknown as ZulipEventTransportConfig["fastifyServer"],
			token: TOKEN,
			credentials: {
				site: "https://example.zulipchat.com",
				botEmail: "impala-bot@example.zulipchat.com",
				apiKey: "api-key",
			},
		};
	});

	it("registers the POST /zulip-webhook endpoint", () => {
		new ZulipEventTransport(config).register();
		expect(fastify.post).toHaveBeenCalledWith(
			"/zulip-webhook",
			expect.any(Function),
		);
	});

	it("emits an event and acknowledges without a reply body", async () => {
		const transport = new ZulipEventTransport(config);
		const events: ZulipWebhookEvent[] = [];
		transport.on("event", (event) => events.push(event));

		const reply = await dispatch(transport, fastify, buildPayload());

		expect(events).toHaveLength(1);
		expect(events[0]?.trigger).toBe("mention");
		expect(events[0]?.message.id).toBe(4242);
		expect(events[0]?.credentials).toEqual(config.credentials);
		expect(reply.code).toHaveBeenCalledWith(200);
		// The reply is posted later over REST — never in the webhook response.
		expect(reply.send).toHaveBeenCalledWith({ response_not_required: true });
	});

	it("rejects a payload whose token does not match", async () => {
		const transport = new ZulipEventTransport(config);
		const events: ZulipWebhookEvent[] = [];
		transport.on("event", (event) => events.push(event));

		const reply = await dispatch(
			transport,
			fastify,
			buildPayload({ token: "x".repeat(TOKEN.length) }),
		);

		expect(events).toHaveLength(0);
		expect(reply.code).toHaveBeenCalledWith(401);
	});

	it("rejects a token of a different length without throwing", async () => {
		const transport = new ZulipEventTransport(config);
		const events: ZulipWebhookEvent[] = [];
		transport.on("event", (event) => events.push(event));

		const reply = await dispatch(
			transport,
			fastify,
			buildPayload({ token: "short" }),
		);

		expect(events).toHaveLength(0);
		expect(reply.code).toHaveBeenCalledWith(401);
	});

	it("rejects a request with no token at all", async () => {
		const transport = new ZulipEventTransport(config);
		const reply = await dispatch(transport, fastify, { trigger: "mention" });
		expect(reply.code).toHaveBeenCalledWith(401);
	});

	it("never authenticates against an empty configured token", async () => {
		const transport = new ZulipEventTransport({ ...config, token: "" });
		const events: ZulipWebhookEvent[] = [];
		transport.on("event", (event) => events.push(event));

		const reply = await dispatch(
			transport,
			fastify,
			buildPayload({ token: "" }),
		);

		expect(events).toHaveLength(0);
		expect(reply.code).toHaveBeenCalledWith(401);
	});

	it.each([
		"direct_message",
		"private_message",
	])("treats %s as a direct message trigger", async (trigger) => {
		const transport = new ZulipEventTransport(config);
		const events: ZulipWebhookEvent[] = [];
		transport.on("event", (event) => events.push(event));

		await dispatch(transport, fastify, buildPayload({ trigger }));

		expect(events[0]?.trigger).toBe("direct_message");
	});

	it("ignores a trigger it does not understand", async () => {
		const transport = new ZulipEventTransport(config);
		const events: ZulipWebhookEvent[] = [];
		transport.on("event", (event) => events.push(event));

		const reply = await dispatch(
			transport,
			fastify,
			buildPayload({ trigger: "reaction" }),
		);

		expect(events).toHaveLength(0);
		expect(reply.code).toHaveBeenCalledWith(200);
	});

	it("ignores a verified payload carrying no usable message", async () => {
		const transport = new ZulipEventTransport(config);
		const events: ZulipWebhookEvent[] = [];
		transport.on("event", (event) => events.push(event));

		const reply = await dispatch(transport, fastify, {
			...buildPayload(),
			message: undefined,
		});

		expect(events).toHaveLength(0);
		expect(reply.code).toHaveBeenCalledWith(200);
	});
});
