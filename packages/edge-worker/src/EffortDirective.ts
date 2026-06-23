import type { EffortDirective } from "cyrus-claude-runner";

/**
 * Matches a natural `Effort: <level>` directive on its own line.
 *
 * - Anchored to a whole line (multiline + ignore-case) so prose like
 *   "the effort was high" never matches.
 * - Leading/trailing spaces and tabs around the keyword, colon, and value are
 *   tolerated.
 * - Only the recognized tokens match; anything else (e.g. `Effort: turbo`)
 *   yields no match.
 */
const EFFORT_DIRECTIVE_REGEX =
	/^[ \t]*effort[ \t]*:[ \t]*(low|medium|high|xhigh|max|ultra)[ \t]*$/gim;

/**
 * Parse a Claude reasoning-effort directive out of free text (a Linear issue
 * description or comment).
 *
 * Returns the recognized {@link EffortDirective} token, or `null` when no
 * directive is present. When multiple `Effort:` lines appear, the LAST one
 * wins ("latest wins" semantics, consistent across description and comments).
 */
export function parseEffortDirective(
	text: string | null | undefined,
): EffortDirective | null {
	if (!text) {
		return null;
	}
	// Reset lastIndex defensively — the regex is global and module-scoped.
	EFFORT_DIRECTIVE_REGEX.lastIndex = 0;
	let last: EffortDirective | null = null;
	let match: RegExpExecArray | null = EFFORT_DIRECTIVE_REGEX.exec(text);
	while (match !== null) {
		const value = match[1];
		if (value) {
			last = value.toLowerCase() as EffortDirective;
		}
		match = EFFORT_DIRECTIVE_REGEX.exec(text);
	}
	return last;
}
