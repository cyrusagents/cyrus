import { readBoundedJson } from "../utils/readBoundedJson.js";
import { AutomationDiagnosticError } from "./Diagnostics.js";
import type { SupervisorTiming } from "./HostedTiming.js";
import { measureLatency } from "./Latency.js";

export type AutomationEndpoint =
	| "authorize"
	| "progress"
	| "result"
	| "interrupt";
export interface AutomationGateway {
	call(
		endpoint: AutomationEndpoint,
		body: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}

/** Existing paired-runtime authentication; never exposed to model/tool arguments. */
export class AutomationHttpGateway implements AutomationGateway {
	private readonly origin: string;
	constructor(
		origin: string,
		private readonly credentials: () => { apiKey: string; workspaceId: string },
		private readonly sessionDelivery = false,
		private readonly engineering: () => boolean = () => false,
	) {
		const url = new URL(origin);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash
		) {
			throw new Error("Automation authority requires a fixed HTTPS origin");
		}
		this.origin = url.origin;
	}
	async call(
		endpoint: AutomationEndpoint,
		body: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		return measureLatency(
			endpoint === "authorize"
				? body.phase === "admit"
					? "authorize.admit"
					: "authorize.renew"
				: endpoint,
			(timing) => this.request(endpoint, body, signal, timing),
		);
	}
	private async request(
		endpoint: AutomationEndpoint,
		body: Record<string, unknown>,
		signal: AbortSignal,
		timing?: SupervisorTiming,
	): Promise<unknown> {
		const authorizePhase =
			endpoint === "authorize" &&
			(body.phase === "admit" || body.phase === "renew")
				? ({ authorizePhase: body.phase } as const)
				: {};
		const { apiKey, workspaceId } = this.credentials();
		if (!apiKey || !workspaceId) throw new Error("Runtime is not paired");
		const response = await fetch(
			`${this.origin}/api/automations/v1/${endpoint}`,
			{
				method: "POST",
				redirect: "error",
				signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
				headers: {
					"Content-Type": "application/json",
					...timing?.headers,
					...(endpoint === "authorize"
						? {
								"X-Cyrus-Customer-Read-Set": "1",
								"X-Cyrus-Slack-Channel-Read": "1",
								"X-Cyrus-Mcp-Session-Renewal": "1",
								"X-Cyrus-Owner-Interruption": "1",
							}
						: {}),
					Authorization: `Bearer ${apiKey}`,
					"X-Cyrus-Team-Id": workspaceId,
					...(endpoint === "authorize" && this.sessionDelivery
						? {
								"X-Cyrus-Session-Delivery": "1",
								"X-Cyrus-Native-Context": "1",
								"X-Cyrus-Customer-Sources": "1",
								"X-Cyrus-Slack-Messages": "1",
								"X-Cyrus-Session-Delivery-Authority": "1",
								"X-Cyrus-Lifecycle-Authority": "1",
								"X-Cyrus-Context-Read-Authority": "1",
								"X-Cyrus-Delegation": "1",
								"X-Cyrus-Session-Execution-Timing": "1",
							}
						: {}),
					...(endpoint === "authorize" &&
					this.sessionDelivery &&
					this.engineering()
						? { "X-Cyrus-Engineering": "1" }
						: {}),
				},
				body: JSON.stringify({ ...body, contractVersion: 1 }),
			},
		).catch(() => {
			throw new AutomationDiagnosticError({
				phase: endpoint,
				...authorizePhase,
				code: "transport_failed",
			});
		});
		timing?.read(response);
		if (!response.ok) {
			await response.body?.cancel();
			throw new AutomationDiagnosticError(
				{
					phase: endpoint,
					...authorizePhase,
					code: "http_denied",
					httpStatus: response.status,
				},
				`Automation authority denied request (${response.status})`,
			);
		}
		return readBoundedJson(response, 2_000_000).catch(() => {
			throw new AutomationDiagnosticError({
				phase: endpoint,
				...authorizePhase,
				code: "response_invalid",
			});
		});
	}
}
