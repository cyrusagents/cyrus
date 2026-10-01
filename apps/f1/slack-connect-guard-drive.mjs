// Real signed/proxy ingress + ordinary chat lifecycle; synthetic Slack/model only.
// Optional argument: isolated installed prefix. Never uses host Slack credentials.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const prefix = process.argv[2];
const root = (name) =>
	prefix
		? join(resolve(prefix), "lib/node_modules", name)
		: resolve("packages", name.replace("cyrus-", ""));
const slack = await import(
	pathToFileURL(join(root("cyrus-slack-event-transport"), "dist/index.js"))
);
const { ChatSessionHandler } = await import(
	pathToFileURL(join(root("cyrus-edge-worker"), "dist/ChatSessionHandler.js"))
);
const { SlackChatAdapter } = await import(
	pathToFileURL(join(root("cyrus-edge-worker"), "dist/SlackChatAdapter.js"))
);
const Fastify = createRequire(join(root("cyrus-edge-worker"), "package.json"))(
	"fastify",
);
const home = await mkdtemp(join(tmpdir(), "cyrus-slack-guard-"));
const oldFetch = globalThis.fetch,
	oldToken = process.env.SLACK_BOT_TOKEN;
const savedExternal = process.env.CYRUS_HOST_EXTERNAL,
	savedSigning = process.env.SLACK_SIGNING_SECRET;
delete process.env.CYRUS_HOST_EXTERNAL;
delete process.env.SLACK_SIGNING_SECRET;
process.env.SLACK_BOT_TOKEN = "synthetic-guard-token";
const posts = [],
	apiCalls = [],
	starts = [],
	configs = [],
	tasks = [];
let external = false,
	unknown = false,
	revoked = false,
	running = false,
	events = 0,
	messages = 0;
const logger = {
	info() {},
	debug() {},
	warn() {},
	error: console.error,
	withContext() {
		return this;
	},
};
const provider = {
	getRepositoryPaths: () => [],
	getDefaultRepository: () => undefined,
	getDefaultLinearWorkspaceId: () => undefined,
};
const adapter = new SlackChatAdapter(provider, logger);
const handler = new ChatSessionHandler(
	adapter,
	{
		cyrusHome: home,
		chatRepositoryProvider: provider,
		runnerConfigBuilder: {
			buildChatConfig: (input) => ({
				...input,
				runnerType: "claude",
				workingDirectory: input.workspacePath,
				allowedTools: [],
				maxTurns: 1,
			}),
		},
		createRunner(config) {
			configs.push(config);
			return {
				supportsStreamingInput: false,
				isRunning: () => running,
				isStreaming: () => false,
				async start(prompt) {
					starts.push(prompt);
					running = true;
					return { sessionId: "native-fixture" };
				},
				async stop() {
					running = false;
				},
				getMessages: () => [
					{
						type: "assistant",
						message: { content: [{ type: "text", text: "INTERNAL_REPLY" }] },
					},
				],
			};
		},
		onWebhookStart() {},
		onWebhookEnd() {},
		async onStateChange() {},
		onClaudeError(error) {
			throw error;
		},
	},
	logger,
);
globalThis.fetch = async (url, init) => {
	const parsed = new URL(url);
	assert.equal(
		parsed.origin,
		"https://slack.com",
		"all external transport is intercepted/denied",
	);
	const method = parsed.pathname.split("/").at(-1);
	apiCalls.push(method);
	if (method === "auth.test")
		return Response.json(
			revoked
				? { ok: false }
				: { ok: true, team_id: "T123", user_id: "U123", bot_id: "B123" },
		);
	if (method === "conversations.info")
		return Response.json({
			ok: true,
			channel: {
				id: new URLSearchParams(init.body).get("channel"),
				is_ext_shared: unknown ? undefined : external,
				is_shared: external,
				is_member: true,
				is_archived: false,
			},
		});
	assert.equal(
		external || unknown || revoked,
		false,
		"no source reads/writes after classification loss",
	);
	if (method === "conversations.replies")
		return Response.json({ ok: true, messages: [] });
	if (method === "chat.postMessage") posts.push(JSON.parse(init.body));
	else assert.ok(["reactions.add", "reactions.remove"].includes(method));
	return Response.json({ ok: true });
};
const servers = [];
const settle = async () => {
	await Promise.all(tasks.splice(0));
	for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};
let serial = 0;
const makeEvent = (
	type = "app_mention",
	ts = `${++serial}.001`,
	thread = "1.001",
) => ({
	type: "event_callback",
	team_id: "T123",
	api_app_id: "A123",
	event_id: `E${++serial}`,
	event_time: 1,
	event: {
		type,
		channel: "C123",
		user: "U456",
		text: "<@U123> synthetic request",
		ts,
		thread_ts: thread,
		event_ts: ts,
	},
});
const secret = "synthetic-signing-or-proxy-secret";
async function server(mode) {
	const app = Fastify();
	servers.push(app);
	app.addContentTypeParser(
		"application/json",
		{ parseAs: "string" },
		(req, body, done) => {
			req.rawBody = body;
			done(null, JSON.parse(body));
		},
	);
	const transport = new slack.SlackEventTransport(
		{ fastifyServer: app, verificationMode: mode, secret },
		logger,
	);
	transport.on("event", (event) => {
		events++;
		tasks.push(handler.handleEvent(event));
	});
	transport.on("message", () => messages++);
	transport.on("error", (error) => {
		throw error;
	});
	transport.register();
	await app.ready();
	return async (envelope, authorized = true) => {
		const body = JSON.stringify(envelope),
			timestamp = `${Math.floor(Date.now() / 1000)}`;
		const headers =
			mode === "proxy"
				? { authorization: `Bearer ${authorized ? secret : "wrong"}` }
				: {
						"x-slack-request-timestamp": timestamp,
						"x-slack-signature": `v0=${createHmac(
							"sha256",
							authorized ? secret : "wrong",
						)
							.update(`v0:${timestamp}:${body}`)
							.digest("hex")}`,
					};
		const result = await app.inject({
			method: "POST",
			url: "/slack-webhook",
			headers: { ...headers, "content-type": "application/json" },
			payload: body,
		});
		await settle();
		return result;
	};
}
try {
	for (const mode of ["proxy", "direct"]) {
		const send = await server(mode);
		const before = apiCalls.length;
		assert.equal((await send(makeEvent(), false)).statusCode, 401);
		assert.equal(
			apiCalls.length,
			before,
			"unauthenticated input never uses provider credential",
		);
		for (const state of ["external", "unknown", "revoked"]) {
			external = state === "external";
			unknown = state === "unknown";
			revoked = state === "revoked";
			for (const type of ["app_mention", "message"])
				assert.equal((await send(makeEvent(type))).json().ignored, true);
		}
	}
	assert.equal(events, 0);
	assert.equal(messages, 0);
	assert.equal(starts.length, 0);
	assert.equal(posts.length, 0);
	external = unknown = revoked = false;
	const send = await server("proxy");
	const mention = makeEvent("app_mention", "100.001", "100.000");
	assert.equal((await send(mention)).statusCode, 200);
	assert.equal(starts.length, 1);
	await configs[0].onMessage({
		type: "system",
		subtype: "init",
		session_id: "native-fixture",
		tools: [],
		model: "fixture",
	});
	await send({
		...mention,
		event_id: "ETWIN",
		event: { ...mention.event, type: "message" },
	});
	assert.equal(events, 1);
	assert.equal(messages, 1);
	assert.equal(starts.length, 1);
	running = false;
	await configs[0].onMessage({
		type: "result",
		subtype: "success",
		is_error: false,
		result: "INTERNAL_REPLY",
		session_id: "native-fixture",
	});
	await settle();
	assert.deepEqual(posts, [
		{ channel: "C123", text: "INTERNAL_REPLY", thread_ts: "100.000" },
	]);
	// Internal follow-ups still resume; a queued third input must be rechecked.
	await send(makeEvent("message", "101.001", "100.000"));
	assert.equal(starts.length, 2);
	await send(makeEvent("message", "102.001", "100.000"));
	assert.equal(starts.length, 2);
	const postCount = posts.length;
	external = true;
	running = false;
	await configs[1].onMessage({
		type: "result",
		subtype: "success",
		is_error: false,
		result: "late",
		session_id: "native-fixture",
	});
	await settle();
	assert.equal(
		posts.length,
		postCount,
		"final reply suppressed after conversion to Connect",
	);
	assert.equal(
		starts.length,
		2,
		"queued prompt denied after conversion to Connect",
	);
	assert.equal(
		(await send(makeEvent("message", "103.001", "100.000"))).json().ignored,
		true,
	);
	// Captured event credentials and a prior thread binding cannot revive an account.
	external = false;
	delete process.env.SLACK_BOT_TOKEN;
	await handler.handleEvent({
		eventType: "app_mention",
		eventId: "EOLD",
		teamId: "T123",
		slackBotToken: "synthetic-guard-token",
		payload: mention.event,
	});
	assert.equal(starts.length, 2);
	console.log(
		JSON.stringify(
			{
				passed: true,
				modes: ["signed-direct", "authenticated-proxy"],
				deniedIngress: 12,
				internalStarts: starts.length,
				emittedEvents: events,
				emittedMessages: messages,
				internalThreadReply: true,
				queuedConversionDenied: true,
				staleCredentialDenied: true,
				model: "controlled runner",
				provider: "controlled fixed-origin transport",
				customerRouting: "Hosted-owned; not exercised by this guard drive",
			},
			null,
			2,
		),
	);
} finally {
	await Promise.all(servers.map((app) => app.close()));
	globalThis.fetch = oldFetch;
	for (const [key, value] of [
		["SLACK_BOT_TOKEN", oldToken],
		["CYRUS_HOST_EXTERNAL", savedExternal],
		["SLACK_SIGNING_SECRET", savedSigning],
	]) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(home, { recursive: true, force: true });
}
