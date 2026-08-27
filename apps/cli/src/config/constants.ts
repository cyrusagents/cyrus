/**
 * Application constants
 */

/**
 * Default server port for OAuth callbacks and webhooks
 */
export const DEFAULT_SERVER_PORT = 3456;

/**
 * Parse a port number from string with validation
 */
export function parsePort(
	value: string | undefined,
	defaultPort: number,
): number {
	if (!value) return defaultPort;
	const parsed = parseInt(value, 10);
	return Number.isNaN(parsed) || parsed < 1 || parsed > 65535
		? defaultPort
		: parsed;
}

/**
 * Resolve the address the HTTP server binds to.
 *
 * `CYRUS_SERVER_HOST` is an explicit override; when it is unset the address is
 * derived from `CYRUS_HOST_EXTERNAL` exactly as before.
 *
 * The two are separate because `CYRUS_HOST_EXTERNAL` is not a bind knob: it also
 * selects the webhook verification mode (direct signature vs proxied) and the
 * default for webhook source-IP validation. The override lets a deployment that
 * is fronted by a tunnel or reverse proxy on the same host bind loopback without
 * changing either of those.
 *
 * @param value Raw `CYRUS_SERVER_HOST` value, if set
 * @param isExternalHost Whether `CYRUS_HOST_EXTERNAL` is enabled
 */
export function resolveServerHost(
	value: string | undefined,
	isExternalHost: boolean,
): string {
	return value?.trim() || (isExternalHost ? "0.0.0.0" : "localhost");
}

/** Addresses that only the local machine can reach. */
function isLoopbackHost(host: string): boolean {
	const lower = host.toLowerCase();
	return (
		lower === "localhost" ||
		lower === "::1" ||
		lower === "[::1]" ||
		// 127.0.0.0/8 is all loopback; the prefix check is case-insensitive
		// because digits aren't, but lowercasing keeps it consistent.
		lower.startsWith("127.")
	);
}

/**
 * Error text for a `CYRUS_SERVER_HOST` that widens exposure rather than
 * narrowing it, or `null` when the resolved address is unremarkable.
 *
 * Binding a non-loopback address without `CYRUS_HOST_EXTERNAL=true` is a
 * combination that was unreachable before `CYRUS_SERVER_HOST` existed, and it is
 * the dangerous one: webhook source-IP validation defaults off and webhooks are
 * verified in proxy mode against `CYRUS_API_KEY`, so the port is reachable from
 * the network with the weaker of the two verification paths in front of it.
 *
 * Only an explicit override can produce it - the derived address for
 * `CYRUS_HOST_EXTERNAL=false` is loopback. Cyrus therefore rejects the
 * configuration before opening the listener rather than binding it: a non-
 * loopback override requires `CYRUS_HOST_EXTERNAL=true`, otherwise Cyrus stays
 * loopback-only.
 */
export function serverHostError(
	host: string,
	isExternalHost: boolean,
): string | null {
	if (isExternalHost || isLoopbackHost(host)) return null;

	return (
		`CYRUS_SERVER_HOST=${host} binds a non-loopback address while CYRUS_HOST_EXTERNAL is not set. ` +
		"A non-loopback override requires CYRUS_HOST_EXTERNAL=true (direct webhook signature verification " +
		"and source-IP validation); without it Cyrus is loopback-only. Set CYRUS_HOST_EXTERNAL=true if " +
		"this instance receives webhooks directly, or use a loopback address."
	);
}
