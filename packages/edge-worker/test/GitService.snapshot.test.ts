import { execSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { GitService } from "../src/GitService.js";

vi.mock("node:child_process", () => ({ execSync: vi.fn() }));

describe("GitService snapshot reads", () => {
	it("returns trimmed porcelain status", () => {
		(execSync as any).mockReturnValue(" M file.ts\n");
		const git = new GitService();
		expect(git.getStatus("/wt")).toBe("M file.ts");
	});

	it("returns recent commits with the requested limit", () => {
		(execSync as any).mockReturnValue("abc one\ndef two\n");
		const git = new GitService();
		expect(git.getRecentCommits("/wt", 5)).toBe("abc one\ndef two");
		expect(execSync as any).toHaveBeenCalledWith(
			"git log --oneline -n 5",
			expect.objectContaining({ cwd: "/wt" }),
		);
	});

	it("returns empty string when a git read throws", () => {
		(execSync as any).mockImplementation(() => {
			throw new Error("not a git repo");
		});
		const git = new GitService();
		expect(git.getDiffSummary("/wt")).toBe("");
		expect(git.getCurrentBranch("/wt")).toBe("");
	});

	it("returns undefined for the PR url when gh fails", () => {
		(execSync as any).mockImplementation(() => {
			throw new Error("gh: no pr");
		});
		const git = new GitService();
		expect(git.getOpenPrUrl("/wt")).toBeUndefined();
	});
});
