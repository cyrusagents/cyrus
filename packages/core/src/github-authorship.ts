/**
 * Commit authorship helpers for GitHub App vs local credential paths.
 *
 * - App token path: commits should be authored as the operator's App bot
 *   (`<slug>[bot]` / `<appId>+<slug>[bot]@users.noreply.github.com`). The
 *   App slug/id are operator-defined — never hard-code a product bot name.
 * - Fallback path: keep the local `git config user.name` / `user.email`.
 * - Always append the mikoagent Co-authored-by trailer (once) so the
 *   separately registered GitHub user is attributed via trailer, not by
 *   impersonating mikoagent as the commit author.
 */

/** Registered GitHub user that must always appear as a co-author trailer. */
export const MIKOAGENT_COAUTHOR_NAME = "mikoagent";
export const MIKOAGENT_COAUTHOR_EMAIL =
	"332957360+mikoagent@users.noreply.github.com";
export const MIKOAGENT_COAUTHOR_TRAILER = `Co-authored-by: ${MIKOAGENT_COAUTHOR_NAME} <${MIKOAGENT_COAUTHOR_EMAIL}>`;

const COAUTHOR_LINE_RE =
	/^Co-authored-by:\s*mikoagent\s*<332957360\+mikoagent@users\.noreply\.github\.com>\s*$/im;

/**
 * Ensure the mikoagent Co-authored-by trailer is present exactly once.
 * Preserves other trailers and body text. Appends after a blank line when
 * missing. Does not touch git user.name / user.email.
 */
export function ensureMikoagentCoAuthorTrailer(message: string): string {
	const normalized = message.replace(/\r\n/g, "\n").replace(/\s+$/u, "");
	if (COAUTHOR_LINE_RE.test(normalized)) {
		return `${normalized}\n`;
	}
	if (normalized.length === 0) {
		return `${MIKOAGENT_COAUTHOR_TRAILER}\n`;
	}
	return `${normalized}\n\n${MIKOAGENT_COAUTHOR_TRAILER}\n`;
}

export interface GitHubAppBotIdentity {
	/** e.g. `my-agent[bot]` */
	name: string;
	/** e.g. `12345+my-agent[bot]@users.noreply.github.com` */
	email: string;
	/** Bare slug without `[bot]` suffix */
	slug: string;
}

/**
 * Build the GitHub-recognized bot author identity for a given App.
 * @see https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation#git-over-https
 */
export function resolveGitHubAppBotIdentity(
	appId: string,
	slug: string,
): GitHubAppBotIdentity {
	const bare = slug.replace(/\[bot\]$/i, "").trim();
	if (!appId || !bare) {
		throw new Error(
			"resolveGitHubAppBotIdentity requires a non-empty appId and slug",
		);
	}
	return {
		slug: bare,
		name: `${bare}[bot]`,
		email: `${appId}+${bare}[bot]@users.noreply.github.com`,
	};
}

/**
 * Resolve the operator-defined App slug from env.
 * Prefers `GITHUB_APP_SLUG`, then `GITHUB_BOT_USERNAME` (mention handle).
 */
export function resolveGitHubAppSlugFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const raw = env.GITHUB_APP_SLUG || env.GITHUB_BOT_USERNAME;
	if (!raw) return undefined;
	const bare = raw.replace(/\[bot\]$/i, "").trim();
	return bare || undefined;
}
