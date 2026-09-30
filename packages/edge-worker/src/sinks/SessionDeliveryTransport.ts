import { measureLatency } from "../automations/Latency.js";
import { readBoundedJson } from "../customer-runtime/Gateway.js";
import {
	parseSessionDeliveryEnvelope,
	SESSION_DELIVERY_PATH,
	type SessionDeliveryAck,
	type SessionDeliveryEnvelope,
	verifySessionDeliveryAck,
} from "./session-delivery.js";

export interface SessionDeliveryTransport {
	deliver(
		envelope: SessionDeliveryEnvelope,
		signal: AbortSignal,
	): Promise<SessionDeliveryAck>;
}

/** Supervisor-only fixed-origin transport; never provided as model/MCP config. */
export class HttpSessionDeliveryTransport implements SessionDeliveryTransport {
	private readonly origin: string;
	private readonly workspaceId: string;
	constructor(
		origin: string,
		private readonly credentials: () => { workspaceId: string; apiKey: string },
	) {
		const url = new URL(origin);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash
		)
			throw new Error("Session delivery requires a fixed HTTPS origin");
		this.origin = url.origin;
		this.workspaceId = credentials().workspaceId;
		if (!this.workspaceId)
			throw new Error("Session delivery requires a paired workspace");
	}
	async deliver(
		input: SessionDeliveryEnvelope,
		signal: AbortSignal,
	): Promise<SessionDeliveryAck> {
		return measureLatency("session.delivery", () =>
			this.request(input, signal),
		);
	}
	private async request(
		input: SessionDeliveryEnvelope,
		signal: AbortSignal,
	): Promise<SessionDeliveryAck> {
		const envelope = parseSessionDeliveryEnvelope(input);
		const { workspaceId, apiKey } = this.credentials();
		if (!workspaceId || workspaceId !== this.workspaceId || !apiKey)
			throw new Error("Session delivery runtime is not paired");
		try {
			const response = await fetch(`${this.origin}${SESSION_DELIVERY_PATH}`, {
				method: "POST",
				redirect: "error",
				signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
					"X-Cyrus-Team-Id": workspaceId,
				},
				body: JSON.stringify(envelope),
			});
			if (!response.ok) {
				await response.body?.cancel();
				throw new Error("Session delivery rejected");
			}
			return verifySessionDeliveryAck(
				await readBoundedJson(response, 4096),
				envelope.item,
			);
		} catch {
			throw new Error(
				"Session delivery was not acknowledged; durable item retained",
			);
		}
	}
}
