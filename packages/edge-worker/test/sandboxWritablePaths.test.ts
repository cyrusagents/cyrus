import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSandboxWritablePaths } from "../src/sandboxWritablePaths.js";

describe("resolveSandboxWritablePaths", () => {
	it("merges config and env entries, expands ~/, dedupes, drops relative paths", () => {
		expect(
			resolveSandboxWritablePaths(
				["~/.supabase", "/opt/cache", "relative/dir"],
				" /opt/cache, /var/data:~/.supabase ,",
			),
		).toEqual([join(homedir(), ".supabase"), "/opt/cache", "/var/data"]);
	});

	it("returns an empty list when nothing is configured", () => {
		expect(resolveSandboxWritablePaths(undefined, "")).toEqual([]);
	});
});
