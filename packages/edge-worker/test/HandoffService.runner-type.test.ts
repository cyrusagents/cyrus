import { describe, expect, it } from "vitest";
import { getActiveRunnerType } from "../src/HandoffService.js";

describe("getActiveRunnerType", () => {
	it("reads claude from claudeSessionId", () => {
		expect(getActiveRunnerType({ claudeSessionId: "x" } as any)).toBe("claude");
	});

	it("reads codex from codexSessionId", () => {
		expect(getActiveRunnerType({ codexSessionId: "x" } as any)).toBe("codex");
	});

	it("falls back to the runner constructor name", () => {
		const session = {
			agentRunner: { constructor: { name: "CodexRunner" } },
		} as any;
		expect(getActiveRunnerType(session)).toBe("codex");
	});

	it("returns unknown when nothing identifies the runner", () => {
		expect(getActiveRunnerType({} as any)).toBe("unknown");
	});
});
