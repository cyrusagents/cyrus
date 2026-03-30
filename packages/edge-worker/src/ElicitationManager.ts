/**
 * ElicitationManager handles pause/resume elicitation workflows.
 *
 * When Cyrus encounters ambiguity (e.g., test failures during validation),
 * it presents clickable choices to the user via Linear's elicitation API.
 * The Claude Code process is NOT running during elicitation — this operates
 * BETWEEN Claude Code runs, not during them.
 *
 * Flow:
 * 1. A trigger point (e.g., validation loop exhaustion) calls emitElicitation()
 * 2. The manager posts a select-signal elicitation to Linear with options
 * 3. The pending state is stored in-memory AND persisted to disk for restart survival
 * 4. A 30-minute timeout is started
 * 5. When the user responds (prompted webhook), handleUserResponse() resolves the pending state
 * 6. The caller receives the user's choice and takes action
 *
 * Follows the same pending-request pattern as AskUserQuestionHandler and RepositoryRouter.
 *
 * @see {@link https://linear.app/developers/agent-signals#select}
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { IIssueTrackerService, ILogger } from "cyrus-core";
import { AgentActivitySignal, createLogger } from "cyrus-core";

/** Default timeout for elicitation responses (30 minutes) */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * An option presented to the user in a select elicitation
 */
export interface ElicitationOption {
	/** Display value shown as a clickable choice */
	value: string;
}

/**
 * Result returned when an elicitation resolves
 */
export interface ElicitationResult {
	/** Whether the user responded (false if timed out or cancelled) */
	responded: boolean;
	/** The value the user selected (undefined if not responded) */
	selectedValue?: string;
	/** Reason for non-response (timeout, cancelled, etc.) */
	reason?: string;
}

/**
 * In-memory state for a pending elicitation
 */
interface PendingElicitation {
	/** Session ID this elicitation belongs to */
	sessionId: string;
	/** Linear workspace/organization ID */
	organizationId: string;
	/** The body/question of the elicitation */
	body: string;
	/** The options presented */
	options: ElicitationOption[];
	/** Elicitation type tag (e.g., "test-failure") for routing response handling */
	type: string;
	/** Promise resolver called when user responds */
	resolve: (result: ElicitationResult) => void;
	/** Timeout handle for cleanup */
	timeoutHandle: ReturnType<typeof setTimeout>;
	/** Timestamp when the elicitation was created */
	createdAt: number;
}

/**
 * Serialized pending elicitation for file persistence (survives restarts)
 */
interface PersistedElicitation {
	sessionId: string;
	organizationId: string;
	body: string;
	options: ElicitationOption[];
	type: string;
	createdAt: number;
	timeoutAt: number;
}

/**
 * Dependencies required by ElicitationManager
 */
export interface ElicitationManagerDeps {
	/** Get issue tracker for a workspace */
	getIssueTracker: (organizationId: string) => IIssueTrackerService | null;
}

/**
 * Configuration for ElicitationManager
 */
export interface ElicitationManagerConfig {
	/** Path to the persistence file for surviving restarts */
	persistencePath: string;
	/** Timeout in milliseconds (default: 30 minutes) */
	timeoutMs?: number;
}

/**
 * Manager for Linear elicitation (clickable choices) workflows.
 *
 * Usage:
 * 1. Call emitElicitation() to post choices and wait for response
 * 2. When webhook arrives, check hasPendingElicitation() then handleUserResponse()
 * 3. The returned promise resolves with the user's choice
 */
export class ElicitationManager {
	private deps: ElicitationManagerDeps;
	private config: ElicitationManagerConfig;
	private logger: ILogger;
	private timeoutMs: number;

	/** Map of Linear agent session ID → pending elicitation */
	private pendingElicitations: Map<string, PendingElicitation> = new Map();

	constructor(
		deps: ElicitationManagerDeps,
		config: ElicitationManagerConfig,
		logger?: ILogger,
	) {
		this.deps = deps;
		this.config = config;
		this.logger = logger ?? createLogger({ component: "ElicitationManager" });
		this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

		// Load persisted state on startup
		this.loadPersistedState();
	}

	/**
	 * Emit an elicitation to Linear with clickable choices and wait for a response.
	 *
	 * This method:
	 * 1. Posts an elicitation activity to Linear with select signal and options
	 * 2. Stores the pending state in memory and on disk
	 * 3. Returns a promise that resolves when the user responds or timeout occurs
	 *
	 * @param sessionId - Linear agent session ID
	 * @param organizationId - Linear organization/workspace ID
	 * @param body - The question/message to display
	 * @param options - Clickable options to present
	 * @param type - Elicitation type tag for routing (e.g., "test-failure")
	 * @returns Promise resolving to the user's selection or timeout
	 */
	async emitElicitation(
		sessionId: string,
		organizationId: string,
		body: string,
		options: ElicitationOption[],
		type: string,
	): Promise<ElicitationResult> {
		this.logger.info(
			`Emitting elicitation for session ${sessionId} (type: ${type}): ${body}`,
		);

		// Cancel any existing pending elicitation for this session
		if (this.pendingElicitations.has(sessionId)) {
			this.logger.warn(
				`Replacing existing pending elicitation for session ${sessionId}`,
			);
			this.cancelPendingElicitation(sessionId, "Replaced by new elicitation");
		}

		// Get issue tracker to post the elicitation
		const issueTracker = this.deps.getIssueTracker(organizationId);
		if (!issueTracker) {
			this.logger.error(
				`No issue tracker found for organization ${organizationId}`,
			);
			return {
				responded: false,
				reason: "Issue tracker not available",
			};
		}

		// Post elicitation to Linear with select signal
		try {
			await issueTracker.createAgentActivity({
				agentSessionId: sessionId,
				content: {
					type: "elicitation",
					body,
				},
				signal: AgentActivitySignal.Select,
				signalMetadata: {
					options: options.map((opt) => ({ value: opt.value })),
				},
			});

			this.logger.info(
				`Posted elicitation with ${options.length} options for session ${sessionId}`,
			);
		} catch (error) {
			const errorMessage = (error as Error).message || String(error);
			this.logger.error(
				`Failed to post elicitation to Linear: ${errorMessage}`,
			);
			return {
				responded: false,
				reason: `Failed to present choices: ${errorMessage}`,
			};
		}

		// Create promise and store pending state
		return new Promise<ElicitationResult>((resolve) => {
			const createdAt = Date.now();

			// Setup timeout
			const timeoutHandle = setTimeout(() => {
				this.logger.info(
					`Elicitation timed out for session ${sessionId} after ${this.timeoutMs}ms`,
				);
				this.pendingElicitations.delete(sessionId);
				this.persistState();

				resolve({
					responded: false,
					reason: "No response received within 30 minutes",
				});
			}, this.timeoutMs);

			// Store pending state
			this.pendingElicitations.set(sessionId, {
				sessionId,
				organizationId,
				body,
				options,
				type,
				resolve: (result: ElicitationResult) => {
					clearTimeout(timeoutHandle);
					this.pendingElicitations.delete(sessionId);
					this.persistState();
					resolve(result);
				},
				timeoutHandle,
				createdAt,
			});

			// Persist to disk for restart survival
			this.persistState();
		});
	}

	/**
	 * Handle a user response from the "prompted" webhook.
	 *
	 * @param sessionId - Linear agent session ID
	 * @param selectedValue - The value selected by the user
	 * @returns true if a pending elicitation was resolved, false if none found
	 */
	handleUserResponse(sessionId: string, selectedValue: string): boolean {
		const pending = this.pendingElicitations.get(sessionId);
		if (!pending) {
			this.logger.debug(
				`No pending elicitation found for session ${sessionId}`,
			);
			return false;
		}

		this.logger.info(
			`User responded to elicitation for session ${sessionId}: "${selectedValue}" (type: ${pending.type})`,
		);

		pending.resolve({
			responded: true,
			selectedValue,
		});

		return true;
	}

	/**
	 * Check if there's a pending elicitation for this session.
	 */
	hasPendingElicitation(sessionId: string): boolean {
		return this.pendingElicitations.has(sessionId);
	}

	/**
	 * Get the type of a pending elicitation (e.g., "test-failure").
	 */
	getPendingElicitationType(sessionId: string): string | undefined {
		return this.pendingElicitations.get(sessionId)?.type;
	}

	/**
	 * Cancel a pending elicitation.
	 */
	cancelPendingElicitation(sessionId: string, reason: string): void {
		const pending = this.pendingElicitations.get(sessionId);
		if (pending) {
			this.logger.info(
				`Cancelling pending elicitation for session ${sessionId}: ${reason}`,
			);
			pending.resolve({
				responded: false,
				reason,
			});
		}
	}

	/**
	 * Get the number of pending elicitations (for debugging/monitoring).
	 */
	get pendingCount(): number {
		return this.pendingElicitations.size;
	}

	/**
	 * Persist pending elicitation state to disk for restart survival.
	 */
	private persistState(): void {
		try {
			const serialized: PersistedElicitation[] = [];
			for (const [, pending] of this.pendingElicitations) {
				serialized.push({
					sessionId: pending.sessionId,
					organizationId: pending.organizationId,
					body: pending.body,
					options: pending.options,
					type: pending.type,
					createdAt: pending.createdAt,
					timeoutAt: pending.createdAt + this.timeoutMs,
				});
			}

			const dir = dirname(this.config.persistencePath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}

			writeFileSync(
				this.config.persistencePath,
				JSON.stringify(serialized, null, 2),
			);
			this.logger.debug(
				`Persisted ${serialized.length} pending elicitation(s) to ${this.config.persistencePath}`,
			);
		} catch (error) {
			this.logger.error(`Failed to persist elicitation state:`, error);
		}
	}

	/**
	 * Load persisted elicitation state from disk on startup.
	 * Expired elicitations are discarded.
	 */
	private loadPersistedState(): void {
		try {
			if (!existsSync(this.config.persistencePath)) {
				return;
			}

			const raw = readFileSync(this.config.persistencePath, "utf-8");
			const persisted: PersistedElicitation[] = JSON.parse(raw);
			const now = Date.now();

			let loaded = 0;
			let expired = 0;

			for (const entry of persisted) {
				// Check if already expired
				if (now >= entry.timeoutAt) {
					expired++;
					this.logger.info(
						`Discarding expired elicitation for session ${entry.sessionId} (type: ${entry.type})`,
					);
					continue;
				}

				// Restore with remaining timeout
				const remainingMs = entry.timeoutAt - now;
				this.logger.info(
					`Restoring elicitation for session ${entry.sessionId} (type: ${entry.type}, ${Math.round(remainingMs / 1000)}s remaining)`,
				);

				// Create a "detached" pending entry — no promise resolver yet.
				// When handleUserResponse is called, it will resolve immediately.
				// If the response never comes, the timeout will fire and clean up.
				const timeoutHandle = setTimeout(() => {
					this.logger.info(
						`Restored elicitation timed out for session ${entry.sessionId}`,
					);
					this.pendingElicitations.delete(entry.sessionId);
					this.persistState();
				}, remainingMs);

				this.pendingElicitations.set(entry.sessionId, {
					sessionId: entry.sessionId,
					organizationId: entry.organizationId,
					body: entry.body,
					options: entry.options,
					type: entry.type,
					resolve: (_result: ElicitationResult) => {
						// Restored elicitations don't have a promise to resolve —
						// the original caller's promise was lost on restart.
						// The webhook handler checks the type and acts accordingly.
						clearTimeout(timeoutHandle);
						this.pendingElicitations.delete(entry.sessionId);
						this.persistState();
					},
					timeoutHandle,
					createdAt: entry.createdAt,
				});
				loaded++;
			}

			if (loaded > 0 || expired > 0) {
				this.logger.info(
					`Loaded ${loaded} pending elicitation(s) from disk (${expired} expired)`,
				);
			}
		} catch (error) {
			this.logger.error(`Failed to load persisted elicitation state:`, error);
		}
	}

	/**
	 * Clean up all pending elicitations (for shutdown).
	 */
	dispose(): void {
		for (const [sessionId, pending] of this.pendingElicitations) {
			clearTimeout(pending.timeoutHandle);
			this.pendingElicitations.delete(sessionId);
		}
	}
}
