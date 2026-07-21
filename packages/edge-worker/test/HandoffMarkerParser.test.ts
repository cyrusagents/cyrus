/**
 * Unit tests for HandoffMarkerParser.
 *
 * Covers the full validation matrix: absent-marker legacy pass,
 * malformed/truncated/duplicate markers, field-level validation,
 * timestamp ordering, canonical-repo normalisation, and the happy path.
 */

import type { Comment } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	normalizeRepoId,
	parseHandoffMarker,
} from "../src/HandoffMarkerParser.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const ISSUE_ID = "BRI-3257";
const GITHUB_URL = "https://github.com/Brilliantio/cyrus-agent";

const FUTURE = new Date(Date.now() + 3_600_000).toISOString(); // 1 hour from now
const NOW_MINUS_10 = new Date(Date.now() - 600_000).toISOString(); // 10 min ago
const NOW_MINUS_5 = new Date(Date.now() - 300_000).toISOString(); // 5 min ago
const PAST = new Date(Date.now() - 1_000).toISOString(); // 1 sec ago (for expiry)

/** Build a minimal valid HandoffMarkerData payload. */
function validPayload(
	overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
	return {
		lease_id: "lease-abc123",
		lease_version: "1",
		issue_id: ISSUE_ID,
		owner: "bridge-agent-principal",
		lane: "bridge",
		canonical_repo: "Brilliantio/cyrus-agent",
		worktree: "/tmp/worktrees/BRI-3257",
		branch: "cyrus2/bri-3257-work",
		starting_sha: "b98afde0792b413d",
		scope: ["read:code", "write:code"],
		policy_hash: "sha256:abc123",
		handoff_target: "cyrus",
		acquired_at: NOW_MINUS_10,
		heartbeat_at: NOW_MINUS_5,
		expires_at: FUTURE,
		ended_at: null,
		...overrides,
	};
}

/**
 * Build a fake Comment containing the handoff marker with the given JSON payload.
 */
function markerComment(
	payload: Record<string, unknown> = validPayload(),
	id = "comment-1",
): Comment {
	const json = JSON.stringify(payload, null, 2);
	return fakeComment(id, `<!-- CYRUS-MACHINE-HANDOFF\n${json}\n-->`);
}

/** Build a plain comment with no marker. */
function fakeComment(id: string, body: string): Comment {
	return {
		id,
		body,
		createdAt: new Date(),
		updatedAt: new Date(),
		user: Promise.resolve(undefined as any),
		parent: Promise.resolve(undefined as any),
		issue: Promise.resolve(undefined as any),
		children: () => Promise.resolve({ nodes: [] }),
	};
}

// ── Absent marker — legacy pass ───────────────────────────────────────────────

describe("parseHandoffMarker — absent marker", () => {
	it("returns none when there are no comments", () => {
		const result = parseHandoffMarker([], ISSUE_ID, GITHUB_URL);
		expect(result.type).toBe("none");
	});

	it("returns none when no comment contains the marker", () => {
		const comments = [
			fakeComment("c1", "This is a normal comment"),
			fakeComment(
				"c2",
				"Another comment with some <!-- HTML --> but not the marker",
			),
		];
		const result = parseHandoffMarker(comments, ISSUE_ID, GITHUB_URL);
		expect(result.type).toBe("none");
	});
});

// ── Duplicate markers — fail closed ──────────────────────────────────────────

describe("parseHandoffMarker — duplicate markers", () => {
	it("fails closed when two separate comments contain the marker", () => {
		const comments = [
			markerComment(validPayload(), "c1"),
			markerComment(validPayload(), "c2"),
		];
		const result = parseHandoffMarker(comments, ISSUE_ID, GITHUB_URL);
		expect(result.type).toBe("error");
		if (result.type === "error") {
			expect(result.reason).toMatch(/[Dd]uplicate/);
		}
	});

	it("fails closed when one comment contains two markers", () => {
		const json = JSON.stringify(validPayload(), null, 2);
		const body = `<!-- CYRUS-MACHINE-HANDOFF\n${json}\n-->\n<!-- CYRUS-MACHINE-HANDOFF\n${json}\n-->`;
		const comments = [fakeComment("c1", body)];
		const result = parseHandoffMarker(comments, ISSUE_ID, GITHUB_URL);
		expect(result.type).toBe("error");
		if (result.type === "error") {
			expect(result.reason).toMatch(/[Dd]uplicate/);
		}
	});
});

// ── Malformed / truncated marker ──────────────────────────────────────────────

describe("parseHandoffMarker — malformed marker", () => {
	it("fails closed when the closing --> is missing (truncated)", () => {
		const comments = [
			fakeComment("c1", '<!-- CYRUS-MACHINE-HANDOFF\n{"lease_id":"x"}'),
		];
		const result = parseHandoffMarker(comments, ISSUE_ID, GITHUB_URL);
		expect(result.type).toBe("error");
		if (result.type === "error") {
			expect(result.reason).toMatch(/closing/i);
		}
	});

	it("fails closed when the JSON is invalid", () => {
		const comments = [
			fakeComment("c1", "<!-- CYRUS-MACHINE-HANDOFF\n{not valid json\n-->"),
		];
		const result = parseHandoffMarker(comments, ISSUE_ID, GITHUB_URL);
		expect(result.type).toBe("error");
		if (result.type === "error") {
			expect(result.reason).toMatch(/JSON/i);
		}
	});

	it("fails closed when the JSON is an array", () => {
		const comments = [fakeComment("c1", "<!-- CYRUS-MACHINE-HANDOFF\n[]\n-->")];
		const result = parseHandoffMarker(comments, ISSUE_ID, GITHUB_URL);
		expect(result.type).toBe("error");
		if (result.type === "error") {
			expect(result.reason).toMatch(/object/i);
		}
	});

	it("fails closed when the JSON is null", () => {
		const comments = [
			fakeComment("c1", "<!-- CYRUS-MACHINE-HANDOFF\nnull\n-->"),
		];
		const result = parseHandoffMarker(comments, ISSUE_ID, GITHUB_URL);
		expect(result.type).toBe("error");
		if (result.type === "error") {
			expect(result.reason).toMatch(/object/i);
		}
	});
});

// ── Missing required fields ───────────────────────────────────────────────────

describe("parseHandoffMarker — missing required fields", () => {
	const requiredFields = [
		"lease_id",
		"lease_version",
		"issue_id",
		"owner",
		"lane",
		"canonical_repo",
		"worktree",
		"branch",
		"starting_sha",
		"scope",
		"policy_hash",
		"handoff_target",
		"acquired_at",
		"heartbeat_at",
		"expires_at",
		"ended_at",
	];

	for (const field of requiredFields) {
		it(`fails closed when '${field}' is missing`, () => {
			const payload = { ...validPayload() };
			delete payload[field];
			const comments = [markerComment(payload)];
			const result = parseHandoffMarker(comments, ISSUE_ID, GITHUB_URL);
			expect(result.type).toBe("error");
			if (result.type === "error") {
				expect(result.reason).toContain(field);
			}
		});
	}
});

// ── Field semantic validations ────────────────────────────────────────────────

describe("parseHandoffMarker — field semantics", () => {
	it("fails closed when ended_at is not null", () => {
		const result = parseHandoffMarker(
			[markerComment(validPayload({ ended_at: "2026-01-01T00:00:00Z" }))],
			ISSUE_ID,
			GITHUB_URL,
		);
		expect(result.type).toBe("error");
		if (result.type === "error") expect(result.reason).toMatch(/ended_at/);
	});

	it("fails closed when lease_version is not accepted", () => {
		const result = parseHandoffMarker(
			[markerComment(validPayload({ lease_version: "99" }))],
			ISSUE_ID,
			GITHUB_URL,
		);
		expect(result.type).toBe("error");
		if (result.type === "error") expect(result.reason).toMatch(/lease_version/);
	});

	it("fails closed when issue_id does not match", () => {
		const result = parseHandoffMarker(
			[markerComment(validPayload({ issue_id: "OTHER-99" }))],
			ISSUE_ID,
			GITHUB_URL,
		);
		expect(result.type).toBe("error");
		if (result.type === "error") expect(result.reason).toMatch(/issue_id/);
	});

	it("fails closed when lane is not 'bridge'", () => {
		const result = parseHandoffMarker(
			[markerComment(validPayload({ lane: "main" }))],
			ISSUE_ID,
			GITHUB_URL,
		);
		expect(result.type).toBe("error");
		if (result.type === "error") expect(result.reason).toMatch(/lane/);
	});

	it("fails closed when handoff_target is not 'cyrus'", () => {
		const result = parseHandoffMarker(
			[markerComment(validPayload({ handoff_target: "codex" }))],
			ISSUE_ID,
			GITHUB_URL,
		);
		expect(result.type).toBe("error");
		if (result.type === "error")
			expect(result.reason).toMatch(/handoff_target/);
	});

	it("fails closed when starting_sha is too short", () => {
		const result = parseHandoffMarker(
			[markerComment(validPayload({ starting_sha: "abc" }))],
			ISSUE_ID,
			GITHUB_URL,
		);
		expect(result.type).toBe("error");
		if (result.type === "error") expect(result.reason).toMatch(/starting_sha/);
	});

	it("fails closed when starting_sha contains uppercase letters", () => {
		const result = parseHandoffMarker(
			[markerComment(validPayload({ starting_sha: "B98AFDE0792B413D" }))],
			ISSUE_ID,
			GITHUB_URL,
		);
		expect(result.type).toBe("error");
		if (result.type === "error") expect(result.reason).toMatch(/starting_sha/);
	});

	it("fails closed when starting_sha contains non-hex characters", () => {
		const result = parseHandoffMarker(
			[markerComment(validPayload({ starting_sha: "gg00ff11223344" }))],
			ISSUE_ID,
			GITHUB_URL,
		);
		expect(result.type).toBe("error");
		if (result.type === "error") expect(result.reason).toMatch(/starting_sha/);
	});

	it("accepts a 7-char SHA", () => {
		const result = parseHandoffMarker(
			[markerComment(validPayload({ starting_sha: "b98afde" }))],
			ISSUE_ID,
			GITHUB_URL,
		);
		expect(result.type).toBe("found");
	});

	it("accepts a 40-char SHA", () => {
		const sha40 = "b98afde0792b413d4cae495c8e5d97609d953b20";
		const result = parseHandoffMarker(
			[markerComment(validPayload({ starting_sha: sha40 }))],
			ISSUE_ID,
			GITHUB_URL,
		);
		expect(result.type).toBe("found");
	});

	it("fails closed when scope is empty", () => {
		const result = parseHandoffMarker(
			[markerComment(validPayload({ scope: [] }))],
			ISSUE_ID,
			GITHUB_URL,
		);
		expect(result.type).toBe("error");
		if (result.type === "error") expect(result.reason).toMatch(/scope/);
	});

	it("fails closed when scope contains a blank entry", () => {
		const result = parseHandoffMarker(
			[markerComment(validPayload({ scope: ["read", "  "] }))],
			ISSUE_ID,
			GITHUB_URL,
		);
		expect(result.type).toBe("error");
		if (result.type === "error") expect(result.reason).toMatch(/scope/);
	});

	it("fails closed when scope is not an array", () => {
		const result = parseHandoffMarker(
			[markerComment(validPayload({ scope: "read:code" }))],
			ISSUE_ID,
			GITHUB_URL,
		);
		expect(result.type).toBe("error");
		if (result.type === "error") expect(result.reason).toMatch(/scope/);
	});
});

// ── Timestamp validation ──────────────────────────────────────────────────────

describe("parseHandoffMarker — timestamps", () => {
	it("fails closed when acquired_at is not a valid timestamp", () => {
		const result = parseHandoffMarker(
			[markerComment(validPayload({ acquired_at: "not-a-date" }))],
			ISSUE_ID,
			GITHUB_URL,
		);
		expect(result.type).toBe("error");
		if (result.type === "error") expect(result.reason).toMatch(/acquired_at/);
	});

	it("fails closed when acquired_at is a plain date with no T separator", () => {
		// Plain date strings like "2026-01-01" are not RFC3339
		const result = parseHandoffMarker(
			[markerComment(validPayload({ acquired_at: "2026-01-01" }))],
			ISSUE_ID,
			GITHUB_URL,
		);
		expect(result.type).toBe("error");
		if (result.type === "error") expect(result.reason).toMatch(/acquired_at/);
	});

	it("fails closed when acquired_at > heartbeat_at", () => {
		const result = parseHandoffMarker(
			[
				markerComment(
					validPayload({
						acquired_at: NOW_MINUS_5,
						heartbeat_at: NOW_MINUS_10,
					}),
				),
			],
			ISSUE_ID,
			GITHUB_URL,
		);
		expect(result.type).toBe("error");
		if (result.type === "error") expect(result.reason).toMatch(/heartbeat_at/);
	});

	it("fails closed when heartbeat_at > expires_at", () => {
		const result = parseHandoffMarker(
			[
				markerComment(
					validPayload({ heartbeat_at: FUTURE, expires_at: NOW_MINUS_5 }),
				),
			],
			ISSUE_ID,
			GITHUB_URL,
		);
		expect(result.type).toBe("error");
		if (result.type === "error") expect(result.reason).toMatch(/expires_at/);
	});

	it("fails closed when the lease is expired (expires_at in the past)", () => {
		const result = parseHandoffMarker(
			[
				markerComment(
					validPayload({
						acquired_at: new Date(Date.now() - 7200000).toISOString(),
						heartbeat_at: new Date(Date.now() - 3600000).toISOString(),
						expires_at: PAST,
					}),
				),
			],
			ISSUE_ID,
			GITHUB_URL,
		);
		expect(result.type).toBe("error");
		if (result.type === "error") expect(result.reason).toMatch(/expir/i);
	});
});

// ── Canonical repo validation ─────────────────────────────────────────────────

describe("parseHandoffMarker — canonical_repo", () => {
	it("fails closed when primaryRepoGithubUrl is undefined", () => {
		const result = parseHandoffMarker(
			[markerComment()],
			ISSUE_ID,
			undefined, // no githubUrl configured
		);
		expect(result.type).toBe("error");
		if (result.type === "error") expect(result.reason).toMatch(/githubUrl/i);
	});

	it("fails closed when canonical_repo does not match primaryRepoGithubUrl", () => {
		const result = parseHandoffMarker(
			[markerComment(validPayload({ canonical_repo: "OtherOrg/other-repo" }))],
			ISSUE_ID,
			GITHUB_URL,
		);
		expect(result.type).toBe("error");
		if (result.type === "error")
			expect(result.reason).toMatch(/canonical_repo/);
	});

	it("accepts canonical_repo with .git suffix", () => {
		const result = parseHandoffMarker(
			[
				markerComment(
					validPayload({ canonical_repo: "Brilliantio/cyrus-agent.git" }),
				),
			],
			ISSUE_ID,
			GITHUB_URL,
		);
		expect(result.type).toBe("found");
	});

	it("accepts canonical_repo with https:// prefix", () => {
		const result = parseHandoffMarker(
			[
				markerComment(
					validPayload({
						canonical_repo: "https://github.com/Brilliantio/cyrus-agent",
					}),
				),
			],
			ISSUE_ID,
			GITHUB_URL,
		);
		expect(result.type).toBe("found");
	});

	it("accepts canonical_repo with different casing", () => {
		const result = parseHandoffMarker(
			[
				markerComment(
					validPayload({ canonical_repo: "BRILLIANTIO/CYRUS-AGENT" }),
				),
			],
			ISSUE_ID,
			GITHUB_URL,
		);
		expect(result.type).toBe("found");
	});

	it("accepts primaryRepoGithubUrl with .git suffix", () => {
		const result = parseHandoffMarker(
			[markerComment()],
			ISSUE_ID,
			"https://github.com/Brilliantio/cyrus-agent.git",
		);
		expect(result.type).toBe("found");
	});
});

// ── normalizeRepoId helper ────────────────────────────────────────────────────

describe("normalizeRepoId", () => {
	it("strips https://github.com/ prefix", () => {
		expect(normalizeRepoId("https://github.com/Org/Repo")).toBe("org/repo");
	});

	it("strips github.com/ prefix", () => {
		expect(normalizeRepoId("github.com/Org/Repo")).toBe("org/repo");
	});

	it("strips .git suffix", () => {
		expect(normalizeRepoId("Org/Repo.git")).toBe("org/repo");
	});

	it("strips trailing slash", () => {
		expect(normalizeRepoId("Org/Repo/")).toBe("org/repo");
	});

	it("lowercases the result", () => {
		expect(normalizeRepoId("Org/MyRepo")).toBe("org/myrepo");
	});

	it("is idempotent on already-normalised value", () => {
		expect(normalizeRepoId("org/repo")).toBe("org/repo");
	});
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe("parseHandoffMarker — happy path", () => {
	it("returns found with fully typed data for a valid marker", () => {
		const comments = [markerComment()];
		const result = parseHandoffMarker(comments, ISSUE_ID, GITHUB_URL);

		expect(result.type).toBe("found");
		if (result.type !== "found") return;

		expect(result.commentId).toBe("comment-1");

		const d = result.data;
		expect(d.lease_id).toBe("lease-abc123");
		expect(d.lease_version).toBe("1");
		expect(d.issue_id).toBe(ISSUE_ID);
		expect(d.owner).toBe("bridge-agent-principal");
		expect(d.lane).toBe("bridge");
		expect(d.canonical_repo).toBe("Brilliantio/cyrus-agent");
		expect(d.starting_sha).toBe("b98afde0792b413d");
		expect(d.scope).toEqual(["read:code", "write:code"]);
		expect(d.policy_hash).toBe("sha256:abc123");
		expect(d.handoff_target).toBe("cyrus");
		expect(d.ended_at).toBeNull();
	});

	it("returns none when surrounding comments contain no marker", () => {
		const comments = [
			fakeComment("c1", "Normal comment"),
			markerComment(validPayload(), "c2"),
			fakeComment("c3", "Another normal comment"),
		];
		const result = parseHandoffMarker(comments, ISSUE_ID, GITHUB_URL);
		expect(result.type).toBe("found");
		if (result.type === "found") expect(result.commentId).toBe("c2");
	});

	it("finds marker on page 2 (later in the comment list)", () => {
		const page1Comments = Array.from({ length: 5 }, (_, i) =>
			fakeComment(`c${i}`, `Comment ${i}`),
		);
		const comments = [...page1Comments, markerComment(validPayload(), "c5")];
		const result = parseHandoffMarker(comments, ISSUE_ID, GITHUB_URL);
		expect(result.type).toBe("found");
	});
});
