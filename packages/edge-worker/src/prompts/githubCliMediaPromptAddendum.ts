/**
 * System-prompt addendum describing GitHub CLI media attachments.
 *
 * Unlike environment-specific tooling addenda, this guidance is included in
 * every agent session so agents can use the capability whenever an appropriate
 * GitHub CLI version is available.
 */
export const GITHUB_CLI_MEDIA_PROMPT_ADDENDUM = `
<github_cli_media>
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
</github_cli_media>
`.trim();

/** Append the GitHub CLI media guidance to a system prompt fragment. */
export function appendGitHubCliMediaAddendum(
	existing: string | undefined | null,
): string {
	const base = (existing ?? "").trimEnd();
	if (base.length === 0) return GITHUB_CLI_MEDIA_PROMPT_ADDENDUM;
	return `${base}\n\n${GITHUB_CLI_MEDIA_PROMPT_ADDENDUM}`;
}
