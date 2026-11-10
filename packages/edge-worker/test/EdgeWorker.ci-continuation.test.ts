import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";

const homes: string[] = [];
function fixture() {
	const path = mkdtempSync(join(tmpdir(), "ci-continuation-"));
	homes.push(path);
	const session = {
		id: "linear-session",
		status: "complete",
		codexSessionId: "existing-codex-session",
		workspace: { path, repoPaths: { repo: path } },
		agentRunner: undefined as any,
	};
	const repository = {
		id: "repo",
		repositoryPath: path,
		linearWorkspaceId: "workspace",
	};
	const runner = { start: vi.fn().mockResolvedValue(undefined) };
	const context = {
		agentSessionManager: {
			getSession: vi.fn(() => session),
			addAgentRunner: vi.fn(),
		},
		resumeAgentSession: vi.fn().mockResolvedValue(undefined),
		buildAgentRunnerConfig: vi.fn().mockResolvedValue({
			config: { resumeSessionId: session.codexSessionId },
			runnerType: "codex",
		}),
		toolPermissionResolver: { buildGithubAllowedTools: vi.fn(() => []) },
		buildDisallowedTools: vi.fn(() => []),
		buildSkillSessionContext: vi.fn(),
		createRunnerForType: vi.fn(() => runner),
		savePersistedState: vi.fn().mockResolvedValue(undefined),
	};
	const prepare = () =>
		(EdgeWorker.prototype as any).prepareCiPrompt.call(
			context,
			session,
			repository,
			"Investigate CI",
		);
	return { session, repository, context, runner, prepare };
}
afterEach(() => {
	for (const path of homes.splice(0))
		rmSync(path, { recursive: true, force: true });
});
describe("CI continues the responsible existing session", () => {
	it("steers the active stream without creating a session or runner", async () => {
		const f = fixture();
		const addStreamMessage = vi.fn();
		f.session.agentRunner = {
			isRunning: () => true,
			supportsStreamingInput: true,
			addStreamMessage,
		};
		const start = await f.prepare();
		expect(addStreamMessage).not.toHaveBeenCalled();
		await start();
		expect(addStreamMessage).toHaveBeenCalledWith("Investigate CI");
		expect(f.context.resumeAgentSession).not.toHaveBeenCalled();
		expect(f.context.createRunnerForType).not.toHaveBeenCalled();
	});
	it("resumes an idle issue session through the existing continuation path", async () => {
		const f = fixture();
		await (await f.prepare())();
		expect(f.context.resumeAgentSession).toHaveBeenCalledWith(
			f.session,
			f.repository,
			f.session.id,
			f.context.agentSessionManager,
			"Investigate CI",
			"",
			false,
			[],
			"workspace",
			50,
		);
	});
	it("resumes GitHub-origin sessions with their existing runner ID and platform", async () => {
		const f = fixture();
		f.session.id = "github-delivery";
		await (await f.prepare())();
		expect(f.context.buildAgentRunnerConfig.mock.calls[0]![7]).toBe(
			"existing-codex-session",
		);
		expect(f.context.buildAgentRunnerConfig.mock.calls[0]![13]).toBe("github");
		expect(f.context.agentSessionManager.addAgentRunner).toHaveBeenCalledWith(
			"github-delivery",
			f.runner,
		);
		expect(f.runner.start).toHaveBeenCalledWith("Investigate CI");
		expect(f.context.resumeAgentSession).not.toHaveBeenCalled();
	});
	it("does not stop a busy non-streaming runner or restart an errored session", async () => {
		const f = fixture();
		f.session.agentRunner = {
			isRunning: () => true,
			supportsStreamingInput: false,
		};
		await expect(f.prepare()).rejects.toThrow("busy");
		f.session.status = "error";
		await expect(f.prepare()).rejects.toThrow("stopped");
		expect(f.context.createRunnerForType).not.toHaveBeenCalled();
	});
});
