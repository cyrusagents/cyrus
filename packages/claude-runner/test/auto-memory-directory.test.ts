import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { getProjectAutoMemoryDirectory } from "../src/auto-memory-directory.js";

describe("getProjectAutoMemoryDirectory", () => {
	const home = homedir();

	it("encodes a plain absolute cwd by replacing / with -", () => {
		expect(
			getProjectAutoMemoryDirectory("/home/cyrus/cyrus-workspaces/cyhost-906"),
		).toBe(
			`${home}/.claude/projects/-home-cyrus-cyrus-workspaces-cyhost-906/memory`,
		);
	});

	it("also encodes . segments as - (so .cyrus becomes --cyrus)", () => {
		expect(
			getProjectAutoMemoryDirectory("/Users/agentops/.cyrus/repos/cyrus"),
		).toBe(
			`${home}/.claude/projects/-Users-agentops--cyrus-repos-cyrus/memory`,
		);
	});

	it("normalizes a trailing slash to the same encoding as without it", () => {
		expect(getProjectAutoMemoryDirectory("/tmp/work/")).toBe(
			getProjectAutoMemoryDirectory("/tmp/work"),
		);
	});

	it("normalizes . path segments via path.resolve before encoding", () => {
		expect(getProjectAutoMemoryDirectory("/tmp/work/./sub")).toBe(
			getProjectAutoMemoryDirectory("/tmp/work/sub"),
		);
	});

	it("normalizes .. path segments via path.resolve before encoding", () => {
		expect(getProjectAutoMemoryDirectory("/tmp/work/sub/..")).toBe(
			getProjectAutoMemoryDirectory("/tmp/work"),
		);
	});

	it("handles paths whose first segment after / is a hidden dotfile dir", () => {
		// /.foo → '-' + '-foo' = '--foo' (leading / encoded as -, then . encoded as -)
		expect(getProjectAutoMemoryDirectory("/.foo")).toBe(
			`${home}/.claude/projects/--foo/memory`,
		);
	});
});
