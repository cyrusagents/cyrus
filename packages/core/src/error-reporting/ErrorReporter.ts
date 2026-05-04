/**
 * Severity level for messages reported to the error tracker.
 */
export type ErrorReporterSeverity =
	| "fatal"
	| "error"
	| "warning"
	| "info"
	| "debug";

/**
 * Severity level for structured logs forwarded to the tracker's log stream
 * (separate from event capture). Mirrors Sentry's Logs API.
 */
export type ErrorReporterLogLevel =
	| "trace"
	| "debug"
	| "info"
	| "warn"
	| "error"
	| "fatal";

/**
 * Per-log structured attributes. Keys are arbitrary; values must be JSON-
 * serialisable primitives. The reporter merges process-wide tags (e.g.
 * `team_id`) into these on the way out so call sites don't need to repeat
 * cross-cutting fields.
 */
export type ErrorReporterLogAttributes = Record<
	string,
	string | number | boolean | null | undefined
>;

/**
 * Structured context attached to a reported event.
 *
 * Keys are arbitrary; values must be JSON-serialisable. Implementations
 * should not throw if the context object is unsupported, instead they
 * should drop or coerce the offending field.
 */
export interface ErrorReporterContext {
	tags?: Record<string, string>;
	extra?: Record<string, unknown>;
	user?: { id?: string; email?: string; username?: string };
	/**
	 * Stable grouping key. Without this Sentry groups by message text — fine
	 * for thrown Errors, but `logger.error("failed for issue ABC-123", err)`
	 * style calls fragment into one group per ID. Pass a sanitised template
	 * (e.g. ["component", "failed for issue <id>"]) to keep groups bounded.
	 */
	fingerprint?: string[];
}

/**
 * Abstraction over error-tracking backends.
 *
 * Cyrus depends only on this interface so that:
 *   - alternative backends (Sentry, Bugsnag, Honeycomb, Noop) can be swapped
 *     without touching call sites,
 *   - the bulk of the codebase compiles without a backend SDK in scope, and
 *   - tests can inject a fake reporter without network or globals.
 */
export interface ErrorReporter {
	/** Report an exception. Safe to call when the backend is disabled. */
	captureException(error: unknown, context?: ErrorReporterContext): void;

	/** Report a message at the given severity (defaults to "info"). */
	captureMessage(
		message: string,
		severity?: ErrorReporterSeverity,
		context?: ErrorReporterContext,
	): void;

	/**
	 * Forward a structured log entry to the tracker's log stream (e.g. Sentry
	 * Logs). Distinct from {@link captureMessage}: log entries flow into the
	 * Logs explorer, not the Issues stream, so this can be called for every
	 * log line without spamming alerts. Implementations that don't support
	 * structured logs should silently no-op.
	 */
	log(
		level: ErrorReporterLogLevel,
		message: string,
		attributes?: ErrorReporterLogAttributes,
	): void;

	/**
	 * Flush any buffered events. Returns true if all events were sent before
	 * the timeout, false otherwise. Safe to call when disabled (resolves true).
	 */
	flush(timeoutMs?: number): Promise<boolean>;

	/** Whether this reporter is actually transmitting events. */
	readonly isEnabled: boolean;
}
