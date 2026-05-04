import type { ErrorReporter } from "./ErrorReporter.js";
import { NoopErrorReporter } from "./NoopErrorReporter.js";

let globalReporter: ErrorReporter = new NoopErrorReporter();
let globalTags: Readonly<Record<string, string>> = Object.freeze({});

/**
 * Install the process-wide {@link ErrorReporter}.
 *
 * The CLI bootstrap should call this exactly once, immediately after
 * constructing its real reporter, so that loggers and library code that
 * observe errors via {@link getGlobalErrorReporter} can forward them without
 * needing the reporter passed through every constructor.
 *
 * Returns the previously-installed reporter so tests can restore state.
 */
export function setGlobalErrorReporter(reporter: ErrorReporter): ErrorReporter {
	const previous = globalReporter;
	globalReporter = reporter;
	return previous;
}

/**
 * Read the process-wide {@link ErrorReporter}. Defaults to a {@link
 * NoopErrorReporter} when bootstrap has not installed one (libraries imported
 * without the CLI, tests, etc.) so call sites never need to null-check.
 */
export function getGlobalErrorReporter(): ErrorReporter {
	return globalReporter;
}

/**
 * Install process-wide tags applied to every event captured via
 * {@link getGlobalErrorReporter} or forwarded by the Logger. Use this for
 * tenant/deployment identifiers (e.g. `team_id`) that should be present on
 * every event regardless of which capture site emitted it.
 *
 * The Sentry SDK's `initialScope` covers events emitted directly through
 * `Sentry.*` APIs, but Logger.error builds an explicit per-event tag map that
 * overrides scope tags by key — so we mirror the registry here so Logger can
 * merge them in.
 */
export function setGlobalErrorTags(tags: Record<string, string>): void {
	globalTags = Object.freeze({ ...tags });
}

export function getGlobalErrorTags(): Readonly<Record<string, string>> {
	return globalTags;
}

/**
 * Restore the default no-op reporter and clear global tags. Intended for tests.
 */
export function resetGlobalErrorReporter(): void {
	globalReporter = new NoopErrorReporter();
	globalTags = Object.freeze({});
}
