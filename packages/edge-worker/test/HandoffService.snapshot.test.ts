import { describe, expect, it } from "vitest";
import { HandoffService } from "../src/HandoffService.js";

function svc(overrides: Record<string, unknown> = {}) {
	const reader = {
		getCurrentBranch: () => "CYR-1-feature",
		getStatus: () => " M src/a.ts",
		getRecentCommits: () => "abc first\ndef second",
		getDiffSummary: () => " src/a.ts | 2 +-",
		getOpenPrUrl: () => "https://github.com/o/r/pull/9",
		...overrides,
	};
	return new HandoffService(reader as any);
}

const args = {
	sourceRunner: "claude" as const,
	targetRunner: "codex" as const,
	issueId: "issue-1",
	sessionId: "sess-1",
	worktreePath: "/ws/CYR-1",
	latestSummary: "Implemented the parser.",
};

describe("HandoffService.buildSnapshot", () => {
	it("collects all git fields from the reader", () => {
		const snap = svc().buildSnapshot(args);
		expect(snap).toMatchObject({
			sourceRunner: "claude",
			targetRunner: "codex",
			branch: "CYR-1-feature",
			gitStatus: " M src/a.ts",
			recentCommits: "abc first\ndef second",
			diffSummary: " src/a.ts | 2 +-",
			prLink: "https://github.com/o/r/pull/9",
			latestSummary: "Implemented the parser.",
		});
	});

	it("omits the PR link when none is available", () => {
		const snap = svc({ getOpenPrUrl: () => undefined }).buildSnapshot(args);
		expect(snap.prLink).toBeUndefined();
	});
});

describe("HandoffService.buildHandoffPrompt", () => {
	it("includes the handoff context block and the user instruction", () => {
		const snap = svc().buildSnapshot(args);
		const prompt = svc().buildHandoffPrompt(snap, "add tests too");
		expect(prompt).toContain("<handoff_context>");
		expect(prompt).toContain("<source_runner>claude</source_runner>");
		expect(prompt).toContain("<target_runner>codex</target_runner>");
		expect(prompt).toContain("<branch>CYR-1-feature</branch>");
		expect(prompt).toContain("https://github.com/o/r/pull/9");
		expect(prompt).toContain("Implemented the parser.");
		expect(prompt.trimEnd().endsWith("add tests too")).toBe(true);
	});

	it("uses a default instruction when the user gave none", () => {
		const snap = svc().buildSnapshot(args);
		const prompt = svc().buildHandoffPrompt(snap, "");
		expect(prompt).toContain(
			"Continue the work in this worktree from where the previous runner left off.",
		);
	});
});
