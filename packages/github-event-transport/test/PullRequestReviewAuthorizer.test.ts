import { describe, expect, it } from "vitest";
import {
	CYRUS_PR_MARKER,
	PullRequestReviewAuthorizer,
} from "../src/PullRequestReviewAuthorizer.js";
import type { GitHubPullRequestReviewPayload } from "../src/types.js";
import { prReviewPayload, testPullRequest, testUser } from "./fixtures.js";

function payloadWith(
	overrides: Partial<{
		body: string | null;
		userLogin: string;
		userType: string;
	}>,
): GitHubPullRequestReviewPayload {
	return {
		...prReviewPayload,
		pull_request: {
			...testPullRequest,
			body:
				"body" in overrides ? (overrides.body ?? null) : testPullRequest.body,
			user: {
				...testUser,
				login: overrides.userLogin ?? testUser.login,
				type: overrides.userType ?? testUser.type,
			},
		},
	};
}

describe("PullRequestReviewAuthorizer", () => {
	it("authorizes when the PR author matches the configured bot username", () => {
		const authorizer = new PullRequestReviewAuthorizer({
			botUsername: "cyrusagent",
		});

		const result = authorizer.authorize(
			payloadWith({ userLogin: "cyrusagent", userType: "User", body: "" }),
		);

		expect(result.authorized).toBe(true);
		expect(result.reason).toContain("Cyrus bot");
	});

	it("authorizes when PR author is the GitHub App bot variant (login[bot])", () => {
		const authorizer = new PullRequestReviewAuthorizer({
			botUsername: "cyrusagent",
		});

		const result = authorizer.authorize(
			payloadWith({
				userLogin: "cyrusagent[bot]",
				userType: "Bot",
				body: "",
			}),
		);

		expect(result.authorized).toBe(true);
	});

	it("authorizes a PR by a human author when the body contains the marker", () => {
		const authorizer = new PullRequestReviewAuthorizer({
			botUsername: "cyrusagent",
		});

		const result = authorizer.authorize(
			payloadWith({
				userLogin: "alice",
				userType: "User",
				body: `Some description\n\n${CYRUS_PR_MARKER}\n`,
			}),
		);

		expect(result.authorized).toBe(true);
		expect(result.reason).toContain("marker");
	});

	it("rejects a PR by a human author with no marker", () => {
		const authorizer = new PullRequestReviewAuthorizer({
			botUsername: "cyrusagent",
		});

		const result = authorizer.authorize(
			payloadWith({
				userLogin: "alice",
				userType: "User",
				body: "Plain human PR",
			}),
		);

		expect(result.authorized).toBe(false);
		expect(result.reason).toContain("not the Cyrus bot");
	});

	it("rejects a PR by a human author when the PR body is null", () => {
		const authorizer = new PullRequestReviewAuthorizer({
			botUsername: "cyrusagent",
		});

		const result = authorizer.authorize(
			payloadWith({
				userLogin: "alice",
				userType: "User",
				body: null,
			}),
		);

		expect(result.authorized).toBe(false);
	});

	it("falls back to marker-only when no botUsername is configured", () => {
		const authorizer = new PullRequestReviewAuthorizer();

		const withMarker = authorizer.authorize(
			payloadWith({
				userLogin: "anyone",
				userType: "User",
				body: CYRUS_PR_MARKER,
			}),
		);
		const withoutMarker = authorizer.authorize(
			payloadWith({
				userLogin: "anyone",
				userType: "User",
				body: "no marker here",
			}),
		);

		expect(withMarker.authorized).toBe(true);
		expect(withoutMarker.authorized).toBe(false);
	});

	it("matches bot username case-insensitively", () => {
		const authorizer = new PullRequestReviewAuthorizer({
			botUsername: "CyrusAgent",
		});

		const result = authorizer.authorize(
			payloadWith({
				userLogin: "cyrusagent[bot]",
				userType: "Bot",
				body: "",
			}),
		);

		expect(result.authorized).toBe(true);
	});
});
