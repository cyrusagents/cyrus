import { describe, expect, it } from "vitest";
import { buildPromptText, stripMention } from "../src/ZulipPromptText.js";

describe("stripMention", () => {
	it("strips a leading mention", () => {
		expect(stripMention("@**Impala** what changed?")).toBe("what changed?");
	});

	it("strips a leading silent mention", () => {
		expect(stripMention("@_**Impala** what changed?")).toBe("what changed?");
	});

	it("strips a mention disambiguated by user ID", () => {
		expect(stripMention("@**Impala|42** what changed?")).toBe("what changed?");
	});

	it("keeps a mention of someone else mid-sentence", () => {
		expect(stripMention("@**Impala** ask @**Nate** about it")).toBe(
			"ask @**Nate** about it",
		);
	});

	it("leaves text with no mention untouched", () => {
		expect(stripMention("just a question")).toBe("just a question");
	});

	it("returns an empty string for a bare mention", () => {
		expect(stripMention("@**Impala**")).toBe("");
	});

	it("handles an empty body", () => {
		expect(buildPromptText("")).toBe("");
	});
});
