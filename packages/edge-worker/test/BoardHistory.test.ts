import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoardHistory, type BoardTask } from "../src/BoardHistory.js";
import { redactBoardText } from "../src/StatusBoard.js";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});
async function path() {
	const directory = await mkdtemp(join(tmpdir(), "board-archive-"));
	directories.push(directory);
	return join(directory, "history.json");
}
function task(id = "one"): BoardTask {
	return {
		id,
		title: "Task",
		issue: "TEAM-1",
		status: "running",
		reason: "",
		model: "",
		createdAt: 1,
		lastActivityAt: 2,
		turnStartedAt: 1,
		quiet: true,
		repositories: [],
	};
}
describe("task archive", () => {
	it("preserves recorded effort across restart and accepts older records", async () => {
		const file = await path();
		const archive = new BoardHistory(file);
		await archive.ready();
		archive.add(
			{
				...task("new"),
				reasoningEffort: "xhigh",
				fastMode: false,
				linearWorkspaceSlug: "nexmoe",
			},
			[],
		);
		archive.add(task("old"), []);
		archive.add({ ...task("fast"), fastMode: true }, []);
		await archive.flush();
		const restored = new BoardHistory(file);
		await restored.ready();
		expect(restored.tasks().find((t) => t.id === "new")?.fastMode).toBe(false);
		expect(restored.tasks().find((t) => t.id === "fast")?.fastMode).toBe(true);
		expect(
			restored.tasks().find((t) => t.id === "old")?.fastMode,
		).toBeUndefined();
		expect(
			restored.tasks().find((t) => t.id === "new")?.linearWorkspaceSlug,
		).toBe("nexmoe");
		expect(restored.tasks().find((t) => t.id === "new")?.reasoningEffort).toBe(
			"xhigh",
		);
		expect(
			restored.tasks().find((t) => t.id === "old")?.reasoningEffort,
		).toBeUndefined();
	});

	it("preserves tool correlation across restart while accepting older unlinked logs", async () => {
		const file = await path();
		const archive = new BoardHistory(file);
		await archive.ready();
		archive.add(task(), [
			{
				at: 1,
				source: "agent",
				kind: "tool",
				level: "info",
				text: "Read\n{}",
				toolCallId: "a".repeat(64),
				sessionId: "one",
			},
			{
				at: 2,
				source: "agent",
				kind: "output",
				level: "info",
				text: "",
				toolCallId: "a".repeat(64),
				sessionId: "one",
			},
			{
				at: 3,
				source: "agent",
				kind: "activity",
				level: "info",
				text: "Old entry",
			},
		]);
		await archive.flush();
		const restored = new BoardHistory(file);
		await restored.ready();
		expect(restored.logs("one")).toEqual(archive.logs("one"));
	});
	it("bounds retention, deduplicates IDs, and never treats an archive as a live runner", async () => {
		const archive = new BoardHistory();
		for (let index = 0; index < 205; index++)
			archive.add({ ...task(String(index)), lastActivityAt: index }, []);
		archive.add(
			{ ...task("204"), lastActivityAt: 204 },
			Array.from({ length: 120 }, (_, at) => ({
				at,
				source: "agent",
				kind: "activity",
				level: "info",
				text: String(at),
			})),
		);
		await archive.flush();
		expect(archive.tasks()).toHaveLength(200);
		expect(
			archive.tasks().every((task) => task.status !== "running" && !task.quiet),
		).toBe(true);
		expect(archive.logs("204")).toHaveLength(100);
		expect(archive.logs("204")[0]?.at).toBe(20);
	});
	it("redacts persisted text, strips extra fields, and loads history without client requests", async () => {
		const file = await path();
		const archive = new BoardHistory(file, redactBoardText);
		await archive.ready();
		archive.add(
			{
				...task(),
				title: "token=private-value",
				workspace: "/private/worktree",
			} as BoardTask,
			[],
		);
		await archive.flush();
		const raw = await readFile(file, "utf8");
		expect(raw).not.toContain("private-value");
		expect(raw).not.toContain("/private/worktree");
		const restored = new BoardHistory(file, redactBoardText);
		await restored.ready();
		expect(restored.tasks()[0]?.title).toBe("token=[REDACTED]");
	});
	it("keeps current task monitoring available when history is corrupt or unwritable", async () => {
		const file = await path();
		await writeFile(file, "invalid json");
		const corrupt = new BoardHistory(file);
		await corrupt.ready();
		expect(corrupt.warning).toContain("could not be read");
		const unwritable = new BoardHistory(join(file, "history.json"));
		await unwritable.ready();
		expect(() => unwritable.add(task(), [])).not.toThrow();
		await unwritable.flush();
		expect(unwritable.tasks()).toHaveLength(1);
		expect(unwritable.warning).toContain("could not be saved");
	});
});
