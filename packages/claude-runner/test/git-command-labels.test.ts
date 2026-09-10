import { describe, expect, it } from "vitest";
import {
	extractPushBranch,
	extractTitleFlag,
	labelGitCommand,
} from "../src/git-command-labels.js";

describe("extractTitleFlag", () => {
	it("extracts double-quoted titles", () => {
		expect(
			extractTitleFlag('gh pr create --title "Add CONTRIBUTING.md" --draft'),
		).toBe("Add CONTRIBUTING.md");
	});

	it("extracts single-quoted titles", () => {
		expect(extractTitleFlag("gh pr create --title 'Fix the lamp'")).toBe(
			"Fix the lamp",
		);
	});

	it("extracts --title=value and -t forms", () => {
		expect(extractTitleFlag('gh pr create --title="Quick fix"')).toBe(
			"Quick fix",
		);
		expect(extractTitleFlag("gh pr create -t oneword")).toBe("oneword");
	});

	it("returns null when absent", () => {
		expect(extractTitleFlag("gh pr create --fill")).toBeNull();
	});
});

describe("extractPushBranch", () => {
	it("reads the branch from push with remote", () => {
		expect(extractPushBranch("git push origin main")).toBe("main");
		expect(
			extractPushBranch("git push -u origin cylocal/spe-57-a-brief-tour"),
		).toBe("cylocal/spe-57-a-brief-tour");
	});

	it("uses the remote side of a refspec", () => {
		expect(extractPushBranch("git push origin HEAD:feature/x")).toBe(
			"feature/x",
		);
	});

	it("skips value-consuming flags", () => {
		expect(extractPushBranch("git push -o ci.skip origin main")).toBe("main");
	});

	it("returns empty for bare git push", () => {
		expect(extractPushBranch("git push")).toBe("");
		expect(extractPushBranch("git push --force-with-lease")).toBe("");
	});
});

describe("labelGitCommand", () => {
	it("labels gh pr create as Create PR with the title", () => {
		expect(
			labelGitCommand('gh pr create --title "Rooms: Turning House" --draft'),
		).toEqual({ action: "Create PR", parameter: "Rooms: Turning House" });
	});

	it("labels glab mr create as Create MR", () => {
		expect(labelGitCommand('glab mr create --title "MR title"')).toEqual({
			action: "Create MR",
			parameter: "MR title",
		});
	});

	it("labels gt submit as Create PR", () => {
		expect(labelGitCommand("gt submit --stack")).toEqual({
			action: "Create PR",
			parameter: "",
		});
	});

	it("labels a simple git push with the branch", () => {
		expect(labelGitCommand("git push -u origin jake/spe-63-test")).toEqual({
			action: "Git Push",
			parameter: "jake/spe-63-test",
		});
	});

	it("tolerates a leading cd prefix", () => {
		expect(labelGitCommand("cd /work/repo && git push origin main")).toEqual({
			action: "Git Push",
			parameter: "main",
		});
	});

	it("does not relabel compound commands ending in push", () => {
		expect(
			labelGitCommand('git add -A && git commit -m "x" && git push'),
		).toBeNull();
	});

	it("labels gh pr create even in compound commands", () => {
		expect(
			labelGitCommand('git push -u origin b && gh pr create --title "T"'),
		).toEqual({ action: "Create PR", parameter: "T" });
	});

	it("leaves unrelated commands alone", () => {
		expect(labelGitCommand("git status")).toBeNull();
		expect(labelGitCommand("npm run eval:reach")).toBeNull();
		expect(labelGitCommand("git push-to-deploy")).toBeNull();
		expect(labelGitCommand(undefined)).toBeNull();
	});
});
