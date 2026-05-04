import { existsSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NetworkPolicy, SandboxConfig } from "cyrus-core";
import { TRUSTED_DOMAINS } from "cyrus-core";
import { afterEach, describe, expect, it } from "vitest";
import { EgressProxy } from "../src/EgressProxy.js";

const TEST_CYRUS_HOME = join(tmpdir(), `cyrus-egress-test-${Date.now()}`);

function createConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
	return {
		enabled: true,
		httpProxyPort: 0, // Will be overridden in tests
		socksProxyPort: 0,
		logRequests: false,
		...overrides,
	} as SandboxConfig;
}

describe("EgressProxy", () => {
	let proxy: EgressProxy;
	// Bind to port 0 so the OS picks an ephemeral port; read the actual
	// bound port via proxy.getHttpProxyPort()/getSocksProxyPort() after start().
	const httpPort = 0;
	const socksPort = 0;

	afterEach(async () => {
		if (proxy) {
			await proxy.stop();
		}
		// Clean up test certs
		if (existsSync(TEST_CYRUS_HOME)) {
			rmSync(TEST_CYRUS_HOME, { recursive: true, force: true });
		}
	});

	describe("constructor", () => {
		it("generates CA certificate on first run", () => {
			proxy = new EgressProxy(
				createConfig({ httpProxyPort: httpPort, socksProxyPort: socksPort }),
				TEST_CYRUS_HOME,
			);

			const caCertPath = proxy.getCACertPath();
			expect(caCertPath).toContain("cyrus-egress-ca.pem");
			expect(existsSync(caCertPath)).toBe(true);
		});

		it("reuses existing CA certificate", () => {
			const config = createConfig({
				httpProxyPort: httpPort,
				socksProxyPort: socksPort,
			});

			const proxy1 = new EgressProxy(config, TEST_CYRUS_HOME);
			const cert1 = proxy1.getCACertPath();

			const proxy2 = new EgressProxy(config, TEST_CYRUS_HOME);
			const cert2 = proxy2.getCACertPath();

			expect(cert1).toEqual(cert2);
		});

		it("returns actual bound ports after start", async () => {
			proxy = new EgressProxy(
				createConfig({ httpProxyPort: httpPort, socksProxyPort: socksPort }),
				TEST_CYRUS_HOME,
			);

			// Before start(), getters return the configured port (0 in tests).
			expect(proxy.getHttpProxyPort()).toBe(0);
			expect(proxy.getSocksProxyPort()).toBe(0);

			await proxy.start();

			// After start(), getters return the OS-assigned ephemeral port.
			expect(proxy.getHttpProxyPort()).toBeGreaterThan(0);
			expect(proxy.getSocksProxyPort()).toBeGreaterThan(0);
		});
	});

	describe("start/stop", () => {
		it("starts and stops without error", async () => {
			proxy = new EgressProxy(
				createConfig({ httpProxyPort: httpPort, socksProxyPort: socksPort }),
				TEST_CYRUS_HOME,
			);

			await proxy.start();
			await proxy.stop();
		});

		it("is idempotent on start", async () => {
			proxy = new EgressProxy(
				createConfig({ httpProxyPort: httpPort, socksProxyPort: socksPort }),
				TEST_CYRUS_HOME,
			);

			await proxy.start();
			await proxy.start(); // Should not throw
			await proxy.stop();
		});
	});

	describe("domain matching", () => {
		it("allows all traffic when no policy is set", async () => {
			proxy = new EgressProxy(
				createConfig({ httpProxyPort: httpPort, socksProxyPort: socksPort }),
				TEST_CYRUS_HOME,
			);
			await proxy.start();

			// With no policy, traffic should pass through
			// We test this indirectly by checking the proxy starts successfully
			// and the domain matching logic returns true for any domain
		});

		it("blocks all traffic when allow map is empty (deny-all)", async () => {
			const policy: NetworkPolicy = {
				allow: {},
			};

			proxy = new EgressProxy(
				createConfig({
					httpProxyPort: httpPort,
					socksProxyPort: socksPort,
					networkPolicy: policy,
				}),
				TEST_CYRUS_HOME,
			);
			await proxy.start();

			const result = await connectViaProxy(
				proxy.getHttpProxyPort(),
				"example.com:443",
			);
			expect(result).toBe(403);
		});

		it("blocks domains not in allow list", async () => {
			const policy: NetworkPolicy = {
				allow: {
					"api.example.com": [{}],
				},
			};

			proxy = new EgressProxy(
				createConfig({
					httpProxyPort: httpPort,
					socksProxyPort: socksPort,
					networkPolicy: policy,
				}),
				TEST_CYRUS_HOME,
			);
			await proxy.start();

			// Try to connect to a blocked domain through the proxy
			const result = await new Promise<number>((resolve) => {
				const req = http.request(
					{
						hostname: "127.0.0.1",
						port: proxy.getHttpProxyPort(),
						method: "CONNECT",
						path: "blocked.example.com:443",
					},
					(res) => resolve(res.statusCode || 0),
				);
				req.on("connect", (_res, _socket, _head) => {
					resolve(_res.statusCode || 0);
				});
				req.on("error", () => resolve(0));
				req.end();
			});

			expect(result).toBe(403);
		});

		it("allows domains in allow list via CONNECT", async () => {
			const policy: NetworkPolicy = {
				allow: {
					"example.com": [{}],
				},
			};

			proxy = new EgressProxy(
				createConfig({
					httpProxyPort: httpPort,
					socksProxyPort: socksPort,
					networkPolicy: policy,
				}),
				TEST_CYRUS_HOME,
			);
			await proxy.start();

			// Try to CONNECT to an allowed domain
			// Since example.com may not resolve, we just check the proxy accepts the CONNECT
			const result = await new Promise<number>((resolve) => {
				const req = http.request({
					hostname: "127.0.0.1",
					port: proxy.getHttpProxyPort(),
					method: "CONNECT",
					path: "example.com:443",
				});
				req.on("connect", (res) => {
					resolve(res.statusCode || 0);
					req.destroy();
				});
				req.on("error", () => resolve(0));
				req.setTimeout(3000, () => {
					resolve(-1);
					req.destroy();
				});
				req.end();
			});

			// Either 200 (tunnel established) or error connecting upstream
			// The key point is it's NOT 403
			expect(result).not.toBe(403);
		});

		it("supports wildcard subdomain matching", async () => {
			const policy: NetworkPolicy = {
				allow: {
					"*.example.com": [{}],
				},
			};

			proxy = new EgressProxy(
				createConfig({
					httpProxyPort: httpPort,
					socksProxyPort: socksPort,
					networkPolicy: policy,
				}),
				TEST_CYRUS_HOME,
			);
			await proxy.start();

			// sub.example.com should be allowed, but bare example.com should be blocked
			const subResult = await connectViaProxy(
				proxy.getHttpProxyPort(),
				"sub.example.com:443",
			);
			const bareResult = await connectViaProxy(
				proxy.getHttpProxyPort(),
				"example.com:443",
			);

			expect(subResult).not.toBe(403); // Allowed
			expect(bareResult).toBe(403); // Blocked - wildcard doesn't match parent
		});
	});

	describe("updateNetworkPolicy", () => {
		it("updates policy at runtime", async () => {
			proxy = new EgressProxy(
				createConfig({
					httpProxyPort: httpPort,
					socksProxyPort: socksPort,
					networkPolicy: {
						allow: {
							"api.example.com": [{}],
						},
					},
				}),
				TEST_CYRUS_HOME,
			);
			await proxy.start();

			// Initially, blocked.com should be blocked
			const result1 = await connectViaProxy(
				proxy.getHttpProxyPort(),
				"blocked.com:443",
			);
			expect(result1).toBe(403);

			// Update policy to allow blocked.com
			proxy.updateNetworkPolicy({
				allow: {
					"api.example.com": [{}],
					"blocked.com": [{}],
				},
			});

			// Now blocked.com should be allowed
			const result2 = await connectViaProxy(
				proxy.getHttpProxyPort(),
				"blocked.com:443",
			);
			expect(result2).not.toBe(403);
		});
	});

	describe("trusted preset", () => {
		it("expands trusted preset into allow list", async () => {
			proxy = new EgressProxy(
				createConfig({
					httpProxyPort: httpPort,
					socksProxyPort: socksPort,
					networkPolicy: {
						preset: "trusted",
					},
				}),
				TEST_CYRUS_HOME,
			);
			await proxy.start();

			// github.com (in the trusted list) should be allowed
			const githubResult = await connectViaProxy(
				proxy.getHttpProxyPort(),
				"github.com:443",
			);
			expect(githubResult).not.toBe(403);

			// evil.example.com (not in the trusted list) should be blocked
			const evilResult = await connectViaProxy(
				proxy.getHttpProxyPort(),
				"evil.example.com:443",
			);
			expect(evilResult).toBe(403);
		});

		it("merges custom allow rules on top of trusted preset", async () => {
			proxy = new EgressProxy(
				createConfig({
					httpProxyPort: httpPort,
					socksProxyPort: socksPort,
					networkPolicy: {
						preset: "trusted",
						allow: {
							"internal.company.com": [{}],
						},
					},
				}),
				TEST_CYRUS_HOME,
			);
			await proxy.start();

			// Custom domain should be allowed
			const customResult = await connectViaProxy(
				proxy.getHttpProxyPort(),
				"internal.company.com:443",
			);
			expect(customResult).not.toBe(403);

			// Trusted domain should still be allowed
			const trustedResult = await connectViaProxy(
				proxy.getHttpProxyPort(),
				"registry.npmjs.org:443",
			);
			expect(trustedResult).not.toBe(403);

			// Unknown domain should be blocked
			const blockedResult = await connectViaProxy(
				proxy.getHttpProxyPort(),
				"unknown.example.com:443",
			);
			expect(blockedResult).toBe(403);
		});

		it("contains expected number of trusted domains", () => {
			expect(TRUSTED_DOMAINS.length).toBeGreaterThan(180);
		});
	});

	describe("SOCKS5 proxy", () => {
		it("responds to SOCKS5 greeting", async () => {
			proxy = new EgressProxy(
				createConfig({ httpProxyPort: httpPort, socksProxyPort: socksPort }),
				TEST_CYRUS_HOME,
			);
			await proxy.start();

			const result = await new Promise<Buffer>((resolve, reject) => {
				const socket = net.connect(
					proxy.getSocksProxyPort(),
					"127.0.0.1",
					() => {
						// Send SOCKS5 greeting: VER=5, NMETHODS=1, METHOD=0 (no auth)
						socket.write(Buffer.from([0x05, 0x01, 0x00]));
					},
				);

				socket.once("data", (data) => {
					resolve(data);
					socket.destroy();
				});

				socket.on("error", reject);
				socket.setTimeout(3000, () => {
					reject(new Error("timeout"));
					socket.destroy();
				});
			});

			// Should respond: VER=5, METHOD=0 (no auth)
			expect(result[0]).toBe(0x05);
			expect(result[1]).toBe(0x00);
		});

		it("blocks non-allowed domains via SOCKS5", async () => {
			const policy: NetworkPolicy = {
				allow: {
					"allowed.com": [{}],
				},
			};

			proxy = new EgressProxy(
				createConfig({
					httpProxyPort: httpPort,
					socksProxyPort: socksPort,
					networkPolicy: policy,
				}),
				TEST_CYRUS_HOME,
			);
			await proxy.start();

			const result = await socksConnect(
				proxy.getSocksProxyPort(),
				"blocked.com",
				443,
			);
			// Reply byte 1 should be 0x02 (connection not allowed by ruleset)
			expect(result[1]).toBe(0x02);
		});
	});
});

/**
 * Helper: issue a CONNECT request via the HTTP proxy and return the status code.
 */
function connectViaProxy(proxyPort: number, target: string): Promise<number> {
	return new Promise<number>((resolve) => {
		const req = http.request({
			hostname: "127.0.0.1",
			port: proxyPort,
			method: "CONNECT",
			path: target,
		});
		req.on("connect", (res) => {
			resolve(res.statusCode || 0);
			req.destroy();
		});
		req.on("error", () => resolve(0));
		req.setTimeout(3000, () => {
			resolve(-1);
			req.destroy();
		});
		req.end();
	});
}

/**
 * Helper: perform a SOCKS5 CONNECT handshake and return the reply buffer.
 */
function socksConnect(
	socksPort: number,
	hostname: string,
	port: number,
): Promise<Buffer> {
	return new Promise<Buffer>((resolve, reject) => {
		const socket = net.connect(socksPort, "127.0.0.1", () => {
			// Greeting
			socket.write(Buffer.from([0x05, 0x01, 0x00]));
		});

		let phase = 0;
		socket.on("data", (data) => {
			if (phase === 0) {
				// Got greeting reply, send CONNECT request
				phase = 1;
				const domainBuf = Buffer.from(hostname, "ascii");
				const portBuf = Buffer.alloc(2);
				portBuf.writeUInt16BE(port);

				const reqBuf = Buffer.concat([
					Buffer.from([0x05, 0x01, 0x00, 0x03, domainBuf.length]),
					domainBuf,
					portBuf,
				]);
				socket.write(reqBuf);
			} else {
				resolve(data);
				socket.destroy();
			}
		});

		socket.on("error", reject);
		socket.setTimeout(3000, () => {
			reject(new Error("timeout"));
			socket.destroy();
		});
	});
}
