import type { FailureModesHttpClient } from "./log-failure-mode.js";

export interface FetchFailureModesClientOptions {
	/**
	 * Base URL of the cyrus-hosted control plane (e.g.
	 * `https://app.atcyrus.com`). Trailing slashes are tolerated.
	 */
	baseUrl: string;
	/**
	 * The `CYRUS_API_KEY` bearer token. Auth is reverse-looked-up server-side
	 * against both `cyrus_api_key` (self-host) and `droplet_api_key_encrypted`
	 * (cloud) columns.
	 */
	apiKey: string;
	/** Optional fetch override for testing. */
	fetchImpl?: typeof fetch;
	/** Optional timeout in ms; defaults to 15s. */
	timeoutMs?: number;
}

export function createFetchFailureModesClient(
	options: FetchFailureModesClientOptions,
): FailureModesHttpClient {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? 15_000;
	const url = `${options.baseUrl.replace(/\/+$/, "")}/api/failure-modes`;

	return {
		async postFailureMode(input) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const res = await fetchImpl(url, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${options.apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						sessionId: input.sessionId,
						category: input.category,
						recap: input.recap,
						userQuoteSnippet: input.userQuoteSnippet,
						agentFailureSnippet: input.agentFailureSnippet,
						...(input.sessionSource
							? { sessionSource: input.sessionSource }
							: {}),
						...(input.sessionLogsUrl
							? { sessionLogsUrl: input.sessionLogsUrl }
							: {}),
					}),
					signal: controller.signal,
				});

				const text = await res.text();
				let parsed: Record<string, unknown> | null = null;
				try {
					parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
				} catch {
					parsed = null;
				}

				if (!res.ok) {
					const errMsg =
						(parsed?.error as string | undefined) ??
						text.slice(0, 500) ??
						res.statusText;
					return { ok: false, status: res.status, error: errMsg };
				}

				const reportId =
					typeof parsed?.reportId === "number"
						? (parsed.reportId as number)
						: null;
				const action =
					parsed?.action === "created" || parsed?.action === "commented"
						? (parsed.action as "created" | "commented")
						: null;
				const linearIssueUrl =
					typeof parsed?.linearIssueUrl === "string"
						? (parsed.linearIssueUrl as string)
						: null;
				return { ok: true, reportId, action, linearIssueUrl };
			} catch (err) {
				return {
					ok: false,
					status: 0,
					error: err instanceof Error ? err.message : String(err),
				};
			} finally {
				clearTimeout(timer);
			}
		},
	};
}
