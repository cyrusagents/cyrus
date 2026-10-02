export interface TunnelRoutingStatus {
	/** Observation of managed ingress only; never an end-to-end identity proof. */
	state: "unverified" | "matches-local-port" | "mismatch";
	expectedPort: number;
}

export function inspectManagedRouting(
	config: unknown,
	expectedPort: number,
): TunnelRoutingStatus {
	const status = (state: TunnelRoutingStatus["state"]) => ({
		state,
		expectedPort,
	});
	if (!config || typeof config !== "object" || !("ingress" in config))
		return status("unverified");
	if (!Array.isArray(config.ingress) || config.ingress.length > 1000)
		return status("unverified");
	let origins = 0;
	for (const rule of config.ingress) {
		if (!rule || typeof rule !== "object" || typeof rule.service !== "string")
			return status("unverified");
		// The terminal HTTP status fallback does not route to another service.
		if (!rule.hostname && /^http_status:[1-5][0-9]{2}$/.test(rule.service))
			continue;
		origins++;
		try {
			const url = new URL(rule.service);
			if (
				url.protocol !== "http:" ||
				!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
				Number(url.port || "80") !== expectedPort ||
				url.username ||
				url.password ||
				url.pathname !== "/" ||
				url.search ||
				url.hash
			)
				return status("mismatch");
		} catch {
			return status("mismatch");
		}
	}
	return status(origins ? "matches-local-port" : "unverified");
}
