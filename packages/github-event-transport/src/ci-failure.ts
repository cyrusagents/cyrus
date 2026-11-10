/** Credential-free CI identity. Raw check output is deliberately excluded. */
export interface GitHubCiFailure {
	eventType: "status" | "check_run";
	repository: { id: number; fullName: string };
	installationId?: number;
	sha: string;
	id: number;
	name: string;
	state: string;
	appId?: number;
}

export type CiParseResult =
	| { kind: "failure"; failure: GitHubCiFailure }
	| { kind: "ignored" }
	| { kind: "invalid" };

export function parseGitHubCiFailure(
	event: string,
	input: unknown,
): CiParseResult {
	if (event !== "status" && event !== "check_run") return { kind: "ignored" };
	if (!input || typeof input !== "object") return { kind: "invalid" };
	const object = (value: unknown): Record<string, unknown> =>
		value !== null && typeof value === "object"
			? (value as Record<string, unknown>)
			: {};
	const p = object(input);
	const repository = object(p.repository);
	const installation = object(p.installation);
	const check = event === "status" ? p : object(p.check_run);
	if (event === "check_run" && !p.check_run) return { kind: "invalid" };
	const app = object(check.app);
	const state = event === "status" ? check.state : check.conclusion;
	if (event === "status") {
		if (
			typeof state !== "string" ||
			!["failure", "error", "success", "pending"].includes(state)
		)
			return { kind: "invalid" };
		if (state !== "failure" && state !== "error") return { kind: "ignored" };
	} else if (
		p.action !== "completed" ||
		check.status !== "completed" ||
		typeof state !== "string" ||
		!["failure", "timed_out", "action_required", "startup_failure"].includes(
			state,
		)
	) {
		return { kind: "ignored" };
	}
	if (typeof state !== "string") return { kind: "invalid" };
	const sha = event === "status" ? check.sha : check.head_sha;
	const name = event === "status" ? check.context : check.name;
	const positiveId = (value: unknown): value is number =>
		Number.isSafeInteger(value) && Number(value) > 0;
	if (
		!positiveId(repository.id) ||
		typeof repository.full_name !== "string" ||
		!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.full_name) ||
		!positiveId(check.id) ||
		typeof sha !== "string" ||
		!/^[a-f0-9]{40}$/i.test(sha) ||
		typeof name !== "string" ||
		name.length === 0 ||
		name.length > 255 ||
		(p.installation && !positiveId(installation.id)) ||
		(event === "check_run" && !positiveId(app.id))
	)
		return { kind: "invalid" };
	return {
		kind: "failure",
		failure: {
			eventType: event,
			repository: { id: repository.id, fullName: repository.full_name },
			installationId: installation.id as number | undefined,
			sha: sha.toLowerCase(),
			id: check.id,
			name,
			state,
			...(event === "check_run" ? { appId: app.id as number } : {}),
		},
	};
}
