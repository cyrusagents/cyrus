import type { LinearClient } from "@linear/sdk";
import type { ILogger } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	LinearIssueTrackerService,
	type LinearOAuthConfig,
} from "../src/LinearIssueTrackerService.js";

/**
 * Characterization tests for the OAuth token-refresh cluster inside
 * LinearIssueTrackerService, pinned BEFORE any extraction. These assert
 * observable behavior only (headers set, retry issued, callbacks invoked,
 * shared-map contents) so a later extraction to a standalone
 * LinearTokenRefresher module can be verified against them unchanged.
 *
 * The two static maps (pendingRefreshes, workspaceRefreshTokens) are
 * process-global and persist for the lifetime of this test module, so every
 * test uses a fresh, unique workspaceId to avoid cross-test interference.
 */

let workspaceCounter = 0;
function uniqueWorkspaceId(): string {
	workspaceCounter += 1;
	return `workspace-${workspaceCounter}`;
}

function createMockLogger(): ILogger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		event: vi.fn(),
		withContext: vi.fn(function (this: ILogger) {
			return this;
		}),
		getLevel: vi.fn(),
		setLevel: vi.fn(),
	} as unknown as ILogger;
}

/** Build a minimal LinearClient mock with a patchable `.client.request`. */
function createMockLinearClient(requestImpl: (...args: unknown[]) => unknown) {
	const setHeader = vi.fn();
	const request = vi.fn(requestImpl);
	const linearClient = {
		client: {
			request,
			setHeader,
		},
	};
	return {
		linearClient: linearClient as unknown as LinearClient,
		request,
		setHeader,
	};
}

/**
 * The `isRetry` flag lives only on the recursive self-call the patched
 * `client.request` wrapper makes to itself (`(client.request as any)(...,
 * true)`) - it is never forwarded to the wrapped `originalRequest`. To
 * observe it, splice a recording spy into `linearClient.client.request`
 * *after* construction: since the constructor closes over the `client`
 * object (not a snapshot of `.request`), the wrapper's internal recursive
 * call reads whatever `client.request` currently is, so it flows through
 * this spy too.
 */
function spyOnPatchedRequest(linearClient: LinearClient) {
	const client = (linearClient as any).client;
	const wrapped = client.request;
	const calls: unknown[][] = [];
	client.request = (...args: unknown[]) => {
		calls.push(args);
		return wrapped(...args);
	};
	return { invoke: (...args: unknown[]) => client.request(...args), calls };
}

function makeOAuthConfig(
	overrides: Partial<LinearOAuthConfig> = {},
): LinearOAuthConfig {
	return {
		clientId: "client-id",
		clientSecret: "client-secret",
		refreshToken: "initial-refresh-token",
		workspaceId: uniqueWorkspaceId(),
		...overrides,
	};
}

function mockFetchOk(body: {
	access_token: string;
	refresh_token: string;
	expires_in?: number;
}) {
	return vi.fn().mockResolvedValue({
		ok: true,
		status: 200,
		json: vi.fn().mockResolvedValue({ expires_in: 3600, ...body }),
	});
}

function mockFetchNotOk(status: number) {
	return vi.fn().mockResolvedValue({
		ok: false,
		status,
		json: vi.fn(),
	});
}

const unauthorizedError = { status: 401 };

describe("LinearIssueTrackerService OAuth token-refresh (characterization)", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("refreshes on 401, sets the header, and retries with isRetry=true, succeeding", async () => {
		const oauthConfig = makeOAuthConfig();
		let callCount = 0;
		const { linearClient, request, setHeader } = createMockLinearClient(
			(..._args: unknown[]) => {
				callCount += 1;
				if (callCount === 1) {
					return Promise.reject(unauthorizedError);
				}
				return Promise.resolve({ data: "ok-after-refresh" });
			},
		);
		const fetchMock = mockFetchOk({
			access_token: "new-access-token",
			refresh_token: "new-refresh-token",
		});
		vi.stubGlobal("fetch", fetchMock);

		const service = new LinearIssueTrackerService(
			linearClient,
			oauthConfig,
			createMockLogger(),
		);

		const spy = spyOnPatchedRequest(linearClient);
		const result = await spy.invoke("query { x }", { a: 1 });

		expect(result).toEqual({ data: "ok-after-refresh" });
		expect(setHeader).toHaveBeenCalledWith(
			"Authorization",
			"Bearer new-access-token",
		);
		expect(request).toHaveBeenCalledTimes(2);
		// Two self-calls to the patched wrapper: the original, then the retry
		// marked isRetry=true as the 4th positional arg.
		expect(spy.calls).toHaveLength(2);
		expect(spy.calls[1]?.[3]).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		void service; // keep instance alive for clarity; behavior asserted via mocks
	});

	it("the isRetry guard prevents an infinite retry loop when the retry also 401s", async () => {
		const oauthConfig = makeOAuthConfig();
		const request = vi.fn().mockRejectedValue(unauthorizedError);
		const linearClient = {
			client: { request, setHeader: vi.fn() },
		} as unknown as LinearClient;
		const fetchMock = mockFetchOk({
			access_token: "new-access-token",
			refresh_token: "new-refresh-token",
		});
		vi.stubGlobal("fetch", fetchMock);

		new LinearIssueTrackerService(
			linearClient,
			oauthConfig,
			createMockLogger(),
		);

		const spy = spyOnPatchedRequest(linearClient);
		await expect(spy.invoke("query { x }", {})).rejects.toEqual(
			unauthorizedError,
		);

		// Exactly two attempts: the original + one retry. The retry's own 401
		// is not retried again (isRetry=true short-circuits), preventing a loop.
		expect(request).toHaveBeenCalledTimes(2);
		expect(spy.calls).toHaveLength(2);
		expect(spy.calls[1]?.[3]).toBe(true);
	});

	it("coalesces concurrent 401s on the same instance into a single refresh HTTP call", async () => {
		const oauthConfig = makeOAuthConfig();
		let callCount = 0;
		const { linearClient, request } = createMockLinearClient(() => {
			callCount += 1;
			// First two calls (the two concurrent original requests) 401.
			// Later calls (retries) succeed.
			if (callCount <= 2) {
				return Promise.reject(unauthorizedError);
			}
			return Promise.resolve({ data: `ok-${callCount}` });
		});
		const fetchMock = mockFetchOk({
			access_token: "new-access-token",
			refresh_token: "new-refresh-token",
		});
		vi.stubGlobal("fetch", fetchMock);

		new LinearIssueTrackerService(
			linearClient,
			oauthConfig,
			createMockLogger(),
		);

		const patchedRequest = linearClient.client.request;
		const [resultA, resultB] = await Promise.all([
			(patchedRequest as any)("query { a }", {}),
			(patchedRequest as any)("query { b }", {}),
		]);

		expect(resultA).toBeDefined();
		expect(resultB).toBeDefined();
		// Only one HTTP refresh call despite two concurrent 401s.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(request).toHaveBeenCalledTimes(4); // 2 original + 2 retries
	});

	it("coalesces concurrent refreshes across two instances via the static pendingRefreshes map", async () => {
		const workspaceId = uniqueWorkspaceId();
		const oauthConfigA = makeOAuthConfig({ workspaceId });
		const oauthConfigB = makeOAuthConfig({ workspaceId });

		const { linearClient: clientA } = createMockLinearClient(() =>
			Promise.resolve(),
		);
		const { linearClient: clientB } = createMockLinearClient(() =>
			Promise.resolve(),
		);

		const fetchMock = mockFetchOk({
			access_token: "shared-access-token",
			refresh_token: "shared-refresh-token",
		});
		vi.stubGlobal("fetch", fetchMock);

		const serviceA = new LinearIssueTrackerService(
			clientA,
			oauthConfigA,
			createMockLogger(),
		);
		const serviceB = new LinearIssueTrackerService(
			clientB,
			oauthConfigB,
			createMockLogger(),
		);

		// Invoke the private doTokenRefresh directly on both instances
		// (this is the seam the extraction targets) without awaiting between
		// the two calls, so they race through the static coalescing map.
		const refreshA = (serviceA as any).doTokenRefresh();
		const refreshB = (serviceB as any).doTokenRefresh();

		const [tokenA, tokenB] = await Promise.all([refreshA, refreshB]);

		expect(tokenA).toBe("shared-access-token");
		expect(tokenB).toBe("shared-access-token");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("shares workspaceRefreshTokens across instances: reads latest value, writes on refresh", async () => {
		const workspaceId = uniqueWorkspaceId();
		const oauthConfigA = makeOAuthConfig({
			workspaceId,
			refreshToken: "token-from-A",
		});
		const { linearClient: clientA } = createMockLinearClient(() =>
			Promise.resolve(),
		);
		const serviceA = new LinearIssueTrackerService(
			clientA,
			oauthConfigA,
			createMockLogger(),
		);

		// A second instance sharing the same workspaceId; its construction
		// overwrites the shared map with its own initial refresh token.
		const oauthConfigB = makeOAuthConfig({
			workspaceId,
			refreshToken: "token-from-B",
		});
		const { linearClient: clientB } = createMockLinearClient(() =>
			Promise.resolve(),
		);
		const serviceB = new LinearIssueTrackerService(
			clientB,
			oauthConfigB,
			createMockLogger(),
		);

		// The shared static map now holds B's token (last writer wins),
		// even when refreshing through A's instance - proving the read is
		// from the shared map, not from `this.oauthConfig.refreshToken`.
		let capturedBody: string | undefined;
		const fetchMock = vi.fn().mockImplementation((_url, init) => {
			capturedBody = init.body as string;
			return Promise.resolve({
				ok: true,
				status: 200,
				json: vi.fn().mockResolvedValue({
					access_token: "new-access-token",
					refresh_token: "written-by-A-refresh",
					expires_in: 3600,
				}),
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		await (serviceA as any).executeTokenRefresh();

		expect(capturedBody).toContain("refresh_token=token-from-B");

		// The write side: after A's refresh, the shared map reflects the new
		// refresh token for both instances (cross-instance visibility).
		const sharedMap = (LinearIssueTrackerService as any).workspaceRefreshTokens;
		expect(sharedMap.get(workspaceId)).toBe("written-by-A-refresh");

		void serviceB; // present only to establish "two instances" sharing state
	});

	it("executeTokenRefresh: HTTP success resolves the access token and posts form-encoded params", async () => {
		const oauthConfig = makeOAuthConfig({ refreshToken: "rt-1" });
		const { linearClient } = createMockLinearClient(() => Promise.resolve());
		const service = new LinearIssueTrackerService(
			linearClient,
			oauthConfig,
			createMockLogger(),
		);

		const fetchMock = mockFetchOk({
			access_token: "success-token",
			refresh_token: "next-rt",
		});
		vi.stubGlobal("fetch", fetchMock);

		const token = await (service as any).executeTokenRefresh();

		expect(token).toBe("success-token");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.linear.app/oauth/token",
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
			}),
		);
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = String(init.body);
		expect(body).toContain("grant_type=refresh_token");
		expect(body).toContain("client_id=client-id");
		expect(body).toContain("client_secret=client-secret");
		expect(body).toContain("refresh_token=rt-1");
	});

	it("executeTokenRefresh: non-ok HTTP status throws", async () => {
		const oauthConfig = makeOAuthConfig({ refreshToken: "rt-1" });
		const { linearClient } = createMockLinearClient(() => Promise.resolve());
		const service = new LinearIssueTrackerService(
			linearClient,
			oauthConfig,
			createMockLogger(),
		);

		vi.stubGlobal("fetch", mockFetchNotOk(400));

		await expect((service as any).executeTokenRefresh()).rejects.toThrow(
			"Token refresh failed: 400",
		);
	});

	it("fires the onTokenRefresh callback and swallows its failure", async () => {
		const onTokenRefresh = vi
			.fn()
			.mockRejectedValue(new Error("persist failed"));
		const oauthConfig = makeOAuthConfig({
			refreshToken: "rt-1",
			onTokenRefresh,
		});
		const { linearClient } = createMockLinearClient(() => Promise.resolve());
		const logger = createMockLogger();
		const service = new LinearIssueTrackerService(
			linearClient,
			oauthConfig,
			logger,
		);

		vi.stubGlobal(
			"fetch",
			mockFetchOk({ access_token: "at-1", refresh_token: "rt-2" }),
		);

		const token = await (service as any).executeTokenRefresh();

		expect(token).toBe("at-1");
		expect(onTokenRefresh).toHaveBeenCalledWith({
			accessToken: "at-1",
			refreshToken: "rt-2",
		});
		expect(logger.error).toHaveBeenCalledWith(
			"onTokenRefresh callback failed:",
			expect.any(Error),
		);
	});

	it("clears refreshPromise on refresh failure so the next 401 retries fresh", async () => {
		const oauthConfig = makeOAuthConfig();
		const { linearClient } = createMockLinearClient((..._args: unknown[]) =>
			// Every "original" (non-retry) call 401s so a refresh is attempted.
			Promise.reject(unauthorizedError),
		);

		// First refresh attempt fails (non-ok HTTP status).
		const failingFetch = mockFetchNotOk(500);
		vi.stubGlobal("fetch", failingFetch);

		const service = new LinearIssueTrackerService(
			linearClient,
			oauthConfig,
			createMockLogger(),
		);
		const patchedRequest = linearClient.client.request;

		await expect((patchedRequest as any)("query { x }", {})).rejects.toEqual(
			unauthorizedError,
		);

		expect((service as any).refreshPromise).toBeNull();
		expect(failingFetch).toHaveBeenCalledTimes(1);

		// Next attempt: refresh now succeeds via a fresh doTokenRefresh() call
		// (the same call the request-interceptor makes on the next 401),
		// proving the prior failure did not leave a stale rejected promise
		// cached on the instance.
		const succeedingFetch = mockFetchOk({
			access_token: "recovered-token",
			refresh_token: "recovered-refresh",
		});
		vi.stubGlobal("fetch", succeedingFetch);

		const freshToken = await (service as any).doTokenRefresh();
		expect(freshToken).toBe("recovered-token");
		expect(succeedingFetch).toHaveBeenCalledTimes(1);
	});

	it("setAccessToken clears refreshPromise and updates the Authorization header", () => {
		const oauthConfig = makeOAuthConfig();
		const { linearClient, setHeader } = createMockLinearClient(() =>
			Promise.resolve(),
		);
		const service = new LinearIssueTrackerService(
			linearClient,
			oauthConfig,
			createMockLogger(),
		);

		(service as any).refreshPromise = Promise.resolve("stale-token");

		service.setAccessToken("brand-new-token");

		expect((service as any).refreshPromise).toBeNull();
		expect(setHeader).toHaveBeenCalledWith(
			"Authorization",
			"Bearer brand-new-token",
		);
	});

	it("does not patch client.request when no oauthConfig is provided", async () => {
		const request = vi.fn().mockRejectedValue(unauthorizedError);
		const linearClient = {
			client: { request, setHeader: vi.fn() },
		} as unknown as LinearClient;

		new LinearIssueTrackerService(linearClient, undefined, createMockLogger());

		// Unpatched: a 401 just propagates, no refresh attempted, called once.
		await expect(
			(linearClient.client.request as any)("query { x }", {}),
		).rejects.toEqual(unauthorizedError);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("guards construction and setAccessToken when linearClient.client is absent (test-mock shape)", () => {
		const oauthConfig = makeOAuthConfig();
		const linearClientNoClient = {} as unknown as LinearClient;

		expect(
			() =>
				new LinearIssueTrackerService(
					linearClientNoClient,
					oauthConfig,
					createMockLogger(),
				),
		).not.toThrow();

		const service = new LinearIssueTrackerService(
			linearClientNoClient,
			oauthConfig,
			createMockLogger(),
		);

		expect(() => service.setAccessToken("some-token")).not.toThrow();
		expect(service.getClient()).toBe(linearClientNoClient);
	});
});
