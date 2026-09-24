import { describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { RunnerConfigBuilder } from "../src/RunnerConfigBuilder.js";

// Exercise the production event handler without starting servers or provider clients.
function fixture(status = "running", pending = false) {
	const worker = Object.create(EdgeWorker.prototype);
	const update = vi.fn(async () => {});
	worker.updateAutomationSession = update;
	worker.automations = {
		store: {
			read: () => ({ runs: [{ id: "run", sessionId: "session", status }] }),
		},
	};
	worker.agentSessionManager = {
		handleClaudeMessage: vi.fn(async () => {}),
		getSession: () => ({
			status: "complete",
			agentRunner: {
				getPendingWork: () => ({
					sessionCrons: [],
					backgroundTasks: pending ? ["task"] : [],
				}),
			},
		}),
		getSessionEntries: () => [
			{
				type: "result",
				content:
					'<!-- miko-automation-result {"outcome":"no_change","reason":"Already current","prUrls":[]} -->',
			},
		],
	};
	return { worker, update };
}

describe("scheduled task lifecycle", () => {
	it("completes a reasoned no-change result only after pending work ends", async () => {
		const { worker, update } = fixture();
		await worker.handleClaudeMessage(
			"session",
			{ type: "result", subtype: "success", is_error: false },
			"repo",
		);
		expect(update).toHaveBeenCalledWith("session", {
			status: "succeeded",
			message: "Already current",
			prUrls: [],
		});
		const active = fixture("running", true);
		await active.worker.handleClaudeMessage(
			"session",
			{ type: "result", subtype: "success", is_error: false },
			"repo",
		);
		expect(active.update).not.toHaveBeenCalled();
	});
	it("preserves an input wait for normal completion but releases it on an execution error", async () => {
		const { worker, update } = fixture("awaiting_input");
		await worker.handleClaudeMessage(
			"session",
			{ type: "result", subtype: "success", is_error: false },
			"repo",
		);
		expect(update).not.toHaveBeenCalled();
		await worker.handleClaudeMessage(
			"session",
			{ type: "result", subtype: "error_during_execution", is_error: true },
			"repo",
		);
		expect(update).toHaveBeenCalledWith(
			"session",
			expect.objectContaining({ status: "failed" }),
		);
	});
	it("ignores duplicate scheduled Linear webhooks before starting another session", async () => {
		const { worker, update } = fixture();
		worker.automations.store.read = () => ({
			runs: [{ id: "run", issueId: "issue", status: "running" }],
		});
		worker.automationSessionStarts = new Set(["run"]);
		worker.repositoryRouter = { determineRepositoryForWebhook: vi.fn() };
		await worker.handleAgentSessionCreatedWebhook(
			{ agentSession: { id: "session", issue: { id: "issue" } } },
			[],
		);
		expect(
			worker.repositoryRouter.determineRepositoryForWebhook,
		).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});
	it("does not restart a claimed Linear execution after process restart", async () => {
		const { worker, update } = fixture();
		worker.automations.store.read = () => ({
			runs: [
				{
					id: "run",
					issueId: "issue",
					status: "running",
					executionClaimedAt: 1,
				},
			],
		});
		worker.automationSessionStarts = new Set();
		worker.repositoryRouter = { determineRepositoryForWebhook: vi.fn() };
		await worker.handleAgentSessionCreatedWebhook(
			{ agentSession: { id: "session", issue: { id: "issue" } } },
			[],
		);
		expect(
			worker.repositoryRouter.determineRepositoryForWebhook,
		).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});
});

it("builds standalone runner config without Linear identity or native Linear tools", () => {
	const buildMcpConfig = vi.fn(() => ({}));
	const requireWorkspace = vi.fn(() => {
		throw new Error("No Linear workspace");
	});
	const question = vi.fn();
	const builder = new RunnerConfigBuilder(
		{ buildChatAllowedTools: () => [] },
		{ buildMcpConfig, buildMergedMcpConfigPath: () => undefined },
		{
			determineRunnerSelection: () => ({ runnerType: "claude" }),
			getDefaultModelForRunner: () => "sonnet",
			getDefaultFallbackModelForRunner: () => "haiku",
		},
	);
	const { config } = builder.buildIssueConfig({
		standalone: true,
		session: {
			id: "automation-run",
			workspace: { path: "/tmp/worktree", isGitWorktree: true },
		},
		repository: {
			id: "repo",
			name: "Repository",
			repositoryPath: "/tmp/repo",
			allowedTools: [],
		},
		sessionId: "automation-run",
		systemPrompt: "Implement, verify and create a PR",
		allowedTools: ["Read(**)"],
		allowedDirectories: ["/tmp/repo"],
		disallowedTools: [],
		atmikoHome: "/tmp/atmiko",
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		onMessage() {},
		onError() {},
		requireLinearWorkspaceId: requireWorkspace,
		createAskUserQuestionCallback: question,
	} as Parameters<RunnerConfigBuilder["buildIssueConfig"]>[0]);
	expect(requireWorkspace).not.toHaveBeenCalled();
	expect(buildMcpConfig).not.toHaveBeenCalled();
	expect(question).not.toHaveBeenCalled();
	expect(config.mcpConfig).toEqual({});
	expect(config.workspaceName).toBe("automation-run");
	expect(config.model).toBe("sonnet");
});
