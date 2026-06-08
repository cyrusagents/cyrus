import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Compute the default Claude Code auto-memory directory for a given cwd.
 *
 * Claude Code's SDK, when `settings.autoMemoryDirectory` is unset, derives the
 * memory dir from the session's cwd by replacing every `/` and `.` in the
 * absolute path with `-` and placing it under `~/.claude/projects/<encoded>/memory`.
 *
 * Knowing this path lets us add it to `additionalDirectories` on session
 * spawn, so Read of an auto-written memory file does not get blocked by
 * Claude Code's directory ACL (the reported bug in CYHOST-906 / CYPACK-1253).
 *
 * Encoding examples:
 *   /home/cyrus/cyrus-workspaces/cyhost-906
 *     → ~/.claude/projects/-home-cyrus-cyrus-workspaces-cyhost-906/memory
 *   /Users/agentops/.cyrus/repos/cyrus
 *     → ~/.claude/projects/-Users-agentops--cyrus-repos-cyrus/memory
 *     (note the `--` where `.` was encoded immediately after a `/`)
 *
 * The input path is normalized via `path.resolve` first so trailing slashes
 * and `.`/`..` segments produce the same encoded form as the SDK.
 */
export function getProjectAutoMemoryDirectory(cwd: string): string {
	const absolute = resolve(cwd);
	const encoded = absolute.replace(/[./]/g, "-");
	return `${homedir()}/.claude/projects/${encoded}/memory`;
}
