import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Application } from "../Application.js";
import { AuthCommand } from "./AuthCommand.js";

let directory: string | undefined;
afterEach(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

it("pairs and starts on the same preview origin, persists it privately and never logs credentials", async () => {
	directory = mkdtempSync(join(tmpdir(), "cyrus-auth-preview-"));
	const envPath = join(directory, ".env");
	writeFileSync(envPath, "previous fixture configuration", { mode: 0o644 });
	vi.stubEnv("CYRUS_APP_URL", "https://cyrus-preview-cyhost-1321.vercel.app/");
	for (const name of [
		"CLOUDFLARE_TOKEN",
		"CYRUS_API_KEY",
		"CYRUS_SETUP_PENDING",
	])
		vi.stubEnv(name, undefined);
	const fetcher = vi.fn().mockResolvedValue(
		Response.json({
			success: true,
			config: {
				cloudflareToken: "private-fixture-tunnel",
				apiKey: "private-fixture-key",
			},
		}),
	);
	vi.stubGlobal("fetch", fetcher);
	const log = vi.fn();
	vi.spyOn(console, "log").mockImplementation(log);
	vi.spyOn(console, "error").mockImplementation(log);
	const starts: string[] = [];
	const app = {
		cyrusHome: directory,
		version: "test",
		config: { load: () => ({ repositories: [] }) },
		logger: { success: log, error: log, divider: log, raw: log, info: log },
		worker: {
			startEdgeWorker: async () => {
				starts.push(process.env.CYRUS_APP_URL!);
			},
			getServerPort: () => 3456,
		},
		setupSignalHandlers: vi.fn(),
	} as unknown as Application;
	await new AuthCommand(app).execute(["private-fixture-code"]);
	expect(fetcher).toHaveBeenCalledWith(
		"https://cyrus-preview-cyhost-1321.vercel.app/api/config",
		expect.objectContaining({
			headers: {
				Authorization: "Bearer private-fixture-code",
				"X-Cyrus-Config-Capabilities": "self-host-port-v1",
			},
			redirect: "error",
		}),
	);
	expect(starts).toEqual(["https://cyrus-preview-cyhost-1321.vercel.app/"]);
	expect(readFileSync(envPath, "utf8")).toContain(
		"CYRUS_APP_URL=https://cyrus-preview-cyhost-1321.vercel.app\n",
	);
	expect(statSync(envPath).mode & 0o777).toBe(0o600);
	for (const secret of [
		"private-fixture-code",
		"private-fixture-key",
		"private-fixture-tunnel",
	])
		expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
});
