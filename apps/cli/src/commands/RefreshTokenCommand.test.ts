import type { EdgeConfig } from "atmiko-core";
import open from "open";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Application } from "../Application.js";
import { RefreshTokenCommand } from "./RefreshTokenCommand.js";

vi.mock("open", () => ({ default: vi.fn() }));
vi.mock("../ui/CLIPrompts.js", () => ({
	CLIPrompts: { ask: vi.fn().mockResolvedValue("all") },
}));

describe("RefreshTokenCommand private apps", () => {
	let config: EdgeConfig;
	const fetchMock = vi.fn<typeof fetch>();
	const logger = { error: vi.fn(), success: vi.fn() };
	const update = vi.fn((mutate: (config: EdgeConfig) => EdgeConfig) => {
		config = mutate(config);
	});

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.stubGlobal("fetch", fetchMock);
		config = {
			repositories: [],
			linearWorkspaces: Object.fromEntries(
				["a", "b"].map((id) => [
					id,
					{
						linearToken: `lin_oauth_old-${id}`,
						linearRefreshToken: `refresh-${id}`,
						linearWorkspaceName: id,
						linearWorkspaceSlug: `slug-${id}`,
						linearOAuth: {
							clientId: `app-${id}`,
							clientSecret: `secret-${id}`,
							webhookSecret: `webhook-${id}`,
						},
					},
				]),
			),
		};
		fetchMock.mockImplementation(async (url, init) => {
			if (String(url).endsWith("/graphql"))
				return Response.json({ errors: [{ message: "Expired" }] });
			const params = new URLSearchParams(String(init?.body));
			const id = params.get("client_id")?.slice(-1);
			expect(params.get("client_secret")).toBe(`secret-${id}`);
			expect(params.get("refresh_token")).toBe(`refresh-${id}`);
			return Response.json({
				access_token: `lin_oauth_new-${id}`,
				refresh_token: `rotated-${id}`,
			});
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	async function run() {
		const app = {
			config: { exists: () => true, load: () => config, update },
			logger,
		} as unknown as Application;
		await new RefreshTokenCommand(app).execute([]);
	}

	it("refreshes all private apps directly and preserves their secrets and metadata", async () => {
		const before = structuredClone(config.linearWorkspaces!);
		await run();
		expect(open).not.toHaveBeenCalled();
		expect(update).toHaveBeenCalledTimes(2);
		for (const id of ["a", "b"]) {
			expect(config.linearWorkspaces![id]).toEqual({
				...before[id],
				linearToken: `lin_oauth_new-${id}`,
				linearRefreshToken: `rotated-${id}`,
			});
		}
	});

	it("does not send a private workspace through the shared proxy when its refresh token is missing", async () => {
		delete config.linearWorkspaces!.a!.linearRefreshToken;
		await run();
		expect(open).not.toHaveBeenCalled();
		expect(update).toHaveBeenCalledTimes(1);
		expect(config.linearWorkspaces!.a!.linearToken).toBe("lin_oauth_old-a");
		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining("self-auth-linear"),
		);
	});

	it("leaves stored credentials intact on refresh failure", async () => {
		const before = structuredClone(config);
		fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
		await run();
		expect(config).toEqual(before);
		expect(update).not.toHaveBeenCalled();
		expect(open).not.toHaveBeenCalled();
	});
});
