import type { EdgeWorkerConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { RunnerSelectionService } from "../src/RunnerSelectionService.js";

function service(): RunnerSelectionService {
	return new RunnerSelectionService({
		repositories: [],
		defaultRunner: "claude",
	} as unknown as EdgeWorkerConfig);
}

describe("RunnerSelectionService fallback selector semantics", () => {
	it("marks defaultRunner selection as implicit", () => {
		expect(
			service().determineRunnerSelection([], "").selectionWasExplicit,
		).toBe(false);
	});

	it("marks an agent description selector as explicit", () => {
		expect(
			service().determineRunnerSelection([], "[agent=claude]")
				.selectionWasExplicit,
		).toBe(true);
	});

	it("marks an agent label as explicit", () => {
		expect(
			service().determineRunnerSelection(["claude"]).selectionWasExplicit,
		).toBe(true);
	});
});
