import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CodexConfigBuilder } from "../src/config/CodexConfigBuilder.js";

afterEach(() => vi.unstubAllEnvs());

it("preserves Codex model auth and protects personal GitHub tool env from ambient policy", async () => {
	const home = mkdtempSync(join(tmpdir(), "codex-personal-env-"));
	try {
		vi.stubEnv("GH_TOKEN", "host-placeholder");
		vi.stubEnv("GITHUB_TOKEN", "host-placeholder");
		vi.stubEnv("OTHER_USER_TOKEN", "other-placeholder");
		vi.stubEnv("OPENAI_API_KEY", "model-placeholder");
		const configs = await Promise.all(
			["ada", "bob"].map((user) =>
				new CodexConfigBuilder({
					cyrusHome: home,
					codexHome: home,
					workingDirectory: home,
					additionalEnv: {
						GH_TOKEN: user,
						GITHUB_TOKEN: user,
						CYRUS_PROMPTER_GITHUB_TOKEN: user,
						GIT_AUTHOR_NAME: user,
					},
					omitEnv: ["OTHER_USER_TOKEN"],
					configOverrides: {
						shell_environment_policy: {
							inherit: "none",
							set: { GH_TOKEN: "host-placeholder" },
						},
					},
				}).build(),
			),
		);
		for (const [i, config] of configs.entries()) {
			const user = i === 0 ? "ada" : "bob";
			expect(config.env).toMatchObject({
				GH_TOKEN: user,
				GITHUB_TOKEN: user,
				GIT_AUTHOR_NAME: user,
				OPENAI_API_KEY: "model-placeholder",
				CODEX_HOME: home,
			});
			expect(config.env?.OTHER_USER_TOKEN).toBeUndefined();
			expect(config.configOverrides?.shell_environment_policy).toEqual({
				inherit: "all",
				experimental_use_profile: false,
				ignore_default_excludes: true,
				exclude: [],
				include_only: [],
				set: {},
			});
		}
		expect(process.env.GH_TOKEN).toBe("host-placeholder");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
