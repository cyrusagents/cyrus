import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinearIssueTrackerService } from "../src/LinearIssueTrackerService.js";

/**
 * Tests for proactive OAuth token refresh (CRATE-153).
 *
 * Linear access tokens live ~24h and Linear REVOKES the old access token the
 * moment a refresh is performed. These tests cover:
 *  - expiry tracking from the refresh response (expires_in -> expiresAt)
 *  - ensureFreshToken(): refreshes when expiry is unknown or within the
 *    threshold, no-ops when the token has plenty of runway
 *  - coalescing: concurrent ensureFreshToken calls share one HTTP refresh
 */

function makeMockLinearClient() {
	return {
		client: {
			request: vi.fn().mockResolvedValue({}),
			setHeader: vi.fn(),
		},
	} as any;
}

function makeOAuthConfig(overrides: Record<string, unknown> = {}) {
	return {
		clientId: "client-id",
		clientSecret: "client-secret",
		refreshToken: "refresh-token-1",
		workspaceId: `ws-${Math.random().toString(36).slice(2)}`,
		...overrides,
	} as any;
}

function mockRefreshResponse(accessToken = "new-access", expiresIn = 86399) {
	return {
		ok: true,
		json: async () => ({
			access_token: accessToken,
			refresh_token: "new-refresh",
			expires_in: expiresIn,
		}),
	} as Response;
}

describe("LinearIssueTrackerService proactive token refresh", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(mockRefreshResponse());
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("reports token expiry from oauth config", () => {
		const expiresAt = Date.now() + 10_000_000;
		const service = new LinearIssueTrackerService(
			makeMockLinearClient(),
			makeOAuthConfig({ expiresAt }),
		);
		expect(service.getTokenExpiresAt()).toBe(expiresAt);
	});

	it("ensureFreshToken refreshes when expiry is unknown", async () => {
		const service = new LinearIssueTrackerService(
			makeMockLinearClient(),
			makeOAuthConfig(),
		);
		const result = await service.ensureFreshToken(60 * 60 * 1000);
		expect(result.refreshed).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("ensureFreshToken no-ops when the token has runway beyond the threshold", async () => {
		const service = new LinearIssueTrackerService(
			makeMockLinearClient(),
			makeOAuthConfig({ expiresAt: Date.now() + 20 * 60 * 60 * 1000 }),
		);
		const result = await service.ensureFreshToken(60 * 60 * 1000);
		expect(result.refreshed).toBe(false);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("ensureFreshToken refreshes when remaining ttl is below the threshold", async () => {
		const client = makeMockLinearClient();
		const service = new LinearIssueTrackerService(
			client,
			makeOAuthConfig({ expiresAt: Date.now() + 10 * 60 * 1000 }),
		);
		const result = await service.ensureFreshToken(60 * 60 * 1000);
		expect(result.refreshed).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		// the instance's client must start using the new token immediately
		expect(client.client.setHeader).toHaveBeenCalledWith(
			"Authorization",
			"Bearer new-access",
		);
	});

	it("updates tracked expiry after a refresh", async () => {
		const before = Date.now();
		const service = new LinearIssueTrackerService(
			makeMockLinearClient(),
			makeOAuthConfig({ expiresAt: Date.now() + 1000 }),
		);
		await service.ensureFreshToken(60 * 60 * 1000);
		const expiresAt = service.getTokenExpiresAt();
		expect(expiresAt).not.toBeNull();
		// ~24h from now (expires_in 86399s)
		expect(expiresAt!).toBeGreaterThan(before + 86_000_000);
	});

	it("passes expiresAt to onTokenRefresh so callers can persist it", async () => {
		const onTokenRefresh = vi.fn();
		const service = new LinearIssueTrackerService(
			makeMockLinearClient(),
			makeOAuthConfig({ expiresAt: Date.now() + 1000, onTokenRefresh }),
		);
		await service.ensureFreshToken(60 * 60 * 1000);
		expect(onTokenRefresh).toHaveBeenCalledTimes(1);
		const arg = onTokenRefresh.mock.calls[0][0];
		expect(arg.accessToken).toBe("new-access");
		expect(arg.refreshToken).toBe("new-refresh");
		expect(typeof arg.expiresAt).toBe("number");
		expect(arg.expiresAt).toBeGreaterThan(Date.now());
	});

	it("coalesces concurrent ensureFreshToken calls into one HTTP refresh", async () => {
		const service = new LinearIssueTrackerService(
			makeMockLinearClient(),
			makeOAuthConfig({ expiresAt: Date.now() + 1000 }),
		);
		const [a, b] = await Promise.all([
			service.ensureFreshToken(60 * 60 * 1000),
			service.ensureFreshToken(60 * 60 * 1000),
		]);
		expect(a.refreshed).toBe(true);
		expect(b.refreshed).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("ensureFreshToken no-ops without oauth config", async () => {
		const service = new LinearIssueTrackerService(makeMockLinearClient());
		const result = await service.ensureFreshToken(60 * 60 * 1000);
		expect(result.refreshed).toBe(false);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("setAccessToken records the new expiry when provided", () => {
		const service = new LinearIssueTrackerService(
			makeMockLinearClient(),
			makeOAuthConfig({ expiresAt: Date.now() + 1000 }),
		);
		const newExpiry = Date.now() + 86_399_000;
		service.setAccessToken("rotated-token", newExpiry);
		expect(service.getTokenExpiresAt()).toBe(newExpiry);
	});
});
