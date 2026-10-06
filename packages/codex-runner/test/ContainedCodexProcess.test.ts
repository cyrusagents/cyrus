import { describe, expect, it } from "vitest";
import { translateAppServerItem } from "../src/backend/appServerEvents.js";
import { ContainedCodexProcess } from "../src/backend/ContainedCodexProcess.js";
import { CodexEventMapper } from "../src/CodexEventMapper.js";

it("rejects mutable images, remote Docker and relative binary paths", () => {
	const good = {
		dockerPath: "/usr/bin/docker",
		dockerHost: "unix:///var/run/docker.sock",
		image: `sha256:${"a".repeat(64)}`,
	};
	for (const patch of [
		{ image: "codex:latest" },
		{ dockerHost: "tcp://example:2375" },
		{ dockerPath: "docker" },
	])
		expect(() => new ContainedCodexProcess({ ...good, ...patch })).toThrow();
});

const image = process.env.CYRUS_TEST_CODEX_IMAGE;
describe.skipIf(!image)(
	"actual isolated Codex app-server (controlled model bridge)",
	() => {
		it("emits a real tool start/result and final answer without host credentials or external network", async () => {
			const runner = new ContainedCodexProcess({
				image: image!,
				dockerPath:
					process.env.CYRUS_TEST_DOCKER_PATH || "/usr/local/bin/docker",
				dockerHost: "unix:///var/run/docker.sock",
			});
			const controller = new AbortController();
			let models = 0,
				tools = 0,
				threadId = "pending";
			const mapper = new CodexEventMapper({
				workingDirectory: "/work",
				model: "gpt-5.5",
				getSessionId: () => threadId,
				getStagedSkillNames: () => [],
				emitMessage() {},
				onThreadStarted(id) {
					threadId = id;
				},
			});
			mapper.reset();
			let finish: (params: any) => void;
			const completed = new Promise<any>((resolve) => {
				finish = resolve;
			});
			const methods: string[] = [];
			try {
				await runner.start({
					signal: controller.signal,
					notification(method, raw) {
						const p = raw as any;
						methods.push(method);
						if (method === "thread/started")
							mapper.handle({ kind: "thread-started", threadId: p.thread.id });
						if (method === "item/started" || method === "item/completed") {
							const item = translateAppServerItem(p.item);
							if (item)
								mapper.handle({
									kind:
										method === "item/started"
											? "item-started"
											: "item-completed",
									item,
								});
						}
						if (method === "turn/completed") {
							mapper.handle({
								kind: "turn-completed",
								usage: {
									input_tokens: 20,
									output_tokens: 10,
									cached_input_tokens: 0,
								},
							});
							finish(p);
						}
					},
					async request(method, params) {
						expect(method).toBe("item/tool/call");
						expect(params).toMatchObject({
							tool: "get_issue",
							arguments: {},
							threadId,
						});
						tools++;
						return {
							success: true,
							contentItems: [
								{ type: "inputText", text: "Scoped issue content" },
							],
						};
					},
					async model({ body }) {
						models++;
						const request = JSON.parse(body);
						expect(request.model).toBe("gpt-5.5");
						expect(request.tools.map((t: any) => t.name)).toContain(
							"get_issue",
						);
						for (const name of [
							"shell",
							"exec_command",
							"web_search",
							"read_file",
						])
							expect(request.tools.map((t: any) => t.name)).not.toContain(name);
						expect(body).not.toContain(
							process.env.CYRUS_TEST_HOST_SECRET || "fixture-host-secret",
						);
						const item =
							models === 1
								? {
										type: "function_call",
										id: "fc_fixture",
										call_id: "call_fixture",
										name: "get_issue",
										arguments: "{}",
									}
								: {
										type: "message",
										id: "msg_fixture",
										role: "assistant",
										content: [
											{
												type: "output_text",
												text: "Completed scoped investigation.",
												annotations: [],
											},
										],
										status: "completed",
									};
						const response = {
							id: `resp_${models}`,
							object: "response",
							status: "completed",
							output: [item],
							usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
						};
						const events = [
							[
								"response.created",
								{
									response: { ...response, status: "in_progress", output: [] },
								},
							],
							["response.output_item.added", { output_index: 0, item }],
							["response.output_item.done", { output_index: 0, item }],
							["response.completed", { response }],
						];
						const output = events
							.map(
								([type, data]) =>
									`event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`,
							)
							.join("");
						return {
							status: 200,
							contentType: "text/event-stream",
							body: Buffer.from(output).toString("base64"),
						};
					},
				});
				const probe = await runner.request<any>("command/exec", {
					command: [
						"/usr/local/bin/node",
						"-e",
						`const fs=require('node:fs'),net=require('node:net');let secret=Object.keys(process.env).some(k=>/API_KEY|CLOUDFLARE_TOKEN|CYRUS_TEAM_ID|CYRUS_TEST_HOST_SECRET/.test(k));let host=fs.existsSync('/Users/agentops/.codex/auth.json')||fs.existsSync('/var/run/docker.sock');let auth=fs.existsSync('/work/home/.codex/auth.json');let socket=net.connect({host:'1.1.1.1',port:443});socket.setTimeout(500);const end=(network)=>{socket.destroy();console.log(JSON.stringify({secret,host,auth,network}));};socket.once('connect',()=>end(true));socket.once('error',()=>end(false));socket.once('timeout',()=>end(false));`,
					],
					cwd: "/work",
					sandboxPolicy: { type: "dangerFullAccess" },
					timeoutMs: 5000,
				});
				expect(probe.exitCode).toBe(0);
				expect(JSON.parse(probe.stdout.trim())).toEqual({
					secret: false,
					host: false,
					auth: false,
					network: false,
				});
				const thread = await runner.request<any>("thread/start", {
					model: "gpt-5.5",
					modelProvider: "cyrus_contained",
					cwd: "/work",
					approvalPolicy: "never",
					sandbox: "danger-full-access",
					dynamicTools: [
						{
							type: "function",
							name: "get_issue",
							description: "Read the bound issue",
							inputSchema: {
								type: "object",
								properties: {},
								additionalProperties: false,
							},
						},
					],
					ephemeral: false,
					historyMode: "legacy",
				});
				await runner.request("turn/start", {
					threadId: thread.thread.id,
					input: [
						{ type: "text", text: "Read the assigned issue and report." },
					],
				});
				expect((await completed).turn.status).toBe("completed");
				expect({ models, tools }).toEqual({ models: 2, tools: 1 });
				const snapshot = await runner.snapshot(thread.thread.id);
				expect(snapshot.threadId).toBe(thread.thread.id);
				await runner.close();
				const resumed = new ContainedCodexProcess({
					image: image!,
					dockerPath:
						process.env.CYRUS_TEST_DOCKER_PATH || "/usr/local/bin/docker",
					dockerHost: "unix:///var/run/docker.sock",
				});
				try {
					await resumed.start({
						signal: controller.signal,
						notification() {},
						async model() {
							throw Error("Resume must not call model");
						},
						async request() {
							throw Error("Resume must not call tools");
						},
					});
					await expect(
						resumed.restore({
							...snapshot,
							threadId: "00000000-0000-0000-0000-000000000000",
						}),
					).rejects.toThrow("identity mismatch");
					const path = await resumed.restore(snapshot);
					const recovered = await resumed.request<any>("thread/resume", {
						threadId: snapshot.threadId,
						path,
						model: "gpt-5.5",
						modelProvider: "cyrus_contained",
						cwd: "/work",
						approvalPolicy: "never",
						sandbox: "danger-full-access",
					});
					expect(recovered.thread.id).toBe(snapshot.threadId);
					expect(JSON.stringify(recovered.thread.turns)).toContain(
						"Completed scoped investigation.",
					);
				} finally {
					await resumed.close();
				}

				const messages = mapper.finalize({ wasStopped: false });
				expect(
					messages.some(
						(m: any) =>
							m.type === "assistant" &&
							m.message.content.some(
								(b: any) =>
									b.type === "tool_use" &&
									b.name === "get_issue" &&
									b.id === "call_fixture",
							),
					),
				).toBe(true);
				expect(
					messages.some(
						(m: any) =>
							m.type === "user" &&
							m.message.content.some(
								(b: any) =>
									b.type === "tool_result" &&
									b.content === "Scoped issue content",
							),
					),
				).toBe(true);
				expect(
					messages.some(
						(m: any) =>
							m.type === "result" &&
							m.result === "Completed scoped investigation.",
					),
				).toBe(true);
			} finally {
				controller.abort();
				await runner.close();
			}
		}, 30000);
	},
);

describe.skipIf(!image)("contained process stop boundaries", () => {
	it("times out sandbox commands and aborts a pending request without leaving the process usable", async () => {
		const runner = new ContainedCodexProcess({
			image: image!,
			dockerPath: process.env.CYRUS_TEST_DOCKER_PATH || "/usr/local/bin/docker",
			dockerHost: "unix:///var/run/docker.sock",
		});
		const controller = new AbortController();
		try {
			await runner.start({
				signal: controller.signal,
				notification() {},
				async model() {
					throw Error("No model authorized");
				},
				async request() {
					throw Error("No tool authorized");
				},
			});
			const command = {
				command: ["/usr/local/bin/node", "-e", "setInterval(()=>{},1000)"],
				cwd: "/work",
				sandboxPolicy: { type: "dangerFullAccess" },
				timeoutMs: 100,
			};
			const timed = await runner.request<{ exitCode: number }>(
				"command/exec",
				command,
			);
			expect(timed.exitCode).not.toBe(0);
			const pending = runner.request("command/exec", {
				...command,
				timeoutMs: 10000,
			});
			const rejected = expect(pending).rejects.toThrow();
			controller.abort();
			await Promise.all([rejected, runner.close(), runner.close()]);
			expect(() => runner.request("thread/list", {})).toThrow("unavailable");
		} finally {
			await runner.close();
		}
	}, 20000);
});
