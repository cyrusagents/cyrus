import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type AutomationCheckpoint,
	AutomationCheckpointStore,
} from "../src/automations/CheckpointStore.js";
import { ContainedCodexAutomationModel } from "../src/automations/ContainedCodexModel.js";
import {
	type AutomationAuthority,
	checkpointKey,
} from "../src/automations/contract.js";
import type { AutomationModelContext } from "../src/automations/Model.js";

function response(tool: boolean) {
	const item = tool
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
						text: "Recovered scoped findings.",
						annotations: [],
					},
				],
				status: "completed",
			};
	const response = {
		id: "resp_fixture",
		object: "response",
		status: "completed",
		output: [item],
		usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
	};
	const events = [
		[
			"response.created",
			{ response: { ...response, status: "in_progress", output: [] } },
		],
		["response.output_item.added", { output_index: 0, item }],
		["response.output_item.done", { output_index: 0, item }],
		["response.completed", { response }],
	];
	return {
		status: 200,
		contentType: "text/event-stream",
		body: Buffer.from(
			events
				.map(
					([type, data]) =>
						`event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`,
				)
				.join(""),
		).toString("base64"),
	};
}
const image = process.env.CYRUS_TEST_CODEX_IMAGE;
describe.skipIf(!image)("native contained automation recovery", () => {
	it("retains an interrupted native tool request, restores only its own rollout and continues with durable output", async () => {
		const root = await mkdtemp(join(tmpdir(), "cyrus-native-automation-"));
		const store = new AutomationCheckpointStore(root);
		const authority: AutomationAuthority = {
			contractVersion: 1,
			definition: {
				id: "a",
				workspaceId: "w",
				ownerId: "operator",
				namespace: "customer-a",
				scopeRef: "customer-a-issue",
				revision: 1,
				state: "enabled",
				role: "investigator",
				instruction: "Read assigned issue",
				schedule: null,
				target: { harness: "codex", model: "gpt-5.5" },
				grants: [
					{
						id: "bound",
						accountId: "account",
						connectionId: "linear",
						resource: { provider: "linear", teamId: "team", issueId: "issue" },
						permissions: ["read"],
					},
				],
			},
			occurrenceId: "occurrence",
			attemptId: "attempt",
			fence: 1,
			leaseUntil: new Date(Date.now() + 60000).toISOString(),
			phase: "execute",
			input: "Investigate",
		};
		let state: AutomationCheckpoint = {
			version: 1,
			scopeKey: checkpointKey(authority),
			sequence: 0,
			status: "running",
			messages: [{ role: "user", content: "Read the bound issue and report" }],
		};
		let modelCalls = 0,
			authCalls = 0;
		const nativeIds: string[] = [];
		const controller = new AbortController();
		const context = (): AutomationModelContext => ({
			state,
			authority: () => authority,
			authorize: async () => {
				controller.signal.throwIfAborted();
				authCalls++;
			},
			save: () => store.save(state),
			signal: controller.signal,
			nativeIdentity: async (id) => {
				nativeIds.push(id);
			},
		});
		const model = new ContainedCodexAutomationModel(
			{
				image: image!,
				dockerPath:
					process.env.CYRUS_TEST_DOCKER_PATH || "/usr/local/bin/docker",
				dockerHost: "unix:///var/run/docker.sock",
			},
			async ({ body }) => {
				modelCalls++;
				const request = JSON.parse(body);
				expect(request.tools.map((t: { name: string }) => t.name)).toContain(
					"get_issue",
				);
				if (modelCalls === 2)
					expect(body).toContain("durable scoped tool output");
				return response(modelCalls === 1);
			},
		);
		let session = await model.open(context());
		try {
			const step = await session.next(
				state.messages,
				authority,
				controller.signal,
			);
			expect(step).toEqual({
				type: "tool",
				call: { name: "get_issue", arguments: {} },
			});
			const nativeId = state.native!.threadId;
			await session.close!();
			state = (await store.load(state.scopeKey))!;
			expect(state.native?.tool?.sequence).toBe(0);
			const denied = await model.open({
				...context(),
				authorize: async () => {
					throw new Error("Revoked replay");
				},
			});
			await expect(
				denied.next(state.messages, authority, controller.signal),
			).rejects.toThrow("Revoked replay");
			await denied.close!();
			expect(modelCalls).toBe(1);
			session = await model.open(context());
			expect(
				await session.next(state.messages, authority, controller.signal),
			).toEqual(step);
			expect(modelCalls).toBe(1);
			state.messages.push(
				{ role: "assistant", content: JSON.stringify(step) },
				{
					role: "user",
					content: JSON.stringify({
						items: [{ text: "durable scoped tool output" }],
						nextCursor: null,
					}),
				},
			);
			state.sequence++;
			await store.save(state);
			expect(
				await session.next(state.messages, authority, controller.signal),
			).toEqual({ type: "result", text: "Recovered scoped findings." });
			expect(nativeIds).toEqual([nativeId, nativeId]);
			expect(state.native?.tool).toBeUndefined();
			expect(authCalls).toBeGreaterThan(4);
			expect(modelCalls).toBe(2);
		} finally {
			await session.close!();
			await rm(root, { recursive: true, force: true });
		}
	}, 30000);
});
