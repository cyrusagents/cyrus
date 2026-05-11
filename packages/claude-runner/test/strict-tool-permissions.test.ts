import { describe, expect, it } from "vitest";
import {
	buildStrictDisallowedTools,
	ClaudeRunner,
	extractToolName,
} from "../src/ClaudeRunner.js";
import type { ClaudeRunnerConfig } from "../src/types.js";

/**
 * The strict-permission decision lives in
 * `ClaudeRunner.createCanUseToolCallback`. The callback is registered
 * privately on the runner; we exercise it via the typed instance by
 * constructing two runners (loose and strict) and asserting on the
 * resulting `PermissionResult` for a non-allowed tool.
 */

function makeRunner(overrides: Partial<ClaudeRunnerConfig> = {}): ClaudeRunner {
	const cfg: ClaudeRunnerConfig = {
		cyrusHome: "/tmp/cyrus-test",
		// onAskUserQuestion ensures the callback is registered in legacy
		// (non-strict) mode too, so we can compare the two policies.
		onAskUserQuestion: async () => ({ answered: false, message: "n/a" }),
		...overrides,
	};
	return new ClaudeRunner(cfg);
}

const callback = (runner: ClaudeRunner) =>
	(runner as unknown as { canUseToolCallback?: Function }).canUseToolCallback!;

const noopOptions = {
	signal: new AbortController().signal,
	toolUseID: "tool-use-123",
};

describe("ClaudeRunner.canUseTool — strict tool permissions", () => {
	it("registers the callback even without onAskUserQuestion when strict=true", () => {
		const runner = new ClaudeRunner({
			cyrusHome: "/tmp",
			strictToolPermissions: true,
		});
		expect(callback(runner)).toBeDefined();
	});

	it("legacy (non-strict) mode rubber-stamps unallowed tools", async () => {
		const runner = makeRunner({ strictToolPermissions: false });
		const result = await callback(runner)(
			"Bash",
			{ command: "rm -rf /" },
			noopOptions,
		);
		expect(result).toEqual({
			behavior: "allow",
			updatedInput: { command: "rm -rf /" },
		});
	});

	it("legacy mode (strictToolPermissions undefined) rubber-stamps too", async () => {
		const runner = makeRunner({});
		const result = await callback(runner)(
			"Glob",
			{ pattern: "**/*" },
			noopOptions,
		);
		expect(result.behavior).toBe("allow");
	});

	it("strict mode denies any non-AskUserQuestion tool", async () => {
		const runner = makeRunner({ strictToolPermissions: true });
		for (const tool of ["Bash", "Glob", "Write", "Edit", "WebFetch"]) {
			const result = await callback(runner)(tool, {}, noopOptions);
			expect(result.behavior).toBe("deny");
			expect((result as { message?: string }).message).toMatch(
				/not permitted/i,
			);
		}
	});

	it("strict mode still routes AskUserQuestion to the configured handler", async () => {
		// onAskUserQuestion is a no-op denier here; we just verify that
		// AskUserQuestion is NOT short-circuited by the strict-deny path.
		const runner = makeRunner({ strictToolPermissions: true });
		const result = await callback(runner)(
			"AskUserQuestion",
			{ questions: [{ id: "q1", question: "?" }] },
			noopOptions,
		);
		// The handler returns answered: false → deny with that message;
		// the important assertion is we did NOT get the strict-mode
		// "not permitted" message.
		expect((result as { message?: string }).message).not.toMatch(
			/not permitted/i,
		);
	});
});

describe("extractToolName", () => {
	it("returns the bare name for un-patterned entries", () => {
		expect(extractToolName("Bash")).toBe("Bash");
		expect(extractToolName("Glob")).toBe("Glob");
	});

	it("strips trailing pattern args", () => {
		expect(extractToolName("Read(**)")).toBe("Read");
		expect(extractToolName("Bash(grep *)")).toBe("Bash");
		expect(extractToolName("Edit(/repo/**)")).toBe("Edit");
	});

	it("preserves MCP-namespaced tool names verbatim", () => {
		expect(extractToolName("mcp__linear__get_issue")).toBe(
			"mcp__linear__get_issue",
		);
	});
});

describe("buildStrictDisallowedTools", () => {
	it("denies every tool name not represented in allowedTools", () => {
		const denials = buildStrictDisallowedTools(["Read(**)", "Bash(grep *)"]);
		// Specific tools that the SDK would otherwise auto-allow:
		expect(denials).toContain("Glob");
		expect(denials).toContain("Grep");
		expect(denials).toContain("Edit");
		expect(denials).toContain("Write");
		expect(denials).toContain("WebFetch");
		// Tools that ARE represented in allowedTools must NOT be denied:
		expect(denials).not.toContain("Read");
		expect(denials).not.toContain("Bash");
	});

	it("never denies AskUserQuestion (Cyrus relies on it)", () => {
		const denials = buildStrictDisallowedTools([]);
		expect(denials).not.toContain("AskUserQuestion");
		// Sanity: with empty allowedTools, almost everything else IS denied
		expect(denials).toContain("Read");
		expect(denials).toContain("Bash");
		expect(denials).toContain("Glob");
	});

	it("treats `Tool(pattern)` and `Tool` as the same name", () => {
		// Mixing patterned and bare entries should not duplicate or miss.
		const a = buildStrictDisallowedTools(["Bash(grep *)"]);
		const b = buildStrictDisallowedTools(["Bash"]);
		expect(a).toEqual(b);
	});
});
