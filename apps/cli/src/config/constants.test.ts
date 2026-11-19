import { describe, expect, it } from "vitest";
import {
	DEFAULT_SERVER_PORT,
	parsePort,
	resolveServerHost,
	serverHostError,
} from "./constants.js";

describe("parsePort", () => {
	it("returns the default when unset or empty", () => {
		expect(parsePort(undefined, DEFAULT_SERVER_PORT)).toBe(DEFAULT_SERVER_PORT);
		expect(parsePort("", DEFAULT_SERVER_PORT)).toBe(DEFAULT_SERVER_PORT);
	});

	it("parses a valid port", () => {
		expect(parsePort("8080", DEFAULT_SERVER_PORT)).toBe(8080);
	});

	it("returns the default for non-numeric or out-of-range values", () => {
		expect(parsePort("not-a-port", DEFAULT_SERVER_PORT)).toBe(
			DEFAULT_SERVER_PORT,
		);
		expect(parsePort("0", DEFAULT_SERVER_PORT)).toBe(DEFAULT_SERVER_PORT);
		expect(parsePort("70000", DEFAULT_SERVER_PORT)).toBe(DEFAULT_SERVER_PORT);
	});
});

describe("resolveServerHost", () => {
	describe("fallback (CYRUS_SERVER_HOST unset)", () => {
		it("binds all interfaces when CYRUS_HOST_EXTERNAL is enabled", () => {
			expect(resolveServerHost(undefined, true)).toBe("0.0.0.0");
		});

		it("binds localhost when CYRUS_HOST_EXTERNAL is disabled", () => {
			expect(resolveServerHost(undefined, false)).toBe("localhost");
		});

		it("falls back for an empty or whitespace-only override", () => {
			expect(resolveServerHost("", true)).toBe("0.0.0.0");
			expect(resolveServerHost("   ", true)).toBe("0.0.0.0");
			expect(resolveServerHost("", false)).toBe("localhost");
			expect(resolveServerHost("   ", false)).toBe("localhost");
		});
	});

	describe("override (CYRUS_SERVER_HOST set)", () => {
		it("takes precedence over the CYRUS_HOST_EXTERNAL derivation", () => {
			// The case from the issue: tunnelled/proxied self-host that wants a
			// loopback bind while keeping direct webhook verification.
			expect(resolveServerHost("127.0.0.1", true)).toBe("127.0.0.1");
			expect(resolveServerHost("0.0.0.0", false)).toBe("0.0.0.0");
		});

		it("accepts any address, not just the two derived values", () => {
			expect(resolveServerHost("::1", true)).toBe("::1");
			expect(resolveServerHost("192.168.1.10", false)).toBe("192.168.1.10");
		});

		it("trims surrounding whitespace", () => {
			expect(resolveServerHost("  127.0.0.1  ", true)).toBe("127.0.0.1");
		});
	});
});

describe("serverHostError", () => {
	it("rejects when an override binds a non-loopback address outside external mode", () => {
		const error = serverHostError("0.0.0.0", false);

		expect(error).toContain("CYRUS_SERVER_HOST=0.0.0.0");
		expect(error).toContain("CYRUS_HOST_EXTERNAL");
		// Spells out the requirement so the operator knows the fix.
		expect(error).toContain("CYRUS_HOST_EXTERNAL=true");
	});

	it("rejects a specific non-loopback interface address too", () => {
		expect(serverHostError("192.168.1.10", false)).toContain(
			"CYRUS_SERVER_HOST=192.168.1.10",
		);
	});

	it("stays quiet for loopback addresses", () => {
		for (const host of [
			"localhost",
			"Localhost",
			"LOCALHOST",
			"127.0.0.1",
			"127.1.2.3",
			"127.255.255.254",
			"::1",
			"[::1]",
		]) {
			expect(serverHostError(host, false)).toBeNull();
		}
	});

	it("rejects hostnames that only look like 127.0.0.0/8", () => {
		for (const host of [
			"127.example.com",
			"127.0.0.1.nip.io",
			"127.attacker.net",
			// Not valid dotted-quads, so not addresses Cyrus will treat as loopback.
			"127.1",
			"127",
			"127.0.0.256",
			"127.0.0.01",
		]) {
			expect(serverHostError(host, false)).toContain(
				`CYRUS_SERVER_HOST=${host}`,
			);
		}
	});

	it("stays quiet in external mode, where a public bind is the point", () => {
		expect(serverHostError("0.0.0.0", true)).toBeNull();
		expect(serverHostError("127.0.0.1", true)).toBeNull();
	});

	it("never fires for a derived address", () => {
		// The only non-loopback derivation requires isExternalHost.
		expect(
			serverHostError(resolveServerHost(undefined, false), false),
		).toBeNull();
		expect(
			serverHostError(resolveServerHost(undefined, true), true),
		).toBeNull();
	});
});
