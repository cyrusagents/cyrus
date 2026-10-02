import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Application } from "../Application.js";

const { getConfig, start } = vi.hoisted(() => ({
	getConfig: vi.fn(),
	start: vi.fn(),
}));
vi.mock("cyrus-cloudflare-tunnel-client", async (original) => ({
	...(await original<object>()),
	ConfigApiClient: {
		getConfig,
		isValid: (r: { success: boolean }) => r.success,
	},
}));
vi.mock("./StartCommand.js", () => ({
	StartCommand: class {
		execute = start;
	},
}));

import { AuthCommand } from "./AuthCommand.js";

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe("auth listener port persistence", () => {
	it.each([
		19119,
		undefined,
	])("writes and reloads hosted port %s before starting", async (serverPort) => {
		const home = mkdtempSync(join(tmpdir(), "cyrus-auth-port-"));
		homes.push(home);
		for (const name of [
			"CLOUDFLARE_TOKEN",
			"CYRUS_API_KEY",
			"CYRUS_SETUP_PENDING",
			"CYRUS_SERVER_PORT",
		])
			vi.stubEnv(name, undefined);
		vi.spyOn(console, "log").mockImplementation(() => {});
		getConfig.mockResolvedValue({
			success: true,
			config: {
				cloudflareToken: "fixture-tunnel",
				apiKey: "fixture-api",
				serverPort,
			},
		});
		start.mockImplementation(async () => {
			expect(process.env.CYRUS_SERVER_PORT).toBe(
				serverPort === undefined ? undefined : "19119",
			);
			expect(process.env.CYRUS_SETUP_PENDING).toBe("true");
		});
		const app = {
			cyrusHome: home,
			logger: { success: vi.fn(), error: vi.fn(), divider: vi.fn() },
		} as unknown as Application;
		await new AuthCommand(app).execute(["fixture-auth"]);
		expect(start).toHaveBeenCalledOnce();
		const env = readFileSync(join(home, ".env"), "utf8");
		if (serverPort === undefined)
			expect(env).not.toContain("CYRUS_SERVER_PORT");
		else expect(env).toContain("CYRUS_SERVER_PORT=19119\n");
	});
});
