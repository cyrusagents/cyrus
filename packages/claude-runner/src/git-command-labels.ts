/**
 * Semantic labels for git/forge Bash commands.
 *
 * Linear's own coding agent renders pushes and PR creation as dedicated
 * timeline rows ("Git Push <branch>", "Create PR <title>") instead of raw
 * shell commands. Cyrus runs those operations through the Bash tool, so by
 * default they render as generic "Bash" action rows. This module recognizes
 * the common forms and supplies the same semantic action/parameter pair,
 * which the formatter uses in place of the generic Bash label.
 *
 * Deliberately conservative: when a command is compound (e.g. `git add …
 * && git commit … && git push`) we do NOT relabel it — calling that row
 * "Git Push" would misrepresent the other side effects. A leading
 * `cd <dir> &&` prefix is the one tolerated compound form.
 */

export interface GitCommandLabel {
	/** Semantic action name, e.g. "Git Push" or "Create PR". */
	action: string;
	/**
	 * Human-oriented parameter for the action row — the branch being pushed
	 * or the PR title. Empty string when nothing better than the raw command
	 * is known; callers should fall back to the command in that case.
	 */
	parameter: string;
}

/** Strip a single tolerated `cd <dir> &&` prefix. */
function stripCdPrefix(command: string): string {
	return command.replace(/^\s*cd\s+(?:"[^"]+"|'[^']+'|\S+)\s*&&\s*/, "");
}

/** True when the string still contains shell chaining/sequencing operators. */
function isCompound(command: string): boolean {
	return /&&|\|\||;|\n/.test(command);
}

/**
 * Extract the value of a `--title`/`-t` flag from a `gh pr create` /
 * `glab mr create` command line. Returns null when absent.
 */
export function extractTitleFlag(command: string): string | null {
	const match = command.match(
		/(?:--title|-t)(?:=|\s+)("([^"]*)"|'([^']*)'|(\S+))/,
	);
	if (!match) return null;
	return match[2] ?? match[3] ?? match[4] ?? null;
}

/**
 * Best-effort branch name for a simple `git push` command.
 * Handles `git push`, `git push origin branch`, `git push -u origin branch`,
 * and refspecs (`local:remote` → remote side). Returns "" when the branch
 * is not stated on the command line (e.g. plain `git push`).
 */
export function extractPushBranch(command: string): string {
	const afterPush = command.replace(/^\s*git\s+push(?=\s|$)/, "");
	const tokens = afterPush.trim().split(/\s+/).filter(Boolean);
	const positionals: string[] = [];
	let skipNext = false;
	for (const token of tokens) {
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (token.startsWith("-")) {
			// Flags that consume a value when space-separated.
			if (/^(?:-o|--push-option|--receive-pack|--exec)$/.test(token)) {
				skipNext = true;
			}
			continue;
		}
		positionals.push(token);
	}
	// [remote] [refspec…] — the branch is the last refspec when present.
	if (positionals.length >= 2) {
		const refspec = positionals[positionals.length - 1] ?? "";
		const colon = refspec.indexOf(":");
		return colon >= 0 ? refspec.slice(colon + 1) : refspec;
	}
	return "";
}

/**
 * Recognize a Bash command as a semantic git/forge operation.
 * Returns null when the command should keep its generic Bash label.
 */
export function labelGitCommand(
	command: string | undefined | null,
): GitCommandLabel | null {
	if (!command) return null;
	const simple = stripCdPrefix(command);

	// PR/MR creation — allow surrounding context (env vars, HEREDOC bodies)
	// as long as the creating invocation is present. Mirrors the matching
	// rule of the PR-marker hook.
	if (/\bgh\s+pr\s+create\b/.test(simple)) {
		return { action: "Create PR", parameter: extractTitleFlag(simple) ?? "" };
	}
	if (/\bglab\s+mr\s+create\b/.test(simple)) {
		return { action: "Create MR", parameter: extractTitleFlag(simple) ?? "" };
	}
	if (/^\s*gt\s+submit\b/.test(simple) && !isCompound(simple)) {
		return { action: "Create PR", parameter: extractTitleFlag(simple) ?? "" };
	}

	// Push — only when the whole (cd-stripped) command is a single push.
	if (/^\s*git\s+push(?=\s|$)/.test(simple) && !isCompound(simple)) {
		return { action: "Git Push", parameter: extractPushBranch(simple) };
	}

	return null;
}
