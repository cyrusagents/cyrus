import type { LinearClient } from "@linear/sdk";
import type { IIssueTrackerService } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	McpConfigService,
	type McpConfigServiceDeps,
} from "../src/McpConfigService.js";

/**
 * These tests pin the MCP tool-loading strategy that keeps session startup
 * fast: Cyrus's small, local servers (`cyrus-tools`, `cyrus-docs`) are marked
 * `alwaysLoad` so they are never deferred behind the SDK's on-demand
 * `ToolSearch`, while the ~50-tool remote Linear catalog is left deferred so it
 * cannot bloat the turn-1 context (and thus cannot force a remote round-trip
 * before the agent can act on the issue).
 */

// A LinearClient stub — createCyrusToolsServer only stores the reference and
// registers tool handlers; it never calls into the client at construction time.
const fakeLinearClient = {} as unknown as LinearClient;

function makeService(withLinear: boolean): McpConfigService {
	const issueTracker = withLinear
		? ({
				getClient: () => fakeLinearClient,
			} as unknown as IIssueTrackerService & {
				getClient?: () => LinearClient;
			})
		: undefined;

	const deps: McpConfigServiceDeps = {
		getLinearTokenForWorkspace: () => (withLinear ? "linear-token" : null),
		getIssueTracker: () => issueTracker,
		getCyrusToolsMcpUrl: () => "http://127.0.0.1:9999/mcp",
		createCyrusToolsOptions: () => ({}),
	};

	return new McpConfigService(deps);
}

describe("McpConfigService.buildMcpConfig tool-loading strategy", () => {
	it("marks the local cyrus-tools and cyrus-docs servers as alwaysLoad", () => {
		const service = makeService(true);
		const config = service.buildMcpConfig("repo-1", "workspace-1", "parent-1");

		expect(config["cyrus-tools"]).toMatchObject({ alwaysLoad: true });
		expect(config["cyrus-docs"]).toMatchObject({ alwaysLoad: true });
	});

	it("leaves the remote Linear catalog deferred (no alwaysLoad)", () => {
		const service = makeService(true);
		const config = service.buildMcpConfig("repo-1", "workspace-1", "parent-1");

		expect(config.linear).toBeDefined();
		expect(
			(config.linear as { alwaysLoad?: boolean }).alwaysLoad,
		).toBeUndefined();
	});

	it("marks cyrus-docs as alwaysLoad in CLI mode (no Linear client)", () => {
		const service = makeService(false);
		const config = service.buildMcpConfig("repo-1", "workspace-1");

		expect(config).toEqual({
			"cyrus-docs": {
				type: "http",
				url: "https://atcyrus.com/docs/mcp",
				alwaysLoad: true,
			},
		});
		// CLI mode has no Linear token, so the remote Linear server is not configured.
		expect(config.linear).toBeUndefined();
		expect(config["cyrus-tools"]).toBeUndefined();
	});
});
