import { describe, expect, it } from "vitest";
import {
	extractMRBaseBranchRef,
	extractMRBranchRef,
	extractMRIid,
	extractNoteAuthor,
	extractNoteBody,
	extractProjectPath,
	extractSessionKey,
	isNoteOnMergeRequest,
	stripMention,
} from "../src/gitlab-webhook-utils.js";
import type { GitLabNotePayload, GitLabWebhookEvent } from "../src/types.js";

function createNoteEvent(
	overrides: Partial<GitLabNotePayload> = {},
): GitLabWebhookEvent {
	const defaultPayload: GitLabNotePayload = {
		object_kind: "note",
		event_type: "note",
		user: {
			id: 1,
			name: "Test User",
			username: "testuser",
			avatar_url: "https://gitlab.com/avatar.png",
		},
		project: {
			id: 42,
			name: "my-project",
			description: null,
			web_url: "https://gitlab.com/mygroup/my-project",
			git_ssh_url: "git@gitlab.com:mygroup/my-project.git",
			git_http_url: "https://gitlab.com/mygroup/my-project.git",
			namespace: "mygroup",
			path_with_namespace: "mygroup/my-project",
			default_branch: "main",
			homepage: "https://gitlab.com/mygroup/my-project",
			url: "git@gitlab.com:mygroup/my-project.git",
			ssh_url: "git@gitlab.com:mygroup/my-project.git",
			http_url: "https://gitlab.com/mygroup/my-project.git",
		},
		object_attributes: {
			id: 100,
			note: "Hello @mikoagent please fix the tests",
			noteable_type: "MergeRequest",
			author_id: 1,
			created_at: "2025-01-01T00:00:00Z",
			updated_at: "2025-01-01T00:00:00Z",
			project_id: 42,
			url: "https://gitlab.com/mygroup/my-project/-/merge_requests/5#note_100",
			type: null,
		},
		merge_request: {
			id: 200,
			iid: 5,
			title: "Fix broken tests",
			description: "This MR fixes the test suite",
			state: "opened",
			url: "https://gitlab.com/mygroup/my-project/-/merge_requests/5",
			source_branch: "fix/tests",
			target_branch: "main",
			source_project_id: 42,
			target_project_id: 42,
			author_id: 1,
			assignee_id: null,
			created_at: "2025-01-01T00:00:00Z",
			updated_at: "2025-01-01T00:00:00Z",
		},
		...overrides,
	};

	return {
		eventType: "note",
		payload: defaultPayload,
	};
}

describe("gitlab-webhook-utils", () => {
	describe("isNoteOnMergeRequest", () => {
		it("returns true for notes on merge requests", () => {
			const event = createNoteEvent();
			expect(isNoteOnMergeRequest(event)).toBe(true);
		});

		it("returns false for notes on issues", () => {
			const event = createNoteEvent({
				object_attributes: {
					id: 100,
					note: "test",
					noteable_type: "Issue",
					author_id: 1,
					created_at: "2025-01-01T00:00:00Z",
					updated_at: "2025-01-01T00:00:00Z",
					project_id: 42,
					url: "",
					type: null,
				},
				merge_request: undefined,
			});
			expect(isNoteOnMergeRequest(event)).toBe(false);
		});
	});

	describe("extractMRBranchRef", () => {
		it("extracts source branch from note event", () => {
			const event = createNoteEvent();
			expect(extractMRBranchRef(event)).toBe("fix/tests");
		});
	});

	describe("extractMRBaseBranchRef", () => {
		it("extracts target branch from note event", () => {
			const event = createNoteEvent();
			expect(extractMRBaseBranchRef(event)).toBe("main");
		});
	});

	describe("extractMRIid", () => {
		it("extracts MR iid from note event", () => {
			const event = createNoteEvent();
			expect(extractMRIid(event)).toBe(5);
		});
	});

	describe("extractNoteBody", () => {
		it("extracts note body from note event", () => {
			const event = createNoteEvent();
			expect(extractNoteBody(event)).toBe(
				"Hello @mikoagent please fix the tests",
			);
		});
	});

	describe("extractNoteAuthor", () => {
		it("extracts username from event", () => {
			const event = createNoteEvent();
			expect(extractNoteAuthor(event)).toBe("testuser");
		});
	});

	describe("extractProjectPath", () => {
		it("extracts path_with_namespace", () => {
			const event = createNoteEvent();
			expect(extractProjectPath(event)).toBe("mygroup/my-project");
		});
	});

	describe("extractSessionKey", () => {
		it("builds session key as gitlab:path!iid", () => {
			const event = createNoteEvent();
			expect(extractSessionKey(event)).toBe("gitlab:mygroup/my-project!5");
		});
	});

	describe("stripMention", () => {
		it("strips @mikoagent mention from note body", () => {
			expect(stripMention("Hello @mikoagent fix tests")).toBe(
				"Hello fix tests",
			);
		});

		it("strips custom mention handle", () => {
			expect(stripMention("@mybot do something", "@mybot")).toBe(
				"do something",
			);
		});
	});
});
