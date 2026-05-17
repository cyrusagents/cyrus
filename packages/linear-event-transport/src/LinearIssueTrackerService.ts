/**
 * Linear-specific implementation of IIssueTrackerService.
 *
 * This adapter wraps the @linear/sdk LinearClient to provide a platform-agnostic
 * interface for issue tracking operations. It transforms Linear-specific types
 * to the platform-agnostic types defined in ../types.ts.
 *
 * @module issue-tracker/adapters/LinearIssueTrackerService
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LinearClient, Project, ProjectUpdate } from "@linear/sdk";
import * as lockfile from "proper-lockfile";

/**
 * Linear's documented grace period for refresh-token requests. Within this
 * window, replaying the exact same request returns the same tokens rather
 * than triggering refresh-token-reuse detection.
 *
 * https://linear.app/developers/oauth-2-0-authentication
 */
const LINEAR_REFRESH_GRACE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Window before access-token expiry at which we proactively refresh,
 * rather than waiting for a 401 to trigger reactive refresh. Predictable
 * scheduled refresh eliminates the thundering-herd / concurrent-401 path
 * that's the root cause of the rotation-race failure class.
 */
const PROACTIVE_REFRESH_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * OAuth configuration for automatic token refresh.
 */
export interface LinearOAuthConfig {
	clientId: string;
	clientSecret: string;
	refreshToken: string;
	/** Workspace ID for coalescing concurrent refreshes across instances */
	workspaceId: string;
	/** Called when tokens are refreshed - use to persist new tokens */
	onTokenRefresh?: (tokens: {
		accessToken: string;
		refreshToken: string;
	}) => void | Promise<void>;
	/**
	 * Path to the credentials file (typically config.json). When provided,
	 * the refresh call is wrapped in a per-host advisory file lock on this
	 * path so multiple processes sharing the same credentials can't race
	 * `/oauth/token` and end up with one party holding a dead refresh
	 * token. Without this, only in-process single-flight applies.
	 */
	credentialsFilePath?: string;
	/**
	 * Directory for refresh-request replay sidecars. When provided, the
	 * outbound refresh request is persisted to disk before being sent;
	 * after success it's deleted. On startup, sidecars younger than
	 * Linear's 30-minute grace window can be replayed to recover from a
	 * crash between sending and persisting. Sidecars are written to
	 * `<stateDir>/refresh-pending-<workspaceId>.json`.
	 */
	stateDir?: string;
	/**
	 * Optional callback that returns the latest persisted refresh token
	 * for this workspace. Called after acquiring the credentials-file lock
	 * so a peer's rotation is observed before we issue our own refresh
	 * request. If omitted, the in-memory map is the only source of truth.
	 */
	readPersistedRefreshToken?: () => Promise<string | null>;
}

import type {
	AgentActivityCreateInput,
	AgentActivityPayload,
	AgentEventTransportConfig,
	AgentSessionCreateOnCommentInput,
	AgentSessionCreateOnIssueInput,
	AttachmentCreateRequest,
	AttachmentCreateResponse,
	Comment,
	CommentCreateInput,
	CommentWithAttachments,
	Connection,
	FetchChildrenOptions,
	FileUploadRequest,
	FileUploadResponse,
	IAgentEventTransport,
	IIssueTrackerService,
	Issue,
	IssueUpdateInput,
	IssueWithChildren,
	Label,
	PaginationOptions,
	Team,
	User,
	WorkflowState,
} from "cyrus-core";
import { createLogger, type ILogger } from "cyrus-core";
import { LinearEventTransport } from "./LinearEventTransport.js";

/**
 * Linear implementation of IIssueTrackerService.
 *
 * This class wraps the Linear SDK's LinearClient and provides a platform-agnostic
 * interface for all issue tracking operations. It handles type conversions between
 * Linear-specific types and platform-agnostic types.
 *
 * @example
 * ```typescript
 * const linearClient = new LinearClient({ accessToken: 'your-token' });
 * const service = new LinearIssueTrackerService(linearClient);
 *
 * // Fetch an issue
 * const issue = await service.fetchIssue('TEAM-123');
 *
 * // Create a comment
 * const comment = await service.createComment(issue.id, {
 *   body: 'This is a comment'
 * });
 * ```
 */
export class LinearIssueTrackerService implements IIssueTrackerService {
	private readonly linearClient: LinearClient;
	private oauthConfig?: LinearOAuthConfig;
	private logger: ILogger;
	private refreshPromise: Promise<string> | null = null;

	/**
	 * Static map for workspace-level coalescing of concurrent token refreshes.
	 * Multiple instances sharing the same workspace will share a single refresh HTTP call.
	 */
	private static pendingRefreshes: Map<string, Promise<string>> = new Map();

	/**
	 * Static map storing the current refresh token per workspace.
	 * All instances sharing a workspace read/write from this shared state.
	 */
	private static workspaceRefreshTokens: Map<string, string> = new Map();

	/**
	 * Static map storing the absolute expiry timestamp (ms) of each
	 * workspace's current access token. Populated after every successful
	 * refresh. Used by {@link refreshIfExpiringSoon} for proactive refresh.
	 */
	private static workspaceTokenExpiry: Map<string, number> = new Map();

	/**
	 * Create a new LinearIssueTrackerService.
	 *
	 * @param linearClient - Configured LinearClient instance
	 * @param oauthConfig - Optional OAuth config for automatic token refresh on 401 errors
	 * @param logger - Optional logger instance
	 */
	constructor(
		linearClient: LinearClient,
		oauthConfig?: LinearOAuthConfig,
		logger?: ILogger,
	) {
		this.linearClient = linearClient;
		this.oauthConfig = oauthConfig;
		this.logger =
			logger ?? createLogger({ component: "LinearIssueTrackerService" });

		// Register initial refresh token in shared static map
		if (oauthConfig?.refreshToken) {
			LinearIssueTrackerService.workspaceRefreshTokens.set(
				oauthConfig.workspaceId,
				oauthConfig.refreshToken,
			);
		}

		// Only patch if oauthConfig is provided AND linearClient.client exists
		// (the .client property may not exist in test mocks)
		if (oauthConfig && linearClient.client) {
			const client = linearClient.client;
			const originalRequest = client.request.bind(client);

			// Track the current refresh promise - coalesces concurrent 401 errors.
			// Cleared when refresh fails or when setAccessToken() is called.

			client.request = async <Data, Variables extends Record<string, unknown>>(
				document: string,
				variables?: Variables,
				requestHeaders?: RequestInit["headers"],
				isRetry = false,
			): Promise<Data> => {
				try {
					return (await originalRequest(
						document,
						variables,
						requestHeaders,
					)) as Data;
				} catch (error) {
					// Don't retry if this is already a retry attempt (prevents infinite loops)
					// or if it's not a token expiration error
					if (isRetry || !this.isTokenExpiredError(error)) throw error;

					// Coalesce concurrent refresh attempts - everyone shares the same promise.
					if (!this.refreshPromise) {
						this.refreshPromise = this.doTokenRefresh().catch(
							(refreshError) => {
								// On failure, clear the promise so next 401 can retry fresh
								this.refreshPromise = null;
								this.logger.error("Token refresh failed:", refreshError);
								throw refreshError;
							},
						);
					}

					try {
						const newToken = await this.refreshPromise;
						// Clear cached promise so future token expirations trigger a fresh refresh.
						// Workspace-level coalescing via pendingRefreshes still deduplicates concurrent calls.
						this.refreshPromise = null;
						client.setHeader("Authorization", `Bearer ${newToken}`);

						// Retry the request with the new token (marked as retry to prevent loops)
						return (await (client.request as any)(
							document,
							variables,
							requestHeaders,
							true, // isRetry flag
						)) as Data;
					} catch (_refreshError) {
						// If refresh failed, throw the original 401 error for clarity
						throw error;
					}
				}
			};
		}
	}

	/**
	 * Performs the OAuth token refresh with workspace-level coalescing.
	 * Multiple concurrent refresh requests for the same workspace share a single HTTP call.
	 * @returns The new access token
	 */
	private async doTokenRefresh(): Promise<string> {
		if (!this.oauthConfig) {
			throw new Error("OAuth config not provided");
		}

		const { workspaceId } = this.oauthConfig;

		// Check if there's already a pending refresh for this workspace
		const pendingRefresh =
			LinearIssueTrackerService.pendingRefreshes.get(workspaceId);
		if (pendingRefresh) {
			this.logger.info(`Coalescing token refresh for workspace ${workspaceId}`);
			return pendingRefresh;
		}

		// Create the refresh promise and store it
		const refreshPromise = this.executeTokenRefresh();
		LinearIssueTrackerService.pendingRefreshes.set(workspaceId, refreshPromise);

		try {
			return await refreshPromise;
		} finally {
			// One of the key guarantees of finally — it runs regardless of how the try block exits (return, throw, or normal completion).
			LinearIssueTrackerService.pendingRefreshes.delete(workspaceId);
		}
	}

	/**
	 * Executes the actual OAuth token refresh HTTP request.
	 *
	 * Layered defenses against the refresh-token-rotation failure class:
	 *
	 * 1. **Per-host file lock** on the credentials file (if provided),
	 *    serializing concurrent refresh attempts from sibling processes
	 *    that share a config file. In-process callers are already
	 *    coalesced by `pendingRefreshes`.
	 * 2. **Disk re-read after lock acquisition** — if a peer already
	 *    rotated while we were queued, we adopt their new token instead
	 *    of issuing a now-stale request.
	 * 3. **Replay sidecar** persisted before the network call — if we
	 *    crash between Linear responding and the local persist step,
	 *    {@link replayPendingRefreshes} can re-send the same request
	 *    within Linear's 30-minute idempotency window and recover the
	 *    same new tokens deterministically.
	 * 4. **Terminal `invalid_grant` handling** — per RFC 9700 §4.14, an
	 *    auth server that detects refresh-token reuse revokes the entire
	 *    token family. Retrying is harmful; we log loudly and surface an
	 *    operator-actionable error pointing at re-auth.
	 *
	 * @internal
	 */
	private async executeTokenRefresh(): Promise<string> {
		const {
			workspaceId,
			credentialsFilePath,
			stateDir,
			readPersistedRefreshToken,
		} = this.oauthConfig!;

		const release = credentialsFilePath
			? await this.acquireCredentialsLock(credentialsFilePath).catch((err) => {
					// If lock acquisition fails we still proceed without it — the
					// failure mode of not having the lock is the same as today.
					this.logger.warn(
						`Could not acquire credentials lock for ${workspaceId}; proceeding without cross-process serialization: ${err instanceof Error ? err.message : String(err)}`,
					);
					return null;
				})
			: null;

		try {
			// After acquiring the lock, give a peer's rotation a chance to be
			// observed — if they already persisted a new refresh token, use it
			// instead of issuing a stale request that would burn the token.
			if (readPersistedRefreshToken) {
				try {
					const persisted = await readPersistedRefreshToken();
					if (persisted) {
						const inMemory =
							LinearIssueTrackerService.workspaceRefreshTokens.get(workspaceId);
						if (persisted !== inMemory) {
							this.logger.info(
								`Peer rotated token for workspace ${workspaceId} while we were queued; adopting persisted token`,
							);
							LinearIssueTrackerService.workspaceRefreshTokens.set(
								workspaceId,
								persisted,
							);
						}
					}
				} catch (err) {
					this.logger.warn(
						`Failed to re-read persisted refresh token for ${workspaceId}; continuing with in-memory token: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}

			return await this.performRefreshNetworkCall(stateDir);
		} finally {
			if (release) {
				try {
					await release();
				} catch (err) {
					this.logger.warn(
						`Failed to release credentials lock for ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		}
	}

	/**
	 * The actual HTTP refresh call, with replay-sidecar bookkeeping.
	 * @internal
	 */
	private async performRefreshNetworkCall(
		stateDir: string | undefined,
	): Promise<string> {
		const { clientId, clientSecret, workspaceId, onTokenRefresh } =
			this.oauthConfig!;

		const refreshToken =
			LinearIssueTrackerService.workspaceRefreshTokens.get(workspaceId);
		if (!refreshToken) {
			throw new Error(
				`No refresh token available for workspace ${workspaceId}`,
			);
		}

		this.logger.info(`Refreshing token for workspace ${workspaceId}...`);

		const params = new URLSearchParams({
			grant_type: "refresh_token",
			client_id: clientId,
			client_secret: clientSecret,
			refresh_token: refreshToken,
		});

		// Persist the outbound request to disk BEFORE sending. If we crash
		// between Linear receiving this request and our local persist step,
		// Linear's 30-minute idempotency window lets a future process replay
		// this exact request and recover the same new tokens.
		const sidecarPath = stateDir
			? LinearIssueTrackerService.sidecarPathFor(stateDir, workspaceId)
			: null;
		if (sidecarPath) {
			await LinearIssueTrackerService.writeReplaySidecar(sidecarPath, {
				workspaceId,
				clientId,
				clientSecret,
				refreshToken,
				sentAt: Date.now(),
			}).catch((err) => {
				// Sidecar failures don't block refresh — they just mean we lose
				// the replay safety net for this attempt.
				this.logger.warn(
					`Failed to write replay sidecar for ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
		}

		// https://linear.app/developers/oauth-2-0-authentication
		const response = await fetch("https://api.linear.app/oauth/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: params.toString(),
		});

		if (!response.ok) {
			// invalid_grant is terminal per RFC 9700 §4.14 — the auth server
			// has revoked the entire refresh-token family. Retrying compounds
			// the damage. Surface an operator-actionable error.
			let body: { error?: string; error_description?: string } = {};
			try {
				body = (await response.json()) as typeof body;
			} catch {
				// non-JSON error body — keep going with status alone
			}
			if (response.status === 400 && body.error === "invalid_grant") {
				// Best-effort sidecar cleanup — the request was definitively
				// rejected, replay won't help.
				if (sidecarPath) await unlink(sidecarPath).catch(() => {});
				this.logger.error(
					`Linear OAuth invalid_grant for workspace ${workspaceId} — the refresh token family has been revoked. Re-authentication required. Run: cyrus self-auth-linear --cyrus-home <agent home>`,
				);
				throw new Error(
					`Token refresh failed: 400 invalid_grant (terminal — re-auth required)`,
				);
			}
			// Non-terminal failures (5xx, 429, network) leave the sidecar in
			// place so a restart can replay within Linear's grace window.
			throw new Error(
				`Token refresh failed: ${response.status}${body.error ? ` ${body.error}` : ""}`,
			);
		}

		const data = (await response.json()) as {
			access_token: string;
			refresh_token: string;
			expires_in: number;
		};

		// Update shared static map for all instances sharing this workspace
		LinearIssueTrackerService.workspaceRefreshTokens.set(
			workspaceId,
			data.refresh_token,
		);

		// Track absolute expiry for proactive (windowed) refresh.
		LinearIssueTrackerService.workspaceTokenExpiry.set(
			workspaceId,
			Date.now() + data.expires_in * 1000,
		);

		// Notify caller so they can persist tokens to disk
		if (onTokenRefresh) {
			try {
				await onTokenRefresh({
					accessToken: data.access_token,
					refreshToken: data.refresh_token,
				});
			} catch (err) {
				this.logger.error("onTokenRefresh callback failed:", err);
			}
		}

		// Successful refresh + persist — sidecar is no longer useful for
		// replay. Best-effort delete.
		if (sidecarPath) {
			await unlink(sidecarPath).catch(() => {});
		}

		this.logger.info(
			`Token refreshed successfully for workspace ${workspaceId} (expires in ${data.expires_in}s)`,
		);
		return data.access_token;
	}

	/**
	 * Acquire an advisory file lock on the credentials file. Defaults to
	 * `proper-lockfile`'s lock-directory pattern (atomic via `mkdir`),
	 * which works on Mac and Linux without OS-specific code. Returns a
	 * `release` function the caller must invoke in `finally`.
	 */
	private async acquireCredentialsLock(
		credentialsFilePath: string,
	): Promise<() => Promise<void>> {
		return lockfile.lock(credentialsFilePath, {
			retries: { retries: 10, minTimeout: 100, maxTimeout: 1000 },
			// `proper-lockfile` considers a lock stale if its mtime hasn't been
			// refreshed in `stale` ms. 30s is plenty for an OAuth refresh that
			// normally completes in <2s; a process crashed mid-refresh stops
			// updating the lock and another can take it after this window.
			stale: 30 * 1000,
			realpath: false,
		});
	}

	/**
	 * Where to write the replay sidecar for a given workspace.
	 */
	private static sidecarPathFor(stateDir: string, workspaceId: string): string {
		// Sanitize workspaceId for filesystem safety — UUIDs are already
		// safe but defensive in case Linear ever changes the format.
		const safe = workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_");
		return join(stateDir, `refresh-pending-${safe}.json`);
	}

	/**
	 * Atomically write a replay sidecar (temp file + rename).
	 */
	private static async writeReplaySidecar(
		path: string,
		payload: {
			workspaceId: string;
			clientId: string;
			clientSecret: string;
			refreshToken: string;
			sentAt: number;
		},
	): Promise<void> {
		await mkdir(dirname(path), { recursive: true });
		const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
		await writeFile(tmp, JSON.stringify(payload), { mode: 0o600 });
		await rename(tmp, path);
	}

	/**
	 * Returns the absolute expiry timestamp (ms) for the current access
	 * token of the given workspace, or `undefined` if unknown. The expiry
	 * is populated only after a successful refresh in the current process
	 * lifetime; the initial access token loaded from disk has no known
	 * expiry until the first refresh happens.
	 */
	static getTokenExpiresAt(workspaceId: string): number | undefined {
		return LinearIssueTrackerService.workspaceTokenExpiry.get(workspaceId);
	}

	/**
	 * Trigger a refresh if this instance's access token is within
	 * `withinMs` of expiry. No-op if expiry is unknown or token is still
	 * comfortably valid. Used by external schedulers (e.g. the EdgeWorker
	 * token health monitor) to refresh proactively rather than waiting
	 * for a 401 to trigger reactive refresh.
	 *
	 * Goes through the same single-flight path as reactive refresh, so
	 * calling this concurrently with a 401-driven refresh coalesces to
	 * one HTTP call.
	 */
	async refreshIfExpiringSoon(
		withinMs: number = PROACTIVE_REFRESH_WINDOW_MS,
	): Promise<void> {
		const wsId = this.oauthConfig?.workspaceId;
		if (!wsId) return;
		const expiresAt = LinearIssueTrackerService.workspaceTokenExpiry.get(wsId);
		if (!expiresAt) return; // First-run state — let reactive refresh teach us
		const msUntilExpiry = expiresAt - Date.now();
		if (msUntilExpiry > withinMs) return;
		this.logger.info(
			`Access token for workspace ${wsId} expires in ${Math.round(msUntilExpiry / 1000)}s — proactively refreshing`,
		);
		const newToken = await this.doTokenRefresh();
		if (this.linearClient.client) {
			this.linearClient.client.setHeader("Authorization", `Bearer ${newToken}`);
		}
	}

	/**
	 * Scan a state directory for refresh-request replay sidecars left by
	 * a previous process that crashed mid-rotation. For each sidecar
	 * younger than Linear's 30-minute idempotency window, re-send the
	 * exact same `/oauth/token` request — Linear will return the same
	 * new tokens if it processed the original, or a fresh rotation if
	 * not. Either way the persisted state catches up with reality.
	 *
	 * Sidecars older than the grace window are deleted; their request
	 * payload is no longer replayable.
	 *
	 * The `onReplaySuccess` callback receives recovered tokens for each
	 * workspace so the caller can persist them via its normal path. The
	 * `onTerminalFailure` callback fires when replay returns
	 * `invalid_grant` — that workspace needs re-auth.
	 */
	static async replayPendingRefreshes(
		stateDir: string,
		options: {
			onReplaySuccess: (recovered: {
				workspaceId: string;
				accessToken: string;
				refreshToken: string;
				expiresIn: number;
			}) => Promise<void>;
			onTerminalFailure: (workspaceId: string) => Promise<void>;
			logger?: ILogger;
		},
	): Promise<void> {
		const log =
			options.logger ?? createLogger({ component: "LinearTokenReplay" });
		let entries: string[];
		try {
			const { readdir } = await import("node:fs/promises");
			entries = await readdir(stateDir);
		} catch {
			return; // No state dir, nothing to replay
		}
		const sidecars = entries.filter(
			(e) => e.startsWith("refresh-pending-") && e.endsWith(".json"),
		);
		if (sidecars.length === 0) return;

		log.info(
			`Found ${sidecars.length} pending refresh sidecar(s); attempting replay within Linear's 30-min grace window`,
		);

		for (const filename of sidecars) {
			const path = join(stateDir, filename);
			let payload: {
				workspaceId: string;
				clientId: string;
				clientSecret: string;
				refreshToken: string;
				sentAt: number;
			};
			try {
				payload = JSON.parse(await readFile(path, "utf-8"));
			} catch (err) {
				log.warn(
					`Could not parse sidecar ${filename}, deleting: ${err instanceof Error ? err.message : String(err)}`,
				);
				await unlink(path).catch(() => {});
				continue;
			}
			const ageMs = Date.now() - payload.sentAt;
			if (ageMs > LINEAR_REFRESH_GRACE_MS) {
				log.warn(
					`Sidecar for workspace ${payload.workspaceId} is ${Math.round(ageMs / 60_000)} min old (>30 min grace) — deleting; manual re-auth may be required`,
				);
				await unlink(path).catch(() => {});
				continue;
			}
			log.info(
				`Replaying refresh for workspace ${payload.workspaceId} (age ${Math.round(ageMs / 1000)}s)`,
			);
			try {
				const params = new URLSearchParams({
					grant_type: "refresh_token",
					client_id: payload.clientId,
					client_secret: payload.clientSecret,
					refresh_token: payload.refreshToken,
				});
				const response = await fetch("https://api.linear.app/oauth/token", {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: params.toString(),
				});
				if (!response.ok) {
					let body: { error?: string } = {};
					try {
						body = (await response.json()) as typeof body;
					} catch {
						// non-JSON
					}
					if (response.status === 400 && body.error === "invalid_grant") {
						log.error(
							`Replay for workspace ${payload.workspaceId} returned invalid_grant — re-auth required`,
						);
						await options.onTerminalFailure(payload.workspaceId);
						await unlink(path).catch(() => {});
						continue;
					}
					log.warn(
						`Replay for workspace ${payload.workspaceId} failed: ${response.status} — leaving sidecar in place for next attempt`,
					);
					continue;
				}
				const data = (await response.json()) as {
					access_token: string;
					refresh_token: string;
					expires_in: number;
				};
				LinearIssueTrackerService.workspaceRefreshTokens.set(
					payload.workspaceId,
					data.refresh_token,
				);
				LinearIssueTrackerService.workspaceTokenExpiry.set(
					payload.workspaceId,
					Date.now() + data.expires_in * 1000,
				);
				await options.onReplaySuccess({
					workspaceId: payload.workspaceId,
					accessToken: data.access_token,
					refreshToken: data.refresh_token,
					expiresIn: data.expires_in,
				});
				await unlink(path).catch(() => {});
				log.info(
					`Replay succeeded for workspace ${payload.workspaceId}; tokens recovered`,
				);
			} catch (err) {
				log.warn(
					`Replay for workspace ${payload.workspaceId} threw: ${err instanceof Error ? err.message : String(err)} — leaving sidecar in place`,
				);
			}
		}
	}

	/**
	 * Check if an error is a 401 token expiration error.
	 */
	private isTokenExpiredError(error: unknown): boolean {
		const err = error as { status?: number; response?: { status?: number } };
		return err?.status === 401 || err?.response?.status === 401;
	}

	/**
	 * Update the access token using setHeader on the underlying GraphQL client.
	 * This is more efficient than recreating the entire LinearClient.
	 * @param token - New access token
	 */
	setAccessToken(token: string): void {
		// Clear any cached refresh promise so subsequent 401s trigger a fresh refresh
		// rather than reusing a stale resolved promise with an old token.
		this.refreshPromise = null;
		// Guard for test mocks that may not have the .client property
		if (this.linearClient.client) {
			this.linearClient.client.setHeader("Authorization", `Bearer ${token}`);
		}
	}

	/**
	 * Get the underlying LinearClient instance.
	 * Useful when callers need the same client with its OAuth refresh interceptor.
	 */
	getClient(): LinearClient {
		return this.linearClient;
	}

	// ========================================================================
	// ISSUE OPERATIONS
	// ========================================================================

	/**
	 * Fetch a single issue by ID or identifier.
	 */
	async fetchIssue(idOrIdentifier: string): Promise<Issue> {
		return await this.linearClient.issue(idOrIdentifier);
	}

	/**
	 * Fetch child issues (sub-issues) for a parent issue.
	 */
	async fetchIssueChildren(
		issueId: string,
		options?: FetchChildrenOptions,
	): Promise<IssueWithChildren> {
		try {
			const parentIssue = await this.linearClient.issue(issueId);

			// Build filter based on options
			const filter: Record<string, unknown> = {};

			if (options?.includeCompleted === false) {
				filter.state = { type: { neq: "completed" } };
			}

			if (options?.includeArchived === false) {
				filter.archivedAt = { null: true };
			}

			// Merge with additional filters
			if (options?.filter) {
				Object.assign(filter, options.filter);
			}

			// Fetch children with filter
			const childrenConnection = await parentIssue.children({
				first: options?.limit ?? 50,
				filter,
			});

			const children = childrenConnection.nodes ?? [];

			// Return issue with children array directly from Linear SDK
			// Cast to IssueWithChildren since Linear SDK types are compatible
			return Object.assign(parentIssue, {
				children,
				childCount: children.length,
			}) as IssueWithChildren;
		} catch (error) {
			const err = new Error(
				`Failed to fetch children for issue ${issueId}: ${error instanceof Error ? error.message : String(error)}`,
			);
			if (error instanceof Error) {
				err.cause = error;
			}
			throw err;
		}
	}

	/**
	 * Update an issue's properties.
	 */
	async updateIssue(
		issueId: string,
		updates: IssueUpdateInput,
	): Promise<Issue> {
		try {
			const updatePayload = await this.linearClient.updateIssue(
				issueId,
				updates,
			);

			if (!updatePayload.success) {
				throw new Error("Linear API returned success=false");
			}

			// Fetch the updated issue
			const updatedIssue = await updatePayload.issue;
			if (!updatedIssue) {
				throw new Error("Updated issue not returned from Linear API");
			}

			return updatedIssue;
		} catch (error) {
			const err = new Error(
				`Failed to update issue ${issueId}: ${error instanceof Error ? error.message : String(error)}`,
			);
			if (error instanceof Error) {
				err.cause = error;
			}
			throw err;
		}
	}

	/**
	 * Fetch attachments for an issue.
	 *
	 * Uses the Linear SDK to fetch native attachments (typically external links
	 * to Sentry errors, Datadog reports, etc.)
	 */
	async fetchIssueAttachments(
		issueId: string,
	): Promise<Array<{ title: string; url: string }>> {
		try {
			const issue = await this.linearClient.issue(issueId);

			if (!issue) {
				throw new Error(`Issue ${issueId} not found`);
			}

			// Call the Linear SDK's attachments() method which returns a Connection
			const attachmentsConnection = await issue.attachments();

			// Extract title and url from each attachment node
			return attachmentsConnection.nodes.map((attachment) => ({
				title: attachment.title || "Untitled attachment",
				url: attachment.url,
			}));
		} catch (error) {
			const err = new Error(
				`Failed to fetch attachments for issue ${issueId}: ${error instanceof Error ? error.message : String(error)}`,
			);
			if (error instanceof Error) {
				err.cause = error;
			}
			throw err;
		}
	}

	// ========================================================================
	// COMMENT OPERATIONS
	// ========================================================================

	/**
	 * Fetch comments for an issue with optional pagination.
	 */
	async fetchComments(
		issueId: string,
		options?: PaginationOptions,
	): Promise<Connection<Comment>> {
		try {
			const issue = await this.linearClient.issue(issueId);
			const commentsConnection = await issue.comments({
				first: options?.first ?? 50,
				after: options?.after,
				before: options?.before,
			});

			return {
				nodes: commentsConnection.nodes ?? [],
				pageInfo: commentsConnection.pageInfo
					? {
							hasNextPage: commentsConnection.pageInfo.hasNextPage,
							hasPreviousPage: commentsConnection.pageInfo.hasPreviousPage,
							startCursor: commentsConnection.pageInfo.startCursor,
							endCursor: commentsConnection.pageInfo.endCursor,
						}
					: undefined,
			};
		} catch (error) {
			const err = new Error(
				`Failed to fetch comments for issue ${issueId}: ${error instanceof Error ? error.message : String(error)}`,
			);
			if (error instanceof Error) {
				err.cause = error;
			}
			throw err;
		}
	}

	/**
	 * Fetch a single comment by ID.
	 */
	async fetchComment(commentId: string): Promise<Comment> {
		return await this.linearClient.comment({ id: commentId });
	}

	/**
	 * Fetch a comment with attachments.
	 *
	 * @param commentId - Comment ID to fetch
	 * @returns Promise resolving to comment with attachments
	 * @throws Error if comment not found or request fails
	 *
	 * @remarks
	 * **LIMITATION**: This method currently returns an empty `attachments` array
	 * because Linear's GraphQL API does not expose comment attachment metadata
	 * through their SDK or documented API endpoints.
	 *
	 * This is expected behavior, not a bug. Issue attachments (via `fetchIssueAttachments`)
	 * work correctly - only comment attachments are unavailable from the Linear API.
	 *
	 * If you need comment attachments, consider:
	 * - Using issue attachments instead (`fetchIssueAttachments`)
	 * - Parsing attachment URLs from comment body markdown
	 * - Waiting for Linear to expose this data in their API
	 *
	 * Implementation detail: The returned comment object is a Linear SDK Comment
	 * with an empty `attachments` array property added.
	 */
	async fetchCommentWithAttachments(
		commentId: string,
	): Promise<CommentWithAttachments> {
		try {
			// Fetch the comment using the Linear SDK
			const comment = await this.fetchComment(commentId);

			// Return comment with empty attachments array (Linear API doesn't expose comment attachments)
			// Cast to CommentWithAttachments since Linear SDK types are compatible
			return Object.assign(comment, {
				attachments: [],
			}) as CommentWithAttachments;
		} catch (error) {
			const err = new Error(
				`Failed to fetch comment with attachments ${commentId}: ${error instanceof Error ? error.message : String(error)}`,
			);
			if (error instanceof Error) {
				err.cause = error;
			}
			throw err;
		}
	}

	/**
	 * Create a comment on an issue.
	 */
	async createComment(
		issueId: string,
		input: CommentCreateInput,
	): Promise<Comment> {
		try {
			// Build the comment body, optionally appending attachment URLs
			let finalBody = input.body;

			// If attachment URLs are provided, append them to the comment body as markdown
			if (input.attachmentUrls && input.attachmentUrls.length > 0) {
				const attachmentMarkdown = input.attachmentUrls
					.map((url) => {
						// Detect if the URL is an image based on file extension
						// Matches common image extensions followed by query params (?), fragments (#), or end of string ($)
						// Examples: image.png, image.png?v=123, image.png#section, image.png?w=500&h=300
						const isImage = /\.(png|jpg|jpeg|gif|svg|webp|bmp)(\?|#|$)/i.test(
							url,
						);
						if (isImage) {
							// Embed as markdown image
							return `![attachment](${url})`;
						}
						// Otherwise, embed as markdown link
						return `[attachment](${url})`;
					})
					.join("\n");

				// Append attachments to the body with a separator if body is not empty
				finalBody = input.body
					? `${input.body}\n\n${attachmentMarkdown}`
					: attachmentMarkdown;
			}

			const createPayload = await this.linearClient.createComment({
				issueId,
				body: finalBody,
				parentId: input.parentId,
			});

			if (!createPayload.success) {
				throw new Error("Linear API returned success=false");
			}

			const createdComment = await createPayload.comment;
			if (!createdComment) {
				throw new Error("Created comment not returned from Linear API");
			}

			return createdComment;
		} catch (error) {
			const err = new Error(
				`Failed to create comment on issue ${issueId}: ${error instanceof Error ? error.message : String(error)}`,
			);
			if (error instanceof Error) {
				err.cause = error;
			}
			throw err;
		}
	}

	// ========================================================================
	// TEAM OPERATIONS
	// ========================================================================

	/**
	 * Fetch all teams in the workspace/organization.
	 */
	async fetchTeams(options?: PaginationOptions): Promise<Connection<Team>> {
		try {
			const teamsConnection = await this.linearClient.teams({
				first: options?.first ?? 50,
				after: options?.after,
				before: options?.before,
			});

			return {
				nodes: teamsConnection.nodes ?? [],
				pageInfo: teamsConnection.pageInfo
					? {
							hasNextPage: teamsConnection.pageInfo.hasNextPage,
							hasPreviousPage: teamsConnection.pageInfo.hasPreviousPage,
							startCursor: teamsConnection.pageInfo.startCursor,
							endCursor: teamsConnection.pageInfo.endCursor,
						}
					: undefined,
			};
		} catch (error) {
			const err = new Error(
				`Failed to fetch teams: ${error instanceof Error ? error.message : String(error)}`,
			);
			if (error instanceof Error) {
				err.cause = error;
			}
			throw err;
		}
	}

	/**
	 * Fetch a single team by ID or key.
	 */
	async fetchTeam(idOrKey: string): Promise<Team> {
		return await this.linearClient.team(idOrKey);
	}

	// ========================================================================
	// LABEL OPERATIONS
	// ========================================================================

	/**
	 * Fetch all issue labels in the workspace/organization.
	 */
	async fetchLabels(options?: PaginationOptions): Promise<Connection<Label>> {
		try {
			const labelsConnection = await this.linearClient.issueLabels({
				first: options?.first ?? 50,
				after: options?.after,
				before: options?.before,
			});

			return {
				nodes: labelsConnection.nodes ?? [],
				pageInfo: labelsConnection.pageInfo
					? {
							hasNextPage: labelsConnection.pageInfo.hasNextPage,
							hasPreviousPage: labelsConnection.pageInfo.hasPreviousPage,
							startCursor: labelsConnection.pageInfo.startCursor,
							endCursor: labelsConnection.pageInfo.endCursor,
						}
					: undefined,
			};
		} catch (error) {
			const err = new Error(
				`Failed to fetch labels: ${error instanceof Error ? error.message : String(error)}`,
			);
			if (error instanceof Error) {
				err.cause = error;
			}
			throw err;
		}
	}

	/**
	 * Fetch a single label by ID or name.
	 */
	async fetchLabel(idOrName: string): Promise<Label> {
		return await this.linearClient.issueLabel(idOrName);
	}

	/**
	 * Fetch label names for a specific issue.
	 */
	async getIssueLabels(issueId: string): Promise<string[]> {
		try {
			const issue = await this.linearClient.issue(issueId);
			const labels = await issue.labels();
			return labels.nodes.map((label) => label.name);
		} catch (error) {
			const err = new Error(
				`Failed to fetch issue labels for ${issueId}: ${error instanceof Error ? error.message : String(error)}`,
			);
			if (error instanceof Error) {
				err.cause = error;
			}
			throw err;
		}
	}

	// ========================================================================
	// WORKFLOW STATE OPERATIONS
	// ========================================================================

	/**
	 * Fetch workflow states for a team.
	 */
	async fetchWorkflowStates(
		teamId: string,
		options?: PaginationOptions,
	): Promise<Connection<WorkflowState>> {
		try {
			const team = await this.linearClient.team(teamId);
			const statesConnection = await team.states({
				first: options?.first ?? 50,
				after: options?.after,
				before: options?.before,
			});

			return {
				nodes: statesConnection.nodes ?? [],
				pageInfo: statesConnection.pageInfo
					? {
							hasNextPage: statesConnection.pageInfo.hasNextPage,
							hasPreviousPage: statesConnection.pageInfo.hasPreviousPage,
							startCursor: statesConnection.pageInfo.startCursor,
							endCursor: statesConnection.pageInfo.endCursor,
						}
					: undefined,
			};
		} catch (error) {
			const err = new Error(
				`Failed to fetch workflow states for team ${teamId}: ${error instanceof Error ? error.message : String(error)}`,
			);
			if (error instanceof Error) {
				err.cause = error;
			}
			throw err;
		}
	}

	/**
	 * Fetch a single workflow state by ID.
	 */
	async fetchWorkflowState(stateId: string): Promise<WorkflowState> {
		return await this.linearClient.workflowState(stateId);
	}

	// ========================================================================
	// USER OPERATIONS
	// ========================================================================

	/**
	 * Fetch a user by ID.
	 */
	async fetchUser(userId: string): Promise<User> {
		return await this.linearClient.user(userId);
	}

	/**
	 * Fetch the current authenticated user.
	 */
	async fetchCurrentUser(): Promise<User> {
		return await this.linearClient.viewer;
	}

	// ========================================================================
	// PROJECT OPERATIONS
	// ========================================================================

	/**
	 * Fetch a single project by ID.
	 *
	 * Direct passthrough to the Linear SDK. Used to load project context
	 * (description, name, recent updates) when an agent is @-mentioned in a
	 * Project Update, and to back-fill the project description cache on a
	 * cache miss.
	 */
	async fetchProject(projectId: string): Promise<Project> {
		return await this.linearClient.project(projectId);
	}

	/**
	 * Post a new Project Update to a project.
	 *
	 * Project Updates have no comment thread of their own — a "reply" to an
	 * Update is itself a new Update on the same project. This is how agents
	 * respond to an @-mention inside a Project Update.
	 */
	async createProjectUpdate(
		projectId: string,
		body: string,
	): Promise<ProjectUpdate> {
		const payload = await this.linearClient.createProjectUpdate({
			projectId,
			body,
		});

		if (!payload.success) {
			throw new Error(
				"Linear API returned success=false for projectUpdateCreate",
			);
		}

		const created = await payload.projectUpdate;
		if (!created) {
			throw new Error("Created project update not returned from Linear API");
		}

		return created;
	}

	// ========================================================================
	// AGENT SESSION OPERATIONS
	// ========================================================================

	/**
	 * Create an agent session on an issue.
	 * Uses native SDK method - direct passthrough to Linear SDK.
	 */
	createAgentSessionOnIssue(input: AgentSessionCreateOnIssueInput) {
		return this.linearClient.agentSessionCreateOnIssue(input);
	}

	/**
	 * Create an agent session on a comment thread.
	 * Uses native SDK method - direct passthrough to Linear SDK.
	 */
	createAgentSessionOnComment(input: AgentSessionCreateOnCommentInput) {
		return this.linearClient.agentSessionCreateOnComment(input);
	}

	/**
	 * Fetch an agent session by ID.
	 * Uses native SDK method - direct passthrough to Linear SDK.
	 */
	fetchAgentSession(sessionId: string) {
		return this.linearClient.agentSession(sessionId);
	}

	/**
	 * Emit a stop signal webhook event.
	 * No-op for Linear - stop signals come from Linear webhooks, not from us.
	 */
	async emitStopSignalEvent(_sessionId: string): Promise<void> {
		// No-op for Linear implementation - stop signals are handled via Linear webhooks
	}

	// ========================================================================
	// AGENT ACTIVITY OPERATIONS
	// ========================================================================

	/**
	 * Post an agent activity to an agent session.
	 * Signature matches Linear SDK's createAgentActivity exactly.
	 */
	async createAgentActivity(
		input: AgentActivityCreateInput,
	): Promise<AgentActivityPayload> {
		return await this.linearClient.createAgentActivity(input);
	}

	// ========================================================================
	// FILE OPERATIONS
	// ========================================================================

	/**
	 * Request a file upload URL from the platform.
	 */
	async requestFileUpload(
		request: FileUploadRequest,
	): Promise<FileUploadResponse> {
		try {
			const uploadPayload = await this.linearClient.fileUpload(
				request.contentType,
				request.filename,
				request.size,
				{
					makePublic: request.makePublic ?? false,
				},
			);

			if (!uploadPayload.success) {
				throw new Error("Linear API returned success=false");
			}

			// Access the upload file result
			const uploadFile = await uploadPayload.uploadFile;
			if (!uploadFile) {
				throw new Error("Upload file not returned from Linear API");
			}

			// Convert headers array to record
			const headersRecord: Record<string, string> = {};
			if (uploadFile.headers) {
				for (const header of uploadFile.headers) {
					if (header.key && header.value) {
						headersRecord[header.key] = header.value;
					}
				}
			}

			return {
				uploadUrl: uploadFile.uploadUrl ?? "",
				headers: headersRecord,
				assetUrl: uploadFile.assetUrl ?? "",
			};
		} catch (error) {
			const err = new Error(
				`Failed to request file upload for ${request.filename}: ${error instanceof Error ? error.message : String(error)}`,
			);
			if (error instanceof Error) {
				err.cause = error;
			}
			throw err;
		}
	}

	/**
	 * Create an attachment on an issue.
	 *
	 * Links a resource URL (typically the `assetUrl` of a file uploaded via
	 * {@link requestFileUpload} + PUT) to an issue. Linear de-duplicates on
	 * `url`, so re-attaching the same asset updates rather than duplicates.
	 */
	async createAttachment(
		request: AttachmentCreateRequest,
	): Promise<AttachmentCreateResponse> {
		try {
			const payload = await this.linearClient.createAttachment({
				issueId: request.issueId,
				title: request.title,
				url: request.url,
				subtitle: request.subtitle,
			});

			if (!payload.success) {
				throw new Error("Linear API returned success=false");
			}

			const attachment = await payload.attachment;
			if (!attachment) {
				throw new Error("Created attachment not returned from Linear API");
			}

			return { success: true, attachmentId: attachment.id };
		} catch (error) {
			const err = new Error(
				`Failed to create attachment "${request.title}" on issue ${request.issueId}: ${error instanceof Error ? error.message : String(error)}`,
			);
			if (error instanceof Error) {
				err.cause = error;
			}
			throw err;
		}
	}

	// ========================================================================
	// PLATFORM METADATA
	// ========================================================================

	/**
	 * Get the platform type identifier.
	 */
	getPlatformType(): string {
		return "linear";
	}

	/**
	 * Get the platform's API version or other metadata.
	 */
	getPlatformMetadata(): Record<string, unknown> {
		return {
			platform: "linear",
			sdkVersion: "unknown", // LinearClient doesn't expose version
			apiVersion: "graphql",
		};
	}

	// ========================================================================
	// EVENT TRANSPORT
	// ========================================================================

	/**
	 * Create an event transport for receiving Linear webhook events.
	 *
	 * @param config - Transport configuration
	 * @returns Linear event transport implementation
	 */
	createEventTransport(
		config: AgentEventTransportConfig,
	): IAgentEventTransport {
		// Type narrow to Linear config
		if (config.platform !== "linear") {
			throw new Error(
				`Invalid platform "${config.platform}" for LinearIssueTrackerService. Expected "linear".`,
			);
		}

		// Import from same package - no require() needed
		return new LinearEventTransport(config);
	}
}
