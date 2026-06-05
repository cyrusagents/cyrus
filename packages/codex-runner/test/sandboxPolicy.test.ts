import { describe, expect, it } from "vitest";
import { resolveCodexSandbox } from "../src/config/sandboxPolicy.js";

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

	it("builds a granular workspaceWrite policy from sandbox settings", () => {
		expect(
			resolveCodexSandbox({
				mode: "workspace-write",
				workingDirectory: "/repo/a",
				writableRoots: ["/repo/b"],
				networkAccess: false,
				sandboxSettings: {
					allowWrite: ["/repo/out"],
					allowRead: ["/usr/lib"],
					denyRead: ["/home/secrets"], // honored by omission
				},
			}),
		).toEqual({
			kind: "policy",
			policy: {
				type: "workspaceWrite",
				writableRoots: ["/repo/a", "/repo/b", "/repo/out"],
				// readable = writable ∪ allowRead; denyRead is simply absent
				readableRoots: ["/repo/a", "/repo/b", "/repo/out", "/usr/lib"],
				networkAccess: false,
			},
		});
	});

	it("maps read-only mode to a readOnly policy when settings are present", () => {
		const r = resolveCodexSandbox({
			mode: "read-only",
			workingDirectory: "/repo/a",
			writableRoots: [],
			networkAccess: true,
			sandboxSettings: { allowRead: ["/repo/a"] },
		});
		expect(r).toEqual({
			kind: "policy",
			policy: {
				type: "readOnly",
				readableRoots: ["/repo/a"],
				networkAccess: true,
			},
		});
	});

	it("maps danger-full-access to a dangerFullAccess policy", () => {
		expect(
			resolveCodexSandbox({
				mode: "danger-full-access",
				writableRoots: [],
				networkAccess: true,
				sandboxSettings: {},
			}),
		).toEqual({ kind: "policy", policy: { type: "dangerFullAccess" } });
	});

	it("drops non-absolute and empty paths", () => {
		const r = resolveCodexSandbox({
			mode: "workspace-write",
			workingDirectory: "/repo/a",
			writableRoots: ["relative/path", ""],
			networkAccess: true,
			sandboxSettings: { allowRead: ["also/relative", "/ok/read"] },
		});
		expect(r).toEqual({
			kind: "policy",
			policy: {
				type: "workspaceWrite",
				writableRoots: ["/repo/a"],
				readableRoots: ["/repo/a", "/ok/read"],
				networkAccess: true,
			},
		});
	});
});
