import { describe, expect, it } from "vitest";
import { CodexConfigBuilder } from "../src/config/CodexConfigBuilder.js";
import type { CodexConfigOverrides, CodexRunnerConfig } from "../src/types.js";

function makeConfig(
	overrides: Partial<CodexRunnerConfig> = {},
): CodexRunnerConfig {
	return {
		cyrusHome: "/tmp/cyrus-home",
		workingDirectory: "/tmp/codex-connector-writes-test",
		codexHome: "/tmp/codex-connector-writes-test-home",
		...overrides,
	} as CodexRunnerConfig;
}

async function buildConfigOverrides(
	overrides: Partial<CodexRunnerConfig> = {},
): Promise<CodexConfigOverrides | undefined> {
	const resolved = await new CodexConfigBuilder(makeConfig(overrides)).build();
	return resolved.configOverrides;
}

describe("CodexConfigBuilder connector writes policy", () => {
	it('emits apps._default gates that block destructive/open-world connector tools when "disabled"', async () => {
		const configOverrides = await buildConfigOverrides({
			connectorWrites: "disabled",
		});
		// `_default` and snake_case fields must match codex's AppsConfigToml,
		// which rejects unknown fields.
		expect(configOverrides?.apps).toEqual({
			_default: {
				destructive_enabled: false,
				open_world_enabled: false,
			},
		});
	});

	it('emits no apps overrides when "enabled" or unset', async () => {
		expect((await buildConfigOverrides({}))?.apps).toBeUndefined();
		expect(
			(await buildConfigOverrides({ connectorWrites: "enabled" }))?.apps,
		).toBeUndefined();
	});

	it("preserves caller-supplied apps overrides while forcing the default gates off", async () => {
		const configOverrides = await buildConfigOverrides({
			connectorWrites: "disabled",
			configOverrides: {
				apps: {
					_default: { enabled: true },
					linear: { default_tools_approval_mode: "approve" },
				},
			},
		});
		expect(configOverrides?.apps).toEqual({
			_default: {
				enabled: true,
				destructive_enabled: false,
				open_world_enabled: false,
			},
			linear: { default_tools_approval_mode: "approve" },
		});
	});
});
