import { isAbsolute } from "node:path";
import type { SandboxMode } from "@openai/codex-sdk";
import type { ResolvedCodexSandbox } from "../backend/types.js";

/**
 * Cyrus filesystem sandbox intent (subset of the agent SDK `SandboxSettings`).
 * Paths are expected absolute by the time they reach here (the EdgeWorker layer
 * resolves `~`/`.`/relative entries before plumbing them in).
 *
 * `denyRead` has no direct app-server equivalent — reads are an allow-list, so
 * a denied path is honored by simply not appearing in `readableRoots`. Sub-path
 * denies inside an allowed root are not expressible (and not needed by Cyrus's
 * deny-broad / allow-narrow posture).
 */
export interface CyrusSandboxFilesystem {
	allowRead?: string[];
	allowWrite?: string[];
	denyRead?: string[];
}

export interface SandboxResolveInput {
	/** Coarse Codex sandbox mode (defaults to workspace-write upstream). */
	mode: SandboxMode;
	/** Session working directory (always writable + readable). */
	workingDirectory?: string;
	/** Extra writable roots (e.g. multi-repo sub-worktrees), already absolute. */
	writableRoots: string[];
	networkAccess: boolean;
	/** When present, produces a granular `policy`; otherwise a `workspace-mode`. */
	sandboxSettings?: CyrusSandboxFilesystem;
}

function uniqueAbsolute(paths: string[]): string[] {
	return [...new Set(paths.filter((p) => p && isAbsolute(p)))];
}

/**
 * Resolve the per-thread sandbox decision.
 *
 * - No `sandboxSettings` → `workspace-mode` (the coarse Codex mode with broad
 *   reads — unchanged default behavior).
 * - `sandboxSettings` present → a granular structured `policy` (restricted reads
 *   to the allow-list + explicit writable roots).
 */
export function resolveCodexSandbox(
	input: SandboxResolveInput,
): ResolvedCodexSandbox {
	const { mode, workingDirectory, writableRoots, networkAccess } = input;
	const baseWritable = uniqueAbsolute([
		...(workingDirectory ? [workingDirectory] : []),
		...writableRoots,
	]);

	if (!input.sandboxSettings) {
		return {
			kind: "workspace-mode",
			mode,
			writableRoots: baseWritable,
			networkAccess,
		};
	}

	const { allowRead = [], allowWrite = [] } = input.sandboxSettings;
	const writable = uniqueAbsolute([...baseWritable, ...allowWrite]);
	// Readable roots always include everything writable, plus explicit reads.
	const readableRoots = uniqueAbsolute([...writable, ...allowRead]);

	switch (mode) {
		case "danger-full-access":
			return { kind: "policy", policy: { type: "dangerFullAccess" } };
		case "read-only":
			return {
				kind: "policy",
				policy: { type: "readOnly", readableRoots, networkAccess },
			};
		default:
			return {
				kind: "policy",
				policy: {
					type: "workspaceWrite",
					writableRoots: writable,
					readableRoots,
					networkAccess,
				},
			};
	}
}
