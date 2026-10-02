import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { CodexConfigBuilder } from "../src/config/CodexConfigBuilder.js";

it("honors supervisor env suppression without changing the registered Codex home", async () => {
	const home = await mkdtemp(join(tmpdir(), "cyrus-codex-env-"));
	vi.stubEnv("CODEX_HOME", home);
	vi.stubEnv("CYRUS_API_KEY", "synthetic-supervisor");
	try {
		const base = { workingDirectory: home, model: "gpt-5.5" };
		const unchanged = await new CodexConfigBuilder(base).build();
		expect(unchanged.env).toBeUndefined();
		const scoped = await new CodexConfigBuilder({
			...base,
			additionalEnv: { CYRUS_API_KEY: "" },
		}).build();
		expect(scoped.env?.CYRUS_API_KEY).toBe("");
		expect(scoped.env?.CODEX_HOME).toBe(home);
		expect(scoped.codexHome).toBe(home);
		expect(process.env.CYRUS_API_KEY).toBe("synthetic-supervisor");
	} finally {
		vi.unstubAllEnvs();
		await rm(home, { recursive: true, force: true });
	}
});
