import {
	type ContainedCodexConfig,
	ContainedCodexProcess,
	type ContainedModelRequest,
	type ContainedModelResponse,
} from "cyrus-codex-runner";
import { z } from "zod";
import type { AutomationMessage } from "./CheckpointStore.js";
import {
	type AutomationAuthority,
	type AutomationStep,
	authorizeTool,
	permittedToolNames,
	scopedToolDescription,
	scopedToolSchemas,
	toolCallSchema,
} from "./contract.js";
import { markLatency, measureLatency } from "./Latency.js";
import type { AutomationModel, AutomationModelContext } from "./Model.js";

/** One native process per admitted occurrence. No shared app-server pool or user config. */
export class ContainedCodexAutomationModel implements AutomationModel {
	constructor(
		private readonly config: ContainedCodexConfig,
		private readonly broker: (
			request: ContainedModelRequest,
			context: AutomationModelContext,
		) => Promise<ContainedModelResponse>,
	) {}
	async next(): Promise<AutomationStep> {
		throw new Error("Contained model requires an admitted session");
	}
	async open(context: AutomationModelContext): Promise<AutomationModel> {
		return new ContainedCodexTurn(this.config, this.broker, context);
	}
}

class ContainedCodexTurn implements AutomationModel {
	private runner?: ContainedCodexProcess;
	private threadId?: string;
	private waiting?: {
		resolve: (step: AutomationStep) => void;
		reject: (error: Error) => void;
	};
	private toolReply?: (result: unknown) => void;
	private finalText = "";
	private closed = false;
	private failed?: Error;
	private completing?: Promise<void>;
	constructor(
		private readonly config: ContainedCodexConfig,
		private readonly broker: (
			request: ContainedModelRequest,
			context: AutomationModelContext,
		) => Promise<ContainedModelResponse>,
		private readonly context: AutomationModelContext,
	) {}
	private fail(): void {
		this.failed = new Error("Contained Codex turn interrupted");
		this.waiting?.reject(this.failed);
		this.waiting = undefined;
	}
	async next(
		messages: AutomationMessage[],
		authority: AutomationAuthority,
		signal: AbortSignal,
	): Promise<AutomationStep> {
		signal.throwIfAborted();
		if (this.closed || this.failed)
			throw this.failed ?? new Error("Contained session is closed");
		if (this.waiting) throw new Error("Concurrent native turn denied");
		const { state } = this.context;
		// Capture-before-operation closes the crash window between native request
		// and the runtime's pending operation checkpoint. Never ask the model to
		// invent another operation identity for an unresolved call.
		if (
			!this.runner &&
			state.native?.tool &&
			state.sequence === state.native.tool.sequence
		)
			return { type: "tool", call: state.native.tool.call };
		const result = new Promise<AutomationStep>((resolve, reject) => {
			this.waiting = { resolve, reject };
		});
		// Install rejection handling before initialization can fail.
		void result.catch(() => {});
		try {
			await this.context.authorize();
			if (this.toolReply) {
				const reply = this.toolReply;
				this.toolReply = undefined;
				reply({
					success: true,
					contentItems: [{ type: "inputText", text: messages.at(-1)!.content }],
				});
			} else if (!this.runner) {
				const runner = new ContainedCodexProcess(this.config);
				this.runner = runner;
				await measureLatency("container.initialize", () =>
					runner.start({
						signal,
						exit: () => {
							if (!this.closed) this.fail();
						},
						model: async (request) => {
							markLatency("model.request");
							await this.context.authorize();
							if (this.threadId) await this.capture();
							return this.broker(request, this.context);
						},
						request: async (method, raw) => {
							if (method !== "item/tool/call")
								throw new Error("Native permission request denied");
							const request = z
								.object({
									threadId: z.string(),
									callId: z.string(),
									tool: z.string(),
									arguments: z.unknown(),
								})
								.passthrough()
								.parse(raw);
							if (
								request.threadId !== this.threadId ||
								this.toolReply ||
								!this.waiting
							)
								throw new Error("Foreign or concurrent native call");
							const call = toolCallSchema.parse({
								name: request.tool,
								arguments: request.arguments,
							});
							authorizeTool(this.context.authority(), call);
							await this.context.authorize();
							await this.capture({ call, sequence: state.sequence });
							const response = new Promise<unknown>((resolve) => {
								this.toolReply = resolve;
							});
							const waiting = this.waiting!;
							this.waiting = undefined;
							waiting.resolve({ type: "tool", call });
							return response;
						},
						notification: (method, raw) => {
							const value = raw as {
								threadId?: string;
								item?: { type?: string; text?: string };
								turn?: { status?: string };
							};
							if (value.threadId && value.threadId !== this.threadId) return;
							if (method === "turn/started") markLatency("native.started");
							if (method === "turn/completed") markLatency("native.completed");
							if (method === "item/started" || method === "item/completed")
								markLatency("native.activity");
							if (
								method === "item/completed" &&
								value.item?.type === "agentMessage" &&
								typeof value.item.text === "string"
							)
								this.finalText = value.item.text;
							if (method === "turn/completed") {
								if (value.turn?.status !== "completed" || !this.finalText) {
									this.fail();
									return;
								}
								this.completing = this.complete().catch(() => this.fail());
							}
						},
					}),
				);
				const target = {
					model: authority.definition.target.model,
					modelProvider: "cyrus_contained",
					cwd: "/work",
					approvalPolicy: "never",
					sandbox: "danger-full-access",
					developerInstructions: `This is a contained automation. Available tools: ${JSON.stringify(permittedToolNames(authority))}. Use only these admitted tools for source access and permitted engineering work. If source access is unavailable, report that limitation. Never suggest credential, filesystem, native-tool or alternate connector access as a fallback. Resource authority is fixed by the connection; arguments can only narrow it.`,
				};
				if (state.native) {
					const path = await runner.restore(state.native);
					this.threadId = state.native.threadId;
					await measureLatency("native.thread", () =>
						runner.request("thread/resume", {
							...target,
							threadId: this.threadId,
							path,
						}),
					);
				} else {
					const thread = await measureLatency("native.thread", () =>
						runner.request<{ thread: { id: string } }>("thread/start", {
							...target,
							ephemeral: false,
							historyMode: "legacy",
							dynamicTools: scopedToolSchemas(authority).map((schema) => ({
								type: "function",
								name: schema.shape.name.value,
								description: scopedToolDescription(
									authority,
									schema.shape.name.value,
								),
								inputSchema: z.toJSONSchema(schema.shape.arguments),
							})),
						}),
					);
					this.threadId = thread.thread.id;
				}
				await this.context.nativeIdentity(this.threadId);
				// Reconnect is a new turn of the same native session. Completed tool
				// output is supplied from the runtime's durable operation receipt.
				const input = state.native
					? `Continue the interrupted scoped task. Durable conversation and operation results:\n${JSON.stringify(messages)}`
					: messages[0]!.content;
				await measureLatency("native.turnStart", () =>
					runner.request("turn/start", {
						threadId: this.threadId,
						input: [{ type: "text", text: input }],
					}),
				);
			}
		} catch {
			this.fail();
		}
		return result;
	}
	private async capture(
		tool?: NonNullable<AutomationModelContext["state"]["native"]>["tool"],
	): Promise<void> {
		const snapshot = await this.runner!.snapshot(this.threadId!);
		this.context.state.native = { ...snapshot, ...(tool && { tool }) };
		await this.context.save();
	}
	private async complete(): Promise<void> {
		await this.context.authorize();
		await this.capture();
		const waiting = this.waiting;
		this.waiting = undefined;
		waiting?.resolve({ type: "result", text: this.finalText });
	}
	async close(): Promise<void> {
		this.closed = true;
		this.fail();
		this.toolReply?.({ success: false, contentItems: [] });
		this.toolReply = undefined;
		try {
			await this.runner?.close();
		} finally {
			await this.completing;
		}
	}
}
