import type { UserAccessControlConfig } from "atmiko-core";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_BLOCK_MESSAGE,
	UserAccessControl,
} from "../src/UserAccessControl.js";

/**
 * Test Suite for UserAccessControl
 *
 * Tests the user whitelisting/blacklisting functionality for Linear users.
 */

// ============================================================================
// TEST HELPERS
// ============================================================================

/**
 * Creates a UserAccessControl instance with the given configs
 */
function createAccessControl(
	globalConfig?: UserAccessControlConfig,
	repoConfigs?: Map<string, UserAccessControlConfig | undefined>,
): UserAccessControl {
	return new UserAccessControl(globalConfig, repoConfigs ?? new Map());
}

// ============================================================================
// TESTS: checkAccess
// ============================================================================

describe("UserAccessControl", () => {
	describe("checkAccess", () => {
		describe("when no access control is configured", () => {
			it("allows all users when no access control configured", () => {
				const accessControl = createAccessControl(undefined, new Map());

				const result = accessControl.checkAccess(
					"user-123",
					"user@example.com",
					"repo-1",
				);

				expect(result.allowed).toBe(true);
			});

			it("allows users with undefined id and email when no config", () => {
				const accessControl = createAccessControl(undefined, new Map());

				const result = accessControl.checkAccess(
					undefined,
					undefined,
					"repo-1",
				);

				expect(result.allowed).toBe(true);
			});
		});

		describe("blocklist behavior", () => {
			it("blocks user in global blocklist by ID", () => {
				const accessControl = createAccessControl(
					{ blockedUsers: ["blocked-user-id"] },
					new Map(),
				);

				const result = accessControl.checkAccess(
					"blocked-user-id",
					"user@example.com",
					"repo-1",
				);

				expect(result.allowed).toBe(false);
				if (!result.allowed) {
					expect(result.reason).toBe("User is in blocklist");
				}
			});

			it("blocks user in global blocklist by explicit ID object", () => {
				const accessControl = createAccessControl(
					{ blockedUsers: [{ id: "blocked-user-id" }] },
					new Map(),
				);

				const result = accessControl.checkAccess(
					"blocked-user-id",
					"user@example.com",
					"repo-1",
				);

				expect(result.allowed).toBe(false);
			});

			it("blocks user in global blocklist by email", () => {
				const accessControl = createAccessControl(
					{ blockedUsers: [{ email: "blocked@example.com" }] },
					new Map(),
				);

				const result = accessControl.checkAccess(
					"user-123",
					"blocked@example.com",
					"repo-1",
				);

				expect(result.allowed).toBe(false);
			});

			it("blocks user in global blocklist by email (case-insensitive)", () => {
				const accessControl = createAccessControl(
					{ blockedUsers: [{ email: "BLOCKED@EXAMPLE.COM" }] },
					new Map(),
				);

				const result = accessControl.checkAccess(
					"user-123",
					"blocked@example.com",
					"repo-1",
				);

				expect(result.allowed).toBe(false);
			});

			it("blocks user in repo-specific blocklist", () => {
				const repoConfigs = new Map<string, UserAccessControlConfig>([
					["repo-1", { blockedUsers: ["blocked-user-id"] }],
				]);
				const accessControl = createAccessControl(undefined, repoConfigs);

				const result = accessControl.checkAccess(
					"blocked-user-id",
					"user@example.com",
					"repo-1",
				);

				expect(result.allowed).toBe(false);
			});

			it("blocks user in combined global + repo blocklist", () => {
				const globalConfig = { blockedUsers: ["global-blocked"] };
				const repoConfigs = new Map<string, UserAccessControlConfig>([
					["repo-1", { blockedUsers: ["repo-blocked"] }],
				]);
				const accessControl = createAccessControl(globalConfig, repoConfigs);

				// Test global blocklist applies
				const result1 = accessControl.checkAccess(
					"global-blocked",
					"user@example.com",
					"repo-1",
				);
				expect(result1.allowed).toBe(false);

				// Test repo blocklist applies
				const result2 = accessControl.checkAccess(
					"repo-blocked",
					"user@example.com",
					"repo-1",
				);
				expect(result2.allowed).toBe(false);
			});

			it("allows user not in any blocklist", () => {
				const accessControl = createAccessControl(
					{ blockedUsers: ["blocked-user-id"] },
					new Map(),
				);

				const result = accessControl.checkAccess(
					"allowed-user-id",
					"user@example.com",
					"repo-1",
				);

				expect(result.allowed).toBe(true);
			});
		});

		describe("allowlist behavior", () => {
			it("allows user in global allowlist by ID", () => {
				const accessControl = createAccessControl(
					{ allowedUsers: ["allowed-user-id"] },
					new Map(),
				);

				const result = accessControl.checkAccess(
					"allowed-user-id",
					"user@example.com",
					"repo-1",
				);

				expect(result.allowed).toBe(true);
			});

			it("allows user in global allowlist by explicit ID object", () => {
				const accessControl = createAccessControl(
					{ allowedUsers: [{ id: "allowed-user-id" }] },
					new Map(),
				);

				const result = accessControl.checkAccess(
					"allowed-user-id",
					"user@example.com",
					"repo-1",
				);

				expect(result.allowed).toBe(true);
			});

			it("allows user in global allowlist by email", () => {
				const accessControl = createAccessControl(
					{ allowedUsers: [{ email: "allowed@example.com" }] },
					new Map(),
				);

				const result = accessControl.checkAccess(
					"user-123",
					"allowed@example.com",
					"repo-1",
				);

				expect(result.allowed).toBe(true);
			});

			it("allows user in global allowlist by email (case-insensitive)", () => {
				const accessControl = createAccessControl(
					{ allowedUsers: [{ email: "ALLOWED@EXAMPLE.COM" }] },
					new Map(),
				);

				const result = accessControl.checkAccess(
					"user-123",
					"allowed@example.com",
					"repo-1",
				);

				expect(result.allowed).toBe(true);
			});

			it("blocks user not in allowlist when allowlist exists", () => {
				const accessControl = createAccessControl(
					{ allowedUsers: ["allowed-user-id"] },
					new Map(),
				);

				const result = accessControl.checkAccess(
					"other-user-id",
					"other@example.com",
					"repo-1",
				);

				expect(result.allowed).toBe(false);
				if (!result.allowed) {
					expect(result.reason).toBe("User is not in allowlist");
				}
			});

			it("blocks all users when allowlist is empty", () => {
				const accessControl = createAccessControl(
					{ allowedUsers: [] },
					new Map(),
				);

				const result = accessControl.checkAccess(
					"any-user-id",
					"any@example.com",
					"repo-1",
				);

				expect(result.allowed).toBe(false);
				if (!result.allowed) {
					expect(result.reason).toBe("No users are allowed (empty allowlist)");
				}
			});

			it("repo allowlist overrides global allowlist (not merged)", () => {
				const globalConfig = { allowedUsers: ["global-allowed"] };
				const repoConfigs = new Map<string, UserAccessControlConfig>([
					["repo-1", { allowedUsers: ["repo-allowed"] }],
				]);
				const accessControl = createAccessControl(globalConfig, repoConfigs);

				// Global allowed user should be BLOCKED because repo has its own allowlist
				const result1 = accessControl.checkAccess(
					"global-allowed",
					"user@example.com",
					"repo-1",
				);
				expect(result1.allowed).toBe(false);

				// Repo allowed user should be allowed
				const result2 = accessControl.checkAccess(
					"repo-allowed",
					"user@example.com",
					"repo-1",
				);
				expect(result2.allowed).toBe(true);
			});

			it("uses global allowlist for repos without their own allowlist", () => {
				const globalConfig = { allowedUsers: ["global-allowed"] };
				const repoConfigs = new Map<string, UserAccessControlConfig>([
					["repo-1", { allowedUsers: ["repo-allowed"] }],
					["repo-2", {}], // No allowlist, should use global
				]);
				const accessControl = createAccessControl(globalConfig, repoConfigs);

				// For repo-2, global allowlist should apply
				const result = accessControl.checkAccess(
					"global-allowed",
					"user@example.com",
					"repo-2",
				);
				expect(result.allowed).toBe(true);
			});
		});

		describe("blocklist takes precedence over allowlist", () => {
			it("blocks user even if in allowlist when also in blocklist", () => {
				const accessControl = createAccessControl(
					{
						allowedUsers: ["user-123"],
						blockedUsers: ["user-123"],
					},
					new Map(),
				);

				const result = accessControl.checkAccess(
					"user-123",
					"user@example.com",
					"repo-1",
				);

				expect(result.allowed).toBe(false);
				if (!result.allowed) {
					expect(result.reason).toBe("User is in blocklist");
				}
			});

			it("blocks user in global allowlist if in repo blocklist", () => {
				const globalConfig = { allowedUsers: ["user-123"] };
				const repoConfigs = new Map<string, UserAccessControlConfig>([
					["repo-1", { blockedUsers: ["user-123"] }],
				]);
				const accessControl = createAccessControl(globalConfig, repoConfigs);

				const result = accessControl.checkAccess(
					"user-123",
					"user@example.com",
					"repo-1",
				);

				expect(result.allowed).toBe(false);
			});
		});

		describe("mixed identifier formats", () => {
			it("handles mix of string and object identifiers", () => {
				const accessControl = createAccessControl(
					{
						allowedUsers: [
							"user-by-string",
							{ id: "user-by-id-object" },
							{ email: "user@by-email.com" },
						],
					},
					new Map(),
				);

				// String ID match
				const result1 = accessControl.checkAccess(
					"user-by-string",
					"any@example.com",
					"repo-1",
				);
				expect(result1.allowed).toBe(true);

				// Object ID match
				const result2 = accessControl.checkAccess(
					"user-by-id-object",
					"any@example.com",
					"repo-1",
				);
				expect(result2.allowed).toBe(true);

				// Email match
				const result3 = accessControl.checkAccess(
					"any-id",
					"user@by-email.com",
					"repo-1",
				);
				expect(result3.allowed).toBe(true);

				// No match
				const result4 = accessControl.checkAccess(
					"no-match",
					"no-match@example.com",
					"repo-1",
				);
				expect(result4.allowed).toBe(false);
			});
		});
	});

	// ============================================================================
	// TESTS: getBlockBehavior
	// ============================================================================

	describe("getBlockBehavior", () => {
		it("returns silent by default when not configured", () => {
			const accessControl = createAccessControl(undefined, new Map());

			const behavior = accessControl.getBlockBehavior("repo-1");

			expect(behavior).toBe("silent");
		});

		it("returns global config when repo has no override", () => {
			const accessControl = createAccessControl(
				{ blockBehavior: "comment" },
				new Map(),
			);

			const behavior = accessControl.getBlockBehavior("repo-1");

			expect(behavior).toBe("comment");
		});

		it("returns repo config when specified (overrides global)", () => {
			const globalConfig = { blockBehavior: "comment" as const };
			const repoConfigs = new Map<string, UserAccessControlConfig>([
				["repo-1", { blockBehavior: "silent" }],
			]);
			const accessControl = createAccessControl(globalConfig, repoConfigs);

			const behavior = accessControl.getBlockBehavior("repo-1");

			expect(behavior).toBe("silent");
		});

		it("returns global config for repos without override", () => {
			const globalConfig = { blockBehavior: "comment" as const };
			const repoConfigs = new Map<string, UserAccessControlConfig>([
				["repo-1", { blockBehavior: "silent" }],
				["repo-2", {}], // No blockBehavior
			]);
			const accessControl = createAccessControl(globalConfig, repoConfigs);

			const behavior = accessControl.getBlockBehavior("repo-2");

			expect(behavior).toBe("comment");
		});
	});

	// ============================================================================
	// TESTS: getBlockMessage
	// ============================================================================

	describe("getBlockMessage", () => {
		it("returns default message when not configured", () => {
			const accessControl = createAccessControl(undefined, new Map());

			const message = accessControl.getBlockMessage("repo-1");

			expect(message).toBe(DEFAULT_BLOCK_MESSAGE);
		});

		it("returns global message when repo has no override", () => {
			const accessControl = createAccessControl(
				{ blockMessage: "Global custom message" },
				new Map(),
			);

			const message = accessControl.getBlockMessage("repo-1");

			expect(message).toBe("Global custom message");
		});

		it("returns repo message when specified (overrides global)", () => {
			const globalConfig = { blockMessage: "Global message" };
			const repoConfigs = new Map<string, UserAccessControlConfig>([
				["repo-1", { blockMessage: "Repo specific message" }],
			]);
			const accessControl = createAccessControl(globalConfig, repoConfigs);

			const message = accessControl.getBlockMessage("repo-1");

			expect(message).toBe("Repo specific message");
		});

		it("returns global message for repos without override", () => {
			const globalConfig = { blockMessage: "Global message" };
			const repoConfigs = new Map<string, UserAccessControlConfig>([
				["repo-1", { blockMessage: "Repo 1 message" }],
				["repo-2", {}], // No blockMessage
			]);
			const accessControl = createAccessControl(globalConfig, repoConfigs);

			const message = accessControl.getBlockMessage("repo-2");

			expect(message).toBe("Global message");
		});
	});

	// ============================================================================
	// TESTS: hasAnyConfiguration
	// ============================================================================

	describe("hasAnyConfiguration", () => {
		it("returns false when no config is set", () => {
			const accessControl = createAccessControl(undefined, new Map());

			expect(accessControl.hasAnyConfiguration()).toBe(false);
		});

		it("returns false when only blockBehavior is set (no actual lists)", () => {
			const accessControl = createAccessControl(
				{ blockBehavior: "comment" },
				new Map(),
			);

			expect(accessControl.hasAnyConfiguration()).toBe(false);
		});

		it("returns true when global allowedUsers is set", () => {
			const accessControl = createAccessControl(
				{ allowedUsers: ["user-1"] },
				new Map(),
			);

			expect(accessControl.hasAnyConfiguration()).toBe(true);
		});

		it("returns true when global blockedUsers is set", () => {
			const accessControl = createAccessControl(
				{ blockedUsers: ["user-1"] },
				new Map(),
			);

			expect(accessControl.hasAnyConfiguration()).toBe(true);
		});

		it("returns true when repo allowedUsers is set", () => {
			const repoConfigs = new Map<string, UserAccessControlConfig>([
				["repo-1", { allowedUsers: ["user-1"] }],
			]);
			const accessControl = createAccessControl(undefined, repoConfigs);

			expect(accessControl.hasAnyConfiguration()).toBe(true);
		});

		it("returns true when repo blockedUsers is set", () => {
			const repoConfigs = new Map<string, UserAccessControlConfig>([
				["repo-1", { blockedUsers: ["user-1"] }],
			]);
			const accessControl = createAccessControl(undefined, repoConfigs);

			expect(accessControl.hasAnyConfiguration()).toBe(true);
		});
	});
});
