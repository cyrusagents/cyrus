import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadRuntimeEnv } from "./loadRuntimeEnv.js";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

it("pins the explicit preview origin across stored env loading and reload without dropping other values", () => {
	const directory = mkdtempSync(join(tmpdir(), "cyrus-env-origin-"));
	directories.push(directory);
	const path = join(directory, ".env");
	vi.stubEnv("CYRUS_APP_URL", "https://cyrus-preview-cyhost-1321.vercel.app/");
	vi.stubEnv("CYRUS_ENV_TEST_VALUE", "before");
	writeFileSync(
		path,
		"CYRUS_APP_URL=https://app.atcyrus.com\nCYRUS_ENV_TEST_VALUE=after\n",
	);
	loadRuntimeEnv(path);
	expect(process.env.CYRUS_APP_URL).toBe(
		"https://cyrus-preview-cyhost-1321.vercel.app/",
	);
	expect(process.env.CYRUS_ENV_TEST_VALUE).toBe("after");
	writeFileSync(path, "CYRUS_APP_URL=https://different.example\n");
	loadRuntimeEnv(path);
	expect(process.env.CYRUS_APP_URL).toBe(
		"https://cyrus-preview-cyhost-1321.vercel.app/",
	);
});

it("loads a stored origin when launch did not select one", () => {
	const directory = mkdtempSync(join(tmpdir(), "cyrus-env-origin-"));
	directories.push(directory);
	vi.stubEnv("CYRUS_APP_URL", undefined);
	const path = join(directory, ".env");
	writeFileSync(
		path,
		"CYRUS_APP_URL=https://cyrus-preview-cyhost-1321.vercel.app\n",
	);
	loadRuntimeEnv(path);
	expect(process.env.CYRUS_APP_URL).toBe(
		"https://cyrus-preview-cyhost-1321.vercel.app",
	);
});
