import { describe, expect, it } from "vitest";
import { activityRows } from "../board/activity-model.mjs";
import {
	marqueeSelection,
	selectionText,
	selectRows,
} from "../board/activity-selection.mjs";

describe("activity row selection", () => {
	it("selects intersecting rows by rectangle, supports additive selection, and excludes non-intersections", () => {
		const bounds = [
			{ key: "one", left: 0, right: 600, top: 0, bottom: 38 },
			{ key: "two", left: 0, right: 600, top: 38, bottom: 76 },
			{ key: "three", left: 0, right: 600, top: 76, bottom: 114 },
		];
		const box = { left: 200, right: 350, top: 15, bottom: 60 };
		expect([...marqueeSelection(bounds, box)]).toEqual(["one", "two"]);
		expect([...marqueeSelection(bounds, box, new Set(["three"]))]).toEqual([
			"three",
			"one",
			"two",
		]);
		expect([
			...marqueeSelection(bounds, { ...box, left: 601, right: 650 }),
		]).toEqual([]);
		expect([
			...marqueeSelection(bounds, { ...box, top: 114, bottom: 200 }),
		]).toEqual([]);
	});
	const rows = ["one", "two", "three", "four"].map((key) => ({ key }));
	it("supports individual toggles and Shift ranges in both directions", () => {
		let selected = selectRows(rows, new Set(), "two", null, false, true);
		selected = selectRows(rows, selected, "four", "two", true, true);
		expect([...selected]).toEqual(["two", "three", "four"]);
		selected = selectRows(rows, selected, "one", "four", true, false);
		expect([...selected]).toEqual([]);
		selected = selectRows(rows, selected, "one", null, false, true);
		selected = selectRows(rows, selected, "four", "one", false, true);
		expect([...selected]).toEqual(["one", "four"]);
	});
	it("ranges use only visible rows and tolerate an anchor removed by new logs", () => {
		const filtered = [rows[0], rows[3]];
		expect([
			...selectRows(filtered, new Set(), "four", "one", true, true),
		]).toEqual(["one", "four"]);
		expect([
			...selectRows(filtered, new Set(), "four", "gone", true, true),
		]).toEqual(["four"]);
	});
	it("copies full loaded text and paired results in display order, without hidden or unselected rows", () => {
		const logs = [
			{
				at: 1000,
				source: "agent",
				kind: "activity",
				level: "info",
				text: "First\nSecond",
				issue: "TEAM-1",
			},
			{
				at: 2000,
				source: "agent",
				kind: "tool",
				level: "info",
				text: 'Read\n{"path":"file.txt"}',
				sessionId: "task",
				toolCallId: "call",
				issue: "TEAM-1",
			},
			{
				at: 3000,
				source: "agent",
				kind: "output",
				level: "error",
				text: `Full output\n${"x".repeat(500)}`,
				sessionId: "task",
				toolCallId: "call",
				issue: "TEAM-1",
			},
			{
				at: 4000,
				source: "miko",
				kind: "service",
				level: "info",
				text: "Not selected",
			},
		];
		const projected = activityRows(logs);
		const selected = new Set([projected[1].key, projected[0].key]);
		expect(selectionText(projected, selected)).toBe(
			"[1970-01-01T00:00:01.000Z] [TEAM-1] ASSISTANT INFO\nFirst\nSecond\n\n" +
				'[1970-01-01T00:00:02.000Z] [TEAM-1] TOOL INFO\nRead\n{"path":"file.txt"}\n' +
				"[1970-01-01T00:00:03.000Z] [TEAM-1] RESULT ERROR\nFull output\n" +
				"x".repeat(500),
		);
		expect(selectionText(projected.slice(1), selected)).not.toContain(
			"ASSISTANT",
		);
		expect(selectionText(projected, new Set())).toBe("");
	});
});
