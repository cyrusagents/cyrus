import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	GITHUB_WEBHOOK_CIDRS_FALLBACK,
	GITLAB_WEBHOOK_CIDRS,
	ipMatchesAllowlist,
	ipMatchesCidr,
	ipToNumber,
	LINEAR_WEBHOOK_IPS,
	normalizeIp,
	parseCidr,
	WebhookIpValidator,
} from "../../src/security/WebhookIpValidator.js";

describe("IP utility functions", () => {
	describe("ipToNumber", () => {
		it("converts 0.0.0.0 to 0", () => {
			expect(ipToNumber("0.0.0.0")).toBe(0);
		});

		it("converts 255.255.255.255 to 4294967295", () => {
			expect(ipToNumber("255.255.255.255")).toBe(4294967295);
		});

		it("converts 192.168.1.1 correctly", () => {
			// 192*2^24 + 168*2^16 + 1*2^8 + 1 = 3232235777
			expect(ipToNumber("192.168.1.1")).toBe(3232235777);
		});
	});

	describe("parseCidr", () => {
		it("parses plain IP as /32", () => {
			const { base, mask } = parseCidr("10.0.0.1");
			expect(base).toBe(ipToNumber("10.0.0.1"));
			expect(mask).toBe(0xffffffff);
		});

		it("parses /24 CIDR", () => {
			const { base, mask } = parseCidr("192.168.1.0/24");
			expect(base).toBe(ipToNumber("192.168.1.0"));
			expect(mask).toBe(0xffffff00);
		});

		it("parses /20 CIDR", () => {
			const { base, mask } = parseCidr("140.82.112.0/20");
			expect(base).toBe(ipToNumber("140.82.112.0"));
			expect(mask).toBe(0xfffff000);
		});

		it("parses /22 CIDR", () => {
			const { base, mask } = parseCidr("192.30.252.0/22");
			expect(base).toBe(ipToNumber("192.30.252.0"));
			expect(mask).toBe(0xfffffc00);
		});

		it("parses /0 as match-all", () => {
			const { mask } = parseCidr("0.0.0.0/0");
			expect(mask).toBe(0);
		});
	});

	describe("ipMatchesCidr", () => {
		it("matches exact IP", () => {
			expect(ipMatchesCidr("35.231.147.226", "35.231.147.226")).toBe(true);
		});

		it("does not match different IP", () => {
			expect(ipMatchesCidr("35.231.147.227", "35.231.147.226")).toBe(false);
		});

		it("matches IP within /24 range", () => {
			expect(ipMatchesCidr("192.168.1.100", "192.168.1.0/24")).toBe(true);
			expect(ipMatchesCidr("192.168.1.255", "192.168.1.0/24")).toBe(true);
		});

		it("does not match IP outside /24 range", () => {
			expect(ipMatchesCidr("192.168.2.1", "192.168.1.0/24")).toBe(false);
		});

		it("matches IP within /20 range", () => {
			// 140.82.112.0/20 covers 140.82.112.0 - 140.82.127.255
			expect(ipMatchesCidr("140.82.112.0", "140.82.112.0/20")).toBe(true);
			expect(ipMatchesCidr("140.82.127.255", "140.82.112.0/20")).toBe(true);
			expect(ipMatchesCidr("140.82.120.50", "140.82.112.0/20")).toBe(true);
		});

		it("does not match IP outside /20 range", () => {
			expect(ipMatchesCidr("140.82.128.0", "140.82.112.0/20")).toBe(false);
		});

		it("matches IP within /22 range", () => {
			// 192.30.252.0/22 covers 192.30.252.0 - 192.30.255.255
			expect(ipMatchesCidr("192.30.252.0", "192.30.252.0/22")).toBe(true);
			expect(ipMatchesCidr("192.30.255.255", "192.30.252.0/22")).toBe(true);
			expect(ipMatchesCidr("192.30.253.100", "192.30.252.0/22")).toBe(true);
		});

		it("does not match IP outside /22 range", () => {
			expect(ipMatchesCidr("192.30.251.255", "192.30.252.0/22")).toBe(false);
		});
	});

	describe("normalizeIp", () => {
		it("strips ::ffff: prefix from IPv4-mapped IPv6", () => {
			expect(normalizeIp("::ffff:192.168.1.1")).toBe("192.168.1.1");
		});

		it("returns plain IPv4 unchanged", () => {
			expect(normalizeIp("10.0.0.1")).toBe("10.0.0.1");
		});

		it("returns pure IPv6 unchanged", () => {
			expect(normalizeIp("::1")).toBe("::1");
		});
	});

	describe("ipMatchesAllowlist", () => {
		it("matches IP in a list of exact IPs", () => {
			const allowlist = ["10.0.0.1", "10.0.0.2", "10.0.0.3"];
			expect(ipMatchesAllowlist("10.0.0.2", allowlist)).toBe(true);
		});

		it("does not match IP not in list", () => {
			const allowlist = ["10.0.0.1", "10.0.0.2"];
			expect(ipMatchesAllowlist("10.0.0.3", allowlist)).toBe(false);
		});

		it("matches IPv4-mapped IPv6 address", () => {
			const allowlist = ["10.0.0.1"];
			expect(ipMatchesAllowlist("::ffff:10.0.0.1", allowlist)).toBe(true);
		});

		it("matches IP against CIDR ranges", () => {
			const allowlist = ["192.30.252.0/22", "140.82.112.0/20"];
			expect(ipMatchesAllowlist("192.30.253.100", allowlist)).toBe(true);
			expect(ipMatchesAllowlist("140.82.120.50", allowlist)).toBe(true);
		});

		it("rejects pure IPv6 addresses", () => {
			const allowlist = ["10.0.0.0/8"];
			expect(ipMatchesAllowlist("::1", allowlist)).toBe(false);
			expect(ipMatchesAllowlist("fe80::1", allowlist)).toBe(false);
		});

		it("handles empty allowlist", () => {
			expect(ipMatchesAllowlist("10.0.0.1", [])).toBe(false);
		});
	});
});

describe("Known provider allowlists", () => {
	it("has 6 Linear webhook IPs", () => {
		expect(LINEAR_WEBHOOK_IPS).toHaveLength(6);
	});

	it("all Linear IPs are valid IPv4", () => {
		for (const ip of LINEAR_WEBHOOK_IPS) {
			expect(ip).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
		}
	});

	it("has GitHub fallback CIDRs", () => {
		expect(GITHUB_WEBHOOK_CIDRS_FALLBACK.length).toBeGreaterThan(0);
	});

	it("has GitLab CIDRs", () => {
		expect(GITLAB_WEBHOOK_CIDRS.length).toBeGreaterThan(0);
	});
});

describe("WebhookIpValidator", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("constructor", () => {
		it("is enabled by default", () => {
			const validator = new WebhookIpValidator();
			expect(validator.isEnabled()).toBe(true);
		});

		it("can be disabled", () => {
			const validator = new WebhookIpValidator({ enabled: false });
			expect(validator.isEnabled()).toBe(false);
		});

		it("uses default allowlists when none provided", () => {
			const validator = new WebhookIpValidator();
			expect(validator.getAllowlist("linear")).toEqual([...LINEAR_WEBHOOK_IPS]);
			expect(validator.getAllowlist("github")).toEqual([
				...GITHUB_WEBHOOK_CIDRS_FALLBACK,
			]);
			expect(validator.getAllowlist("gitlab")).toEqual([
				...GITLAB_WEBHOOK_CIDRS,
			]);
		});

		it("accepts custom allowlists", () => {
			const custom = { linear: ["1.2.3.4"] as const };
			const validator = new WebhookIpValidator({
				customAllowlists: custom,
			});
			expect(validator.getAllowlist("linear")).toEqual(["1.2.3.4"]);
			// Others should still use defaults
			expect(validator.getAllowlist("github")).toEqual([
				...GITHUB_WEBHOOK_CIDRS_FALLBACK,
			]);
		});
	});

	describe("validate", () => {
		it("allows any IP when disabled", () => {
			const validator = new WebhookIpValidator({ enabled: false });
			expect(validator.validate("1.2.3.4", "linear")).toBe(true);
			expect(validator.validate("255.255.255.255", "github")).toBe(true);
		});

		it("allows known Linear IPs", () => {
			const validator = new WebhookIpValidator();
			for (const ip of LINEAR_WEBHOOK_IPS) {
				expect(validator.validate(ip, "linear")).toBe(true);
			}
		});

		it("rejects unknown IPs for Linear", () => {
			const validator = new WebhookIpValidator();
			expect(validator.validate("1.2.3.4", "linear")).toBe(false);
		});

		it("allows IPs within GitHub CIDR ranges", () => {
			const validator = new WebhookIpValidator();
			// 192.30.252.0/22 should include 192.30.253.1
			expect(validator.validate("192.30.253.1", "github")).toBe(true);
		});

		it("rejects IPs outside GitHub CIDR ranges", () => {
			const validator = new WebhookIpValidator();
			expect(validator.validate("8.8.8.8", "github")).toBe(false);
		});

		it("handles IPv4-mapped IPv6 addresses", () => {
			const validator = new WebhookIpValidator();
			// Linear IP in IPv6-mapped form
			expect(validator.validate("::ffff:35.231.147.226", "linear")).toBe(true);
		});
	});

	describe("refreshGitHubAllowlist", () => {
		it("updates allowlist from GitHub /meta API", async () => {
			const mockCidrs = ["1.0.0.0/8", "2.0.0.0/8"];

			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ hooks: mockCidrs }),
			}) as unknown as typeof fetch;

			const validator = new WebhookIpValidator();
			await validator.refreshGitHubAllowlist();

			expect(validator.getAllowlist("github")).toEqual(mockCidrs);

			// Clean up
			vi.mocked(global.fetch).mockRestore();
		});

		it("keeps fallback on API failure", async () => {
			global.fetch = vi
				.fn()
				.mockRejectedValue(
					new Error("Network error"),
				) as unknown as typeof fetch;

			const validator = new WebhookIpValidator();
			await validator.refreshGitHubAllowlist();

			expect(validator.getAllowlist("github")).toEqual([
				...GITHUB_WEBHOOK_CIDRS_FALLBACK,
			]);

			vi.mocked(global.fetch).mockRestore();
		});

		it("keeps fallback on non-OK response", async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 403,
			}) as unknown as typeof fetch;

			const validator = new WebhookIpValidator();
			await validator.refreshGitHubAllowlist();

			expect(validator.getAllowlist("github")).toEqual([
				...GITHUB_WEBHOOK_CIDRS_FALLBACK,
			]);

			vi.mocked(global.fetch).mockRestore();
		});
	});
});
