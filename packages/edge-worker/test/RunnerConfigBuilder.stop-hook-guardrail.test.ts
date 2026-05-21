import type { StopHookInput } from "cyrus-claude-runner";
import { describe, expect, it } from "vitest";
import { buildStopHook } from "../src/RunnerConfigBuilder.js";

function getStopHookCallback() {
	const hooks = buildStopHook();
	const stop = hooks.Stop;
	if (!stop || stop.length === 0) {
		throw new Error("expected Stop hook entries");
	}
	const matcher = stop[0];
	expect(matcher.matcher).toBe(".*");
	const callback = matcher.hooks[0];
	if (!callback) {
		throw new Error("expected at least one Stop hook callback");
	}
	return callback;
}

function makeStopInput(overrides: Partial<StopHookInput> = {}): StopHookInput {
	return {
		hook_event_name: "Stop",
		session_id: "test-session",
		transcript_path: "/tmp/transcript",
		cwd: "/tmp",
		stop_hook_active: false,
		...overrides,
	} as StopHookInput;
}

describe("buildStopHook", () => {
	it("returns the Stop hook with a single `.*` matcher", () => {
		const hooks = buildStopHook();
		expect(Object.keys(hooks)).toEqual(["Stop"]);
		expect(hooks.Stop).toHaveLength(1);
		expect(hooks.Stop?.[0].matcher).toBe(".*");
		expect(hooks.Stop?.[0].hooks).toHaveLength(1);
	});

	it("blocks the first stop attempt with the commit/push/PR reminder", async () => {
		const callback = getStopHookCallback();
		const result = await callback(
			makeStopInput({ stop_hook_active: false }),
			"tool-use-id",
			{ signal: new AbortController().signal },
		);

		expect(result).toEqual({
			decision: "block",
			reason:
				"Before stopping, ensure you have committed and pushed all code changes " +
				"and created/updated a PR (if you made any code changes).\n\n" +
				"If you have already done this (or no code changes were made), you may stop again.",
		});
	});

	it("does not use the invalid `additionalContext` or `continue` fields", async () => {
		const callback = getStopHookCallback();
		const result = (await callback(
			makeStopInput({ stop_hook_active: false }),
			"tool-use-id",
			{ signal: new AbortController().signal },
		)) as Record<string, unknown>;

		expect(result).not.toHaveProperty("additionalContext");
		expect(result).not.toHaveProperty("continue");
	});

	it("allows the stop through when `stop_hook_active` is true", async () => {
		const callback = getStopHookCallback();
		const result = await callback(
			makeStopInput({ stop_hook_active: true }),
			"tool-use-id",
			{ signal: new AbortController().signal },
		);

		expect(result).toEqual({});
	});
});
