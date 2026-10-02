import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dotenv from "dotenv";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureRuntimeBootstrap } from "./RuntimeBootstrap.js";

const origin = "https://cyrus-preview-cyhost-1321.vercel.app";
const team = "11111111-1111-4111-8111-111111111111";
let directory: string;
const payload = () => ({
	success: true,
	bootstrap: {
		contractVersion: 1,
		teamId: team,
		cyrusConfig: {
			repositories: [],
			defaultRunner: "codex",
			codexDefaultModel: "gpt-5.5",
		},
		environment: {
			CYRUS_TEAM_ID: team,
			OPENAI_API_KEY: "fixture-provider-key",
		},
	},
});
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "runtime-bootstrap-"));
	for (const [name, value] of Object.entries({
		CYRUS_APP_URL: origin,
		CYRUS_TEAM_ID: team,
		CYRUS_API_KEY: "fixture-key",
		CLOUDFLARE_TOKEN: "fixture-tunnel",
		CYRUS_SETUP_PENDING: "true",
		SERVER_PORT: "50967",
		ANTHROPIC_API_KEY: "stale-provider",
	}))
		vi.stubEnv(name, value);
	vi.stubEnv("OPENAI_API_KEY", undefined);
	writeFileSync(
		join(directory, ".env"),
		`CYRUS_API_KEY=fixture-key\nCLOUDFLARE_TOKEN=fixture-tunnel\nCYRUS_TEAM_ID=${team}\nSERVER_PORT=50967\nLOCAL_PATH='C:\\new\\repo'\nANTHROPIC_API_KEY=stale-provider\n`,
		{ mode: 0o600 },
	);
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload())));
});
afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});
it("bootstraps authenticated configuration before launch and preserves the selected origin/local port", async () => {
	expect(await ensureRuntimeBootstrap(directory)).toBe(true);
	expect(fetch).toHaveBeenCalledWith(
		`${origin}/api/config/runtime`,
		expect.objectContaining({
			headers: { Authorization: "Bearer fixture-key", "X-Cyrus-Team-Id": team },
			redirect: "error",
		}),
	);
	expect(
		JSON.parse(readFileSync(join(directory, "config.json"), "utf8")),
	).toMatchObject(payload().bootstrap.cyrusConfig);
	const env = dotenv.parse(readFileSync(join(directory, ".env")));
	expect(env).toEqual({
		CYRUS_API_KEY: "fixture-key",
		CLOUDFLARE_TOKEN: "fixture-tunnel",
		CYRUS_TEAM_ID: team,
		SERVER_PORT: "50967",
		LOCAL_PATH: "C:\\new\\repo",
		OPENAI_API_KEY: "fixture-provider-key",
		CYRUS_APP_URL: origin,
	});
	expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
	expect(process.env.OPENAI_API_KEY).toBe("fixture-provider-key");
	expect(process.env.CYRUS_SETUP_PENDING).toBeUndefined();
	for (const file of [".env", "config.json"])
		expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600);
	expect(await ensureRuntimeBootstrap(directory)).toBe(false);
	expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([
	"wrong-team",
	"origin-override",
	"credential-override",
	"unknown-contract",
	"redirect",
	"changed-pairing",
])("fails closed without changing files: %s", async (failure) => {
	const before = readFileSync(join(directory, ".env"), "utf8");
	const body = payload();
	if (failure === "wrong-team")
		body.bootstrap.teamId = "22222222-2222-4222-8222-222222222222";
	if (failure === "origin-override")
		Object.assign(body.bootstrap.environment, {
			CYRUS_APP_URL: "https://other.invalid",
		});
	if (failure === "credential-override")
		Object.assign(body.bootstrap.environment, { CYRUS_API_KEY: "forged" });
	if (failure === "unknown-contract") body.bootstrap.contractVersion = 2;
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			if (failure === "changed-pairing") process.env.CYRUS_API_KEY = "other";
			return failure === "redirect"
				? new Response("private error", { status: 302 })
				: Response.json(body);
		}),
	);
	await expect(ensureRuntimeBootstrap(directory)).rejects.toThrow(
		"Registered runtime bootstrap failed",
	);
	expect(readFileSync(join(directory, ".env"), "utf8")).toBe(before);
});
it("preserves configured unscoped startup without contacting hosted", async () => {
	vi.stubEnv("CYRUS_TEAM_ID", undefined);
	expect(await ensureRuntimeBootstrap(directory)).toBe(false);
	expect(fetch).not.toHaveBeenCalled();
});
