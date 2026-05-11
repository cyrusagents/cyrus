import type { EnvironmentConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { ActivityPoster } from "../src/ActivityPoster.js";

const fmt = ActivityPoster.formatEnvironmentBindingLines;

describe("ActivityPoster.formatEnvironmentBindingLines", () => {
	it("returns no lines for an env that customizes nothing", () => {
		expect(fmt({})).toEqual([]);
	});

	it("includes only customized fields", () => {
		const env: EnvironmentConfig = {
			name: "fde",
			isolated: true,
			allowedTools: ["Read(**)", "Bash(grep *)"],
			repositories: ["cyrus", "cyrus-hosted"],
		};
		expect(fmt(env)).toEqual([
			"- Allowed tools: 2 entries",
			"- Read-only repositories: cyrus, cyrus-hosted",
		]);
	});

	it("renders inline-prompt and prompt-file forms separately", () => {
		expect(fmt({ systemPrompt: "you are X" })).toContain(
			"- System prompt: from env (inline)",
		);
		expect(fmt({ systemPromptPath: "~/p.txt" })).toContain(
			"- System prompt: file `~/p.txt`",
		);
	});

	it("renders mcpConfigPath single + array forms", () => {
		expect(fmt({ mcpConfigPath: "/a.json" })).toContain(
			"- MCP config: 1 path(s) (replaces repo defaults)",
		);
		expect(fmt({ mcpConfigPath: ["/a.json", "/b.json"] })).toContain(
			"- MCP config: 2 path(s) (replaces repo defaults)",
		);
	});

	it("counts plugins+skills together", () => {
		expect(
			fmt({
				plugins: [{ type: "local", path: "/p" }],
				skills: ["/s1", "/s2"],
			}),
		).toContain("- Plugins/skills: 3 entries");
	});

	it("describes claudeSettingSources empty vs subset", () => {
		expect(fmt({ claudeSettingSources: [] })).toContain(
			"- Claude settings sources: none (fully isolated)",
		);
		expect(fmt({ claudeSettingSources: ["project", "local"] })).toContain(
			"- Claude settings sources: project, local",
		);
	});

	it("lists env variable keys (sorted) and accepted inline overrides", () => {
		const env: EnvironmentConfig = {
			env: { FOO: "1", BAR: "2" },
			allowInlineOverrides: ["FEATURE_FLAG"],
		};
		const lines = fmt(env, { FEATURE_FLAG: "1" });
		expect(lines).toContain("- Env variables: 2 (BAR, FOO)");
		expect(lines).toContain("- Allowed inline overrides: FEATURE_FLAG");
		expect(lines).toContain("- Inline overrides accepted: FEATURE_FLAG");
	});

	it("renders gitWorktrees empty vs populated", () => {
		expect(fmt({ gitWorktrees: [] })).toContain(
			"- Git worktrees: none (no-git workspace)",
		);
		expect(fmt({ gitWorktrees: ["a", "b"] })).toContain(
			"- Git worktrees: a, b",
		);
	});

	it("only flags home-dir restriction when explicitly disabled", () => {
		expect(fmt({ restrictHomeDirectoryReads: true })).not.toContain(
			"- Home-directory read restriction: disabled",
		);
		expect(fmt({})).not.toContain(
			"- Home-directory read restriction: disabled",
		);
		expect(fmt({ restrictHomeDirectoryReads: false })).toContain(
			"- Home-directory read restriction: disabled",
		);
	});

	it("includes the description as a top bullet when set", () => {
		expect(fmt({ description: "FDE review session" })[0]).toBe(
			"- FDE review session",
		);
	});
});
