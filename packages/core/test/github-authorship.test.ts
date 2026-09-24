import { describe, expect, it } from "vitest";
import {
	ensureMikoagentCoAuthorTrailer,
	MIKOAGENT_COAUTHOR_TRAILER,
	resolveGitHubAppBotIdentity,
	resolveGitHubAppSlugFromEnv,
} from "../src/github-authorship.js";

describe("ensureMikoagentCoAuthorTrailer", () => {
	it("appends the trailer when missing", () => {
		const result = ensureMikoagentCoAuthorTrailer("feat: add thing\n");
		expect(result).toBe(`feat: add thing\n\n${MIKOAGENT_COAUTHOR_TRAILER}\n`);
	});

	it("does not duplicate an existing trailer", () => {
		const message = `feat: add thing\n\n${MIKOAGENT_COAUTHOR_TRAILER}\n`;
		expect(ensureMikoagentCoAuthorTrailer(message)).toBe(message);
	});

	it("preserves other co-authors and adds mikoagent once", () => {
		const message = "fix: bug\n\nCo-authored-by: Alice <alice@example.com>\n";
		const result = ensureMikoagentCoAuthorTrailer(message);
		expect(result).toContain("Co-authored-by: Alice <alice@example.com>");
		expect(result).toContain(MIKOAGENT_COAUTHOR_TRAILER);
		expect(result.match(/Co-authored-by: mikoagent/gi)?.length).toBe(1);
	});

	it("is case-insensitive when detecting an existing trailer", () => {
		const message =
			"chore: x\n\nCo-Authored-By: MikoAgent <332957360+mikoagent@users.noreply.github.com>\n";
		expect(ensureMikoagentCoAuthorTrailer(message)).toBe(message);
	});
});

describe("resolveGitHubAppBotIdentity", () => {
	it("builds the GitHub App bot author form for the operator slug", () => {
		expect(resolveGitHubAppBotIdentity("42", "my-custom-agent")).toEqual({
			slug: "my-custom-agent",
			name: "my-custom-agent[bot]",
			email: "42+my-custom-agent[bot]@users.noreply.github.com",
		});
	});

	it("strips a trailing [bot] from the slug", () => {
		expect(resolveGitHubAppBotIdentity("99", "ops-bot[bot]").name).toBe(
			"ops-bot[bot]",
		);
	});

	it("does not hard-code miko-agent", () => {
		const identity = resolveGitHubAppBotIdentity("1", "whatever-slug");
		expect(identity.name).not.toContain("miko-agent");
		expect(identity.email).not.toContain("miko-agent");
	});
});

describe("resolveGitHubAppSlugFromEnv", () => {
	it("prefers GITHUB_APP_SLUG over GITHUB_BOT_USERNAME", () => {
		expect(
			resolveGitHubAppSlugFromEnv({
				GITHUB_APP_SLUG: "from-slug",
				GITHUB_BOT_USERNAME: "from-bot",
			}),
		).toBe("from-slug");
	});

	it("falls back to GITHUB_BOT_USERNAME", () => {
		expect(
			resolveGitHubAppSlugFromEnv({ GITHUB_BOT_USERNAME: "mention-bot[bot]" }),
		).toBe("mention-bot");
	});

	it("returns undefined when neither is set", () => {
		expect(resolveGitHubAppSlugFromEnv({})).toBeUndefined();
	});
});
