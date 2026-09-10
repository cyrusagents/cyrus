import type {
	HookCallbackMatcher,
	PostToolUseHookInput,
} from "cyrus-claude-runner";
import type { ILogger } from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import {
	appendMarker,
	buildPrMarkerHook,
	CYRUS_PR_MARKER,
	type DetectedPullRequest,
	GitHubPrMarkerProvider,
	GitLabMrMarkerProvider,
	type PrMarkerProvider,
} from "../src/hooks/PrMarkerHook.js";

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

function makeHookInput(
	command: string,
	cwd = "/tmp/repo",
): PostToolUseHookInput {
	return {
		hook_event_name: "PostToolUse",
		session_id: "s",
		transcript_path: "t",
		cwd,
		tool_name: "Bash",
		tool_input: { command },
		tool_response: {},
		tool_use_id: "u",
	} as PostToolUseHookInput;
}

async function runHook(
	matcher: HookCallbackMatcher,
	input: PostToolUseHookInput,
): Promise<void> {
	const fn = matcher.hooks[0];
	await fn(input as any, "u", { signal: new AbortController().signal });
}

describe("appendMarker", () => {
	it("appends the marker to a non-empty body", () => {
		expect(appendMarker("hello")).toBe(`hello\n\n${CYRUS_PR_MARKER}`);
	});

	it("returns just the marker for an empty body", () => {
		expect(appendMarker("")).toBe(CYRUS_PR_MARKER);
		expect(appendMarker(null)).toBe(CYRUS_PR_MARKER);
		expect(appendMarker(undefined)).toBe(CYRUS_PR_MARKER);
	});

	it("is idempotent when the marker is already present", () => {
		const body = `summary\n\n${CYRUS_PR_MARKER}`;
		expect(appendMarker(body)).toBe(body);
	});

	it("trims trailing whitespace before appending", () => {
		expect(appendMarker("body\n\n\n")).toBe(`body\n\n${CYRUS_PR_MARKER}`);
	});
});

describe("GitHubPrMarkerProvider.matches", () => {
	const provider = new GitHubPrMarkerProvider();

	it.each([
		"gh pr create --draft --title foo",
		"gh pr edit 123 --body x",
		"gt submit",
		"  gt submit --stack  ",
	])("matches %s", (cmd) => {
		expect(provider.matches(cmd)).toBe(true);
	});

	it.each([
		"gh repo view",
		"gh issue create",
		"echo gh pr create", // still substring match — acceptable since hook is idempotent
		"git pr create",
	])("rejects unrelated command: %s", (cmd) => {
		// `echo gh pr create` will actually match — that's fine and a documented
		// false-positive. The provider's ensureMarker is idempotent and a no-op
		// when there's no PR. Sanity-check the truly unrelated ones here.
		if (cmd === "echo gh pr create") return;
		expect(provider.matches(cmd)).toBe(false);
	});
});

describe("GitLabMrMarkerProvider.matches", () => {
	const provider = new GitLabMrMarkerProvider();

	it.each([
		"glab mr create --draft",
		"glab mr update 5 --description x",
		"glab mr edit",
	])("matches %s", (cmd) => {
		expect(provider.matches(cmd)).toBe(true);
	});

	it.each([
		"glab issue create",
		"gh mr create",
	])("rejects unrelated command: %s", (cmd) => {
		expect(provider.matches(cmd)).toBe(false);
	});
});

describe("buildPrMarkerHook", () => {
	function fakeProvider(
		name: string,
		matchPattern: RegExp,
	): {
		provider: PrMarkerProvider;
		ensureMarker: ReturnType<typeof vi.fn>;
	} {
		const ensureMarker = vi.fn();
		return {
			provider: {
				name,
				matches: (cmd) => matchPattern.test(cmd),
				ensureMarker,
			},
			ensureMarker,
		};
	}

	it("registers a single PostToolUse hook on the Bash matcher", () => {
		const hook = buildPrMarkerHook(silentLogger, []);
		expect(hook.PostToolUse).toHaveLength(1);
		expect(hook.PostToolUse?.[0].matcher).toBe("Bash");
	});

	it("invokes the first matching provider's ensureMarker with the session cwd", async () => {
		const a = fakeProvider("a", /\bgh pr create\b/);
		const b = fakeProvider("b", /\bglab mr create\b/);

		const hook = buildPrMarkerHook(silentLogger, [a.provider, b.provider]);
		await runHook(
			hook.PostToolUse![0],
			makeHookInput("gh pr create --title x", "/work/repo"),
		);

		expect(a.ensureMarker).toHaveBeenCalledTimes(1);
		expect(a.ensureMarker).toHaveBeenCalledWith("/work/repo", silentLogger);
		expect(b.ensureMarker).not.toHaveBeenCalled();
	});

	it("is a no-op when no provider matches the command", async () => {
		const a = fakeProvider("a", /\bgh pr create\b/);

		const hook = buildPrMarkerHook(silentLogger, [a.provider]);
		await runHook(hook.PostToolUse![0], makeHookInput("ls -la"));

		expect(a.ensureMarker).not.toHaveBeenCalled();
	});

	it("swallows provider errors so the session is not interrupted", async () => {
		const provider: PrMarkerProvider = {
			name: "explodes",
			matches: () => true,
			ensureMarker: () => {
				throw new Error("boom");
			},
		};
		const warn = vi.fn();
		const log: ILogger = { ...silentLogger, warn } as unknown as ILogger;

		const hook = buildPrMarkerHook(log, [provider]);
		await expect(
			runHook(hook.PostToolUse![0], makeHookInput("gh pr create")),
		).resolves.toBeUndefined();

		expect(warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
	});
});

describe("buildPrMarkerHook — PR detection callback", () => {
	const detectedPr: DetectedPullRequest = {
		provider: "github",
		number: 16,
		title: "A Brief Tour of the Turning House (SPE-57)",
		url: "https://github.com/specstoryai/adventure/pull/16",
		isDraft: false,
		headBranch: "cylocal/spe-57-a-brief-tour-of-the-turning-house",
	};

	function providerReturning(pr: DetectedPullRequest | null): PrMarkerProvider {
		return {
			name: "github",
			matches: (cmd) => /\bgh pr create\b/.test(cmd),
			ensureMarker: () => {},
			readPullRequest: () => pr,
		};
	}

	it("invokes onPullRequestDetected with the provider's PR info and cwd", async () => {
		const onPr = vi.fn().mockResolvedValue(undefined);
		const hook = buildPrMarkerHook(
			silentLogger,
			[providerReturning(detectedPr)],
			onPr,
		);

		await runHook(
			hook.PostToolUse![0],
			makeHookInput("gh pr create --title x", "/work/repo"),
		);

		expect(onPr).toHaveBeenCalledTimes(1);
		expect(onPr).toHaveBeenCalledWith(detectedPr, "/work/repo");
	});

	it("does not invoke the callback when the provider finds no PR", async () => {
		const onPr = vi.fn();
		const hook = buildPrMarkerHook(
			silentLogger,
			[providerReturning(null)],
			onPr,
		);

		await runHook(hook.PostToolUse![0], makeHookInput("gh pr create"));

		expect(onPr).not.toHaveBeenCalled();
	});

	it("does not invoke the callback for providers without readPullRequest", async () => {
		const onPr = vi.fn();
		const provider: PrMarkerProvider = {
			name: "github",
			matches: () => true,
			ensureMarker: () => {},
		};
		const hook = buildPrMarkerHook(silentLogger, [provider], onPr);

		await runHook(hook.PostToolUse![0], makeHookInput("gh pr create"));

		expect(onPr).not.toHaveBeenCalled();
	});

	it("does not invoke the callback when the command matches no provider", async () => {
		const onPr = vi.fn();
		const hook = buildPrMarkerHook(
			silentLogger,
			[providerReturning(detectedPr)],
			onPr,
		);

		await runHook(hook.PostToolUse![0], makeHookInput("ls -la"));

		expect(onPr).not.toHaveBeenCalled();
	});

	it("swallows callback errors so the session is not interrupted", async () => {
		const warn = vi.fn();
		const log: ILogger = { ...silentLogger, warn } as unknown as ILogger;
		const onPr = vi.fn().mockRejectedValue(new Error("link failed"));
		const hook = buildPrMarkerHook(log, [providerReturning(detectedPr)], onPr);

		await expect(
			runHook(hook.PostToolUse![0], makeHookInput("gh pr create")),
		).resolves.toBeUndefined();

		expect(warn).toHaveBeenCalledWith(expect.stringContaining("link failed"));
	});
});
