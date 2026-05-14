/**
 * Tests for the Project Update @-mention routing gate (Workstream A1).
 */

import { describe, expect, it } from "vitest";
import { mentionsAgent, parseMentions } from "../src/project-mentions.js";

describe("parseMentions", () => {
	it("extracts bare @mentions, lower-cased and de-duplicated", () => {
		expect(parseMentions("hey @Mara and @greta, also @Mara again")).toEqual([
			"mara",
			"greta",
		]);
	});

	it("extracts markdown-link style mentions", () => {
		expect(
			parseMentions("[@Mara](https://linear.app/test/profiles/mara) thoughts?"),
		).toContain("mara");
	});

	it("returns an empty array when there are no mentions", () => {
		expect(parseMentions("Status: on track, no blockers.")).toEqual([]);
	});
});

describe("mentionsAgent", () => {
	const identity = { id: "47dc268e-9d4f-4f7b-ac18-3ba7b2beb255", name: "Mara" };

	it("matches the agent's display name as @Name (case-insensitive)", () => {
		expect(mentionsAgent("hey @mara what about pricing?", identity)).toBe(true);
		expect(mentionsAgent("hey @MARA what about pricing?", identity)).toBe(true);
	});

	it("matches the agent's Linear user id embedded in the body", () => {
		expect(
			mentionsAgent(
				"[Mara](https://linear.app/test/profiles/47dc268e-9d4f-4f7b-ac18-3ba7b2beb255)",
				identity,
			),
		).toBe(true);
	});

	it("does not match a different agent's mention", () => {
		expect(mentionsAgent("hey @greta can you review?", identity)).toBe(false);
	});

	it("does not match a substring of the name (word boundary)", () => {
		expect(mentionsAgent("hey @maradona is here", identity)).toBe(false);
	});

	it("does not match when the name appears without an @", () => {
		expect(mentionsAgent("Mara should look at this", identity)).toBe(false);
	});

	it("returns false for an empty body", () => {
		expect(mentionsAgent("", identity)).toBe(false);
	});

	it("returns false when the agent identity is unknown", () => {
		expect(mentionsAgent("hey @mara", {})).toBe(false);
	});

	it("still matches by name when only the name is known", () => {
		expect(mentionsAgent("hey @mara", { name: "Mara" })).toBe(true);
	});

	it("still matches by id when only the id is known", () => {
		expect(
			mentionsAgent("ping 47dc268e-9d4f-4f7b-ac18-3ba7b2beb255", {
				id: "47dc268e-9d4f-4f7b-ac18-3ba7b2beb255",
			}),
		).toBe(true);
	});
});
