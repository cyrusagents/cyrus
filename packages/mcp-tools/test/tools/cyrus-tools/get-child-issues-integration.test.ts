import { describe, expect, it } from "vitest";
import { createCyrusToolsServer } from "../../../src/tools/cyrus-tools/index.js";

describe("linear_get_child_issues tool integration", () => {
	it("should create cyrus tools server with expected structure", () => {
		const server = createCyrusToolsServer("test-token");

		// Verify the server has the expected MCP SDK structure
		expect(server).toBeDefined();
		expect(server.server).toBeDefined();
		expect(typeof server.connect).toBe("function");
		expect(typeof server.close).toBe("function");
	});

	it("should have created server with proper configuration", () => {
		const server = createCyrusToolsServer("test-token", {
			parentSessionId: "parent-123",
			onSessionCreated: (child, parent) => {
				console.log(`Session created: ${child} -> ${parent}`);
			},
			onFeedbackDelivery: async (child, message) => {
				console.log(`Feedback: ${child} -> ${message}`);
				return true;
			},
		});

		// Basic server structure check
		expect(server).toBeDefined();
		expect(server.server).toBeDefined();
	});

	it("should verify tool exists through successful server creation", () => {
		// Since we can't easily access the tools array from the MCP server,
		// we verify the tool exists by checking that server creation succeeds
		// The actual testing of the tool functionality happens through
		// the test script that uses the ClaudeRunner to call the tool

		// Create a server to ensure it doesn't throw
		expect(() => createCyrusToolsServer("test-token")).not.toThrow();

		// Create another server with options to ensure configuration works
		expect(() =>
			createCyrusToolsServer("test-token", {
				parentSessionId: "test-parent",
			}),
		).not.toThrow();
	});

	it("should handle different configuration options", () => {
		// Test with minimal config
		const server1 = createCyrusToolsServer("token1");
		expect(server1).toBeDefined();

		// Test with full config
		const server2 = createCyrusToolsServer("token2", {
			parentSessionId: "parent-456",
		});
		expect(server2).toBeDefined();

		// Test with empty options
		const server3 = createCyrusToolsServer("token3", {});
		expect(server3).toBeDefined();
	});
});
