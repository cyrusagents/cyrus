import { AgentSessionStatus } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";
import { mockClaudeAssistantMessage, mockClaudeResultMessage } from "./setup";

describe("AgentSessionManager Claude API error attribution", () => {
	let manager: AgentSessionManager;
	let mockActivitySink: IActivitySink;
	let postActivitySpy: any;
	const sessionId = "test-session-api-error";
	const issueId = "issue-api-error";

	beforeEach(() => {
		mockActivitySink = {
			id: "test-workspace",
			postActivity: vi.fn().mockResolvedValue({ activityId: "activity-1" }),
			createAgentSession: vi.fn().mockResolvedValue("session-1"),
		};
		postActivitySpy = vi.spyOn(mockActivitySink, "postActivity");

		manager = new AgentSessionManager();
		manager.createCyrusAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "TEST-API",
				title: "API Error Test",
				description: "test",
				branchName: "test-api",
			},
			{ path: "/tmp/workspace", isGitWorktree: false },
		);
		manager.setActivitySink(sessionId, mockActivitySink);
	});

	const findResultActivity = () =>
		postActivitySpy.mock.calls
			.map((call: any[]) => call[1])
			.reverse()
			.find(
				(content: any) =>
					content?.type === "error" || content?.type === "response",
			);

	it("relabels a Claude API error that arrives as the final assistant text (success subtype)", async () => {
		// Claude surfaces an API failure as the final assistant text, then ends
		// the turn with a success-subtype result.
		await manager.handleClaudeMessage(
			sessionId,
			mockClaudeAssistantMessage("API Error: Internal server error"),
		);
		await manager.handleClaudeMessage(
			sessionId,
			mockClaudeResultMessage("success"),
		);

		const activity = findResultActivity();
		expect(activity).toBeDefined();
		expect(activity.type).toBe("error");
		expect(activity.body).toBe(
			"⚠️ **Claude API error** — this error came from Claude's API, not from Cyrus.\n\nAPI Error: Internal server error",
		);
	});

	it("attributes a Claude API error that arrives with an error subtype but empty errors[]", async () => {
		await manager.handleClaudeMessage(
			sessionId,
			mockClaudeAssistantMessage("API Error: Overloaded"),
		);
		await manager.handleClaudeMessage(
			sessionId,
			mockClaudeResultMessage("error_during_execution"),
		);

		const activity = findResultActivity();
		expect(activity).toBeDefined();
		expect(activity.type).toBe("error");
		expect(activity.body).toBe(
			"⚠️ **Claude API error** — this error came from Claude's API, not from Cyrus.\n\nAPI Error: Overloaded",
		);
		expect(manager.getSession(sessionId)?.status).toBe(
			AgentSessionStatus.Error,
		);
	});

	it("does not alter a normal successful response", async () => {
		await manager.handleClaudeMessage(
			sessionId,
			mockClaudeAssistantMessage("All done! I implemented the feature."),
		);
		await manager.handleClaudeMessage(
			sessionId,
			mockClaudeResultMessage("success"),
		);

		const activity = findResultActivity();
		expect(activity).toBeDefined();
		expect(activity.type).toBe("response");
		expect(activity.body).toBe("All done! I implemented the feature.");
	});
});
