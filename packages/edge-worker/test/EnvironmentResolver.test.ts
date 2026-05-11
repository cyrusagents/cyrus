import type { EnvironmentConfig } from "cyrus-core";
import { createLogger, LogLevel } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	EnvironmentResolver,
	type EnvironmentResolverBaseInputs,
	isEnvironmentIsolated,
} from "../src/EnvironmentResolver.js";

const log = createLogger({ component: "test", level: LogLevel.ERROR });
const resolver = new EnvironmentResolver(log);

function baseInputs(
	overrides: Partial<EnvironmentResolverBaseInputs> = {},
): EnvironmentResolverBaseInputs {
	return {
		systemPrompt: "BASE PROMPT",
		allowedTools: ["Read", "Bash"],
		disallowedTools: ["Write"],
		mcpConfigPath: "/repo/.mcp.json",
		mcpConfig: { linear: { type: "stdio", command: "linear-mcp" } as any },
		plugins: [{ type: "local", path: "/auto/skill" }],
		sandboxSettings: { enabled: true } as any,
		hooks: { Stop: [{ matcher: ".*", hooks: [] }] } as any,
		settingSources: undefined,
		addChromeExtraArg: true,
		defaultAllowedDirectories: ["/attachments", "/repo", "/repo/.git"],
		envReadOnlyRepoPaths: [],
		worktreePath: "/work/CYPACK-1130",
		restrictHomeDirectoryReads: true,
		strictToolPermissions: false,
		...overrides,
	};
}

describe("isEnvironmentIsolated", () => {
	it("returns true only when env.isolated === true", () => {
		expect(isEnvironmentIsolated(null)).toBe(false);
		expect(isEnvironmentIsolated(undefined)).toBe(false);
		expect(isEnvironmentIsolated({})).toBe(false);
		expect(isEnvironmentIsolated({ isolated: false })).toBe(false);
		expect(isEnvironmentIsolated({ isolated: true })).toBe(true);
	});
});

describe("EnvironmentResolver — no env bound", () => {
	it("passes the base inputs through unchanged", () => {
		const base = baseInputs();
		const r = resolver.resolve(null, base);
		expect(r.systemPrompt).toBe("BASE PROMPT");
		expect(r.allowedTools).toEqual(["Read", "Bash"]);
		expect(r.disallowedTools).toEqual(["Write"]);
		expect(r.mcpConfigPath).toBe("/repo/.mcp.json");
		expect(r.mcpConfig).toEqual(base.mcpConfig);
		expect(r.plugins).toEqual(base.plugins);
		expect(r.sandboxSettings).toEqual(base.sandboxSettings);
		expect(r.hooks).toEqual(base.hooks);
		expect(r.settingSources).toBeUndefined();
		expect(r.addChromeExtraArg).toBe(true);
		expect(r.allowedDirectories).toEqual(base.defaultAllowedDirectories);
	});
});

describe("EnvironmentResolver — strictToolPermissions", () => {
	it("preserves base value when no env is bound", () => {
		expect(
			resolver.resolve(null, baseInputs({ strictToolPermissions: false }))
				.strictToolPermissions,
		).toBe(false);
		expect(
			resolver.resolve(null, baseInputs({ strictToolPermissions: true }))
				.strictToolPermissions,
		).toBe(true);
	});

	it("flips to true for any env-bound session by default", () => {
		const env: EnvironmentConfig = {};
		expect(resolver.resolve(env, baseInputs()).strictToolPermissions).toBe(
			true,
		);
	});

	it("env can opt out by setting false", () => {
		const env: EnvironmentConfig = { strictToolPermissions: false };
		expect(resolver.resolve(env, baseInputs()).strictToolPermissions).toBe(
			false,
		);
	});

	it("env explicit true matches the default", () => {
		const env: EnvironmentConfig = { strictToolPermissions: true };
		expect(resolver.resolve(env, baseInputs()).strictToolPermissions).toBe(
			true,
		);
	});

	it("isolated envs are strict by default", () => {
		const env: EnvironmentConfig = { isolated: true };
		expect(resolver.resolve(env, baseInputs()).strictToolPermissions).toBe(
			true,
		);
	});
});

describe("EnvironmentResolver — restrictHomeDirectoryReads", () => {
	it("propagates the base default when the env omits the flag", () => {
		const env: EnvironmentConfig = {};
		expect(resolver.resolve(env, baseInputs()).restrictHomeDirectoryReads).toBe(
			true,
		);
	});

	it("forwards env.restrictHomeDirectoryReads=false to opt out", () => {
		const env: EnvironmentConfig = { restrictHomeDirectoryReads: false };
		expect(resolver.resolve(env, baseInputs()).restrictHomeDirectoryReads).toBe(
			false,
		);
	});

	it("forwards env.restrictHomeDirectoryReads=true even when base is false", () => {
		const env: EnvironmentConfig = { restrictHomeDirectoryReads: true };
		expect(
			resolver.resolve(env, baseInputs({ restrictHomeDirectoryReads: false }))
				.restrictHomeDirectoryReads,
		).toBe(true);
	});
});

describe("EnvironmentResolver — merge mode (env present, isolated=false)", () => {
	it("env values replace base where defined, otherwise base wins", () => {
		const env: EnvironmentConfig = {
			systemPrompt: "ENV PROMPT",
			allowedTools: ["Grep"],
			// disallowedTools omitted → base wins
		};
		const r = resolver.resolve(env, baseInputs());
		expect(r.systemPrompt).toBe("ENV PROMPT");
		expect(r.allowedTools).toEqual(["Grep"]);
		expect(r.disallowedTools).toEqual(["Write"]); // from base
		expect(r.mcpConfigPath).toBe("/repo/.mcp.json"); // base
		expect(r.mcpConfig).toBeDefined(); // dynamic MCPs preserved
		expect(r.plugins).toEqual([{ type: "local", path: "/auto/skill" }]); // base
		expect(r.hooks).toBeDefined(); // base hooks preserved
		expect(r.addChromeExtraArg).toBe(true); // chrome stays in merge mode
		expect(r.allowedDirectories).toEqual([
			"/attachments",
			"/repo",
			"/repo/.git",
		]);
	});

	it("env plugins+skills replace auto-discovered plugins", () => {
		const env: EnvironmentConfig = {
			plugins: [{ type: "local", path: "~/explicit" }],
			skills: ["~/extra-skill"],
		};
		const r = resolver.resolve(env, baseInputs());
		expect(r.plugins).toEqual([
			{ type: "local", path: expect.stringMatching(/explicit$/) },
			{ type: "local", path: expect.stringMatching(/extra-skill$/) },
		]);
	});

	it("env claudeSettingSources is forwarded explicitly", () => {
		const env: EnvironmentConfig = { claudeSettingSources: ["project"] };
		expect(resolver.resolve(env, baseInputs()).settingSources).toEqual([
			"project",
		]);
	});

	it("env claudeSettingSources empty array opts out of all sources", () => {
		const env: EnvironmentConfig = { claudeSettingSources: [] };
		expect(resolver.resolve(env, baseInputs()).settingSources).toEqual([]);
	});
});

describe("EnvironmentResolver — isolated mode", () => {
	it("strips dynamic MCPs, hooks, Chrome arg, and forces empty settingSources", () => {
		const env: EnvironmentConfig = { isolated: true };
		const r = resolver.resolve(env, baseInputs());
		expect(r.mcpConfig).toBeUndefined();
		expect(r.mcpConfigPath).toBeUndefined();
		expect(r.hooks).toEqual({});
		expect(r.addChromeExtraArg).toBe(false);
		expect(r.settingSources).toEqual([]); // forced default for isolation
	});

	it("emits empty tool lists when env omits them", () => {
		const env: EnvironmentConfig = { isolated: true };
		const r = resolver.resolve(env, baseInputs());
		expect(r.allowedTools).toEqual([]);
		expect(r.disallowedTools).toEqual([]);
	});

	it("preserves env-supplied tool lists in isolated mode", () => {
		const env: EnvironmentConfig = {
			isolated: true,
			allowedTools: ["Read"],
			disallowedTools: ["Bash"],
		};
		const r = resolver.resolve(env, baseInputs());
		expect(r.allowedTools).toEqual(["Read"]);
		expect(r.disallowedTools).toEqual(["Bash"]);
	});

	it("does not inherit base systemPrompt when env omits one", () => {
		const env: EnvironmentConfig = { isolated: true };
		const r = resolver.resolve(env, baseInputs());
		expect(r.systemPrompt).toBeUndefined();
	});

	it("uses env-only allowedDirectories: worktree + read-only repos", () => {
		const env: EnvironmentConfig = { isolated: true };
		const r = resolver.resolve(
			env,
			baseInputs({
				envReadOnlyRepoPaths: ["/ro/docs", "/ro/api"],
				defaultAllowedDirectories: ["/attachments", "/should/not/leak"],
			}),
		);
		expect(r.allowedDirectories).toEqual([
			"/work/CYPACK-1130",
			"/ro/docs",
			"/ro/api",
		]);
	});

	it("returns no plugins when env declares none in isolated mode", () => {
		const env: EnvironmentConfig = { isolated: true };
		expect(resolver.resolve(env, baseInputs()).plugins).toEqual([]);
	});

	it("returns no sandboxSettings when env omits sandbox in isolated mode", () => {
		const env: EnvironmentConfig = { isolated: true };
		expect(resolver.resolve(env, baseInputs()).sandboxSettings).toBeUndefined();
	});

	it("preserves the restrictHomeDirectoryReads default in isolated mode", () => {
		// Isolation does NOT silently disable the home-dir safety enumeration.
		// Authors must opt out explicitly via env.restrictHomeDirectoryReads=false.
		const env: EnvironmentConfig = { isolated: true };
		expect(resolver.resolve(env, baseInputs()).restrictHomeDirectoryReads).toBe(
			true,
		);
	});

	it("env claudeSettingSources subset wins over the isolation default", () => {
		const env: EnvironmentConfig = {
			isolated: true,
			claudeSettingSources: ["project"],
		};
		expect(resolver.resolve(env, baseInputs()).settingSources).toEqual([
			"project",
		]);
	});
});
