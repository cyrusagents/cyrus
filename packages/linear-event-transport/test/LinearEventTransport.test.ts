import { createHmac } from "node:crypto";
import { LINEAR_WEBHOOK_IPS } from "cyrus-core";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinearEventTransport } from "../src/LinearEventTransport.js";

describe("LinearEventTransport", () => {
	describe("published source IPs in direct mode", () => {
		let server: FastifyInstance;
		const onEvent = vi.fn();
		const secret = "test-webhook-secret";
		const payload = {
			type: "Issue",
			action: "create",
			data: { id: "issue-1" },
		};
		const signature = createHmac("sha256", secret)
			.update(JSON.stringify(payload))
			.digest("hex");

		beforeEach(() => {
			onEvent.mockClear();
			// Match SharedApplicationServer's existing reverse-proxy configuration.
			server = Fastify({ trustProxy: true });
			const transport = new LinearEventTransport({
				fastifyServer: server,
				verificationMode: "direct",
				secret,
				ipAllowlist: LINEAR_WEBHOOK_IPS,
			});
			transport.on("event", onEvent);
			transport.register();
		});

		afterEach(async () => {
			await server.close();
		});

		it.each([
			"34.186.126.124",
			"34.48.40.158",
			"35.236.218.67",
		])("accepts signed webhooks from new source %s", async (ip) => {
			for (const url of ["/linear-webhook", "/webhook"]) {
				const response = await server.inject({
					method: "POST",
					url,
					remoteAddress: ip,
					headers: { "linear-signature": signature },
					payload,
				});
				expect(response.statusCode).toBe(200);
			}
			expect(onEvent).toHaveBeenCalledTimes(2);
			expect(onEvent).toHaveBeenCalledWith(payload);
		});

		it.each([
			undefined,
			"0".repeat(64),
		])("rejects a new allowed IP with missing or invalid signature %s", async (invalidSignature) => {
			const response = await server.inject({
				method: "POST",
				url: "/linear-webhook",
				remoteAddress: "34.186.126.124",
				headers: invalidSignature
					? { "linear-signature": invalidSignature }
					: {},
				payload,
			});
			expect(response.statusCode).toBe(401);
			expect(onEvent).not.toHaveBeenCalled();
		});

		it.each([
			["::ffff:34.48.40.158", 200],
			["34.48.40.159", 403],
		])("validates forwarded source %s", async (ip, status) => {
			const response = await server.inject({
				method: "POST",
				url: "/linear-webhook",
				remoteAddress: "127.0.0.1",
				headers: {
					"x-forwarded-for": ip,
					"linear-signature": signature,
				},
				payload,
			});
			expect(response.statusCode).toBe(status);
			expect(onEvent).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
		});
	});

	describe("register", () => {
		it("registers POST /linear-webhook and a deprecated /webhook alias", () => {
			const post = vi.fn();
			const fastifyServer = { post } as unknown as FastifyInstance;

			const transport = new LinearEventTransport({
				fastifyServer,
				verificationMode: "proxy",
				secret: "test-secret",
			});

			transport.register();

			const registeredPaths = post.mock.calls.map((call: unknown[]) => call[0]);
			expect(registeredPaths).toEqual(
				expect.arrayContaining(["/linear-webhook", "/webhook"]),
			);
			expect(post).toHaveBeenCalledTimes(2);
		});

		it("deprecated /webhook alias delegates to the same handler as /linear-webhook", async () => {
			const post = vi.fn();
			const fastifyServer = { post } as unknown as FastifyInstance;

			const transport = new LinearEventTransport({
				fastifyServer,
				verificationMode: "proxy",
				secret: "test-secret",
			});

			transport.register();

			const calls = post.mock.calls as Array<
				[string, (request: unknown, reply: unknown) => Promise<void>]
			>;
			const primary = calls.find(([path]) => path === "/linear-webhook");
			const deprecated = calls.find(([path]) => path === "/webhook");
			expect(primary).toBeDefined();
			expect(deprecated).toBeDefined();

			const makeReply = () => ({
				code: vi.fn().mockReturnThis(),
				send: vi.fn().mockReturnThis(),
			});

			const unauthorizedRequest = {
				headers: {},
			};

			const primaryReply = makeReply();
			await primary![1](unauthorizedRequest, primaryReply);
			expect(primaryReply.code).toHaveBeenCalledWith(401);

			const deprecatedReply = makeReply();
			await deprecated![1](unauthorizedRequest, deprecatedReply);
			expect(deprecatedReply.code).toHaveBeenCalledWith(401);
		});
	});
});
