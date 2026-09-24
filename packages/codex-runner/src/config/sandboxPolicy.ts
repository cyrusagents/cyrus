import { isAbsolute } from "node:path";
import type { SandboxMode } from "@openai/codex-sdk";
import type {
	CodexFileSystemAccess,
	ResolvedCodexSandbox,
} from "../backend/types.js";

/** Stable id for the per-thread permission profile Miko builds. */
export const MIKO_SANDBOX_PROFILE_ID = "miko-sandbox";

/**
 * Miko filesystem sandbox intent (subset of the agent SDK `SandboxSettings`).
 * Paths are expected absolute by the time they reach here (the EdgeWorker layer
 * resolves `~`/`.`/relative entries before plumbing them in).
 *
 * Reads are an allow-list: a path is readable only if it is the worktree
 * (`:workspace_roots`), a platform default (`:minimal`), or appears in
 * `allowRead`/`allowWrite`. Anything else (e.g. the home directory) is denied.
 * `denyRead` is honored by omission — a denied path simply never appears in the
 * allow-list. Sub-path denies inside an allowed root are not expressible (and
 * not needed by Miko's deny-broad / allow-narrow posture).
 */
export interface MikoSandboxFilesystem {
	allowRead?: string[];
	allowWrite?: string[];
	denyRead?: string[];
}

export interface SandboxResolveInput {
	/** Coarse Codex sandbox mode (defaults to workspace-write upstream). */
	mode: SandboxMode;
	/** Session working directory (the worktree; maps to `:workspace_roots`). */
	workingDirectory?: string;
	/** Extra writable roots (e.g. multi-repo sub-worktrees), already absolute. */
	writableRoots: string[];
	networkAccess: boolean;
	/** When present, produces a granular `profile`; otherwise a `workspace-mode`. */
	sandboxSettings?: MikoSandboxFilesystem;
}

function uniqueAbsolute(paths: string[]): string[] {
	return [...new Set(paths.filter((p) => p && isAbsolute(p)))];
}

/**
 * Resolve the per-thread sandbox decision.
 *
 * - No `sandboxSettings` → `workspace-mode` (the coarse Codex mode with broad
 *   reads — unchanged default behavior).
 * - `sandboxSettings` present → a granular permission `profile` that restricts
 *   reads to an allow-list (worktree + platform defaults + explicit reads) and
 *   writes to the worktree + explicit writable roots.
 */
export function resolveCodexSandbox(
	input: SandboxResolveInput,
): ResolvedCodexSandbox {
	const { mode, workingDirectory, writableRoots, networkAccess } = input;

	if (!input.sandboxSettings) {
		return {
			kind: "workspace-mode",
			mode,
			writableRoots: uniqueAbsolute([
				...(workingDirectory ? [workingDirectory] : []),
				...writableRoots,
			]),
			networkAccess,
		};
	}

	const { allowRead = [], allowWrite = [] } = input.sandboxSettings;
	const cwd = workingDirectory;
	// Extra writable roots beyond the worktree (cwd is covered by :workspace_roots).
	const writableAbs = uniqueAbsolute([...writableRoots, ...allowWrite]).filter(
		(p) => p !== cwd,
	);
	// Readable-only roots: explicit reads not already writable / the worktree.
	const readableAbs = uniqueAbsolute(allowRead).filter(
		(p) => p !== cwd && !writableAbs.includes(p),
	);

	// Danger-full-access keeps broad access; read-only forbids writes; the
	// default (workspace-write) makes the worktree writable.
	const dangerFull = mode === "danger-full-access";
	const workspaceAccess: CodexFileSystemAccess =
		mode === "read-only" ? "read" : "write";

	const filesystem: Record<string, CodexFileSystemAccess> = dangerFull
		? { ":root": "write" }
		: {
				":minimal": "read",
				":workspace_roots": workspaceAccess,
				":tmpdir": "write",
				":slash_tmp": "write",
				...Object.fromEntries(writableAbs.map((p) => [p, "write" as const])),
				...Object.fromEntries(readableAbs.map((p) => [p, "read" as const])),
			};

	return {
		kind: "profile",
		profileId: MIKO_SANDBOX_PROFILE_ID,
		filesystem,
		networkAccess,
	};
}
