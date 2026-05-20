import type { EdgeWorkerConfig, RepositoryConfig } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const edgeWorkerInstances: Array<{
	config: EdgeWorkerConfig;
	setConfigPath: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	start: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("cyrus-edge-worker", () => ({
	EdgeWorker: vi.fn().mockImplementation((config: EdgeWorkerConfig) => {
		const instance = {
			config,
			setConfigPath: vi.fn(),
			on: vi.fn(),
			start: vi.fn().mockResolvedValue(undefined),
		};
		edgeWorkerInstances.push(instance);
		return instance;
	}),
}));

vi.mock("cyrus-cloudflare-tunnel-client", () => ({
	getCyrusAppUrl: vi.fn(),
}));

vi.mock("cyrus-slack-event-transport", () => ({
	SlackEventTransport: vi.fn(),
}));

const { WorkerService } = await import("./WorkerService.js");

const repository: RepositoryConfig = {
	id: "repo-1",
	name: "Repo 1",
	repositoryPath: "/tmp/repo-1",
	baseBranch: "main",
};

describe("WorkerService", () => {
	beforeEach(() => {
		edgeWorkerInstances.length = 0;
	});

	it("forwards top-level OpenCode config overrides to EdgeWorker", async () => {
		const opencode = {
			config: {
				provider: {
					anthropic: { options: { baseURL: "https://opencode.test" } },
				},
			},
		};
		const service = new WorkerService(
			{
				load: () => ({ opencode }),
				getConfigPath: () => "/tmp/cyrus/config.json",
			} as any,
			{ createGitWorktree: vi.fn() } as any,
			"/tmp/cyrus",
			{
				info: vi.fn(),
				success: vi.fn(),
				error: vi.fn(),
				warn: vi.fn(),
			} as any,
			"test-version",
		);

		await service.startEdgeWorker({
			repositories: [repository],
			onOAuthCallback: vi.fn(),
		});

		expect(edgeWorkerInstances).toHaveLength(1);
		expect(edgeWorkerInstances[0].config.opencode).toBe(opencode);
	});
});
