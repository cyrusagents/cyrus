import { join } from "node:path";
import { getReadOnlyTools } from "cyrus-claude-runner";
import type { RepositoryConfig } from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import type { ChatRepositoryProvider } from "../src/ChatRepositoryProvider.js";
import { LiveChatRepositoryProvider } from "../src/ChatRepositoryProvider.js";
import type { ChatPlatformAdapter } from "../src/ChatSessionHandler.js";
import { ChatSessionHandler } from "../src/ChatSessionHandler.js";
import type { RunnerConfigBuilder } from "../src/RunnerConfigBuilder.js";
import { SlackChatAdapter } from "../src/SlackChatAdapter.js";
import { TEST_CYRUS_CHAT } from "./test-dirs.js";

function createMockRunnerConfigBuilder(): RunnerConfigBuilder {
	return {
		buildChatConfig: (input: any) => {
			const repositoryPaths = Array.from(
				new Set((input.repositoryPaths ?? []).filter(Boolean)),
			);
			return {
				workingDirectory: input.workspacePath,
				allowedTools: [
					...new Set([...getReadOnlyTools(), "Bash(git -C * pull)"]),
				],
				disallowedTools: [],
				allowedDirectories: [input.workspacePath, ...repositoryPaths],
				workspaceName: input.workspaceName,
				cyrusHome: input.cyrusHome,
				appendSystemPrompt: input.systemPrompt,
				...(input.resumeSessionId
					? { resumeSessionId: input.resumeSessionId }
					: {}),
				logger: input.logger,
				maxTurns: 200,
				onMessage: input.onMessage,
				onError: input.onError,
			};
		},
		buildIssueConfig: vi.fn(),
	} as unknown as RunnerConfigBuilder;
}

/** Minimal ChatRepositoryProvider backed by a plain array (for tests) */
function createStaticProvider(
	paths: string[],
	defaultRepo?: RepositoryConfig,
	linearWorkspaceId?: string,
): ChatRepositoryProvider {
	return {
		getRepositoryPaths: () => paths,
		getDefaultRepository: () => defaultRepo,
		getDefaultLinearWorkspaceId: () => linearWorkspaceId,
	};
}

interface TestEvent {
	eventId: string;
	threadKey: string;
}

class TestChatAdapter implements ChatPlatformAdapter<TestEvent> {
	public platformName = "slack" as const;

	constructor(private readonly threadKey: string) {}

	extractTaskInstructions(_event: TestEvent): string {
		return "Inspect repository configuration";
	}

	getThreadKey(_event: TestEvent): string {
		return this.threadKey;
	}

	getEventId(_event: TestEvent): string {
		return "test-event";
	}

	buildSystemPrompt(_event: TestEvent): string {
		return "You are a test chat assistant.";
	}

	async fetchThreadContext(_event: TestEvent): Promise<string> {
		return "";
	}

	async postReply(_event: TestEvent, _runner: unknown): Promise<void> {
		return;
	}

	async acknowledgeReceipt(_event: TestEvent): Promise<void> {
		return;
	}

	async notifyBusy(_event: TestEvent): Promise<void> {
		return;
	}

	async notifyUnavailable(
		_event: TestEvent,
		_threadKey: string,
		_message: string,
	): Promise<void> {
		return;
	}
}

describe("ChatSessionHandler chat session permissions", () => {
	it("grants read-only tools, explicit git pull, and repository read access", async () => {
		const event: TestEvent = {
			eventId: "test-event",
			threadKey: "test-thread",
		};
		const cyrusHome = TEST_CYRUS_CHAT;
		const chatRepositoryPaths = ["/repo/chat-one", "/repo/chat-two"];
		let capturedConfig: any;

		const adapter = new TestChatAdapter("thread-key");
		const createRunner = vi.fn((config: any) => {
			capturedConfig = config;
			return {
				supportsStreamingInput: false,
				start: vi.fn().mockResolvedValue({ sessionId: "session-1" }),
				stop: vi.fn(),
				isRunning: vi.fn().mockReturnValue(false),
				isStreaming: vi.fn().mockReturnValue(false),
				addStreamMessage: vi.fn(),
				getMessages: vi.fn().mockReturnValue([]),
			} as any;
		});
		const onWebhookStart = vi.fn();
		const onWebhookEnd = vi.fn();
		const onStateChange = vi.fn().mockResolvedValue(undefined);
		const onClaudeError = vi.fn();

		const handler = new ChatSessionHandler(adapter, {
			cyrusHome,
			chatRepositoryProvider: createStaticProvider(chatRepositoryPaths),
			runnerConfigBuilder: createMockRunnerConfigBuilder(),
			createRunner: createRunner,
			onWebhookStart,
			onWebhookEnd,
			onStateChange,
			onClaudeError,
		});

		await handler.handleEvent(event as any);

		expect(capturedConfig).toBeDefined();
		expect(capturedConfig.allowedTools).toContain("Read(**)");
		expect(capturedConfig.allowedTools).toContain("Glob");
		expect(capturedConfig.allowedTools).toContain("Bash(git -C * pull)");
		expect(capturedConfig.allowedTools).not.toContain("Edit(**)");

		const expectedWorkspace = join(cyrusHome, "slack-workspaces", "thread-key");
		expect(capturedConfig.allowedDirectories).toContain(expectedWorkspace);
		for (const path of chatRepositoryPaths) {
			expect(capturedConfig.allowedDirectories).toContain(path);
		}
	});
});

describe("SlackChatAdapter system prompt", () => {
	it("includes configured repository context and git pull instructions", () => {
		const repositoryPaths = ["/repo/chat-one", "/repo/chat-two"];
		const adapter = new SlackChatAdapter(createStaticProvider(repositoryPaths));
		const systemPrompt = adapter.buildSystemPrompt({
			payload: {
				user: "U1",
				channel: "C1",
				text: "<@cyrus> inspect code",
				ts: "1700000000.000100",
				event_ts: "1700000000.000100",
				type: "app_mention",
			},
		} as any);

		expect(systemPrompt).toContain("## Repository Access");
		expect(systemPrompt).toContain("- /repo/chat-one");
		expect(systemPrompt).toContain("- /repo/chat-two");
		expect(systemPrompt).toContain("Bash(git -C * pull)");
	});

	it("includes orchestrator routing context and self-assignment workflow", () => {
		const repositoryPaths = ["/repo/chat-one", "/repo/chat-two"];
		const repositoryRoutingContext =
			"<repository_routing_context>\n  <description>Use repo routing tags.</description>\n</repository_routing_context>";
		const adapter = new SlackChatAdapter(
			createStaticProvider(repositoryPaths),
			undefined,
			{ repositoryRoutingContext },
		);
		const systemPrompt = adapter.buildSystemPrompt({
			payload: {
				user: "U1",
				channel: "C1",
				text: "<@cyrus> assign this work",
				ts: "1700000000.000100",
				event_ts: "1700000000.000100",
				type: "app_mention",
			},
		} as any);

		expect(systemPrompt).toContain(repositoryRoutingContext);
		expect(systemPrompt).toContain("mcp__linear__get_user");
		expect(systemPrompt).toContain('query: "me"');
		expect(systemPrompt).toContain("linear_get_agent_sessions");
	});
});

describe("ChatRepositoryProvider runtime updates", () => {
	const slackEvent = {
		payload: {
			user: "U1",
			channel: "C1",
			text: "<@cyrus> test",
			ts: "1700000000.000100",
			event_ts: "1700000000.000100",
			type: "app_mention",
		},
	} as any;

	it("SlackChatAdapter.buildSystemPrompt reflects repos added at runtime", () => {
		const paths = ["/repo/A"];
		const provider: ChatRepositoryProvider = {
			getRepositoryPaths: () => paths,
			getDefaultRepository: () => undefined,
			getDefaultLinearWorkspaceId: () => undefined,
		};
		const adapter = new SlackChatAdapter(provider);

		// Initial state: only repo A
		let prompt = adapter.buildSystemPrompt(slackEvent);
		expect(prompt).toContain("- /repo/A");
		expect(prompt).not.toContain("- /repo/B");

		// Simulate runtime config change: add repo B
		paths.push("/repo/B");

		prompt = adapter.buildSystemPrompt(slackEvent);
		expect(prompt).toContain("- /repo/A");
		expect(prompt).toContain("- /repo/B");
	});

	it("SlackChatAdapter.buildSystemPrompt reflects repos removed at runtime", () => {
		const paths = ["/repo/A", "/repo/B"];
		const provider: ChatRepositoryProvider = {
			getRepositoryPaths: () => paths,
			getDefaultRepository: () => undefined,
			getDefaultLinearWorkspaceId: () => undefined,
		};
		const adapter = new SlackChatAdapter(provider);

		// Initial state: both repos
		let prompt = adapter.buildSystemPrompt(slackEvent);
		expect(prompt).toContain("- /repo/A");
		expect(prompt).toContain("- /repo/B");

		// Simulate runtime config change: remove repo A
		paths.splice(0, 1);

		prompt = adapter.buildSystemPrompt(slackEvent);
		expect(prompt).not.toContain("- /repo/A");
		expect(prompt).toContain("- /repo/B");
	});

	it("ChatSessionHandler reads live repository paths from provider at session build time", async () => {
		const cyrusHome = TEST_CYRUS_CHAT;
		const paths = ["/repo/A"];
		const provider: ChatRepositoryProvider = {
			getRepositoryPaths: () => [...paths],
			getDefaultRepository: () => undefined,
			getDefaultLinearWorkspaceId: () => undefined,
		};

		let capturedConfig: any;
		const createRunner = vi.fn((config: any) => {
			capturedConfig = config;
			return {
				supportsStreamingInput: false,
				start: vi.fn().mockResolvedValue({ sessionId: "session-1" }),
				stop: vi.fn(),
				isRunning: vi.fn().mockReturnValue(false),
				isStreaming: vi.fn().mockReturnValue(false),
				addStreamMessage: vi.fn(),
				getMessages: vi.fn().mockReturnValue([]),
			} as any;
		});

		const adapter = new TestChatAdapter("runtime-thread");
		const handler = new ChatSessionHandler(adapter, {
			cyrusHome,
			chatRepositoryProvider: provider,
			runnerConfigBuilder: createMockRunnerConfigBuilder(),
			createRunner,
			onWebhookStart: vi.fn(),
			onWebhookEnd: vi.fn(),
			onStateChange: vi.fn().mockResolvedValue(undefined),
			onClaudeError: vi.fn(),
		});

		// Add repo B at "runtime" before creating a session
		paths.push("/repo/B");

		await handler.handleEvent({
			eventId: "runtime-event",
			threadKey: "runtime-thread",
		} as any);

		expect(capturedConfig.allowedDirectories).toContain("/repo/A");
		expect(capturedConfig.allowedDirectories).toContain("/repo/B");
	});

	it("ChatSessionHandler excludes removed repos from allowedDirectories", async () => {
		const cyrusHome = TEST_CYRUS_CHAT;
		const paths = ["/repo/A", "/repo/B"];
		const provider: ChatRepositoryProvider = {
			getRepositoryPaths: () => [...paths],
			getDefaultRepository: () => undefined,
			getDefaultLinearWorkspaceId: () => undefined,
		};

		let capturedConfig: any;
		const createRunner = vi.fn((config: any) => {
			capturedConfig = config;
			return {
				supportsStreamingInput: false,
				start: vi.fn().mockResolvedValue({ sessionId: "session-1" }),
				stop: vi.fn(),
				isRunning: vi.fn().mockReturnValue(false),
				isStreaming: vi.fn().mockReturnValue(false),
				addStreamMessage: vi.fn(),
				getMessages: vi.fn().mockReturnValue([]),
			} as any;
		});

		const adapter = new TestChatAdapter("remove-thread");
		const handler = new ChatSessionHandler(adapter, {
			cyrusHome,
			chatRepositoryProvider: provider,
			runnerConfigBuilder: createMockRunnerConfigBuilder(),
			createRunner,
			onWebhookStart: vi.fn(),
			onWebhookEnd: vi.fn(),
			onStateChange: vi.fn().mockResolvedValue(undefined),
			onClaudeError: vi.fn(),
		});

		// Remove repo A at "runtime" before creating a session
		paths.splice(0, 1);

		await handler.handleEvent({
			eventId: "remove-event",
			threadKey: "remove-thread",
		} as any);

		expect(capturedConfig.allowedDirectories).not.toContain("/repo/A");
		expect(capturedConfig.allowedDirectories).toContain("/repo/B");
	});
});

describe("LiveChatRepositoryProvider", () => {
	function makeRepo(id: string, path: string): RepositoryConfig {
		return {
			id,
			name: id,
			repositoryPath: path,
			baseBranch: "main",
			workspaceBaseDir: "/tmp",
		} as RepositoryConfig;
	}

	it("returns current repository paths from the live map", () => {
		const repos = new Map<string, RepositoryConfig>();
		repos.set("r1", makeRepo("r1", "/repo/alpha"));

		const provider = new LiveChatRepositoryProvider(repos, () => ({ ws1: {} }));

		expect(provider.getRepositoryPaths()).toEqual(["/repo/alpha"]);

		// Add a repo at "runtime"
		repos.set("r2", makeRepo("r2", "/repo/beta"));
		expect(provider.getRepositoryPaths()).toEqual([
			"/repo/alpha",
			"/repo/beta",
		]);

		// Remove a repo at "runtime"
		repos.delete("r1");
		expect(provider.getRepositoryPaths()).toEqual(["/repo/beta"]);
	});

	it("returns the first repo as default", () => {
		const repos = new Map<string, RepositoryConfig>();
		const repo1 = makeRepo("r1", "/repo/alpha");
		repos.set("r1", repo1);

		const provider = new LiveChatRepositoryProvider(repos, () => ({}));
		expect(provider.getDefaultRepository()).toBe(repo1);
	});

	it("returns undefined when no repos are configured", () => {
		const repos = new Map<string, RepositoryConfig>();
		const provider = new LiveChatRepositoryProvider(repos, () => ({}));
		expect(provider.getDefaultRepository()).toBeUndefined();
		expect(provider.getRepositoryPaths()).toEqual([]);
	});

	it("returns first linear workspace ID from live config", () => {
		const repos = new Map<string, RepositoryConfig>();
		const workspaces = { ws1: {}, ws2: {} };
		const provider = new LiveChatRepositoryProvider(repos, () => workspaces);

		expect(provider.getDefaultLinearWorkspaceId()).toBe("ws1");
	});
});
