import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexConfigBuilder } from "../src/config/CodexConfigBuilder.js";

const codexHome = mkdtempSync(join(tmpdir(), "codex-home-"));

describe("CodexConfigBuilder writableRoots (operator path whitelist)", () => {
	it("adds whitelisted paths as writable roots in workspace-write mode", async () => {
		const resolved = await new CodexConfigBuilder({
			workingDirectory: "/ws/repo",
			codexHome,
			writableRoots: ["/Users/me/.supabase"],
		}).build();

		expect(resolved.sandbox).toEqual({
			kind: "workspace-mode",
			mode: "workspace-write",
			writableRoots: ["/ws/repo", "/Users/me/.supabase"],
			networkAccess: true,
		});
	});

	it("grants write on whitelisted paths in the egress-sandbox profile", async () => {
		const resolved = await new CodexConfigBuilder({
			workingDirectory: "/ws/repo",
			codexHome,
			writableRoots: ["/Users/me/.supabase"],
			sandboxSettings: {
				allowWrite: ["/ws/repo"],
				allowRead: ["/ws/repo"],
			},
		}).build();

		expect(resolved.sandbox.kind).toBe("profile");
		if (resolved.sandbox.kind !== "profile") return;
		expect(resolved.sandbox.filesystem).toEqual({
			":minimal": "read",
			":workspace_roots": "write",
			":tmpdir": "write",
			":slash_tmp": "write",
			"/Users/me/.supabase": "write",
		});
	});
});
