import { createHmac, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { createLogger, type ILogger } from "cyrus-core";
import type { FastifyReply, FastifyRequest } from "fastify";
import type {
	PlaneAgentWebhookPayload,
	PlaneEventTransportConfig,
	PlaneEventTransportEvents,
} from "./types.js";

export declare interface PlaneEventTransport {
	on<K extends keyof PlaneEventTransportEvents>(
		event: K,
		listener: PlaneEventTransportEvents[K],
	): this;
	emit<K extends keyof PlaneEventTransportEvents>(
		event: K,
		...args: Parameters<PlaneEventTransportEvents[K]>
	): boolean;
}

/**
 * PlaneEventTransport - receives Plane app webhooks.
 *
 * - `POST /plane-webhook`: agent-run webhooks (`agent_run_create`,
 *   `agent_run_user_prompt`). The `X-Plane-Signature` header must be the
 *   HMAC-SHA256 hex digest of the raw body, keyed with the webhook secret.
 *   Plane retries a delivery that doesn't get a 2xx and marks a run stale when
 *   nothing comes back, so the request is answered at once and the work is
 *   done after the `event` is emitted.
 * - `GET /plane-oauth/callback`: where Plane redirects after the app is
 *   installed in a workspace, with `app_installation_id` in the query string.
 *
 * @see https://developers.plane.so/dev-tools/intro-webhooks
 */
export class PlaneEventTransport extends EventEmitter {
	private readonly logger: ILogger;

	constructor(
		private readonly config: PlaneEventTransportConfig,
		logger?: ILogger,
	) {
		super();
		this.logger = logger ?? createLogger({ component: "PlaneEventTransport" });
	}

	register(): void {
		const server = this.config.fastifyServer;

		server.post(
			"/plane-webhook",
			async (request: FastifyRequest, reply: FastifyReply) => {
				try {
					this.handleWebhook(request, reply);
				} catch (error) {
					const err = new Error("Plane webhook error", { cause: error });
					this.logger.error("Plane webhook error", err);
					this.emit("error", err);
					reply.code(500).send({ error: "Internal server error" });
				}
			},
		);

		server.get(
			"/plane-oauth/callback",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const query = (request.query ?? {}) as Record<string, string>;
				if (!query.app_installation_id) {
					reply
						.code(400)
						.type("text/plain")
						.send("Missing app_installation_id");
					return;
				}
				const message = this.config.onInstall
					? await this.config.onInstall(query)
					: `Installed. app_installation_id=${query.app_installation_id}`;
				reply.code(200).type("text/plain").send(message);
			},
		);

		this.logger.info(
			"Registered POST /plane-webhook and GET /plane-oauth/callback",
		);
	}

	private handleWebhook(request: FastifyRequest, reply: FastifyReply): void {
		const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody;
		const signature = request.headers["x-plane-signature"];

		if (
			!this.verifySignature(
				rawBody ?? JSON.stringify(request.body ?? {}),
				typeof signature === "string" ? signature : undefined,
			)
		) {
			reply.code(401).send({ error: "Invalid webhook signature" });
			return;
		}

		const payload = unwrapEnvelope(request.body);
		reply.code(200).send({ ok: true });

		if (!payload || !isAgentWebhook(payload)) {
			const { type, event, action } = (request.body ?? {}) as {
				type?: string;
				event?: string;
				action?: string;
			};
			this.logger.debug(`Ignoring Plane webhook ${event ?? type}/${action}`);
			return;
		}

		this.logger.info(
			`Received Plane ${payload.type}/${payload.action} (run ${payload.agent_run.id})`,
		);
		this.emit("event", payload);
	}

	/**
	 * Constant-time check of `X-Plane-Signature`. An empty secret is only
	 * accepted when the transport was built with one on purpose (local tests).
	 */
	private verifySignature(rawBody: string, signature?: string): boolean {
		if (!this.config.webhookSecret) {
			return true;
		}
		if (!signature) {
			return false;
		}
		const expected = createHmac("sha256", this.config.webhookSecret)
			.update(rawBody)
			.digest("hex");
		const a = Buffer.from(expected);
		const b = Buffer.from(signature.trim().toLowerCase());
		return a.length === b.length && timingSafeEqual(a, b);
	}
}

/**
 * Plane delivers app webhooks in its workspace-webhook envelope,
 * `{ event: "agent_run_create" | "agent_run_user_prompt", action, webhook_id,
 * workspace_id, data, activity }`, with the agent payload in `data`. The outer
 * `action` is "created" for prompts too, so only `data` is reliable. A bare
 * payload (as in Plane's docs) is accepted as is.
 */
function unwrapEnvelope(body: unknown): unknown {
	const envelope = body as { event?: unknown; data?: unknown } | undefined;
	if (
		typeof envelope?.event === "string" &&
		envelope.data &&
		typeof envelope.data === "object"
	) {
		return envelope.data;
	}
	return body;
}

function isAgentWebhook(payload: unknown): payload is PlaneAgentWebhookPayload {
	const p = payload as Partial<PlaneAgentWebhookPayload>;
	if (!p?.agent_run?.id) {
		return false;
	}
	return (
		(p.type === "agent_run" && p.action === "created") ||
		(p.type === "agent_run_activity" &&
			p.action === "prompted" &&
			"agent_run_activity" in p)
	);
}
