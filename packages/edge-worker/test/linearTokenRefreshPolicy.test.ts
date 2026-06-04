import { describe, expect, it } from "vitest";
import {
	LINEAR_TOKEN_FORCED_REFRESH_TTL_MS,
	LINEAR_TOKEN_SOFT_REFRESH_TTL_MS,
	shouldRefreshLinearToken,
} from "../src/linearTokenRefreshPolicy.js";

/**
 * Policy for proactive Linear OAuth token refresh (CRATE-153).
 *
 * Constraint discovered during investigation: Linear REVOKES the previous
 * access token the moment a refresh succeeds. In-flight agent sessions hold
 * static Authorization-header snapshots, so refreshing while turns are
 * running kills their hosted Linear MCP access. The policy therefore:
 *   - refreshes early (hours before expiry) while the worker is idle
 *   - only forces a refresh under active turns when the token is about to
 *     die anyway (the snapshots are about to die naturally regardless)
 */

import { containsLinearReauthorizationError } from "../src/linearTokenRefreshPolicy.js";

const NOW = 1_780_000_000_000;
const hours = (n: number) => n * 60 * 60 * 1000;

describe("containsLinearReauthorizationError", () => {
	it("detects the real-world stale-token tool_result from the CRATE-80 session", () => {
		// Verbatim shape from logs/CRATE-80/session-cfc5acfe...jsonl
		const message = {
			type: "user",
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						content:
							'MCP server "linear" requires re-authorization (token expired)',
						is_error: true,
						tool_use_id: "toolu_01DQUg1poCadpYMmmCHyveqk",
					},
				],
			},
		};
		expect(containsLinearReauthorizationError(message)).toBe(true);
	});

	it("detects the error when tool_result content is a block array", () => {
		const message = {
			type: "user",
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						content: [
							{
								type: "text",
								text: 'Error: MCP server "linear" requires re-authorization',
							},
						],
						is_error: true,
					},
				],
			},
		};
		expect(containsLinearReauthorizationError(message)).toBe(true);
	});

	it("ignores successful tool results and unrelated errors", () => {
		expect(
			containsLinearReauthorizationError({
				type: "user",
				message: {
					role: "user",
					content: [
						{
							type: "tool_result",
							content: "ok",
							is_error: false,
						},
						{
							type: "tool_result",
							content: "Error: file not found",
							is_error: true,
						},
					],
				},
			}),
		).toBe(false);
	});

	it("ignores assistant and malformed messages", () => {
		expect(
			containsLinearReauthorizationError({ type: "assistant", message: {} }),
		).toBe(false);
		expect(containsLinearReauthorizationError(null)).toBe(false);
		expect(containsLinearReauthorizationError("nope")).toBe(false);
	});
});

describe("shouldRefreshLinearToken", () => {
	it("refreshes when expiry is unknown (token of unknown age)", () => {
		expect(
			shouldRefreshLinearToken({ expiresAt: null, now: NOW, busy: false }),
		).toBe(true);
		expect(
			shouldRefreshLinearToken({ expiresAt: null, now: NOW, busy: true }),
		).toBe(true);
	});

	it("does not refresh a token with plenty of runway", () => {
		expect(
			shouldRefreshLinearToken({
				expiresAt: NOW + hours(20),
				now: NOW,
				busy: false,
			}),
		).toBe(false);
	});

	it("refreshes an aging token while idle (soft threshold)", () => {
		expect(
			shouldRefreshLinearToken({
				expiresAt: NOW + LINEAR_TOKEN_SOFT_REFRESH_TTL_MS - 1,
				now: NOW,
				busy: false,
			}),
		).toBe(true);
	});

	it("does NOT refresh an aging token while busy — refresh would revoke snapshots held by running turns", () => {
		expect(
			shouldRefreshLinearToken({
				expiresAt: NOW + LINEAR_TOKEN_SOFT_REFRESH_TTL_MS - 1,
				now: NOW,
				busy: true,
			}),
		).toBe(false);
	});

	it("refreshes a nearly-dead token even while busy — the snapshots die naturally in moments anyway", () => {
		expect(
			shouldRefreshLinearToken({
				expiresAt: NOW + LINEAR_TOKEN_FORCED_REFRESH_TTL_MS - 1,
				now: NOW,
				busy: true,
			}),
		).toBe(true);
	});

	it("refreshes an already-expired token regardless of activity", () => {
		expect(
			shouldRefreshLinearToken({
				expiresAt: NOW - 1000,
				now: NOW,
				busy: true,
			}),
		).toBe(true);
	});
});
