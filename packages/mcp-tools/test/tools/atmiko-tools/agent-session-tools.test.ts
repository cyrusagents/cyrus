import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { createAtmikoToolsServer } from "../../../src/tools/atmiko-tools/index.js";

describe("atmiko-tools agent-session permissions", () => {
	it("does not expose tools that create Linear agent sessions", () => {
		const registerTool = vi.spyOn(McpServer.prototype, "registerTool");

		createAtmikoToolsServer({} as any);

		const registeredToolNames = registerTool.mock.calls.map(([name]) => name);
		expect(registeredToolNames).not.toContain("linear_agent_session_create");
		expect(registeredToolNames).not.toContain(
			"linear_agent_session_create_on_comment",
		);
	});
});
