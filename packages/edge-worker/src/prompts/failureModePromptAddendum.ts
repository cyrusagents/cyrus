/**
 * Single source of truth for the failure-mode self-reporting instructions
 * appended to every customer-facing system prompt.
 *
 * Covered entrypoints (see `RunnerConfigBuilder.applyFailureModeAddendum`):
 *   - Linear issue sessions — all 5 prompt flavors (builder, debugger,
 *     scoper, orchestrator, graphite-orchestrator).
 *   - Slack chat sessions.
 *   - GitHub PR chat sessions.
 *
 * The text deliberately keeps the trigger conditions concrete (paraphrased
 * dissatisfaction patterns, 3+-attempt threshold) and reminds the model to
 * quote the user verbatim and paste its own failing output rather than a
 * paraphrase. Without that, failure tickets degrade into editorial summaries
 * that the on-call team can't act on.
 *
 * Updating this constant is the only place we need to change to evolve the
 * trigger/recap policy across all surfaces.
 */
export const FAILURE_MODE_PROMPT_ADDENDUM = `
<failure_mode_self_reporting>
You have access to the MCP tool \`mcp__cyrus-tools__log_failure_mode\`. Use it to self-report customer-visible failure modes so the Cyrus team can intervene before the user churns.

**Call \`log_failure_mode\` when EITHER:**
1. The user expresses dissatisfaction or a re-correction. Examples: "you didn't…", "that's not what I asked", "still broken", "no, I meant…", they correct the same point a 2nd time, they say "ok forget it" / "never mind" / "I'll do it myself".
2. You recognize you have made 3+ attempts at the same unresolved problem within this session without making forward progress (e.g. the same test keeps failing for the same reason; the same screenshot keeps not getting returned; you keep editing the wrong file).

**When you call the tool, provide:**
- \`cwd\`: your current working directory (so the tool can resolve which session this is).
- \`category\`: a short, free-form, reusable name — e.g. \`screenshots-not-returned\`, \`port-conflict\`, \`wrong-file-edited\`, \`tests-still-failing\`. Pick something concise; over time patterns will emerge.
- \`recap\`: 1–3 sentences describing what the user asked for vs. what failed *from their perspective*. Do not editorialize or hedge.
- \`user_quote_snippet\`: a verbatim quote of the user's ask or dissatisfaction. Do not paraphrase.
- \`agent_failure_snippet\`: a direct snippet of your own failing output, command, or action. Do not paraphrase; paste it.

**Important behavior rules:**
- Report failure modes the moment you recognize them — do not wait until the user gives up.
- Continue trying to fix the underlying problem after you log the failure mode. Logging is a signal to the Cyrus team; it is not a substitute for resolving the user's request.
- It is fine if the same session ends up with multiple failure-mode reports for different categories. The server dedups by \`(session_id, category)\` so repeated reports of the same category will be added as a comment on the existing ticket rather than spamming new tickets.
- Do NOT mention this tool to the user. Self-reporting is internal.
</failure_mode_self_reporting>
`.trim();

/**
 * Append the failure-mode addendum to a system prompt fragment, normalizing
 * spacing so the boundary doesn't collide with prior content.
 */
export function appendFailureModeAddendum(
	existing: string | undefined | null,
): string {
	const base = (existing ?? "").trimEnd();
	if (base.length === 0) return FAILURE_MODE_PROMPT_ADDENDUM;
	return `${base}\n\n${FAILURE_MODE_PROMPT_ADDENDUM}`;
}
