import { execFileSync, execSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StopHookInput } from "cyrus-claude-runner";
import type { ILogger } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildStopHook,
	inspectGitGuardrail,
} from "../src/RunnerConfigBuilder.js";

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

function getStopHookCallback() {
	const hooks = buildStopHook(silentLogger);
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

describe("buildStopHook", () => {
	let workdir: string;

	beforeEach(() => {
		workdir = mkdtempSync(join(tmpdir(), "cyrus-stop-hook-build-"));
	});

	afterEach(() => {
		rmSync(workdir, { recursive: true, force: true });
	});

	it("returns the Stop hook with a single `.*` matcher", () => {
		const hooks = buildStopHook(silentLogger);
		expect(Object.keys(hooks)).toEqual(["Stop"]);
		expect(hooks.Stop).toHaveLength(1);
		expect(hooks.Stop?.[0].matcher).toBe(".*");
		expect(hooks.Stop?.[0].hooks).toHaveLength(1);
	});

	it("allows the stop through when the working tree is clean", async () => {
		// Set up a clean repo synced with its upstream.
		const remote = mkdtempSync(join(tmpdir(), "cyrus-stop-hook-remote-"));
		try {
			execSync(`git init --bare`, { cwd: remote, stdio: "ignore" });
			git(workdir, "init -b main");
			git(workdir, `remote add origin ${remote}`);
			writeFileSync(join(workdir, "README.md"), "hello\n");
			git(workdir, "add README.md");
			git(workdir, 'commit -m "init"');
			git(workdir, "push -u origin main");

			const callback = getStopHookCallback();
			const result = await callback(
				makeStopInput({ cwd: workdir, stop_hook_active: false }),
				"tool-use-id",
				{ signal: new AbortController().signal },
			);
			expect(result).toEqual({});
		} finally {
			rmSync(remote, { recursive: true, force: true });
		}
	});

	it("blocks the first stop attempt when there are uncommitted tracked changes", async () => {
		git(workdir, "init -b main");
		writeFileSync(join(workdir, "a.txt"), "stuff\n");
		git(workdir, "add a.txt");
		git(workdir, 'commit -m "init"');
		writeFileSync(join(workdir, "a.txt"), "modified\n");

		const callback = getStopHookCallback();
		const result = (await callback(
			makeStopInput({ cwd: workdir, stop_hook_active: false }),
			"tool-use-id",
			{ signal: new AbortController().signal },
		)) as { decision?: string; reason?: string };

		expect(result.decision).toBe("block");
		expect(result.reason).toContain("1 uncommitted file change");
		expect(result.reason).toContain("Create or update a pull request");
	});

	it("does not use the invalid `additionalContext` or `continue` fields when blocking", async () => {
		git(workdir, "init -b main");
		writeFileSync(join(workdir, "a.txt"), "stuff\n");
		git(workdir, "add a.txt");
		git(workdir, 'commit -m "init"');
		writeFileSync(join(workdir, "a.txt"), "modified\n");

		const callback = getStopHookCallback();
		const result = (await callback(
			makeStopInput({ cwd: workdir, stop_hook_active: false }),
			"tool-use-id",
			{ signal: new AbortController().signal },
		)) as Record<string, unknown>;

		expect(result).not.toHaveProperty("additionalContext");
		expect(result).not.toHaveProperty("continue");
	});

	it("allows the stop through when `stop_hook_active` is true even with dirty tree", async () => {
		git(workdir, "init -b main");
		writeFileSync(join(workdir, "a.txt"), "stuff\n");
		git(workdir, "add a.txt");
		git(workdir, 'commit -m "init"');
		writeFileSync(join(workdir, "a.txt"), "modified\n");

		const callback = getStopHookCallback();
		const result = await callback(
			makeStopInput({ cwd: workdir, stop_hook_active: true }),
			"tool-use-id",
			{ signal: new AbortController().signal },
		);

		expect(result).toEqual({});
	});
});

describe("inspectGitGuardrail", () => {
	let workdir: string;

	beforeEach(() => {
		workdir = mkdtempSync(join(tmpdir(), "cyrus-stop-hook-"));
	});

	afterEach(() => {
		rmSync(workdir, { recursive: true, force: true });
	});

	it.each([
		"cached",
		"uncached",
		"diverged",
	])("checks whether a newer published PR head contains the local work (%s)", (relationship) => {
		const remote = mkdtempSync(join(tmpdir(), "cyrus-published-remote-"));
		const publisher = mkdtempSync(join(tmpdir(), "cyrus-published-writer-"));
		const readGit = (args: string[]) =>
			execFileSync("git", args, { cwd: workdir, encoding: "utf8" }).trim();
		const fetchHead = () => {
			const path = join(workdir, ".git", "FETCH_HEAD");
			return existsSync(path) ? readFileSync(path, "utf8") : undefined;
		};
		try {
			git(remote, "init --bare");
			git(workdir, "init -b main");
			git(workdir, `remote add origin ${remote}`);
			writeFileSync(join(workdir, "README.md"), "base\n");
			git(workdir, "add README.md");
			git(workdir, 'commit -m "base"');
			git(workdir, "push -u origin main");
			git(workdir, "switch -c reviewed");
			git(workdir, "branch --set-upstream-to=origin/main");
			writeFileSync(join(workdir, "README.md"), "reviewed commit\n");
			git(workdir, "commit -am reviewed");
			git(workdir, `push ${remote} HEAD:refs/heads/reviewed`);

			// The PR author pushes while the agent is reviewing an older checkout.
			git(publisher, `clone --branch reviewed ${remote} .`);
			writeFileSync(join(publisher, "README.md"), "newer published commit\n");
			git(publisher, "commit -am advance");
			git(publisher, "push origin reviewed");
			if (relationship === "cached") git(workdir, "fetch origin");
			if (relationship === "diverged") {
				writeFileSync(join(workdir, "local.txt"), "unpublished work\n");
				git(workdir, "add local.txt");
				git(workdir, "commit -m unpublished");
			}
			const refs = readGit(["show-ref"]);
			const oldFetchHead = fetchHead();
			const result = inspectGitGuardrail(workdir, silentLogger);
			if (relationship === "diverged") {
				expect(result).toContain("not yet on the remote");
			} else {
				expect(result).toBeNull();
			}
			expect(readGit(["show-ref"])).toBe(refs);
			expect(fetchHead()).toBe(oldFetchHead);
			expect(readGit(["status", "--porcelain"])).toBe("");
		} finally {
			rmSync(publisher, { recursive: true, force: true });
			rmSync(remote, { recursive: true, force: true });
		}
	});

	it.each([
		"missing",
		"stale",
		"base",
	])("does not request another shipping turn for a published PR branch with %s tracking", (tracking) => {
		const remote = mkdtempSync(join(tmpdir(), "cyrus-stop-hook-remote-"));
		try {
			git(remote, "init --bare");
			git(workdir, "init -b main");
			git(workdir, `remote add origin ${remote}`);
			writeFileSync(join(workdir, "README.md"), "hello\n");
			git(workdir, "add README.md");
			git(workdir, 'commit -m "init"');
			git(workdir, "push -u origin main");
			git(workdir, "remote set-head origin main");
			git(workdir, "switch -c fix-review");
			if (tracking === "stale") git(workdir, "push -u origin fix-review");
			if (tracking === "base")
				git(workdir, "branch --set-upstream-to=origin/main");
			writeFileSync(join(workdir, "README.md"), "fixed review\n");
			git(workdir, "commit -am fix");
			// Push by URL, as an agent can do with an installation token; local tracking stays stale.
			git(workdir, `push ${remote} HEAD:refs/heads/fix-review`);
			expect(inspectGitGuardrail(workdir, silentLogger)).toBeNull();
		} finally {
			rmSync(remote, { recursive: true, force: true });
		}
	});

	it("returns null when cwd is not a git repository", () => {
		expect(inspectGitGuardrail(workdir, silentLogger)).toBeNull();
	});

	it("returns null on a clean repo with no commits ahead of upstream", () => {
		const remote = mkdtempSync(join(tmpdir(), "cyrus-stop-hook-remote-"));
		try {
			execSync(`git init --bare`, { cwd: remote, stdio: "ignore" });
			git(workdir, "init -b main");
			git(workdir, `remote add origin ${remote}`);
			writeFileSync(join(workdir, "README.md"), "hello\n");
			git(workdir, "add README.md");
			git(workdir, 'commit -m "init"');
			git(workdir, "push -u origin main");

			expect(inspectGitGuardrail(workdir, silentLogger)).toBeNull();
		} finally {
			rmSync(remote, { recursive: true, force: true });
		}
	});

	it("returns null when the only working-tree change is a pre-existing untracked file", () => {
		// Cooper @ QuitCarbon's case: a stray untracked file outside .gitignore
		// must not block the agent from stopping.
		git(workdir, "init -b main");
		writeFileSync(join(workdir, "README.md"), "hello\n");
		git(workdir, "add README.md");
		git(workdir, 'commit -m "init"');

		writeFileSync(join(workdir, "scratch.txt"), "stray\n");

		expect(inspectGitGuardrail(workdir, silentLogger)).toBeNull();
	});

	it("returns a guardrail message for uncommitted changes to tracked files", () => {
		git(workdir, "init -b main");
		writeFileSync(join(workdir, "a.txt"), "stuff\n");
		git(workdir, "add a.txt");
		git(workdir, 'commit -m "init"');
		writeFileSync(join(workdir, "a.txt"), "modified\n");

		const message = inspectGitGuardrail(workdir, silentLogger);
		expect(message).toContain("1 uncommitted file change");
		expect(message).toContain("Create or update a pull request");
	});

	it("flags intent-to-add files so forgotten new files still block", () => {
		// IntentToAddHook marks newly-Written files with `git add -N`. The
		// guardrail must continue to see those as uncommitted work even
		// though `--untracked-files=no` is set.
		git(workdir, "init -b main");
		writeFileSync(join(workdir, "README.md"), "hello\n");
		git(workdir, "add README.md");
		git(workdir, 'commit -m "init"');

		writeFileSync(join(workdir, "new-feature.ts"), "export const x = 1;\n");
		git(workdir, "add --intent-to-add new-feature.ts");

		const message = inspectGitGuardrail(workdir, silentLogger);
		expect(message).toContain("1 uncommitted file change");
	});

	it("counts commits ahead of upstream as unshipped work", () => {
		const remote = mkdtempSync(join(tmpdir(), "cyrus-stop-hook-remote-"));
		try {
			execSync(`git init --bare`, { cwd: remote, stdio: "ignore" });
			git(workdir, "init -b main");
			git(workdir, `remote add origin ${remote}`);
			writeFileSync(join(workdir, "README.md"), "hello\n");
			git(workdir, "add README.md");
			git(workdir, 'commit -m "init"');
			git(workdir, "push -u origin main");

			writeFileSync(join(workdir, "feature.txt"), "feature\n");
			git(workdir, "add feature.txt");
			git(workdir, 'commit -m "feature"');

			const message = inspectGitGuardrail(workdir, silentLogger);
			expect(message).toContain("1 commit");
			expect(message).toContain("not yet on the remote");
		} finally {
			rmSync(remote, { recursive: true, force: true });
		}
	});
});
