import { describe, expect, it } from "vitest";
import { HandoffService } from "../src/HandoffService.js";

function svc() {
	const reader = {
		getCurrentBranch: () => "branch",
		getStatus: () => "",
		getRecentCommits: () => "",
		getDiffSummary: () => "",
		getOpenPrUrl: () => undefined,
	};
	return new HandoffService(reader);
}

describe("HandoffService.parseHandoffCommand", () => {
	it("returns null when there is no handoff command", () => {
		expect(svc().parseHandoffCommand("please add tests")).toBeNull();
	});

	it("parses a codex target", () => {
		expect(svc().parseHandoffCommand("/handoff codex")).toEqual({
			targetRunner: "codex",
			rawTarget: "codex",
			remainder: "",
		});
	});

	it("parses a claude target with a leading mention and trailing instruction", () => {
		expect(
			svc().parseHandoffCommand("@Cyrus /handoff claude also add tests"),
		).toEqual({
			targetRunner: "claude",
			rawTarget: "claude",
			remainder: "also add tests",
		});
	});

	it("is case-insensitive for the target", () => {
		expect(svc().parseHandoffCommand("/handoff CODEX")?.targetRunner).toBe(
			"codex",
		);
	});

	it("flags an unrecognized target with targetRunner null", () => {
		expect(svc().parseHandoffCommand("/handoff gemini")).toEqual({
			targetRunner: null,
			rawTarget: "gemini",
			remainder: "",
		});
	});
});
