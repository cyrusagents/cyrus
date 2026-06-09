import type { FastifyInstance } from "fastify";
import { z } from "zod";

export const GENERIC_AGENT_SESSION_ROUTE = "/agent-session-webhook";

const JsonObjectSchema = z.record(z.string(), z.unknown());

export const GenericAgentSessionEventTypeSchema = z.enum([
	"agent_session.created",
	"agent_session.prompted",
	"agent_session.stopped",
]);

export const GenericAgentSessionWebhookSchema = z
	.object({
		version: z.literal(1),
		event: z.object({
			id: z.string().min(1),
			type: GenericAgentSessionEventTypeSchema,
			createdAt: z.string().optional(),
			idempotencyKey: z.string().optional(),
		}),
		session: z.object({
			id: z.string().min(1),
			bindingKey: z.string().min(1).optional(),
			title: z.string().optional(),
		}),
		surface: z.object({
			type: z.string().min(1),
			id: z.string().optional(),
			threadId: z.string().optional(),
			url: z.string().url().optional(),
			metadata: JsonObjectSchema.optional(),
		}),
		actor: z
			.object({
				id: z.string().optional(),
				name: z.string().optional(),
				email: z.string().email().optional(),
				url: z.string().url().optional(),
			})
			.optional(),
		message: z
			.object({
				id: z.string().optional(),
				body: z.string().optional(),
				createdAt: z.string().optional(),
				metadata: JsonObjectSchema.optional(),
			})
			.optional(),
		context: z
			.object({
				messages: z
					.array(
						z.object({
							id: z.string().optional(),
							author: z.string().optional(),
							body: z.string().optional(),
							createdAt: z.string().optional(),
						}),
					)
					.optional(),
			})
			.optional(),
		response: z
			.object({
				replyCallbackUrl: z.string().url().optional(),
				activityCallbackUrl: z.string().url().optional(),
			})
			.optional(),
		metadata: JsonObjectSchema.optional(),
	})
	.superRefine((payload, ctx) => {
		if (
			payload.event.type !== "agent_session.stopped" &&
			!payload.message?.body?.trim()
		) {
			ctx.addIssue({
				code: "custom",
				path: ["message", "body"],
				message: "message.body is required for created and prompted events",
			});
		}
	});

export type GenericAgentSessionWebhook = z.infer<
	typeof GenericAgentSessionWebhookSchema
>;
export type GenericAgentSessionEventType = z.infer<
	typeof GenericAgentSessionEventTypeSchema
>;

export interface GenericAgentSessionTransportConfig {
	/** Fastify server instance to mount routes on */
	fastifyServer: FastifyInstance;
	/** Bearer token used to authenticate webhook requests */
	secret: string;
	/** Optional override for tests or future versioned routes */
	routePath?: string;
}

export interface GenericAgentSessionTransportEvents {
	/** Emitted when a generic agent-session webhook is received and verified */
	event: (event: GenericAgentSessionWebhook) => void;
	/** Emitted when an error occurs */
	error: (error: Error) => void;
}
