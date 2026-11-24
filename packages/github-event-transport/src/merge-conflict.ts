/**
 * A merge conflict hint from Cyrus Hosted. GitHub has no conflict webhook, so
 * Hosted re-reads a qualifying pull request after `pull_request` or base
 * branch `push` events and sends this only when GitHub reported
 * `mergeable: false`. It is a hint, never proof: the runtime re-reads the
 * pull request itself before acting. Identifiers only, no provider text.
 */
export interface GitHubMergeConflictHint {
	repository: { id: number; fullName: string };
	pullRequest: { number: number; headSha: string; baseSha: string };
}

/** Bump only with a matching Hosted change; Hosted rejects any other value. */
export const MERGE_CONFLICT_PROTOCOL = 1;

const positiveId = (value: unknown): value is number =>
	Number.isSafeInteger(value) && Number(value) > 0;
const sha = (value: unknown): value is string =>
	typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
const record = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

/** Strict: unknown keys, wrong types or another protocol version are rejected. */
export function parseGitHubMergeConflictHint(
	input: unknown,
): GitHubMergeConflictHint | null {
	const body = record(input);
	const repository = record(body?.repository);
	const pullRequest = record(body?.pullRequest);
	if (
		!body ||
		!repository ||
		!pullRequest ||
		Object.keys(body).sort().join() !==
			"conflictProtocol,pullRequest,repository" ||
		Object.keys(repository).sort().join() !== "fullName,id" ||
		Object.keys(pullRequest).sort().join() !== "baseSha,headSha,number" ||
		body.conflictProtocol !== MERGE_CONFLICT_PROTOCOL ||
		!positiveId(repository.id) ||
		typeof repository.fullName !== "string" ||
		!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.fullName) ||
		// Dot-only segments would change the API path the router reads.
		repository.fullName.split("/").some((part) => /^\.+$/.test(part)) ||
		!positiveId(pullRequest.number) ||
		!sha(pullRequest.headSha) ||
		!sha(pullRequest.baseSha)
	)
		return null;
	return {
		repository: { id: repository.id, fullName: repository.fullName },
		pullRequest: {
			number: pullRequest.number,
			headSha: pullRequest.headSha.toLowerCase(),
			baseSha: pullRequest.baseSha.toLowerCase(),
		},
	};
}
