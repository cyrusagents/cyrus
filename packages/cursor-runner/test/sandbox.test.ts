import { describe, expect, it } from "vitest";
import { buildCursorSandboxJson, buildSandboxEnv } from "../src/sandbox.js";

describe("buildCursorSandboxJson", () => {
	const workspace = "/tmp/wkspc";

	it("returns null when sandbox is disabled", () => {
		expect(
			buildCursorSandboxJson({
				workspace,
				sandboxSettings: { enabled: false },
			}),
		).toBeNull();
		expect(buildCursorSandboxJson({ workspace })).toBeNull();
	});

	it("translates Claude SandboxSettings filesystem allowlists", () => {
		const cfg = buildCursorSandboxJson({
			workspace,
			sandboxSettings: {
				enabled: true,
				filesystem: {
					allowWrite: ["/tmp/wkspc", "/tmp/extra-write"],
					allowRead: [".", "/tmp/attachments"],
				},
			},
		});
		expect(cfg).not.toBeNull();
		expect(cfg!.type).toBe("workspace_readwrite");
		// workspace itself is implicit and stripped from extras
		expect(cfg!.additionalReadwritePaths).toEqual(["/tmp/extra-write"]);
		// "." (workspace shorthand) is stripped from extras
		expect(cfg!.additionalReadonlyPaths).toEqual(["/tmp/attachments"]);
	});

	it("translates network allow/deny lists with deny-default", () => {
		const cfg = buildCursorSandboxJson({
			workspace,
			sandboxSettings: {
				enabled: true,
				network: {
					allowedDomains: ["api.linear.app", "*.github.com"],
					deniedDomains: ["malware.example"],
				},
			},
		});
		expect(cfg!.networkPolicy.default).toBe("deny");
		expect(cfg!.networkPolicy.allow).toEqual([
			"*.github.com",
			"api.linear.app",
		]);
		expect(cfg!.networkPolicy.deny).toEqual(["malware.example"]);
	});

	it("adds 127.0.0.1/localhost to allow when an http proxy is configured", () => {
		const cfg = buildCursorSandboxJson({
			workspace,
			sandboxSettings: {
				enabled: true,
				network: { httpProxyPort: 9876 },
			},
		});
		expect(cfg!.networkPolicy.allow).toEqual(
			expect.arrayContaining(["127.0.0.1", "::1", "localhost"]),
		);
	});

	it("includes the egress CA cert path in additionalReadonlyPaths", () => {
		const cfg = buildCursorSandboxJson({
			workspace,
			sandboxSettings: { enabled: true },
			egressCaCertPath: "/Users/u/.cyrus/certs/cyrus-egress-ca.pem",
		});
		expect(cfg!.additionalReadonlyPaths).toContain(
			"/Users/u/.cyrus/certs/cyrus-egress-ca.pem",
		);
	});

	it("merges additionalReadwritePaths arg without duplicating workspace", () => {
		const cfg = buildCursorSandboxJson({
			workspace,
			sandboxSettings: { enabled: true },
			additionalReadwritePaths: [workspace, "/tmp/aux-repo"],
		});
		expect(cfg!.additionalReadwritePaths).toEqual(["/tmp/aux-repo"]);
	});
});

describe("buildSandboxEnv", () => {
	it("returns empty when sandbox is disabled", () => {
		expect(buildSandboxEnv({ sandboxSettings: { enabled: false } })).toEqual(
			{},
		);
		expect(buildSandboxEnv({})).toEqual({});
	});

	it("emits CA cert env vars when egressCaCertPath is set", () => {
		const env = buildSandboxEnv({
			sandboxSettings: { enabled: true },
			egressCaCertPath: "/abs/ca.pem",
		});
		expect(env.NODE_EXTRA_CA_CERTS).toBe("/abs/ca.pem");
		expect(env.SSL_CERT_FILE).toBe("/abs/ca.pem");
		expect(env.GIT_SSL_CAINFO).toBe("/abs/ca.pem");
		expect(env.REQUESTS_CA_BUNDLE).toBe("/abs/ca.pem");
		expect(env.CURL_CA_BUNDLE).toBe("/abs/ca.pem");
		expect(env.AWS_CA_BUNDLE).toBe("/abs/ca.pem");
	});

	it("emits HTTP_PROXY / HTTPS_PROXY when httpProxyPort is set", () => {
		const env = buildSandboxEnv({
			sandboxSettings: { enabled: true, network: { httpProxyPort: 9876 } },
		});
		expect(env.HTTP_PROXY).toBe("http://127.0.0.1:9876");
		expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:9876");
		expect(env.http_proxy).toBe(env.HTTP_PROXY);
		expect(env.https_proxy).toBe(env.HTTPS_PROXY);
	});

	it("emits ALL_PROXY when socksProxyPort is set", () => {
		const env = buildSandboxEnv({
			sandboxSettings: { enabled: true, network: { socksProxyPort: 1080 } },
		});
		expect(env.ALL_PROXY).toBe("socks5://127.0.0.1:1080");
		expect(env.all_proxy).toBe(env.ALL_PROXY);
	});
});
