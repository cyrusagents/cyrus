/**
 * PR follow-through input (merge conflicts and branch freshness), parsed from
 * a standard GitHub `pull_request` or `push` webhook that already passed HMAC
 * (direct) or Bearer (Hosted proxy) admission on `/github-webhook`. GitHub
 * has no conflict or "base moved" event for a PR: these are only reasons to
 * re-read pull requests owned by this runtime's sessions. Payload values are
 * hints; the router re-reads GitHub before acting.
 */
export type GitHubFollowThroughEvent = {
	repository: { id: number; fullName: string };
	installationId?: number;
} & (
	| {
			kind: "pull_request";
			action: string;
			number: number;
			/** Hint used only to skip PRs no session owns; re-read before use. */
			headRef: string;
	  }
	| { kind: "push"; baseRef: string }
);

export type FollowThroughStrategy = "off" | "merge" | "rebase";

/**
 * What a Hosted proxy delivery authorizes, from Hosted's current workspace
 * settings. The runtime's own live config must also allow each feature, so
 * neither side alone can turn one on.
 */
export type FollowThroughAdmission = {
	conflicts: boolean;
	freshness: FollowThroughStrategy;
};

/** Acknowledged by runtimes that handle PR follow-through. */
export const FOLLOW_THROUGH_PROTOCOL = 1;

/**
 * Hosted's admission for a proxied delivery, for example
 * `conflicts=on; freshness=merge`. Honored only after Bearer (proxy)
 * authentication; ignored in direct signature mode. Absent or malformed on a
 * proxied delivery means nothing is authorized.
 */
export const FOLLOW_THROUGH_HEADER = "x-cyrus-follow-through";

/** Strict: exactly `conflicts=on|off; freshness=off|merge|rebase`. */
export function parseFollowThroughAdmission(
	value: unknown,
): FollowThroughAdmission | null {
	if (typeof value !== "string" || value.length > 64) return null;
	const match = value
		.trim()
		.match(/^conflicts=(on|off);\s*freshness=(off|merge|rebase)$/);
	if (!match) return null;
	return {
		conflicts: match[1] === "on",
		freshness: match[2] as FollowThroughStrategy,
	};
}

export function formatFollowThroughAdmission(
	admission: FollowThroughAdmission,
): string {
	return `conflicts=${admission.conflicts ? "on" : "off"}; freshness=${admission.freshness}`;
}

const PR_ACTIONS = new Set([
	"opened",
	"reopened",
	"synchronize",
	"ready_for_review",
]);

const record = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const positiveId = (value: unknown): value is number =>
	Number.isSafeInteger(value) && Number(value) > 0;
const safeRef = (value: unknown): value is string =>
	typeof value === "string" &&
	value.length > 0 &&
	value.length <= 255 &&
	![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

/** Qualifying events only; everything else (drafts, labels, tags) is null. */
export function parseGitHubFollowThroughEvent(
	eventType: string,
	input: unknown,
): GitHubFollowThroughEvent | null {
	const payload = record(input);
	const repository = record(payload.repository);
	const installation = record(payload.installation);
	if (
		!positiveId(repository.id) ||
		typeof repository.full_name !== "string" ||
		!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.full_name) ||
		// Dot-only segments would change the API path the router reads.
		repository.full_name.split("/").some((part) => /^\.+$/.test(part)) ||
		(payload.installation !== undefined && !positiveId(installation.id))
	)
		return null;
	const base = {
		repository: { id: repository.id, fullName: repository.full_name },
		...(positiveId(installation.id) ? { installationId: installation.id } : {}),
	};
	if (eventType === "pull_request") {
		const pr = record(payload.pull_request);
		const head = record(pr.head);
		const retargeted =
			payload.action === "edited" && record(payload.changes).base !== undefined;
		if (
			(!PR_ACTIONS.has(String(payload.action)) && !retargeted) ||
			pr.draft === true ||
			!positiveId(pr.number) ||
			!safeRef(head.ref)
		)
			return null;
		return {
			...base,
			kind: "pull_request",
			action: String(payload.action),
			number: pr.number,
			headRef: head.ref,
		};
	}
	if (eventType === "push") {
		const ref = payload.ref;
		if (
			typeof ref !== "string" ||
			!ref.startsWith("refs/heads/") ||
			payload.deleted === true ||
			// A new branch cannot yet be any open PR's base.
			payload.created === true
		)
			return null;
		const baseRef = ref.slice("refs/heads/".length);
		if (!safeRef(baseRef)) return null;
		return { ...base, kind: "push", baseRef };
	}
	return null;
}
