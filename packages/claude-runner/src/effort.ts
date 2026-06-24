import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { EffortApplicationResult, EffortDirective } from "cyrus-core";

export type { EffortDirective } from "cyrus-core";

/** All recognized directive tokens, in ascending order. */
export const EFFORT_DIRECTIVE_VALUES: readonly EffortDirective[] = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
] as const;

/**
 * The SDK flag-layer effort levels accepted by `Query.applyFlagSettings`.
 * Note this set deliberately omits `max`: the live flag layer cannot reach
 * `max` — only session-start `Options.effort` can.
 */
export type FlagEffortLevel = "low" | "medium" | "high" | "xhigh";

/**
 * Resolved effort to apply when a session is STARTING, via the `query()`
 * `Options.effort` (full range, including `max`) plus the `ultracode` settings
 * flag for `ultra`.
 */
export interface StartEffort {
	/** Top-level `Options.effort` value (supports the full range incl. `max`). */
	effort: EffortLevel;
	/** When true, enable ultracode (xhigh + workflow orchestration) at start. */
	ultracode?: boolean;
}

/**
 * Map a directive to the values used at session start.
 *
 * - `low`..`max` → that effort level.
 * - `ultra` → `xhigh` effort + ultracode enabled.
 */
export function resolveStartEffort(directive: EffortDirective): StartEffort {
	if (directive === "ultra") {
		return { effort: "xhigh", ultracode: true };
	}
	return { effort: directive };
}

/**
 * Flag-layer settings to merge into a LIVE session via
 * `Query.applyFlagSettings`. Every field is set explicitly so the flag layer
 * fully reflects the latest directive ("latest wins" semantics).
 */
export interface LiveEffortFlagSettings {
	effortLevel: FlagEffortLevel;
	ultracode: boolean;
	/**
	 * Whether the Workflow tool is enabled. Set true only for `ultra` — ultracode
	 * cannot orchestrate workflows unless workflows are also enabled (the SDK
	 * gates the Workflow tool behind this). Set explicitly so switching away from
	 * `ultra` turns it back off ("latest wins").
	 */
	enableWorkflows: boolean;
}

/**
 * Resolved effort to apply MID-SESSION. Because the live flag layer cannot set
 * `max`, a mid-session `max` directive is clamped to `xhigh` and `clampedFromMax`
 * is set so the caller can surface a note explaining `max` needs a fresh session.
 */
export interface LiveEffort extends EffortApplicationResult {
	/** Settings to pass to `Query.applyFlagSettings`. */
	flagSettings: LiveEffortFlagSettings;
}

/**
 * Map a directive to the live (mid-session) flag-layer application.
 *
 * - `low`..`xhigh` → that level, ultracode cleared.
 * - `max` → clamped to `xhigh` (ultracode cleared), `clampedFromMax = true`.
 * - `ultra` → `xhigh` + ultracode enabled.
 */
export function resolveLiveEffort(directive: EffortDirective): LiveEffort {
	if (directive === "ultra") {
		return {
			flagSettings: {
				effortLevel: "xhigh",
				ultracode: true,
				enableWorkflows: true,
			},
			clampedFromMax: false,
			label: "ultracode (xhigh + workflows)",
		};
	}
	if (directive === "max") {
		return {
			flagSettings: {
				effortLevel: "xhigh",
				ultracode: false,
				enableWorkflows: false,
			},
			clampedFromMax: true,
			label: "xhigh (clamped from max — max takes effect from a new session)",
		};
	}
	return {
		flagSettings: {
			effortLevel: directive,
			ultracode: false,
			enableWorkflows: false,
		},
		clampedFromMax: false,
		label: directive,
	};
}
