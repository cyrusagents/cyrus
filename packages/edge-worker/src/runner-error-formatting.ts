/**
 * Helpers for recognising and clearly attributing errors that originate in the
 * underlying model/agent provider (Claude, Gemini, Codex, Cursor) rather than
 * in Cyrus itself.
 *
 * Motivation: when Claude's Anthropic API fails mid-turn, Claude Code surfaces
 * the failure as an assistant text block such as "API Error: Internal server
 * error". With a success-subtype result that text otherwise renders in Linear
 * as an ordinary "response" activity — making it look like Cyrus produced the
 * error, when in fact it came from the model provider's API. These helpers let
 * us detect that case and relabel it as an error that is explicitly attributed
 * to the provider.
 */

/** Human-readable display names for each runner type. */
const RUNNER_DISPLAY_NAMES: Record<string, string> = {
	claude: "Claude",
	gemini: "Gemini",
	codex: "Codex",
	cursor: "Cursor",
};

/**
 * Detect whether a piece of agent output is actually an error surfaced by the
 * underlying model/agent provider rather than a genuine agent response.
 *
 * Claude Code surfaces API failures as an assistant text block beginning with
 * "API Error:" — for example:
 *   - "API Error: Internal server error"
 *   - "API Error: 500 {\"type\":\"error\",...}"
 *   - "API Error: Request timed out."
 *
 * The match is anchored to the start of the (trimmed) text and case-insensitive
 * so that a legitimate response merely *mentioning* an API error elsewhere in
 * its body is not misclassified.
 */
export function isModelApiErrorText(text: string | undefined | null): boolean {
	if (!text) return false;
	return /^API Error\b/i.test(text.trim());
}

/**
 * Prefix model/provider error content with a clear attribution so the user can
 * tell the failure came from the model provider's API and not from Cyrus.
 *
 * @param content - The raw error text (e.g. "API Error: Internal server error")
 * @param runnerType - The runner that produced the error ("claude" | "gemini" | "codex" | "cursor")
 */
export function formatModelApiError(
	content: string,
	runnerType: string,
): string {
	const provider = RUNNER_DISPLAY_NAMES[runnerType] ?? "the agent";
	const body = content.trim();
	return `⚠️ **${provider} API error** — this error came from ${provider}'s API, not from Cyrus.\n\n${body}`;
}
