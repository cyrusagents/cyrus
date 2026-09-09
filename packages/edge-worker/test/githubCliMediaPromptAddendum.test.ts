import { describe, expect, it } from "vitest";
import {
	appendGitHubCliMediaAddendum,
	GITHUB_CLI_MEDIA_PROMPT_ADDENDUM,
} from "../src/prompts/githubCliMediaPromptAddendum.js";

describe("GitHub CLI media prompt addendum", () => {
	it("contains the complete GitHub CLI media guidance", () => {
		expect(GITHUB_CLI_MEDIA_PROMPT_ADDENDUM).toBe(`<github_cli_media>
GitHub CLI v2.99.0+ has a repeatable \`--attach <path>\` flag that uploads a
local image or video and references it inline in an issue, pull request, or
comment body. This is generally available to users on all GitHub plans. Use it
with \`gh issue create|edit|comment\` or
\`gh pr create|edit|comment\`, for example
\`gh pr comment --attach ./screenshot.png\`.

Check \`gh --version\` before using \`--attach\`. If the installed version is
older than v2.99.0, recommend that the user update GitHub CLI. See
https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments/
for supported formats, limits, alt text, and more examples.
</github_cli_media>`);
	});

	it("appends the guidance with a blank-line separator", () => {
		expect(appendGitHubCliMediaAddendum("You are Cyrus.")).toBe(
			`You are Cyrus.\n\n${GITHUB_CLI_MEDIA_PROMPT_ADDENDUM}`,
		);
	});

	it("returns the guidance verbatim with no base prompt", () => {
		expect(appendGitHubCliMediaAddendum(undefined)).toBe(
			GITHUB_CLI_MEDIA_PROMPT_ADDENDUM,
		);
		expect(appendGitHubCliMediaAddendum(null)).toBe(
			GITHUB_CLI_MEDIA_PROMPT_ADDENDUM,
		);
		expect(appendGitHubCliMediaAddendum("")).toBe(
			GITHUB_CLI_MEDIA_PROMPT_ADDENDUM,
		);
	});
});
