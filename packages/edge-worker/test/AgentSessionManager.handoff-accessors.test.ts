import type { CyrusAgentSession } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";

// Minimal manager: we only exercise the new accessors against its internal maps.
function makeManager() {
	// Construct with no args — matches the existing AgentSessionManager.stop-session.test.ts
	return new AgentSessionManager();
}

describe("AgentSessionManager handoff accessors", () => {
	it("clearRunnerSessionBindings nulls every runner session id", () => {
		const mgr = makeManager();
		const session = {
			id: "s1",
			claudeSessionId: "c",
			codexSessionId: undefined,
		} as unknown as CyrusAgentSession;
		(mgr as any).sessions.set("s1", session);

		mgr.clearRunnerSessionBindings("s1");

		expect(session.claudeSessionId).toBeUndefined();
		expect(session.geminiSessionId).toBeUndefined();
		expect(session.codexSessionId).toBeUndefined();
		expect(session.cursorSessionId).toBeUndefined();
	});

	it("clearRunnerSessionBindings is a no-op for an unknown session", () => {
		const mgr = makeManager();
		expect(() => mgr.clearRunnerSessionBindings("missing")).not.toThrow();
	});

	it("getLastAssistantBody returns the buffered body", () => {
		const mgr = makeManager();
		(mgr as any).lastAssistantBodyBySession.set("s1", "the summary");
		expect(mgr.getLastAssistantBody("s1")).toBe("the summary");
		expect(mgr.getLastAssistantBody("s2")).toBeUndefined();
	});
});
