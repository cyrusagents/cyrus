import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	HookCallbackMatcher,
	PostToolUseHookInput,
} from "cyrus-claude-runner";
import type { ILogger } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyIntentToAdd,
	buildIntentToAddHook,
	DefaultIntentToAddGitClient,
	extractToolPath,
	type IntentToAddGitClient,
} from "../src/hooks/IntentToAddHook.js";

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

function git(cwd: string, args: string): void {
	execSync(`git ${args}`, {
		cwd,
		stdio: ["ignore", "ignore", "ignore"],
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "test",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	});
}

function makeHookInput(
	toolName: string,
	toolInput: Record<string, unknown>,
	cwd: string,
): PostToolUseHookInput {
	return {
		hook_event_name: "PostToolUse",
		session_id: "s",
		transcript_path: "t",
		cwd,
		tool_name: toolName,
		tool_input: toolInput,
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

describe("extractToolPath", () => {
	it("reads file_path for Write/Edit/MultiEdit", () => {
		expect(extractToolPath({ file_path: "/a.txt" })).toBe("/a.txt");
	});

	it("reads notebook_path for NotebookEdit", () => {
		expect(extractToolPath({ notebook_path: "/n.ipynb" })).toBe("/n.ipynb");
	});

	it("returns undefined for missing/empty/non-string paths", () => {
		expect(extractToolPath(undefined)).toBeUndefined();
		expect(extractToolPath({})).toBeUndefined();
		expect(extractToolPath({ file_path: "" })).toBeUndefined();
		expect(extractToolPath({ file_path: 42 })).toBeUndefined();
	});
});

describe("applyIntentToAdd", () => {
	function makeClient(overrides: Partial<IntentToAddGitClient> = {}) {
		return {
			isGitRepo: vi.fn().mockReturnValue(true),
			pathExists: vi.fn().mockReturnValue(true),
			isIgnored: vi.fn().mockReturnValue(false),
			isTracked: vi.fn().mockReturnValue(false),
			intentToAdd: vi.fn(),
			...overrides,
		};
	}

	it("calls intentToAdd when all preconditions hold", () => {
		const client = makeClient();
		applyIntentToAdd(client, "/cwd", "/cwd/x.ts", silentLogger);
		expect(client.intentToAdd).toHaveBeenCalledWith("/cwd", "/cwd/x.ts");
	});

	it("is a no-op when cwd is not a git repo", () => {
		const client = makeClient({ isGitRepo: vi.fn().mockReturnValue(false) });
		applyIntentToAdd(client, "/cwd", "/cwd/x.ts", silentLogger);
		expect(client.intentToAdd).not.toHaveBeenCalled();
	});

	it("is a no-op when path does not exist", () => {
		const client = makeClient({ pathExists: vi.fn().mockReturnValue(false) });
		applyIntentToAdd(client, "/cwd", "/cwd/x.ts", silentLogger);
		expect(client.intentToAdd).not.toHaveBeenCalled();
	});

	it("is a no-op when path is gitignored", () => {
		const client = makeClient({ isIgnored: vi.fn().mockReturnValue(true) });
		applyIntentToAdd(client, "/cwd", "/cwd/x.ts", silentLogger);
		expect(client.intentToAdd).not.toHaveBeenCalled();
	});

	it("is a no-op when path is already tracked", () => {
		const client = makeClient({ isTracked: vi.fn().mockReturnValue(true) });
		applyIntentToAdd(client, "/cwd", "/cwd/x.ts", silentLogger);
		expect(client.intentToAdd).not.toHaveBeenCalled();
	});

	it("does not throw when intentToAdd throws", () => {
		const client = makeClient({
			intentToAdd: vi.fn(() => {
				throw new Error("boom");
			}),
		});
		expect(() =>
			applyIntentToAdd(client, "/cwd", "/cwd/x.ts", silentLogger),
		).not.toThrow();
	});
});

describe("buildIntentToAddHook", () => {
	it("registers a PostToolUse matcher for Write/Edit/MultiEdit/NotebookEdit", () => {
		const hooks = buildIntentToAddHook(silentLogger);
		const matchers = hooks.PostToolUse ?? [];
		expect(matchers).toHaveLength(1);
		const regex = new RegExp(matchers[0]!.matcher!);
		expect(regex.test("Write")).toBe(true);
		expect(regex.test("Edit")).toBe(true);
		expect(regex.test("MultiEdit")).toBe(true);
		expect(regex.test("NotebookEdit")).toBe(true);
		expect(regex.test("Bash")).toBe(false);
		expect(regex.test("Read")).toBe(false);
	});

	it("invokes the client when called with a Write tool input", async () => {
		const client: IntentToAddGitClient = {
			isGitRepo: vi.fn().mockReturnValue(true),
			pathExists: vi.fn().mockReturnValue(true),
			isIgnored: vi.fn().mockReturnValue(false),
			isTracked: vi.fn().mockReturnValue(false),
			intentToAdd: vi.fn(),
		};
		const hooks = buildIntentToAddHook(silentLogger, client);
		await runHook(
			hooks.PostToolUse![0]!,
			makeHookInput("Write", { file_path: "/cwd/new.ts" }, "/cwd"),
		);
		expect(client.intentToAdd).toHaveBeenCalledWith("/cwd", "/cwd/new.ts");
	});

	it("is a no-op when tool input has no path", async () => {
		const client: IntentToAddGitClient = {
			isGitRepo: vi.fn().mockReturnValue(true),
			pathExists: vi.fn().mockReturnValue(true),
			isIgnored: vi.fn().mockReturnValue(false),
			isTracked: vi.fn().mockReturnValue(false),
			intentToAdd: vi.fn(),
		};
		const hooks = buildIntentToAddHook(silentLogger, client);
		await runHook(hooks.PostToolUse![0]!, makeHookInput("Write", {}, "/cwd"));
		expect(client.isGitRepo).not.toHaveBeenCalled();
		expect(client.intentToAdd).not.toHaveBeenCalled();
	});
});

describe("DefaultIntentToAddGitClient (integration with real git)", () => {
	let workdir: string;

	beforeEach(() => {
		workdir = mkdtempSync(join(tmpdir(), "cyrus-intent-to-add-"));
	});

	afterEach(() => {
		rmSync(workdir, { recursive: true, force: true });
	});

	it("marks an untracked file with intent-to-add so git status surfaces it", () => {
		git(workdir, "init -b main");
		writeFileSync(join(workdir, "README.md"), "hello\n");
		git(workdir, "add README.md");
		git(workdir, 'commit -m "init"');

		const newFile = join(workdir, "new-feature.ts");
		writeFileSync(newFile, "export const x = 1;\n");

		const client = new DefaultIntentToAddGitClient();
		applyIntentToAdd(client, workdir, newFile, silentLogger);

		const status = execSync("git status --porcelain --untracked-files=no", {
			cwd: workdir,
			encoding: "utf8",
		}).trim();
		expect(status).toMatch(/new-feature\.ts/);
	});

	it("does nothing when cwd is not a git repo", () => {
		const newFile = join(workdir, "file.ts");
		writeFileSync(newFile, "x\n");
		const client = new DefaultIntentToAddGitClient();
		expect(() =>
			applyIntentToAdd(client, workdir, newFile, silentLogger),
		).not.toThrow();
		expect(existsSync(join(workdir, ".git"))).toBe(false);
	});

	it("does nothing when the path is gitignored", () => {
		git(workdir, "init -b main");
		writeFileSync(join(workdir, ".gitignore"), "ignored.txt\n");
		git(workdir, "add .gitignore");
		git(workdir, 'commit -m "init"');

		const ignored = join(workdir, "ignored.txt");
		writeFileSync(ignored, "x\n");

		const client = new DefaultIntentToAddGitClient();
		applyIntentToAdd(client, workdir, ignored, silentLogger);

		const status = execSync("git status --porcelain --untracked-files=no", {
			cwd: workdir,
			encoding: "utf8",
		}).trim();
		expect(status).toBe("");
	});

	it("does nothing when the path is already tracked", () => {
		git(workdir, "init -b main");
		const tracked = join(workdir, "tracked.txt");
		writeFileSync(tracked, "hello\n");
		git(workdir, "add tracked.txt");
		git(workdir, 'commit -m "init"');

		const client = new DefaultIntentToAddGitClient();
		expect(() =>
			applyIntentToAdd(client, workdir, tracked, silentLogger),
		).not.toThrow();

		const status = execSync("git status --porcelain --untracked-files=no", {
			cwd: workdir,
			encoding: "utf8",
		}).trim();
		expect(status).toBe("");
	});

	it("does nothing when the path does not exist", () => {
		git(workdir, "init -b main");
		const missing = join(workdir, "missing.txt");
		const client = new DefaultIntentToAddGitClient();
		expect(() =>
			applyIntentToAdd(client, workdir, missing, silentLogger),
		).not.toThrow();
	});
});
