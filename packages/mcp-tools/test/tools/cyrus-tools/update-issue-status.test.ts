import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createCyrusToolsServer } from "../../../src/tools/cyrus-tools/index.js";

/**
 * Tests for linear_update_issue_status (CRATE-153).
 *
 * Status writes previously had to go through the hosted Linear MCP server,
 * whose Authorization header is a static token snapshot that dies when the
 * OAuth token rotates. This tool goes through the daemon's LinearClient,
 * which auto-refreshes on 401 — so the critical "move to In Review" write
 * keeps working even mid-rotation.
 */

function makeMockLinearClient(overrides: Record<string, unknown> = {}) {
	const states = {
		nodes: [
			{ id: "state-backlog", name: "Backlog", type: "backlog" },
			{ id: "state-in-review", name: "In Review", type: "started" },
			{ id: "state-done", name: "Done", type: "completed" },
		],
	};
	return {
		issue: vi.fn().mockResolvedValue({
			id: "issue-uuid-1",
			identifier: "CRATE-80",
			team: Promise.resolve({
				id: "team-1",
				states: vi.fn().mockResolvedValue(states),
			}),
		}),
		updateIssue: vi.fn().mockResolvedValue({ success: true }),
		...overrides,
	} as any;
}

async function callTool(linearClient: any, args: Record<string, unknown>) {
	const server = createCyrusToolsServer(linearClient);
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test-client", version: "1.0.0" });
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	]);
	const result = await client.callTool({
		name: "linear_update_issue_status",
		arguments: args,
	});
	await client.close();
	await server.close();
	const text = (result.content as Array<{ type: string; text: string }>)[0]
		?.text;
	return JSON.parse(text ?? "{}");
}

describe("linear_update_issue_status tool", () => {
	it("updates the issue state by case-insensitive status name", async () => {
		const linearClient = makeMockLinearClient();
		const result = await callTool(linearClient, {
			issueId: "CRATE-80",
			status: "in review",
		});
		expect(result.success).toBe(true);
		expect(linearClient.updateIssue).toHaveBeenCalledWith("issue-uuid-1", {
			stateId: "state-in-review",
		});
		expect(result.message).toContain("CRATE-80");
		expect(result.message).toContain("In Review");
	});

	it("returns the available states when the requested status does not exist", async () => {
		const linearClient = makeMockLinearClient();
		const result = await callTool(linearClient, {
			issueId: "CRATE-80",
			status: "Shipped",
		});
		expect(result.success).toBe(false);
		expect(result.error).toContain("Shipped");
		expect(result.availableStatuses).toEqual(["Backlog", "In Review", "Done"]);
		expect(linearClient.updateIssue).not.toHaveBeenCalled();
	});

	it("surfaces underlying API failures loudly instead of silently no-oping", async () => {
		const linearClient = makeMockLinearClient({
			updateIssue: vi
				.fn()
				.mockRejectedValue(
					new Error("Authentication required, not authenticated"),
				),
		});
		const result = await callTool(linearClient, {
			issueId: "CRATE-80",
			status: "Done",
		});
		expect(result.success).toBe(false);
		expect(result.error).toContain("Authentication required");
	});

	it("fails loudly when the issue cannot be found", async () => {
		const linearClient = makeMockLinearClient({
			issue: vi.fn().mockResolvedValue(null),
		});
		const result = await callTool(linearClient, {
			issueId: "CRATE-999",
			status: "Done",
		});
		expect(result.success).toBe(false);
		expect(result.error).toContain("CRATE-999");
	});
});
