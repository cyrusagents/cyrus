import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CodexLoginBroker } from "../src/backend/CodexLoginBroker.js";

let home: string;
afterEach(async () => {
	vi.unstubAllGlobals();
	if (home) await rm(home, { recursive: true, force: true });
});
async function setup() {
	home = await mkdtemp(join(tmpdir(), "codex-broker-test-"));
	await writeFile(
		join(home, "auth.json"),
		JSON.stringify({
			auth_mode: "chatgpt",
			tokens: {
				access_token: "fixture-private-token",
				account_id: "fixture-account",
				refresh_token: "fixture-refresh",
			},
		}),
		{ mode: 0o600 },
	);
	return new CodexLoginBroker(home);
}
const context = () => ({
	model: "gpt-5.5",
	scopeKey: "private-scope-key",
	toolNames: ["get_issue"],
	authorize: vi.fn(async () => {}),
});
const body = () => ({
	model: "gpt-5.5",
	store: false,
	stream: true,
	input: [
		{
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "Read the bound issue" }],
		},
	],
	tools: [
		{
			type: "function",
			name: "get_issue",
			parameters: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
		},
	],
});
it("brokers only the admitted model at the fixed origin and keeps existing ChatGPT credentials in supervisor headers", async () => {
	const broker = await setup();
	const auth = context();
	expect(await broker.readiness()).toBeNull();
	const fetcher = vi.fn(async (url, init) => {
		expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(init.redirect).toBe("error");
		expect(init.headers.Authorization).toBe("Bearer fixture-private-token");
		expect(init.headers["ChatGPT-Account-ID"]).toBe("fixture-account");
		expect(init.body).not.toContain("fixture-private-token");
		expect(JSON.parse(init.body).prompt_cache_key).toBe(auth.scopeKey);
		return new Response("data: fixture-event\n\n", {
			headers: { "content-type": "text/event-stream" },
		});
	});
	vi.stubGlobal("fetch", fetcher);
	const response = await broker.respond(
		{ body: JSON.stringify(body()) },
		auth,
		new AbortController().signal,
	);
	expect(Buffer.from(response.body, "base64").toString()).toBe(
		"data: fixture-event\n\n",
	);
	expect(JSON.stringify(response)).not.toContain("fixture-private-token");
	expect(auth.authorize).toHaveBeenCalledTimes(3);
	expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([
	"model",
	"prior-response",
	"web-search",
	"remote-file",
	"foreign-tool",
	"revoked",
	"account-switch",
	"api-key",
])("denies %s before provider access", async (failure) => {
	const broker = await setup();
	await broker.readiness();
	const auth = context();
	const request: any = body();
	if (failure === "model") request.model = "other-model";
	if (failure === "prior-response")
		request.previous_response_id = "another-customer";
	if (failure === "web-search") request.tools = [{ type: "web_search" }];
	if (failure === "foreign-tool")
		request.tools = [{ type: "function", name: "customer_billing_write" }];
	if (failure === "remote-file")
		request.input = [
			{
				type: "input_file",
				file_url: "https://other-customer.invalid/private",
			},
		];
	if (failure === "revoked")
		auth.authorize.mockRejectedValue(new Error("Revoked"));
	if (failure === "account-switch")
		await writeFile(
			join(home, "auth.json"),
			JSON.stringify({
				tokens: { access_token: "other", account_id: "other-account" },
			}),
		);
	if (failure === "api-key")
		await writeFile(
			join(home, "auth.json"),
			JSON.stringify({ OPENAI_API_KEY: "fixture-api-key" }),
		);
	const fetcher = vi.fn();
	vi.stubGlobal("fetch", fetcher);
	await expect(
		broker.respond(
			{ body: JSON.stringify(request) },
			auth,
			new AbortController().signal,
		),
	).rejects.toThrow("denied or interrupted");
	expect(fetcher).not.toHaveBeenCalled();
});
it("requires private owner-only login storage", async () => {
	const broker = await setup();
	await chmod(join(home, "auth.json"), 0o644);
	expect(await broker.readiness()).toMatch(/unavailable/);
});

it.each([
	{ toolNames: [] },
	{ toolNames: ["read_messages", "read_thread"] },
	{ toolNames: ["execute", "publish_artifact"] },
])("forwards only admitted tools %j and removes native fallback built-ins", async ({
	toolNames,
}) => {
	const broker = await setup();
	const auth = { ...context(), toolNames };
	const request = {
		...body(),
		tools: [
			...toolNames.map((name) => ({
				type: "function",
				name,
				parameters: {
					type: "object",
					properties: {},
					additionalProperties: false,
				},
			})),
			...["apply_patch", "view_image", "request_user_input"].map((name) => ({
				type: name === "apply_patch" ? "custom" : "function",
				name,
			})),
		],
	};
	const fetcher = vi.fn(async (_url, init) => {
		expect(JSON.parse(init.body).tools).toEqual(
			request.tools.filter((tool) => toolNames.includes(tool.name)),
		);
		return new Response("data: fixture\n\n", {
			headers: { "content-type": "text/event-stream" },
		});
	});
	vi.stubGlobal("fetch", fetcher);
	await broker.respond(
		{ body: JSON.stringify(request) },
		auth,
		new AbortController().signal,
	);
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(auth.authorize).toHaveBeenCalledTimes(3);
});
