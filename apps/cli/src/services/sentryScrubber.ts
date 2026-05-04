import type { ErrorEvent, EventHint } from "@sentry/node";

/**
 * Mirrors Sentry's `Log` shape just enough for the scrubber to operate on it.
 * Generic over the level type so this hook plugs into the SDK's `beforeSendLog`
 * signature without redeclaring the LogSeverityLevel literal union here.
 */
export interface SentryLog<LevelT = string> {
	level: LevelT;
	message: unknown;
	attributes?: Record<string, unknown>;
	severityNumber?: number;
}

/**
 * Substring patterns (lowercased) that mark a key as sensitive. We err on the
 * side of dropping: a redaction is recoverable from local logs, a leaked token
 * is not.
 */
const SENSITIVE_KEY_PATTERNS = [
	"token",
	"secret",
	"password",
	"passwd",
	"apikey",
	"api_key",
	"authorization",
	"auth_header",
	"cookie",
	// NOTE: "session" intentionally omitted — it's too broad (matches the
	// `sessionId` / `claudeSessionId` identifier attributes we *want* in
	// Sentry for log slicing). Real session secrets are caught by the more
	// specific patterns ("token", "cookie", "secret") via compounds like
	// `session_token`, `session_cookie`, `session_secret`.
	"private_key",
	"privatekey",
	"client_secret",
	"clientsecret",
	"refresh_token",
	"access_token",
	"bearer",
	"dsn",
	"webhook_secret",
	"webhooksecret",
	"signing_secret",
	"signingsecret",
	"linear_token",
	"github_token",
	"gitlab_token",
	"slack_token",
];

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 8;

function isSensitiveKey(key: string): boolean {
	const lower = key.toLowerCase();
	return SENSITIVE_KEY_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Recursively redact values whose keys match a sensitive pattern. Strings that
 * look like tokens (long, no whitespace, high entropy-ish) are also redacted
 * even when their parent key is innocuous, so payload fields like
 * `headers["x-foo"]: "ghp_…"` don't slip through.
 */
function scrubValue(value: unknown, depth = 0): unknown {
	if (depth > MAX_DEPTH) return REDACTED;
	if (value == null) return value;

	if (typeof value === "string") {
		return looksLikeToken(value) ? REDACTED : redactBearerInString(value);
	}

	if (Array.isArray(value)) {
		return value.map((v) => scrubValue(v, depth + 1));
	}

	if (typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (isSensitiveKey(k)) {
				out[k] = REDACTED;
			} else {
				out[k] = scrubValue(v, depth + 1);
			}
		}
		return out;
	}

	return value;
}

/**
 * Heuristic for an opaque token: long, no whitespace, mostly URL-safe chars,
 * and matches one of the well-known prefixes used by tokens we handle.
 */
function looksLikeToken(s: string): boolean {
	if (s.length < 20) return false;
	if (/\s/.test(s)) return false;

	// Known prefixes
	if (
		/^(ghp|gho|ghu|ghs|ghr|github_pat)_/i.test(s) ||
		/^xox[abprs]-/i.test(s) ||
		/^glpat-/i.test(s) ||
		/^lin_(api|oauth)_/i.test(s) ||
		/^sk-[A-Za-z0-9_-]{20,}$/i.test(s) ||
		/^Bearer\s+\S{16,}$/i.test(s)
	) {
		return true;
	}

	// JWT-shaped (three base64url segments)
	if (/^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(s)) {
		return true;
	}

	return false;
}

/**
 * Redact `Authorization: Bearer …` and `?token=…` substrings inside otherwise
 * innocuous strings (e.g. error messages echoing a request line).
 */
function redactBearerInString(s: string): string {
	return s
		.replace(/Bearer\s+[A-Za-z0-9._\-+/=]{16,}/gi, "Bearer [REDACTED]")
		.replace(
			/([?&](?:token|access_token|api_key|key|secret)=)[^&\s"']+/gi,
			"$1[REDACTED]",
		);
}

/**
 * Strip token-shaped substrings from a Sentry event. Mutates and returns the
 * event so it can be used directly as a `beforeSend` hook.
 */
export function scrubSentryEvent(
	event: ErrorEvent,
	_hint?: EventHint,
): ErrorEvent | null {
	if (event.message) {
		event.message = redactBearerInString(event.message);
	}

	if (event.extra) {
		event.extra = scrubValue(event.extra) as Record<string, unknown>;
	}

	if (event.contexts) {
		event.contexts = scrubValue(event.contexts) as typeof event.contexts;
	}

	if (event.request) {
		if (event.request.headers) {
			event.request.headers = scrubValue(event.request.headers) as Record<
				string,
				string
			>;
		}
		if (event.request.cookies) {
			event.request.cookies =
				REDACTED as unknown as typeof event.request.cookies;
		}
		if (event.request.data !== undefined) {
			event.request.data = scrubValue(event.request.data);
		}
	}

	if (event.exception?.values) {
		for (const ex of event.exception.values) {
			if (ex.value) ex.value = redactBearerInString(ex.value);
		}
	}

	// Breadcrumbs come from `consoleIntegration` (every console.* line) and
	// other auto-captured trails. They ride along on every event, so anything
	// the app printed before the failure — request bodies, headers, repo paths
	// — would otherwise leak with the next captured exception.
	if (event.breadcrumbs) {
		for (const bc of event.breadcrumbs) {
			if (typeof bc.message === "string") {
				bc.message = redactBearerInString(bc.message);
			}
			if (bc.data) {
				bc.data = scrubValue(bc.data) as Record<string, unknown>;
			}
		}
	}

	return event;
}

/**
 * Scrub a Sentry Logs entry. Wired as `beforeSendLog` on `Sentry.init`. The
 * Logs stream is a separate pipeline from Issues — `beforeSend` does not run
 * on logs, so we need a dedicated hook to keep the redaction guarantees
 * symmetric across both ingestion paths.
 *
 * Generic in `T` so the SDK's stricter `Log` shape (with `level:
 * LogSeverityLevel`) flows through unchanged — TypeScript would otherwise
 * narrow the return to a looser `string` level on assignment.
 */
export function scrubSentryLog<T extends SentryLog<unknown>>(log: T): T {
	if (typeof log.message === "string") {
		log.message = redactBearerInString(log.message) as T["message"];
	}
	if (log.attributes) {
		log.attributes = scrubValue(log.attributes) as Record<string, unknown>;
	}
	return log;
}
