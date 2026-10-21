import type { EdgeWorkerConfig, ILogger } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { ToolPermissionResolver } from "../src/ToolPermissionResolver.js";

const noopLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

function resolverWith(slackAllowedTools?: string[]): ToolPermissionResolver {
	return new ToolPermissionResolver(
		{ slackAllowedTools } as unknown as EdgeWorkerConfig,
		noopLogger,
	);
}

describe("ToolPermissionResolver.buildChatAllowedTools MCP scoping", () => {
	it("does not re-add a server prefix the operator deliberately omitted", () => {
		// Operator wants a read-only Slack bot: cyrus-tools (which exposes
		// engineering_create_and_start / github_issue_start) is left out.
		const resolver = resolverWith(["Read", "mcp__cyrus-docs"]);

		const allowed = resolver.buildChatAllowedTools([
			"cyrus-tools",
			"cyrus-docs",
		]);

		expect(allowed).not.toContain("mcp__cyrus-tools");
	});

	it("does not broaden a per-tool MCP entry to the whole server", () => {
		const resolver = resolverWith([
			"Read",
			"mcp__cyrus-tools__slack_file_upload",
		]);

		const allowed = resolver.buildChatAllowedTools(["cyrus-tools"]);

		expect(allowed).toContain("mcp__cyrus-tools__slack_file_upload");
		expect(allowed).not.toContain("mcp__cyrus-tools");
	});

	it("still auto-adds server prefixes when falling back to built-in defaults", () => {
		// No operator override -> convenience auto-add must be preserved so
		// non-standard servers (e.g. a Notion MCP) remain reachable.
		const resolver = resolverWith(undefined);

		const allowed = resolver.buildChatAllowedTools(["notion"]);

		expect(allowed).toContain("mcp__notion");
		expect(allowed).toContain("mcp__linear");
	});
});
