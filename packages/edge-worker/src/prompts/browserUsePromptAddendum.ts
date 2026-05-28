/**
 * Optional system-prompt addendum that tells the agent it has access to the
 * `agent-browser` CLI (Playwright-backed) and a local Chromium for taking
 * screenshots and driving real browsers.
 *
 * Only injected when the environment variable `CYRUS_BROWSER_USE_ENABLED` is
 * set to a truthy value. cyrus-hosted sets this on cloud-runtime droplets
 * (where chromium + agent-browser are pre-installed) and leaves it unset for
 * self-host runtimes (where the binaries may not be available).
 */
export const BROWSER_USE_PROMPT_ADDENDUM = `
<browser_use>
You have access to the \`agent-browser\` CLI (a Playwright-backed browser
automation tool) and a local Chromium install. Use it to verify frontend
changes, capture screenshots for the user, and drive real browser flows.

**When to use it:**
- After making UI or frontend changes, open the running dev server in a
  browser and capture a screenshot to confirm the change renders as
  expected. Attach the screenshot when summarizing your work.
- When the user asks "what does this look like?" or requests visual proof.
- When reproducing a bug that involves browser behavior (clicks, forms,
  navigation, rendering).

**Tips:**
- Add \`sleep 0.5\` between rapid commands — each invocation spawns its own
  process and the browser needs a moment to settle.
- Use \`snapshot -i\` to find a reliable \`@ref\` before clicking; visible
  text alone can be ambiguous.
- For screenshots you intend to attach to a PR or Linear comment, write
  them to the workspace (e.g. \`./screenshot.png\`) so they're picked up by
  the upload flow.
</browser_use>
`.trim();

/**
 * Append the browser-use addendum to a system prompt fragment, but only when
 * the `CYRUS_BROWSER_USE_ENABLED` env var is truthy. Returns the existing
 * prompt unchanged otherwise.
 */
export function appendBrowserUseAddendum(
	existing: string | undefined | null,
): string {
	const base = (existing ?? "").trimEnd();
	if (!isBrowserUseEnabled()) {
		return existing ?? "";
	}
	if (base.length === 0) return BROWSER_USE_PROMPT_ADDENDUM;
	return `${base}\n\n${BROWSER_USE_PROMPT_ADDENDUM}`;
}

function isBrowserUseEnabled(): boolean {
	const raw = process.env.CYRUS_BROWSER_USE_ENABLED;
	if (!raw) return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes";
}
