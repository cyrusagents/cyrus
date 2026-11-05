import { createLogger, type ILogger } from "cyrus-core";
import type {
	PlaneAgentRun,
	PlaneAgentRunActivity,
	PlaneAttachment,
	PlaneComment,
	PlaneCreateActivityRequest,
	PlaneCredentials,
	PlaneLabel,
	PlaneLink,
	PlaneMember,
	PlaneProject,
	PlaneState,
	PlaneWorkItem,
} from "./types.js";

/** Refresh the bot token this long before Plane says it expires. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class PlaneApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly body: string,
	) {
		super(message);
		this.name = "PlaneApiError";
	}
}

type FetchLike = typeof fetch;

/**
 * Minimal REST client for one Plane workspace, authenticated as the app's bot.
 *
 * The bot token comes from the OAuth client-credentials grant
 * (`grant_type=client_credentials` + `app_installation_id`, Basic auth with
 * the app's client id and secret), the same flow as Plane's SDK `getBotToken`.
 * It is cached and refreshed before expiry, and once more on a 401.
 *
 * Paths follow Plane's v1 API (`/api/v1/workspaces/{slug}/...`).
 */
export class PlaneApiClient {
	private token: { value: string; expiresAt: number } | null = null;
	private tokenRequest: Promise<string> | null = null;
	private readonly logger: ILogger;
	private readonly fetchImpl: FetchLike;

	constructor(
		private readonly credentials: PlaneCredentials,
		options: { logger?: ILogger; fetch?: FetchLike } = {},
	) {
		this.logger =
			options.logger ?? createLogger({ component: "PlaneApiClient" });
		this.fetchImpl = options.fetch ?? fetch;
	}

	get workspaceSlug(): string {
		return this.credentials.workspaceSlug;
	}

	get baseUrl(): string {
		return this.credentials.baseUrl;
	}

	/** False until the app has been installed in the workspace. */
	get isInstalled(): boolean {
		return Boolean(this.credentials.appInstallationId);
	}

	/** A copy of the credentials in use, e.g. to start the Plane tools as the same bot. */
	getCredentials(): PlaneCredentials {
		return { ...this.credentials };
	}

	/** Use the installation from a new OAuth install redirect. */
	setAppInstallationId(appInstallationId: string): void {
		this.credentials.appInstallationId = appInstallationId;
		this.token = null;
	}

	// ----- agent runs -----

	getRun(runId: string): Promise<PlaneAgentRun> {
		return this.request("GET", `/runs/${runId}/`);
	}

	createActivity(
		runId: string,
		body: PlaneCreateActivityRequest,
	): Promise<PlaneAgentRunActivity> {
		return this.request("POST", `/runs/${runId}/activities/`, body);
	}

	// ----- work items -----

	async getWorkItem(
		projectId: string,
		workItemId: string,
	): Promise<PlaneWorkItem> {
		return normalizeWorkItem(
			await this.request(
				"GET",
				`/projects/${projectId}/work-items/${workItemId}/`,
			),
		);
	}

	/** By its human identifier, e.g. "WEB-12". */
	async getWorkItemByIdentifier(identifier: string): Promise<PlaneWorkItem> {
		return normalizeWorkItem(
			await this.request("GET", `/work-items/${identifier}/`),
		);
	}

	async updateWorkItem(
		projectId: string,
		workItemId: string,
		changes: Record<string, unknown>,
	): Promise<PlaneWorkItem> {
		return normalizeWorkItem(
			await this.request(
				"PATCH",
				`/projects/${projectId}/work-items/${workItemId}/`,
				changes,
			),
		);
	}

	async listComments(
		projectId: string,
		workItemId: string,
	): Promise<PlaneComment[]> {
		return results(
			await this.request(
				"GET",
				`/projects/${projectId}/work-items/${workItemId}/comments/`,
			),
		);
	}

	getComment(
		projectId: string,
		workItemId: string,
		commentId: string,
	): Promise<PlaneComment> {
		return this.request(
			"GET",
			`/projects/${projectId}/work-items/${workItemId}/comments/${commentId}/`,
		);
	}

	/** With `parentId`, a reply in that comment's thread. */
	createComment(
		projectId: string,
		workItemId: string,
		commentHtml: string,
		parentId?: string,
	): Promise<PlaneComment> {
		return this.request(
			"POST",
			`/projects/${projectId}/work-items/${workItemId}/comments/`,
			{ comment_html: commentHtml, ...(parentId && { parent: parentId }) },
		);
	}

	updateComment(
		projectId: string,
		workItemId: string,
		commentId: string,
		commentHtml: string,
	): Promise<PlaneComment> {
		return this.request(
			"PATCH",
			`/projects/${projectId}/work-items/${workItemId}/comments/${commentId}/`,
			{ comment_html: commentHtml },
		);
	}

	async deleteComment(
		projectId: string,
		workItemId: string,
		commentId: string,
	): Promise<void> {
		await this.request(
			"DELETE",
			`/projects/${projectId}/work-items/${workItemId}/comments/${commentId}/`,
		);
	}

	async listLinks(projectId: string, workItemId: string): Promise<PlaneLink[]> {
		return results(
			await this.request(
				"GET",
				`/projects/${projectId}/work-items/${workItemId}/links/`,
			),
		);
	}

	/** Add a link, or retitle it if the work item already has that URL. */
	async upsertLink(
		projectId: string,
		workItemId: string,
		url: string,
		title: string,
	): Promise<PlaneLink & { created: boolean }> {
		const base = `/projects/${projectId}/work-items/${workItemId}/links/`;
		const existing = (await this.listLinks(projectId, workItemId)).find(
			(l) => l.url === url,
		);
		if (existing) {
			const updated = await this.request<PlaneLink>(
				"PATCH",
				`${base}${existing.id}/`,
				{ title },
			);
			return { ...existing, ...updated, created: false };
		}
		const created = await this.request<PlaneLink>("POST", base, {
			url,
			title,
		});
		return { ...created, created: true };
	}

	async listAttachments(
		projectId: string,
		workItemId: string,
	): Promise<PlaneAttachment[]> {
		return results(
			await this.request(
				"GET",
				`/projects/${projectId}/work-items/${workItemId}/attachments/`,
			),
		);
	}

	/**
	 * An attachment's bytes. Plane answers with a redirect to a signed storage
	 * URL, which is fetched without the bot token (storage rejects a second
	 * credential).
	 */
	async downloadAttachment(
		projectId: string,
		workItemId: string,
		attachmentId: string,
	): Promise<Buffer> {
		const path = `/projects/${projectId}/work-items/${workItemId}/attachments/${attachmentId}/`;
		const url = `${this.credentials.baseUrl}/api/v1/workspaces/${this.credentials.workspaceSlug}${path}`;
		let response = await this.fetchImpl(url, {
			headers: { Authorization: `Bearer ${await this.getToken()}` },
			redirect: "manual",
		});
		if (response.status === 401) {
			this.token = null;
			response = await this.fetchImpl(url, {
				headers: { Authorization: `Bearer ${await this.getToken()}` },
				redirect: "manual",
			});
		}
		const location = response.headers.get("location");
		if (response.status < 300 || response.status >= 400 || !location) {
			throw new PlaneApiError(
				`Plane GET ${path} failed: ${response.status}`,
				response.status,
				(await response.text()).slice(0, 500),
			);
		}
		const file = await this.fetchImpl(
			new URL(location, this.credentials.baseUrl).toString(),
			{},
		);
		if (!file.ok) {
			throw new PlaneApiError(
				`Plane attachment download failed: ${file.status}`,
				file.status,
				(await file.text()).slice(0, 500),
			);
		}
		return Buffer.from(await file.arrayBuffer());
	}

	// ----- projects, states, labels, members -----

	getProject(projectId: string): Promise<PlaneProject> {
		return this.request("GET", `/projects/${projectId}/`);
	}

	async listProjects(): Promise<PlaneProject[]> {
		return results(await this.request("GET", "/projects/"));
	}

	async listStates(projectId: string): Promise<PlaneState[]> {
		return results(await this.request("GET", `/projects/${projectId}/states/`));
	}

	async listLabels(projectId: string): Promise<PlaneLabel[]> {
		return results(await this.request("GET", `/projects/${projectId}/labels/`));
	}

	async listMembers(): Promise<PlaneMember[]> {
		const raw = results<PlaneMember | { member: PlaneMember }>(
			await this.request("GET", "/members/"),
		);
		// Some Plane versions wrap each member as { member: {...}, role }.
		return raw.map(
			(m) => ("member" in m && m.member ? m.member : m) as PlaneMember,
		);
	}

	// ----- transport -----

	private async request<T>(
		method: string,
		path: string,
		body?: unknown,
		retried = false,
	): Promise<T> {
		const url = `${this.credentials.baseUrl}/api/v1/workspaces/${this.credentials.workspaceSlug}${path}`;
		const response = await this.fetchImpl(url, {
			method,
			headers: {
				Authorization: `Bearer ${await this.getToken()}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});

		if (response.status === 401 && !retried) {
			this.logger.info("Plane returned 401, refreshing the bot token");
			this.token = null;
			return this.request(method, path, body, true);
		}

		const text = await response.text();
		if (!response.ok) {
			throw new PlaneApiError(
				`Plane ${method} ${path} failed: ${response.status}`,
				response.status,
				text.slice(0, 500),
			);
		}
		return (text ? JSON.parse(text) : undefined) as T;
	}

	private async getToken(): Promise<string> {
		if (this.token && Date.now() < this.token.expiresAt) {
			return this.token.value;
		}
		// One in-flight token request at a time.
		this.tokenRequest ??= this.fetchBotToken().finally(() => {
			this.tokenRequest = null;
		});
		return this.tokenRequest;
	}

	private async fetchBotToken(): Promise<string> {
		const { baseUrl, clientId, clientSecret, appInstallationId } =
			this.credentials;
		const response = await this.fetchImpl(`${baseUrl}/auth/o/token/`, {
			method: "POST",
			headers: {
				Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
				"Content-Type": "application/x-www-form-urlencoded",
				"Cache-Control": "no-cache",
			},
			body: new URLSearchParams({
				grant_type: "client_credentials",
				app_installation_id: appInstallationId,
			}).toString(),
		});
		const text = await response.text();
		if (!response.ok) {
			throw new PlaneApiError(
				`Plane bot token request failed: ${response.status}`,
				response.status,
				text.slice(0, 500),
			);
		}
		const data = JSON.parse(text) as {
			access_token: string;
			expires_in?: number;
		};
		const lifetimeMs = (data.expires_in ?? 3600) * 1000;
		this.token = {
			value: data.access_token,
			expiresAt:
				Date.now() + Math.max(lifetimeMs - TOKEN_REFRESH_MARGIN_MS, 30_000),
		};
		return data.access_token;
	}
}

/**
 * Plane answers a work item's labels and assignees either as ids or, on some
 * versions, as full objects. Callers always get ids.
 */
function normalizeWorkItem(workItem: PlaneWorkItem): PlaneWorkItem {
	return {
		...workItem,
		labels: idsOf(workItem.labels),
		assignees: idsOf(workItem.assignees),
	};
}

function idsOf(values: unknown): string[] | undefined {
	if (!Array.isArray(values)) return undefined;
	return values
		.map((v) => (typeof v === "string" ? v : (v as { id?: string } | null)?.id))
		.filter((v): v is string => Boolean(v));
}

/** Plane list endpoints answer either a bare array or `{ results: [...] }`. */
function results<T>(data: T[] | { results?: T[] } | undefined): T[] {
	if (Array.isArray(data)) {
		return data;
	}
	return data?.results ?? [];
}
