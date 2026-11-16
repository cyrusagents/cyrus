import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
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

describe("auth preserves credentials and replaces pairing settings", () => {
	it.each([
		{ serverPort: 19119, paired: true },
		{ serverPort: undefined, paired: true },
		{ serverPort: undefined, paired: false },
	])("preserves provider settings with registration %j", async ({
		serverPort,
		paired,
	}) => {
		const home = mkdtempSync(join(tmpdir(), "cyrus-auth-port-"));
		homes.push(home);
		for (const name of [
			"CLOUDFLARE_TOKEN",
			"CYRUS_API_KEY",
			"CYRUS_SETUP_PENDING",
			"CYRUS_SERVER_PORT",
			"CYRUS_TEAM_ID",
			"CYRUS_DEVICE_ID",
			"CYRUS_APP_URL",
			"SLACK_BOT_TOKEN",
			"CLAUDE_CODE_OAUTH_TOKEN",
			"LOCAL_SETTING",
		])
			vi.stubEnv(name, undefined);
		writeFileSync(
			join(home, ".env"),
			'# Local settings\nSLACK_BOT_TOKEN=fixture-slack\nCLAUDE_CODE_OAUTH_TOKEN="fixture-claude"\nLOCAL_SETTING="contains # and spaces"\nCYRUS_API_KEY=old-api\nexport CYRUS_DEVICE_ID=old-device\nCYRUS_SERVER_PORT=9999\n',
		);
		vi.stubEnv("CYRUS_TEAM_ID", "old-team");
		vi.stubEnv("CYRUS_DEVICE_ID", "old-device");
		vi.stubEnv("CYRUS_APP_URL", "https://staging.app.atcyrus.com");
		vi.spyOn(console, "log").mockImplementation(() => {});
		getConfig.mockResolvedValue({
			success: true,
			config: {
				cloudflareToken: "fixture-tunnel",
				apiKey: "fixture-api",
				teamId: paired ? "fixture-team" : undefined,
				deviceId: paired ? "fixture-device" : undefined,
				serverPort,
			},
		});
		start.mockImplementation(async () => {
			expect(process.env.CYRUS_SERVER_PORT).toBe(
				serverPort === undefined ? undefined : "19119",
			);
			expect(process.env.CYRUS_SETUP_PENDING).toBe("true");
			expect(process.env.SLACK_BOT_TOKEN).toBe("fixture-slack");
			expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("fixture-claude");
			expect(process.env.LOCAL_SETTING).toBe("contains # and spaces");
		});
		const app = {
			cyrusHome: home,
			logger: { success: vi.fn(), error: vi.fn(), divider: vi.fn() },
		} as unknown as Application;
		await new AuthCommand(app).execute(["fixture-auth"]);
		expect(start).toHaveBeenCalledOnce();
		expect(getConfig).toHaveBeenCalledWith(
			"fixture-auth",
			expect.objectContaining({
				hostname: expect.any(String),
				platform: expect.any(String),
				arch: expect.any(String),
				cores: expect.any(Number),
				memory: expect.any(Number),
			}),
		);
		expect(process.env.CYRUS_TEAM_ID).toBe(paired ? "fixture-team" : undefined);
		expect(process.env.CYRUS_DEVICE_ID).toBe(
			paired ? "fixture-device" : undefined,
		);
		const env = readFileSync(join(home, ".env"), "utf8");
		expect(env).toContain("# Local settings");
		expect(env).toContain("CYRUS_APP_URL=https://staging.app.atcyrus.com");
		expect(env).not.toContain("old-api");
		expect(env).not.toContain("old-device");
		expect(statSync(join(home, ".env")).mode & 0o777).toBe(0o600);
		if (serverPort === undefined)
			expect(env).not.toContain("CYRUS_SERVER_PORT");
		else expect(env).toContain("CYRUS_SERVER_PORT=19119\n");
	});
});
