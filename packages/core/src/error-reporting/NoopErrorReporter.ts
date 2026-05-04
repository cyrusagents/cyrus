import type { ErrorReporter } from "./ErrorReporter.js";

/**
 * No-op {@link ErrorReporter} used when error tracking is disabled (opt-out
 * via env var, missing DSN, or test harness).
 *
 * Liskov-compatible with any other reporter: every method is a safe no-op.
 */
export class NoopErrorReporter implements ErrorReporter {
	readonly isEnabled = false;

	captureException(): void {
		// intentionally empty
	}

	captureMessage(): void {
		// intentionally empty
	}

	log(): void {
		// intentionally empty
	}

	async flush(): Promise<boolean> {
		return true;
	}
}
