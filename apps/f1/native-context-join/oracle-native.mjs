// Test-only bridge: existing Hosted deterministic step oracle drives the real
// installed native process. No live login, model request or provider access.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function nativeOracle(oracle, { directory, modules, load }) {
	const { ContainedCodexAutomationModel } = await load("ContainedCodexModel");
	const { permittedToolNames, scopedToolDescription } = await load("contract");
	const { CodexLoginBroker } = await import(
		pathToFileURL(resolve(modules, "../../../cyrus-codex-runner/dist/index.js"))
	);
	const home = join(directory, "synthetic-native-login");
	await mkdir(home, { mode: 0o700 });
	await writeFile(
		join(home, "auth.json"),
		JSON.stringify({
			auth_mode: "chatgpt",
			tokens: {
				access_token: "synthetic-native-oracle",
				account_id: "fixture",
			},
		}),
		{ mode: 0o600 },
	);
	const broker = new CodexLoginBroker(home);
	const context = new AsyncLocalStorage();
	const transport = globalThis.fetch;
	const evidence = {
		opens: 0,
		requests: 0,
		childRequests: 0,
		closes: 0,
		noPrivateParentInChildInput: true,
		delegationDescriptionRequests: 0,
	};
	const save = () =>
		writeFile(
			join(directory, "native-summary.json"),
			JSON.stringify(evidence, null, 2),
		);
	globalThis.fetch = async (url, init) => {
		const parsed = new URL(url);
		if (parsed.origin !== "https://chatgpt.com") return transport(url, init);
		assert.equal(parsed.pathname, "/backend-api/codex/responses");
		const c = context.getStore();
		assert.ok(c, "native provider request belongs to an admitted occurrence");
		const authority = c.authority();
		const request = JSON.parse(init.body);
		// Assert the complete descriptions at the real native -> broker request
		// boundary, where SDK rewriting or missing dynamic-tool metadata matters.
		for (const tool of request.tools ?? []) {
			if (
				tool.name === "delegate_investigation" ||
				tool.name === "read_context"
			)
				assert.equal(
					tool.description,
					scopedToolDescription(authority, tool.name),
				);
			if (tool.name === "delegate_investigation")
				evidence.delegationDescriptionRequests++;
		}
		if (authority.definition.role === "investigator") {
			evidence.childRequests++;
			assert.ok(
				!init.body.includes("PRIVATE_PARENT_CONTEXT"),
				"native child request excludes private parent input",
			);
		}
		const step = await oracle.next(c.state.messages, authority, c.signal);
		const id = `native_oracle_${++evidence.requests}`;
		const item =
			step.type === "tool"
				? {
						type: "function_call",
						id,
						call_id: id,
						name: step.call.name,
						arguments: JSON.stringify(step.call.arguments),
					}
				: {
						type: "message",
						id,
						role: "assistant",
						content: [
							{ type: "output_text", text: step.text, annotations: [] },
						],
						status: "completed",
					};
		assert.ok(step.type === "tool" || step.type === "result");
		if (step.type === "tool")
			assert.ok(
				JSON.parse(init.body).tools.some((t) => t.name === step.call.name),
			);
		const response = {
			id,
			object: "response",
			status: "completed",
			output: [item],
			usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
		};
		const stream = [
			[
				"response.created",
				{ response: { ...response, status: "in_progress", output: [] } },
			],
			["response.output_item.added", { output_index: 0, item }],
			["response.output_item.done", { output_index: 0, item }],
			["response.completed", { response }],
		]
			.map(
				([type, data]) =>
					`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
			)
			.join("");
		await save();
		return new Response(stream, {
			headers: { "content-type": "text/event-stream" },
		});
	};
	const model = new ContainedCodexAutomationModel(
		{
			image: process.env.CYRUS_F1_CODEX_IMAGE,
			dockerPath: process.env.CYRUS_TEST_DOCKER_PATH || "/usr/local/bin/docker",
			dockerHost:
				process.env.CYRUS_TEST_DOCKER_HOST || "unix:///var/run/docker.sock",
		},
		(request, c) =>
			context.run(c, () =>
				broker.respond(
					request,
					{
						model: "gpt-5.5",
						scopeKey: c.state.scopeKey,
						toolNames: permittedToolNames(c.authority()),
						authorize: c.authorize,
					},
					c.signal,
				),
			),
	);
	return {
		async open(c) {
			evidence.opens++;
			const turn = await model.open(c);
			return {
				next: (...args) => turn.next(...args),
				async close() {
					await turn.close();
					evidence.closes++;
					await save();
				},
			};
		},
		next: (...args) => model.next(...args),
	};
}
