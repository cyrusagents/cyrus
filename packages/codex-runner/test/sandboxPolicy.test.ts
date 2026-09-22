import { describe, expect, it } from "vitest";
import {
	ATMIKO_SANDBOX_PROFILE_ID,
	resolveCodexSandbox,
} from "../src/config/sandboxPolicy.js";

describe("resolveCodexSandbox", () => {
	it("returns a workspace-mode (broad reads) when no sandbox settings are given", () => {
		expect(
			resolveCodexSandbox({
				mode: "workspace-write",
				workingDirectory: "/repo/a",
				writableRoots: ["/repo/b"],
				networkAccess: true,
			}),
		).toEqual({
			kind: "workspace-mode",
			mode: "workspace-write",
			writableRoots: ["/repo/a", "/repo/b"],
			networkAccess: true,
		});
	});

	it("builds a read-restricted permission profile from sandbox settings", () => {
		expect(
			resolveCodexSandbox({
				mode: "workspace-write",
				workingDirectory: "/repo/a",
				writableRoots: ["/repo/b"],
				networkAccess: false,
				sandboxSettings: {
					allowWrite: ["/repo/a", "/repo/out"],
					allowRead: ["/repo/a", "/usr/lib"],
					denyRead: ["/home/secrets"], // honored by omission
				},
			}),
		).toEqual({
			kind: "profile",
			profileId: ATMIKO_SANDBOX_PROFILE_ID,
			networkAccess: false,
			filesystem: {
				":minimal": "read",
				":workspace_roots": "write", // the worktree (cwd)
				":tmpdir": "write",
				":slash_tmp": "write",
				"/repo/b": "write", // extra writable root
				"/repo/out": "write", // allowWrite (beyond cwd)
				"/usr/lib": "read", // allowRead (not already writable)
			},
		});
	});

	it("maps read-only mode to a read-only worktree in the profile", () => {
		expect(
			resolveCodexSandbox({
				mode: "read-only",
				workingDirectory: "/repo/a",
				writableRoots: [],
				networkAccess: true,
				sandboxSettings: { allowRead: ["/repo/a"] },
			}),
		).toEqual({
			kind: "profile",
			profileId: ATMIKO_SANDBOX_PROFILE_ID,
			networkAccess: true,
			filesystem: {
				":minimal": "read",
				":workspace_roots": "read",
				":tmpdir": "write",
				":slash_tmp": "write",
			},
		});
	});

	it("maps danger-full-access to an unrestricted profile", () => {
		expect(
			resolveCodexSandbox({
				mode: "danger-full-access",
				writableRoots: [],
				networkAccess: true,
				sandboxSettings: {},
			}),
		).toEqual({
			kind: "profile",
			profileId: ATMIKO_SANDBOX_PROFILE_ID,
			networkAccess: true,
			filesystem: { ":root": "write" },
		});
	});

	it("drops non-absolute and empty paths", () => {
		expect(
			resolveCodexSandbox({
				mode: "workspace-write",
				workingDirectory: "/repo/a",
				writableRoots: ["relative/path", ""],
				networkAccess: true,
				sandboxSettings: { allowRead: ["also/relative", "/ok/read"] },
			}),
		).toEqual({
			kind: "profile",
			profileId: ATMIKO_SANDBOX_PROFILE_ID,
			networkAccess: true,
			filesystem: {
				":minimal": "read",
				":workspace_roots": "write",
				":tmpdir": "write",
				":slash_tmp": "write",
				"/ok/read": "read",
			},
		});
	});
});
