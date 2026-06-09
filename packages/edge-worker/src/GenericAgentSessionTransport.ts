import { timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { createLogger, type ILogger } from "cyrus-core";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
	GENERIC_AGENT_SESSION_ROUTE,
	type GenericAgentSessionTransportConfig,
	type GenericAgentSessionTransportEvents,
	type GenericAgentSessionWebhook,
	GenericAgentSessionWebhookSchema,
} from "./GenericAgentSessionTypes.js";

export declare interface GenericAgentSessionTransport {
	on<K extends keyof GenericAgentSessionTransportEvents>(
		event: K,
		listener: GenericAgentSessionTransportEvents[K],
	): this;
	emit<K extends keyof GenericAgentSessionTransportEvents>(
		event: K,
		...args: Parameters<GenericAgentSessionTransportEvents[K]>
	): boolean;
}

/**
 * Receives generic agent-session webhooks from arbitrary trusted surfaces.
 */
export class GenericAgentSessionTransport extends EventEmitter {
	private config: GenericAgentSessionTransportConfig;
	private logger: ILogger;
	private recentEventIds = new Map<string, number>();
	private static readonly DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

	constructor(config: GenericAgentSessionTransportConfig, logger?: ILogger) {
		super();
		this.config = config;
		this.logger =
			logger ?? createLogger({ component: "GenericAgentSessionTransport" });
	}

	register(): void {
		const routePath = this.config.routePath ?? GENERIC_AGENT_SESSION_ROUTE;
		this.config.fastifyServer.post(
			routePath,
			{
				config: {
					rawBody: true,
				},
			},
			async (request: FastifyRequest, reply: FastifyReply) => {
				try {
					await this.handleWebhook(request, reply);
				} catch (error) {
					const err = new Error("Generic agent-session webhook error");
					if (error instanceof Error) {
						err.cause = error;
					}
					this.logger.error("Generic agent-session webhook error", err);
					this.emit("error", err);
					reply.code(500).send({ error: "Internal server error" });
				}
			},
		);

		this.logger.info(`Registered POST ${routePath} endpoint`);
	}

	private async handleWebhook(
		request: FastifyRequest,
		reply: FastifyReply,
	): Promise<void> {
		if (!this.config.secret) {
			reply
				.code(503)
				.send({ error: "Generic agent-session webhook unavailable" });
			return;
		}

		if (!this.isAuthorized(request.headers.authorization)) {
			reply.code(401).send({ error: "Invalid authorization token" });
			return;
		}

		const parseResult = GenericAgentSessionWebhookSchema.safeParse(
			request.body,
		);
		if (!parseResult.success) {
			reply.code(400).send({
				error: "Invalid generic agent-session webhook payload",
				issues: parseResult.error.issues.map((issue) => ({
					path: issue.path.join("."),
					message: issue.message,
				})),
			});
			return;
		}

		const event = parseResult.data;
		const idempotencyKey = this.getIdempotencyKey(event);
		if (this.isDuplicateEvent(idempotencyKey)) {
			this.logger.debug(
				`Ignoring duplicate generic agent-session event ${idempotencyKey}`,
			);
			reply.code(200).send({ success: true, duplicate: true });
			return;
		}
		this.rememberEvent(idempotencyKey);

		this.logger.info(
			`Received generic agent-session webhook ${event.event.type} (${event.event.id})`,
		);
		this.emit("event", event);
		reply.code(200).send({ success: true });
	}

	private isAuthorized(authHeader: unknown): boolean {
		if (typeof authHeader !== "string") {
			return false;
		}

		const expectedAuth = `Bearer ${this.config.secret}`;
		const provided = Buffer.from(authHeader);
		const expected = Buffer.from(expectedAuth);
		if (provided.length !== expected.length) {
			return false;
		}

		return timingSafeEqual(provided, expected);
	}

	private getIdempotencyKey(event: GenericAgentSessionWebhook): string {
		return event.event.idempotencyKey ?? event.event.id;
	}

	private isDuplicateEvent(key: string): boolean {
		this.pruneRecentEventIds();
		return this.recentEventIds.has(key);
	}

	private rememberEvent(key: string): void {
		this.recentEventIds.set(key, Date.now());
	}

	private pruneRecentEventIds(): void {
		const now = Date.now();
		for (const [key, seenAt] of this.recentEventIds) {
			if (now - seenAt > GenericAgentSessionTransport.DEDUP_TTL_MS) {
				this.recentEventIds.delete(key);
			}
		}
	}
}
