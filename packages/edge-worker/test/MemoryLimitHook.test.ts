import type {
	HookCallbackMatcher,
	PostToolUseHookInput,
	PreToolUseHookInput,
} from "cyrus-claude-runner";
import type { ILogger } from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import {
	buildCommandExcerpt,
	buildMemoryLimitHook,
	buildOomReportHook,
	extractResultText,
	OOM_MARKER,
	parseOomMarker,
	singleQuote,
} from "../src/hooks/MemoryLimitHook.js";

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

/** A working set of env values that satisfies all PreToolUse gates. */
function cloudEnv(
	overrides: Record<string, string | undefined> = {},
): (name: string) => string | undefined {
	const env: Record<string, string | undefined> = {
		CYRUS_RUNTIME: "cloud",
		CYRUS_TOOL_MEMORY_MAX_MB: "1300",
		...overrides,
	};
	return (name: string) => env[name];
}

function makePreInput(toolInput: unknown): PreToolUseHookInput {
	return {
		hook_event_name: "PreToolUse",
		session_id: "s",
		transcript_path: "t",
		cwd: "/work",
		tool_name: "Bash",
		tool_input: toolInput,
		tool_use_id: "u",
	} as PreToolUseHookInput;
}

async function runPre(
	matcher: HookCallbackMatcher,
	input: PreToolUseHookInput,
): Promise<any> {
	const fn = matcher.hooks[0];
	return fn(input as any, "u", { signal: new AbortController().signal });
}

function preMatcher(
	deps: Parameters<typeof buildMemoryLimitHook>[1],
): HookCallbackMatcher {
	const hook = buildMemoryLimitHook(silentLogger, deps);
	const matcher = hook.PreToolUse?.[0];
	if (!matcher) {
		throw new Error("expected a PreToolUse matcher");
	}
	return matcher;
}

describe("singleQuote", () => {
	it("wraps a simple string", () => {
		expect(singleQuote("echo hi")).toBe("'echo hi'");
	});

	it("escapes embedded single quotes", () => {
		expect(singleQuote("it's")).toBe("'it'\\''s'");
	});

	it("leaves double quotes, backticks and $() untouched inside quotes", () => {
		expect(singleQuote('echo "$(date)" `id`')).toBe("'echo \"$(date)\" `id`'");
	});
});

describe("buildMemoryLimitHook — gating (no-op cases)", () => {
	it("registers a Bash matcher under PreToolUse", () => {
		const matcher = preMatcher({});
		expect(matcher.matcher).toBe("Bash");
	});

	it("is a no-op when CYRUS_RUNTIME is not 'cloud'", async () => {
		const matcher = preMatcher({
			getEnv: cloudEnv({ CYRUS_RUNTIME: undefined }),
			wrapperExists: () => true,
		});
		const result = await runPre(matcher, makePreInput({ command: "ls" }));
		expect(result).toEqual({ continue: true });
	});

	it("is a no-op when CYRUS_TOOL_MEMORY_MAX_MB is unset", async () => {
		const matcher = preMatcher({
			getEnv: cloudEnv({ CYRUS_TOOL_MEMORY_MAX_MB: undefined }),
			wrapperExists: () => true,
		});
		const result = await runPre(matcher, makePreInput({ command: "ls" }));
		expect(result).toEqual({ continue: true });
	});

	it("is a no-op when the wrapper binary is absent even if both env vars are set", async () => {
		const matcher = preMatcher({
			getEnv: cloudEnv(),
			wrapperExists: () => false,
		});
		const result = await runPre(matcher, makePreInput({ command: "ls" }));
		expect(result).toEqual({ continue: true });
	});
});

describe("buildMemoryLimitHook — command rewrite", () => {
	const deps = { getEnv: cloudEnv(), wrapperExists: () => true };

	it("rewrites a simple command with the inline cap prefix", async () => {
		const matcher = preMatcher(deps);
		const result = await runPre(
			matcher,
			makePreInput({ command: "pnpm test" }),
		);
		expect(result.hookSpecificOutput).toEqual({
			hookEventName: "PreToolUse",
			permissionDecision: "allow",
			updatedInput: {
				command: "CYRUS_TOOL_MEMORY_MAX_MB=1300 cyrus-tool-exec 'pnpm test'",
			},
		});
	});

	it("preserves other tool_input fields in updatedInput", async () => {
		const matcher = preMatcher(deps);
		const result = await runPre(
			matcher,
			makePreInput({ command: "ls", description: "list", timeout: 5000 }),
		);
		expect(result.hookSpecificOutput.updatedInput).toEqual({
			command: "CYRUS_TOOL_MEMORY_MAX_MB=1300 cyrus-tool-exec 'ls'",
			description: "list",
			timeout: 5000,
		});
	});

	it("safely single-quotes embedded single quotes", async () => {
		const matcher = preMatcher(deps);
		const result = await runPre(
			matcher,
			makePreInput({ command: "echo 'hello world'" }),
		);
		expect(result.hookSpecificOutput.updatedInput.command).toBe(
			"CYRUS_TOOL_MEMORY_MAX_MB=1300 cyrus-tool-exec 'echo '\\''hello world'\\'''",
		);
	});

	it("leaves double quotes, backticks and command substitution intact", async () => {
		const matcher = preMatcher(deps);
		const cmd = 'echo "$(whoami)" `hostname`';
		const result = await runPre(matcher, makePreInput({ command: cmd }));
		expect(result.hookSpecificOutput.updatedInput.command).toBe(
			`CYRUS_TOOL_MEMORY_MAX_MB=1300 cyrus-tool-exec ${singleQuote(cmd)}`,
		);
	});

	it("handles heredocs (newlines) without corruption", async () => {
		const matcher = preMatcher(deps);
		const cmd = "cat <<'EOF'\nline1\nline2\nEOF";
		const result = await runPre(matcher, makePreInput({ command: cmd }));
		expect(result.hookSpecificOutput.updatedInput.command).toBe(
			`CYRUS_TOOL_MEMORY_MAX_MB=1300 cyrus-tool-exec ${singleQuote(cmd)}`,
		);
	});
});

describe("buildMemoryLimitHook — fail open on unexpected input", () => {
	const deps = { getEnv: cloudEnv(), wrapperExists: () => true };

	it("is a no-op when command is missing", async () => {
		const matcher = preMatcher(deps);
		const result = await runPre(matcher, makePreInput({ description: "x" }));
		expect(result).toEqual({ continue: true });
	});

	it("is a no-op when tool_input is undefined", async () => {
		const matcher = preMatcher(deps);
		const result = await runPre(matcher, makePreInput(undefined));
		expect(result).toEqual({ continue: true });
	});

	it("is a no-op when command is not a string", async () => {
		const matcher = preMatcher(deps);
		const result = await runPre(matcher, makePreInput({ command: 42 }));
		expect(result).toEqual({ continue: true });
	});

	it("is a no-op when command is an empty string", async () => {
		const matcher = preMatcher(deps);
		const result = await runPre(matcher, makePreInput({ command: "" }));
		expect(result).toEqual({ continue: true });
	});
});

describe("parseOomMarker", () => {
	it("parses cap and peak from the marker line", () => {
		const line = `${OOM_MARKER} exceeded 1300M memory budget (peak 1500000000 bytes).`;
		expect(parseOomMarker(line)).toEqual({
			budgetMb: 1300,
			peakBytes: 1500000000,
		});
	});

	it("returns an empty object when nothing matches", () => {
		expect(parseOomMarker("no marker here")).toEqual({});
	});
});

describe("extractResultText", () => {
	it("returns strings unchanged", () => {
		expect(extractResultText("hello")).toBe("hello");
	});

	it("joins string fields of an object (e.g. stdout/stderr)", () => {
		const text = extractResultText({ stdout: "out", stderr: "err" });
		expect(text).toContain("out");
		expect(text).toContain("err");
	});
});

describe("buildCommandExcerpt", () => {
	it("returns a short prefix of a plain command", () => {
		expect(buildCommandExcerpt("pnpm test")).toBe("pnpm test");
	});

	it("unwraps the wrapper prefix back to the original command", () => {
		const wrapped =
			"CYRUS_TOOL_MEMORY_MAX_MB=1300 cyrus-tool-exec 'echo '\\''hi'\\'''";
		expect(buildCommandExcerpt(wrapped)).toBe("echo 'hi'");
	});

	it("truncates to the max length", () => {
		const long = "a".repeat(500);
		expect(buildCommandExcerpt(long, 200)).toHaveLength(200);
	});
});

function makePostInput(
	toolResponse: unknown,
	command = "pnpm test",
): PostToolUseHookInput {
	return {
		hook_event_name: "PostToolUse",
		session_id: "s",
		transcript_path: "t",
		cwd: "/work",
		tool_name: "Bash",
		tool_input: { command },
		tool_response: toolResponse,
		tool_use_id: "u",
	} as PostToolUseHookInput;
}

async function runPost(
	matcher: HookCallbackMatcher,
	input: PostToolUseHookInput,
): Promise<any> {
	const fn = matcher.hooks[0];
	return fn(input as any, "u", { signal: new AbortController().signal });
}

function postMatcher(
	deps: Parameters<typeof buildOomReportHook>[1],
): HookCallbackMatcher {
	const hook = buildOomReportHook(silentLogger, deps);
	const matcher = hook.PostToolUse?.[0];
	if (!matcher) {
		throw new Error("expected a PostToolUse matcher");
	}
	return matcher;
}

describe("buildOomReportHook", () => {
	const markerText = `${OOM_MARKER} exceeded 1300M memory budget (peak 1500000000 bytes).`;

	it("registers a Bash matcher under PostToolUse", () => {
		const matcher = postMatcher({ getEnv: () => undefined });
		expect(matcher.matcher).toBe("Bash");
	});

	it("does not POST when the marker is absent", async () => {
		const fetchImpl = vi.fn();
		const matcher = postMatcher({
			getEnv: cloudEnv({ CYRUS_API_KEY: "key" }),
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		await runPost(matcher, makePostInput("all good"));
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("does not POST when CYRUS_API_KEY is missing", async () => {
		const fetchImpl = vi.fn();
		const matcher = postMatcher({
			getEnv: () => undefined,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		await runPost(matcher, makePostInput(markerText));
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("POSTs the parsed OOM event to /api/oom-event with the bearer key", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		const matcher = postMatcher({
			getEnv: (n) => (n === "CYRUS_API_KEY" ? "secret-key" : undefined),
			getBaseUrl: () => "https://app.atcyrus.com",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		await runPost(
			matcher,
			makePostInput({ stderr: markerText }, "pnpm run heavy"),
		);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, options] = fetchImpl.mock.calls[0];
		expect(url).toBe("https://app.atcyrus.com/api/oom-event");
		expect(options.method).toBe("POST");
		expect(options.headers.Authorization).toBe("Bearer secret-key");
		expect(JSON.parse(options.body)).toEqual({
			budgetMb: 1300,
			peakBytes: 1500000000,
			commandExcerpt: "pnpm run heavy",
		});
	});

	it("fails open (returns {}) when fetch throws", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
		const matcher = postMatcher({
			getEnv: (n) => (n === "CYRUS_API_KEY" ? "secret-key" : undefined),
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		const result = await runPost(
			matcher,
			makePostInput({ stderr: markerText }),
		);
		expect(result).toEqual({});
	});
});
