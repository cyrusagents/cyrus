import type { LinearClient } from "@linear/sdk";
import { createLogger, type ILogger } from "cyrus-core";
import type { LinearIssueTrackerService } from "cyrus-linear-event-transport";

/**
 * Source of LinearClient instances keyed by Linear workspace ID. Returns
 * the wrapped clients that already carry the OAuth-refresh interceptor,
 * so a health check that succeeds confirms both that the access token
 * still works AND that a refresh would succeed if needed.
 */
export type GetLinearClients = () => Map<string, LinearClient>;

/**
 * Source of LinearIssueTrackerService instances keyed by workspace ID,
 * used to drive proactive (windowed) refresh — refreshing tokens shortly
 * before they expire rather than waiting for a 401 to trigger reactive
 * refresh. Predictable scheduled refresh eliminates the concurrent-401
 * thundering-herd path that's the root cause of rotation-race failures.
 */
export type GetLinearTrackers = () => Map<string, LinearIssueTrackerService>;

export interface TokenHealthMonitorOptions {
	getLinearClients: GetLinearClients;
	/** Optional — when provided, enables proactive windowed refresh. */
	getLinearTrackers?: GetLinearTrackers;
	/** How often to run the check, in ms. Default 5 minutes. */
	intervalMs?: number;
	/**
	 * Refresh proactively when access token has less than this many ms
	 * left before expiry. Default 5 minutes. Must be larger than
	 * `intervalMs` so a token doesn't slip through between checks.
	 */
	proactiveRefreshWindowMs?: number;
	/** Initial delay before the first check, in ms. Default 30 seconds. */
	initialDelayMs?: number;
	logger?: ILogger;
}

/**
 * Periodically verifies that every workspace's Linear OAuth credentials
 * still work, by making a lightweight `viewer` query through the wrapped
 * `LinearClient`. The wrapping interceptor triggers a refresh on 401, so
 * a successful response means the access token works AND a refresh path
 * exists. A failure surfaces as an ERROR-level log line that the
 * deployment's external journal-based health monitor (e.g. Tincture's
 * `cyrus-health-monitor.sh`) picks up.
 *
 * Without this, an agent with a dead refresh token only reveals itself
 * when the next webhook arrives, which can be days later for idle
 * agents. Periodic active checks bound the silent-failure window to one
 * check interval (5 minutes by default).
 */
export class TokenHealthMonitor {
	private timer: NodeJS.Timeout | null = null;
	private startupTimer: NodeJS.Timeout | null = null;
	private inFlight = false;
	private logger: ILogger;
	private intervalMs: number;
	private initialDelayMs: number;
	private proactiveRefreshWindowMs: number;
	private getLinearClients: GetLinearClients;
	private getLinearTrackers: GetLinearTrackers | undefined;

	constructor(options: TokenHealthMonitorOptions) {
		this.getLinearClients = options.getLinearClients;
		this.getLinearTrackers = options.getLinearTrackers;
		this.logger =
			options.logger ?? createLogger({ component: "TokenHealthMonitor" });
		this.intervalMs = options.intervalMs ?? 5 * 60 * 1000;
		this.initialDelayMs = options.initialDelayMs ?? 30 * 1000;
		this.proactiveRefreshWindowMs =
			options.proactiveRefreshWindowMs ?? 5 * 60 * 1000;
	}

	start(): void {
		if (this.timer || this.startupTimer) {
			return;
		}
		this.logger.info(
			`Token health monitor starting (interval ${Math.round(this.intervalMs / 1000)}s, proactive refresh when <${Math.round(this.proactiveRefreshWindowMs / 1000)}s left)`,
		);
		this.startupTimer = setTimeout(() => {
			this.startupTimer = null;
			void this.checkAll();
			this.timer = setInterval(() => {
				void this.checkAll();
			}, this.intervalMs);
		}, this.initialDelayMs);
	}

	stop(): void {
		if (this.startupTimer) {
			clearTimeout(this.startupTimer);
			this.startupTimer = null;
		}
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/**
	 * Run a single health check pass. Exposed for tests + manual triggers.
	 * No-op if a previous check is still running (avoids piling up if a
	 * Linear API call hangs).
	 */
	async checkAll(): Promise<void> {
		if (this.inFlight) {
			this.logger.debug(
				"Health check skipped — previous check still in flight",
			);
			return;
		}
		this.inFlight = true;
		try {
			// First: proactive windowed refresh. Refresh any token within
			// `proactiveRefreshWindowMs` of expiry BEFORE we run the viewer
			// liveness check, so a token that's about to expire gets rotated
			// rather than expiring mid-check.
			if (this.getLinearTrackers) {
				const trackers = this.getLinearTrackers();
				const refreshes = Array.from(trackers.entries()).map(
					async ([workspaceId, tracker]) => {
						try {
							await tracker.refreshIfExpiringSoon(
								this.proactiveRefreshWindowMs,
							);
						} catch (err) {
							this.logger.warn(
								`Proactive refresh failed for workspace ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`,
							);
						}
					},
				);
				await Promise.allSettled(refreshes);
			}

			// Then: viewer liveness check. Confirms access token works (or a
			// refresh succeeded mid-call). Failures surface as ERROR-level
			// logs the external monitor (e.g. cyrus-health-monitor.sh) can
			// detect.
			const clients = this.getLinearClients();
			if (clients.size === 0) {
				return;
			}
			const checks = Array.from(clients.entries()).map(
				([workspaceId, client]) => this.checkOne(workspaceId, client),
			);
			await Promise.allSettled(checks);
		} finally {
			this.inFlight = false;
		}
	}

	private async checkOne(
		workspaceId: string,
		client: LinearClient,
	): Promise<void> {
		try {
			// `viewer` triggers a real authenticated request and exercises the
			// OAuth-refresh interceptor on the wrapped client. A success here
			// means: access token works OR refresh succeeded mid-call.
			const viewer = await client.viewer;
			this.logger.debug(
				`Linear OAuth health check OK for workspace ${workspaceId}`,
				{ viewerId: viewer?.id },
			);
		} catch (error) {
			// ERROR level so external journal watchers (e.g. the VM-side
			// cyrus-health-monitor.sh) surface the failure. The message
			// includes the workspace and matches the existing "Token refresh
			// failed" pattern the monitor already greps for.
			const message = error instanceof Error ? error.message : String(error);
			this.logger.error(
				`Linear OAuth health check failed for workspace ${workspaceId}: ${message}`,
			);
		}
	}
}
