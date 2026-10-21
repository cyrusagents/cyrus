import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const codexMessageSchema = z
	.object({
		inboxId: z
			.string()
			.uuid()
			.describe(
				"Explicit inbox ID shared by the authorized receiving user after connecting and subscribing.",
			),
		idempotencyKey: z
			.string()
			.min(8)
			.max(128)
			.describe(
				"Stable operation key. Reuse exactly when retrying the same message.",
			),
		text: z
			.string()
			.min(1)
			.max(16000)
			.describe("Message content, treated as data by the receiver."),
	})
	.strict();
const receiptSchema = z
	.object({
		messageId: z.string().uuid(),
		status: z.enum(["queued", "webhook_received", "not_delivered"]),
	})
	.strict();
export type CodexMessage = z.infer<typeof codexMessageSchema>;
export type CodexMessageReceipt = z.infer<typeof receiptSchema>;
export type CodexMessagePublisher = (
	input: CodexMessage,
) => Promise<CodexMessageReceipt>;

export function createCodexMessagePublisher(
	config: { baseUrl: string; apiKey: string },
	fetcher: typeof fetch = fetch,
): CodexMessagePublisher {
	const base = new URL(config.baseUrl);
	if (
		base.protocol !== "https:" &&
		!(
			base.protocol === "http:" &&
			["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
		)
	)
		throw new Error("Cyrus control plane must use HTTPS");
	if (base.username || base.password)
		throw new Error("Invalid control plane URL");
	const endpoint = new URL("/api/codex-inbox/messages", base);
	return async (input) => {
		const message = codexMessageSchema.parse(input);
		const response = await fetcher(endpoint, {
			method: "POST",
			redirect: "error",
			signal: AbortSignal.timeout(15_000),
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${config.apiKey}`,
			},
			body: JSON.stringify(message),
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(
				`Inbox publication rejected (${response.status}). Check the destination and its active subscription; retry with the same idempotency key.`,
			);
		}
		return receiptSchema.parse(await response.json());
	};
}
export function registerPostMessageToCodexTool(
	server: McpServer,
	publish: CodexMessagePublisher,
) {
	server.registerTool(
		"post_message_to_codex",
		{
			description:
				"Send a message to one explicitly authorized Cyrus inbox subscribed by a dot or Cloud Work chat. Requires the destination shared by that user. Never broadcasts. Reuse the idempotency key on retry. Queued or webhook-received status does not mean the receiving agent has acted. Do not automatically echo received events or transfer operator ownership.",
			inputSchema: codexMessageSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		async (input) => {
			try {
				const receipt = receiptSchema.parse(await publish(input));
				return {
					content: [{ type: "text" as const, text: JSON.stringify(receipt) }],
				};
			} catch {
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: "Message publication failed. Check the authorized inbox and subscription; retry the same message with the same idempotency key. Delivery or agent execution is not confirmed.",
						},
					],
				};
			}
		},
	);
}
