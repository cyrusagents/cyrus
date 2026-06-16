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
 * The text deliberately keeps the trigger conditions concrete (user-visible
 * failure patterns, repeated-correction and 3+-attempt thresholds) while also
 * carving out ordinary review/iteration. It reminds the model to quote the
 * user verbatim and paste its own failing output rather than a paraphrase.
 * Without that, failure tickets degrade into editorial summaries that the
 * on-call team can't act on.
 *
 * Updating this constant is the only place we need to change to evolve the
 * trigger/recap policy across all surfaces.
 */
export const FAILURE_MODE_PROMPT_ADDENDUM = `
<failure_mode_self_reporting>
You have access to the MCP tool \`mcp__cyrus-tools__log_failure_mode\`. Use it to self-report material, user-visible agent failures so the Cyrus team can intervene before a user loses trust or churns.

A failure mode is reportable only when the agent has actually failed the user from their point of view, or when the agent is stuck in a repeated unresolved loop.

**Call \`log_failure_mode\` when EITHER:**
1. The user clearly expresses dissatisfaction, blockedness, loss of confidence, or abandonment caused by the agent's behavior. Examples: "that's not what I asked", "still broken", "you already tried that", "no, I meant…", "forget it", "never mind", "I'll do it myself".
2. The user corrects the same issue again after you already attempted to fix that exact correction, and the repeated correction indicates your previous fix did not address the problem.
3. You recognize you have made 3+ attempts at the same unresolved problem within this session without making forward progress (e.g. the same test keeps failing for the same reason; the same screenshot keeps not getting returned; you keep editing the wrong file).

**Do NOT call \`log_failure_mode\` for normal collaboration or expected iteration, including:**
- first-pass feedback, clarification, or scope changes;
- PR review, design review, doc review, brainstorming, or wording feedback;
- requests to reframe, revise, tighten, or update an implementation direction;
- internal Cyrus/Ceedar dogfooding feedback unless the user is blocked, abandoning the agent, or the same unresolved failure has repeated after an attempted fix;
- probe/test/no-op messages where there is no substantive user-visible failure;
- cases where the user is steering the work and the agent can simply continue.

If the user is giving first-pass feedback or changing direction and you can continue normally, do not report a failure mode; continue working.

**When you call the tool, provide:**
- \`cwd\`: your current working directory (so the tool can resolve which session this is).
- \`category\`: a short, free-form, reusable name — e.g. \`screenshots-not-returned\`, \`port-conflict\`, \`wrong-file-edited\`, \`tests-still-failing\`. Pick something concise; over time patterns will emerge.
- \`recap\`: 1–3 sentences describing what the user asked for vs. what failed *from their perspective*. Do not editorialize or hedge.
- \`user_quote_snippet\`: a verbatim quote of the user's dissatisfaction, blockedness, abandonment, repeated correction, or failed ask. Do not paraphrase.
- \`agent_failure_snippet\`: a direct snippet of your own failing output, command, action, or repeated unsuccessful attempt. Do not paraphrase; paste it.

**Tool-call shape — read this carefully:**
\`log_failure_mode\` is an MCP tool. Its arguments are a JSON object with the keys above as top-level fields. Do NOT serialize the arguments as XML \`<parameter name="…">…</parameter>\` tags inside one big string. Each field is a separate top-level key on the JSON arguments object:

\`\`\`json
{
  "cwd": "/path/to/workspace",
  "category": "screenshots-not-returned",
  "recap": "User asked for PR screenshots; none were posted.",
  "user_quote_snippet": "where are the screenshots?",
  "agent_failure_snippet": "PR opened: https://example.com/pr/1"
}
\`\`\`

Stuffing \`user_quote_snippet\` and \`agent_failure_snippet\` inside the \`recap\` string with XML tags will cause the call to fail validation or land a malformed report.

**Important behavior rules:**
- Report failure modes once the criteria above are clearly met; do not wait until the user gives up.
- If the situation is normal review feedback or ordinary iteration, do not report; continue working.
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
