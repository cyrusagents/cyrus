import { describe, expect, it } from "vitest";
import {
	activityRows,
	activityStats,
	visibleRows,
} from "../board/activity-model.mjs";
import type { BoardLog } from "../src/StatusBoard.js";

function log(
	kind: BoardLog["kind"],
	text: string,
	extra: Partial<BoardLog> = {},
): BoardLog {
	return {
		at: 1000,
		source: "agent",
		level: "info",
		sessionId: "task-a",
		kind,
		text,
		...extra,
	};
}

describe("board activity projection", () => {
	it("joins overlapping tool calls by ID, retains failures, and searches full results", () => {
		const logs = [
			log("tool", 'Read\n{"path":"one"}', { toolCallId: "one" }),
			log("tool", 'Bash\n{"command":"build"}', { toolCallId: "two" }),
			log("output", "BUILD_FAILURE", {
				toolCallId: "two",
				level: "error",
				at: 3000,
			}),
			log("output", "file contents", { toolCallId: "one", at: 5000 }),
		];
		const rows = activityRows(logs);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			name: "Read",
			input: '{"path":"one"}',
			output: { text: "file contents" },
		});
		expect(rows[1]).toMatchObject({
			name: "Bash",
			level: "error",
			output: { text: "BUILD_FAILURE" },
		});
		expect(visibleRows(rows, "failure", true)).toEqual([rows[1]]);
		expect(visibleRows(rows, "not found", false)).toEqual([]);
		expect(activityStats(logs)).toEqual({ span: 4000, calls: 2, errors: 1 });
	});
	it("never pairs across tasks or invents links for historical records without IDs", () => {
		const rows = activityRows([
			log("tool", "Read\n{}", { toolCallId: "same" }),
			log("output", "other task", { sessionId: "task-b", toolCallId: "same" }),
			log("output", "unidentified result"),
			log("tool", "OldTool\n{}"),
			log("output", "old result"),
		]);
		expect(rows).toHaveLength(5);
		expect(rows.every((row) => !row.output)).toBe(true);
	});
	it("keeps expanded-row identity stable across rolling snapshots and new results", () => {
		const call = log("tool", "Read\n{}", { toolCallId: "one" });
		const before = activityRows([log("activity", "previous"), call]);
		const after = activityRows([
			call,
			log("output", "", { toolCallId: "one" }),
		]);
		expect(before[1].key).toBe(after[0].key);
		expect(after[0].output.text).toBe("");
		const duplicates = activityRows([call, call]);
		expect(duplicates[0].key).not.toBe(duplicates[1].key);
	});
	it("handles empty logs and service errors without reporting tool calls", () => {
		expect(activityStats([])).toEqual({ span: 0, calls: 0, errors: 0 });
		const rows = activityRows([
			log("service", "<script>alert(1)</script>", {
				source: "atmiko",
				level: "error",
			}),
		]);
		expect(visibleRows(rows, "ATMIKO", true)).toEqual(rows);
		expect(rows[0].log.text).toBe("<script>alert(1)</script>");
	});
});
