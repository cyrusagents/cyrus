/**
 * Single source of truth for the context-discipline guidance appended to every
 * customer-facing Claude system prompt.
 *
 * Why this exists: the dominant cost driver on long Cyrus sessions is the volume
 * of accumulated conversation context that is re-sent on every turn. The
 * structural fix is early auto-compaction (`EdgeWorkerConfig.claudeAutoCompactWindow`
 * → SDK `settings.autoCompactWindow`). This addendum is the *behavioral* comple-
 * ment: a short nudge to avoid needlessly growing that context (redundant
 * re-reads, whole-file reads where a range/grep suffices) and to prefer scoping
 * genuinely oversized work rather than ballooning one session.
 *
 * Deliberately terse. Every token here is paid on every turn of every session,
 * so a long lecture would work against the very cost goal it serves. Claude Code
 * already has strong read-discipline instincts; this only reinforces them and
 * makes the scoping option explicit.
 *
 * Updating this constant is the only place we need to change to evolve the
 * context-discipline policy across all Claude surfaces.
 */
export const CONTEXT_DISCIPLINE_PROMPT_ADDENDUM = `
<context_discipline>
Keep the working context lean — on long sessions the accumulated conversation is
re-sent every turn, so needless growth is the main driver of cost and latency.

- Reuse what you have already read; do not re-read a file whose contents are
  still in this conversation unless you have reason to believe it changed.
- Prefer targeted reads (a line range, or a grep/search) over reading an entire
  large file when you only need part of it.
- After you edit a file, trust that the edit applied — do not re-read it just to
  confirm, unless a later step actually depends on the new contents.
- If a task is genuinely too large to complete well in one focused session, it is
  fine to say so and propose splitting it into smaller scoped issues rather than
  attempting everything in one ever-growing session.

This is about avoiding *wasted* work, not about cutting corners: read whatever you
genuinely need to do the task correctly.
</context_discipline>
`.trim();

/**
 * Append the context-discipline addendum to a system prompt fragment,
 * normalizing spacing so the boundary doesn't collide with prior content.
 */
export function appendContextDisciplineAddendum(
	existing: string | undefined | null,
): string {
	const base = (existing ?? "").trimEnd();
	if (base.length === 0) return CONTEXT_DISCIPLINE_PROMPT_ADDENDUM;
	return `${base}\n\n${CONTEXT_DISCIPLINE_PROMPT_ADDENDUM}`;
}
