import { describe, expect, it } from "vitest";
import { PlaneProgressNotes } from "../src/PlaneProgressNotes.js";
import { fakePlane } from "./fakePlane.js";

const routes = {
	// The run started from a reply (c-2) in the thread of c-1.
	"GET /runs/run-1/": {
		id: "run-1",
		issue: "wi-1",
		project: "p-1",
		comment: "c-2",
	},
	"GET /projects/p-1/work-items/wi-1/comments/c-2/": {
		id: "c-2",
		parent: "c-1",
	},
	"POST /projects/p-1/work-items/wi-1/comments/": { id: "note-1" },
	"PATCH /projects/p-1/work-items/wi-1/comments/note-1/": { id: "note-1" },
	"DELETE /projects/p-1/work-items/wi-1/comments/note-1/": {},
};

const writes = (calls: ReturnType<typeof fakePlane>["calls"]) =>
	calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/auth/o/token/"));

describe("PlaneProgressNotes", () => {
	it("posts a working note in the run's thread, keeps it current, and removes it when the agent answers", async () => {
		const { api, calls } = fakePlane(routes);
		const notes = new PlaneProgressNotes(api, { minUpdateMs: 0 });

		await notes.onActivity("run-1", "thought", "Using model: opus");
		await notes.onActivity("run-1", "thought", "Reading the **exports**");
		await notes.onActivity("run-1", "action");
		await notes.onActivity("run-1", "response", "Done.");

		const [create, update, remove] = writes(calls);
		// A reply to the thread's top comment; housekeeping thoughts aren't shown.
		expect(create).toMatchObject({ method: "POST", body: { parent: "c-1" } });
		expect(
			(create!.body as { comment_html: string }).comment_html,
		).not.toContain("Using model");
		expect(update).toMatchObject({ method: "PATCH" });
		expect((update!.body as { comment_html: string }).comment_html).toContain(
			"<p>Now: Reading the <strong>exports</strong></p>",
		);
		expect(remove).toMatchObject({ method: "DELETE" });
		expect(writes(calls)).toHaveLength(3);
	});

	it("waits between edits instead of editing on every thought", async () => {
		const { api, calls } = fakePlane(routes);
		const notes = new PlaneProgressNotes(api, { minUpdateMs: 60_000 });
		await notes.onActivity("run-1", "thought", "First step");
		await notes.onActivity("run-1", "thought", "Second step");
		await notes.onActivity("run-1", "thought", "Third step");
		expect(writes(calls).map((c) => c.method)).toEqual(["POST"]);
		// Answering still removes the note (and drops the queued edit).
		await notes.onActivity("run-1", "elicitation", "Which repo?");
		expect(writes(calls).map((c) => c.method)).toEqual(["POST", "DELETE"]);
	});
});
