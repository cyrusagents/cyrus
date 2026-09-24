import { exec } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCheckGh } from "../../src/handlers/checkGh.js";
import type { CheckGhPayload } from "../../src/types.js";

// Mock node:child_process
vi.mock("node:child_process", () => ({
	exec: vi.fn(),
}));

// Mock node:util (promisify is used in the handler)
vi.mock("node:util", () => ({
	promisify: (fn: any) => fn,
}));

describe("handleCheckGh", () => {
	const mockExec = vi.mocked(exec);
	const mikoHome = "/test/miko/home";
	const payload: CheckGhPayload = {};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.resetAllMocks();
	});

	describe("when gh is installed and authenticated", () => {
		it("should return success with both flags true", async () => {
			// Mock successful gh --version call
			mockExec.mockImplementation((cmd: string, _callback?: any) => {
				if (cmd === "gh --version") {
					return Promise.resolve({ stdout: "gh version 2.0.0", stderr: "" });
				}
				if (cmd === "gh auth status") {
					return Promise.resolve({
						stdout: "Logged in to github.com",
						stderr: "",
					});
				}
				return Promise.reject(new Error("Unknown command"));
			});

			const result = await handleCheckGh(payload, mikoHome);

			expect(result).toEqual({
				success: true,
				message: "GitHub CLI check completed",
				data: {
					isInstalled: true,
					isAuthenticated: true,
				},
			});
		});
	});

	describe("when gh is installed but not authenticated", () => {
		it("should return success with isInstalled true and isAuthenticated false", async () => {
			mockExec.mockImplementation((cmd: string, _callback?: any) => {
				if (cmd === "gh --version") {
					return Promise.resolve({ stdout: "gh version 2.0.0", stderr: "" });
				}
				if (cmd === "gh auth status") {
					return Promise.reject(new Error("Not authenticated"));
				}
				return Promise.reject(new Error("Unknown command"));
			});

			const result = await handleCheckGh(payload, mikoHome);

			expect(result).toEqual({
				success: true,
				message: "GitHub CLI check completed",
				data: {
					isInstalled: true,
					isAuthenticated: false,
				},
			});
		});
	});

	describe("when gh is not installed", () => {
		it("should return success with both flags false", async () => {
			mockExec.mockImplementation((cmd: string, _callback?: any) => {
				if (cmd === "gh --version") {
					return Promise.reject(new Error("command not found: gh"));
				}
				return Promise.reject(new Error("Unknown command"));
			});

			const result = await handleCheckGh(payload, mikoHome);

			expect(result).toEqual({
				success: true,
				message: "GitHub CLI check completed",
				data: {
					isInstalled: false,
					isAuthenticated: false,
				},
			});
		});

		it("should not check authentication when gh is not installed", async () => {
			mockExec.mockImplementation((cmd: string, _callback?: any) => {
				if (cmd === "gh --version") {
					return Promise.reject(new Error("command not found: gh"));
				}
				if (cmd === "gh auth status") {
					throw new Error("Should not be called");
				}
				return Promise.reject(new Error("Unknown command"));
			});

			const result = await handleCheckGh(payload, mikoHome);

			expect(result.success).toBe(true);
			expect(result.data).toEqual({
				isInstalled: false,
				isAuthenticated: false,
			});
		});
	});

	describe("command execution edge cases", () => {
		it("should treat any execAsync rejection as command not found", async () => {
			mockExec.mockImplementation(() => {
				return Promise.reject(new Error("Permission denied"));
			});

			const result = await handleCheckGh(payload, mikoHome);

			// Any error is treated as "not installed"
			expect(result).toEqual({
				success: true,
				message: "GitHub CLI check completed",
				data: {
					isInstalled: false,
					isAuthenticated: false,
				},
			});
		});
	});
});
