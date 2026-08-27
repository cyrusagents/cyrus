/**
 * Application constants
 */

import { isIPv4 } from "node:net";

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
 * `CYRUS_HOST_EXTERNAL` is not a bind knob: it also selects the webhook
 * verification mode and the source-IP validation default. `CYRUS_SERVER_HOST`
 * exists so a deployment fronted by a tunnel or reverse proxy can move the bind
 * address without changing either of those.
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

/** Addresses only the local machine can reach. */
function isLoopbackHost(host: string): boolean {
	const lower = host.toLowerCase();
	if (lower === "localhost" || lower === "::1" || lower === "[::1]") {
		return true;
	}
	// Hostnames can start "127." too (`127.example.com`), so the address has to
	// parse as IPv4 before the 127.0.0.0/8 prefix means anything.
	return isIPv4(lower) && lower.startsWith("127.");
}

/**
 * Error text for a `CYRUS_SERVER_HOST` that binds beyond loopback without
 * `CYRUS_HOST_EXTERNAL=true`, or `null` when the address is acceptable.
 *
 * That combination is unreachable without the override and is the dangerous
 * one: the port is on the network while webhooks are verified in proxy mode and
 * source-IP validation is off by default. Cyrus rejects it rather than binding.
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
