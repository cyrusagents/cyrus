/**
 * Parser and validator for CYRUS-MACHINE-HANDOFF marker comments.
 *
 * When the bridge lane pre-delegates a Linear issue to Cyrus, it posts a comment
 * containing a machine-readable HTML comment with the handoff payload. This module
 * scans all issue comments for that marker, validates it strictly, and returns a
 * typed result that EdgeWorker uses to decide whether to run the lease-adoption
 * flow before startup.
 *
 * Security invariants:
 *   - Zero markers across all comments → legacy path (no env var check needed)
 *   - Any raw marker present → exactly one must be found, fully valid, or fail closed
 *   - Malformed / duplicate / ambiguous data always fails closed before any mutation
 */

import type { Comment } from "cyrus-core";

/** The raw HTML comment sentinel that identifies a handoff comment. */
const HANDOFF_MARKER = "<!-- CYRUS-MACHINE-HANDOFF";

/** Lease versions this implementation accepts. */
const ACCEPTED_LEASE_VERSIONS = new Set(["1"]);

/**
 * Valid SHA: 7–64 lowercase hex characters only.
 * Per the spec: "real 7..64 lowercase hex SHA".
 */
const SHA_PATTERN = /^[0-9a-f]{7,64}$/;

/** All required top-level fields in the handoff JSON payload. */
const REQUIRED_FIELDS: ReadonlyArray<string> = [
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

/** String fields that must be nonblank (ended_at is excluded — it must be null). */
const NONBLANK_STRING_FIELDS: ReadonlyArray<string> = [
	"lease_id",
	"lease_version",
	"issue_id",
	"owner",
	"lane",
	"canonical_repo",
	"worktree",
	"branch",
	"starting_sha",
	"policy_hash",
	"handoff_target",
	"acquired_at",
	"heartbeat_at",
	"expires_at",
];

/**
 * Validated, strongly-typed handoff payload.
 * Matches the bridge wire contract exactly.
 */
export interface HandoffMarkerData {
	lease_id: string;
	lease_version: string;
	issue_id: string;
	owner: string;
	lane: "bridge";
	canonical_repo: string;
	worktree: string;
	branch: string;
	starting_sha: string;
	scope: string[];
	policy_hash: string;
	handoff_target: "cyrus";
	acquired_at: string;
	heartbeat_at: string;
	expires_at: string;
	ended_at: null;
}

/** Result of scanning and validating comments for a handoff marker. */
export type HandoffParseResult =
	| { type: "none" }
	| { type: "error"; reason: string }
	| { type: "found"; commentId: string; data: HandoffMarkerData };

/**
 * Scan a flat array of issue comments for a CYRUS-MACHINE-HANDOFF marker.
 *
 * Rules:
 *   - Zero raw markers across all comments → `{ type: "none" }` (legacy path)
 *   - More than one marker (in any combination of comments) → `{ type: "error" }`
 *   - Exactly one marker but malformed/invalid → `{ type: "error" }`
 *   - Exactly one valid, unexpired marker → `{ type: "found", commentId, data }`
 *
 * @param comments       Flat array of all issue comments (all pages already fetched).
 * @param issueIdentifier  The issue identifier (e.g. "BRI-3257") to validate against.
 * @param primaryRepoGithubUrl  The githubUrl of the routed primary repository, used to
 *                              validate canonical_repo. If undefined, fail closed when a
 *                              marker is found (cannot validate canonical repo).
 */
export function parseHandoffMarker(
	comments: Comment[],
	issueIdentifier: string,
	primaryRepoGithubUrl: string | undefined,
): HandoffParseResult {
	// ── Step 1: Count raw markers across all comments ────────────────────────────
	const commentsWithMarker = comments.filter((c) =>
		c.body.includes(HANDOFF_MARKER),
	);

	if (commentsWithMarker.length === 0) {
		return { type: "none" };
	}

	if (commentsWithMarker.length > 1) {
		return {
			type: "error",
			reason: `Duplicate handoff markers: ${commentsWithMarker.length} comments contain the marker`,
		};
	}

	const markerComment = commentsWithMarker[0]!;
	const body = markerComment.body;

	// Count occurrences within the single comment
	const occurrences = countOccurrences(body, HANDOFF_MARKER);
	if (occurrences > 1) {
		return {
			type: "error",
			reason: `Duplicate markers in single comment: ${occurrences} occurrences found`,
		};
	}

	// ── Step 2: Extract JSON between marker and closing --> ──────────────────────
	const markerStart = body.indexOf(HANDOFF_MARKER);
	const jsonStart = markerStart + HANDOFF_MARKER.length;
	const closePos = body.indexOf("-->", jsonStart);
	if (closePos === -1) {
		return {
			type: "error",
			reason: "Malformed or truncated handoff marker: no closing -->",
		};
	}

	const rawJson = body.slice(jsonStart, closePos).trim();

	// ── Step 3: Parse JSON ───────────────────────────────────────────────────────
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawJson);
	} catch (err) {
		return {
			type: "error",
			reason: `Malformed handoff marker JSON: ${(err as Error).message}`,
		};
	}

	// Must be a plain object (not array, not null, not primitive)
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {
			type: "error",
			reason: "Handoff marker JSON must be a plain object",
		};
	}

	const obj = parsed as Record<string, unknown>;

	// ── Step 4: Presence check for all required fields ───────────────────────────
	for (const field of REQUIRED_FIELDS) {
		if (!(field in obj)) {
			return { type: "error", reason: `Missing required field: ${field}` };
		}
	}

	// ── Step 5: ended_at must be null ────────────────────────────────────────────
	if (obj.ended_at !== null) {
		return {
			type: "error",
			reason: `ended_at must be null, got: ${JSON.stringify(obj.ended_at)}`,
		};
	}

	// ── Step 6: Nonblank string fields ──────────────────────────────────────────
	for (const field of NONBLANK_STRING_FIELDS) {
		if (typeof obj[field] !== "string" || !(obj[field] as string).trim()) {
			return {
				type: "error",
				reason: `Field '${field}' must be a nonblank string, got: ${JSON.stringify(obj[field])}`,
			};
		}
	}

	// ── Step 7: Semantic field validations ───────────────────────────────────────

	// lease_version must be accepted
	if (!ACCEPTED_LEASE_VERSIONS.has(obj.lease_version as string)) {
		return {
			type: "error",
			reason: `Unaccepted lease_version: '${obj.lease_version}'`,
		};
	}

	// issue_id must match the routed issue
	if (obj.issue_id !== issueIdentifier) {
		return {
			type: "error",
			reason: `issue_id mismatch: marker says '${obj.issue_id}', issue is '${issueIdentifier}'`,
		};
	}

	// lane must be "bridge"
	if (obj.lane !== "bridge") {
		return {
			type: "error",
			reason: `lane must be 'bridge', got '${obj.lane}'`,
		};
	}

	// handoff_target must be "cyrus"
	if (obj.handoff_target !== "cyrus") {
		return {
			type: "error",
			reason: `handoff_target must be 'cyrus', got '${obj.handoff_target}'`,
		};
	}

	// starting_sha: 7–64 lowercase hex
	if (!SHA_PATTERN.test(obj.starting_sha as string)) {
		return {
			type: "error",
			reason: `starting_sha must be 7–64 lowercase hex characters, got '${obj.starting_sha}'`,
		};
	}

	// scope: nonempty array of nonblank strings
	if (!Array.isArray(obj.scope) || (obj.scope as unknown[]).length === 0) {
		return { type: "error", reason: "scope must be a nonempty array" };
	}
	for (const entry of obj.scope as unknown[]) {
		if (typeof entry !== "string" || !entry.trim()) {
			return {
				type: "error",
				reason: `scope entries must be nonblank strings, got: ${JSON.stringify(entry)}`,
			};
		}
	}

	// ── Step 8: Timestamp validation ─────────────────────────────────────────────
	const acquiredMs = parseRfc3339Ms(obj.acquired_at as string);
	const heartbeatMs = parseRfc3339Ms(obj.heartbeat_at as string);
	const expiresMs = parseRfc3339Ms(obj.expires_at as string);

	if (acquiredMs === null) {
		return {
			type: "error",
			reason: `acquired_at is not a valid RFC3339 timestamp: '${obj.acquired_at}'`,
		};
	}
	if (heartbeatMs === null) {
		return {
			type: "error",
			reason: `heartbeat_at is not a valid RFC3339 timestamp: '${obj.heartbeat_at}'`,
		};
	}
	if (expiresMs === null) {
		return {
			type: "error",
			reason: `expires_at is not a valid RFC3339 timestamp: '${obj.expires_at}'`,
		};
	}

	// Must be in order: acquired_at <= heartbeat_at <= expires_at
	if (acquiredMs > heartbeatMs) {
		return {
			type: "error",
			reason: "acquired_at must be ≤ heartbeat_at",
		};
	}
	if (heartbeatMs > expiresMs) {
		return {
			type: "error",
			reason: "heartbeat_at must be ≤ expires_at",
		};
	}

	// Must not be expired (expires_at > now)
	if (expiresMs <= Date.now()) {
		return { type: "error", reason: "Handoff lease has already expired" };
	}

	// ── Step 9: Canonical repo validation ────────────────────────────────────────
	if (primaryRepoGithubUrl === undefined) {
		return {
			type: "error",
			reason:
				"Cannot validate canonical_repo: primary repository has no githubUrl configured",
		};
	}

	const normalizedComment = normalizeRepoId(obj.canonical_repo as string);
	const normalizedPrimary = normalizeRepoId(primaryRepoGithubUrl);

	if (normalizedComment !== normalizedPrimary) {
		return {
			type: "error",
			reason: `canonical_repo mismatch: marker says '${obj.canonical_repo}', primary repo githubUrl is '${primaryRepoGithubUrl}'`,
		};
	}

	// ── All validations passed ────────────────────────────────────────────────────
	return {
		type: "found",
		commentId: markerComment.id,
		data: {
			lease_id: obj.lease_id as string,
			lease_version: obj.lease_version as string,
			issue_id: obj.issue_id as string,
			owner: obj.owner as string,
			lane: "bridge",
			canonical_repo: obj.canonical_repo as string,
			worktree: obj.worktree as string,
			branch: obj.branch as string,
			starting_sha: obj.starting_sha as string,
			scope: (obj.scope as unknown[]).map(String),
			policy_hash: obj.policy_hash as string,
			handoff_target: "cyrus",
			acquired_at: obj.acquired_at as string,
			heartbeat_at: obj.heartbeat_at as string,
			expires_at: obj.expires_at as string,
			ended_at: null,
		},
	};
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let pos = haystack.indexOf(needle, 0);
	while (pos !== -1) {
		count++;
		pos = haystack.indexOf(needle, pos + needle.length);
	}
	return count;
}

/**
 * Parse an RFC3339 timestamp string and return its millisecond epoch value,
 * or null if the string is not a valid date.
 */
function parseRfc3339Ms(ts: string): number | null {
	const ms = Date.parse(ts);
	if (Number.isNaN(ms)) return null;
	// Additional sanity check: ensure the string round-trips to a reasonable date
	// (Date.parse accepts many non-RFC3339 formats; we require a recognizable form)
	if (!ts.includes("T") && !ts.includes("t")) return null;
	return ms;
}

/**
 * Normalise a repository identifier for comparison:
 *   - Lowercase
 *   - Strip https://github.com/ or github.com/ prefix
 *   - Strip .git suffix
 *   - Strip trailing slash
 *
 * Examples:
 *   "https://github.com/Org/Repo.git" → "org/repo"
 *   "Org/Repo"                         → "org/repo"
 */
export function normalizeRepoId(s: string): string {
	return s
		.toLowerCase()
		.replace(/^https?:\/\/github\.com\//, "")
		.replace(/^github\.com\//, "")
		.replace(/\.git$/, "")
		.replace(/\/$/, "");
}
