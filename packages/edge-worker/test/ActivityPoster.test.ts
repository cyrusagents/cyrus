import type { IIssueTrackerService, ILogger } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityPoster } from "../src/ActivityPoster.js";

describe("ActivityPoster", () => {
	let createAgentActivity: ReturnType<typeof vi.fn>;
	let poster: ActivityPoster;

	beforeEach(() => {
		createAgentActivity = vi.fn().mockResolvedValue({
			success: true,
			agentActivity: Promise.resolve({ id: "activity-1" }),
		});

		poster = new ActivityPoster(
			new Map([
				[
					"workspace-1",
					{ createAgentActivity } as unknown as IIssueTrackerService,
				],
			]),
			new Map(),
			{
				debug: vi.fn(),
				error: vi.fn(),
				warn: vi.fn(),
				info: vi.fn(),
			} as unknown as ILogger,
		);
	});

	it("adds a sudo guidance hint to repo setup hook sudo failures", async () => {
		await poster.postRepoSetupHookActivity("session-1", "workspace-1", {
			status: "failed",
			issueIdentifier: "ENG-97",
			scriptName: "cyrus-setup.sh",
			repositoryName: "test-repo",
			durationMs: 1_200,
			exitCode: 1,
			errorMessage: "Script exited with code 1",
			stderrTail: "sudo: a password is required",
			truncated: false,
		});

		const result = createAgentActivity.mock.calls[0][0].content.result;
		expect(result).toContain("sudo: a password is required");
		expect(result).toContain(
			"The setup script does not run with sudo privileges.",
		);
		expect(result).toContain("Settings > Packages (`/settings/packages`)");
		expect(result).toContain("self-hosted Cyrus");
	});

	it("does not add sudo guidance to non-sudo repo setup hook failures", async () => {
		await poster.postRepoSetupHookActivity("session-1", "workspace-1", {
			status: "failed",
			issueIdentifier: "ENG-97",
			scriptName: "cyrus-setup.sh",
			repositoryName: "test-repo",
			durationMs: 1_200,
			exitCode: 42,
			errorMessage: "Script exited with code 42",
			stderrTail: "missing package @fake/missing",
			truncated: false,
		});

		const result = createAgentActivity.mock.calls[0][0].content.result;
		expect(result).toContain("missing package @fake/missing");
		expect(result).not.toContain("sudo privileges");
		expect(result).not.toContain("/settings/packages");
	});
});
