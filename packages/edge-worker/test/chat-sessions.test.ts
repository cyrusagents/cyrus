import { join } from "node:path";
import { getReadOnlyTools } from "cyrus-claude-runner";
import type { RepositoryConfig } from "cyrus-core";
import {
	SlackMessageService,
	SlackReactionService,
} from "cyrus-slack-event-transport";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatRepositoryProvider } from "../src/ChatRepositoryProvider.js";
import { LiveChatRepositoryProvider } from "../src/ChatRepositoryProvider.js";
import type { ChatPlatformAdapter } from "../src/ChatSessionHandler.js";
import { ChatSessionHandler } from "../src/ChatSessionHandler.js";
import type { RunnerConfigBuilder } from "../src/RunnerConfigBuilder.js";
import {
	BEHAVIOURS_PAGE_ROUTE,
	PROCESSED_REACTION,
	RECEIPT_REACTION,
	SLACK_NO_RESPONSE_SENTINEL,
	SlackChatAdapter,
} from "../src/SlackChatAdapter.js";
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
		expect(capturedConfig.allowedTools).toContain("Bash(git -C * pull)");
		expect(capturedConfig.allowedTools).not.toContain("Edit(**)");

		const expectedWorkspace = join(cyrusHome, "slack-workspaces", "thread-key");
		expect(capturedConfig.allowedDirectories).toContain(expectedWorkspace);
		for (const path of chatRepositoryPaths) {
			expect(capturedConfig.allowedDirectories).toContain(path);
		}
	});
});

describe("ChatSessionHandler session-initiation gate", () => {
	function buildHandler(adapter: ChatPlatformAdapter<TestEvent>) {
		const createRunner = vi.fn(
			() =>
				({
					supportsStreamingInput: false,
					start: vi.fn().mockResolvedValue({ sessionId: "session-1" }),
					stop: vi.fn(),
					isRunning: vi.fn().mockReturnValue(false),
					isStreaming: vi.fn().mockReturnValue(false),
					addStreamMessage: vi.fn(),
					getMessages: vi.fn().mockReturnValue([]),
				}) as any,
		);
		const handler = new ChatSessionHandler(adapter, {
			cyrusHome: TEST_CYRUS_CHAT,
			chatRepositoryProvider: createStaticProvider([]),
			runnerConfigBuilder: createMockRunnerConfigBuilder(),
			createRunner,
			onWebhookStart: vi.fn(),
			onWebhookEnd: vi.fn(),
			onStateChange: vi.fn().mockResolvedValue(undefined),
			onClaudeError: vi.fn(),
		});
		return { handler, createRunner };
	}

	it("ignores a non-initiating event when no session exists for the thread", async () => {
		const adapter: ChatPlatformAdapter<TestEvent> = new TestChatAdapter(
			"unbound-thread",
		);
		// Mark this event as a follow-up that must not start a session.
		adapter.isSessionInitiatingEvent = () => false;

		const { handler, createRunner } = buildHandler(adapter);
		await handler.handleEvent({
			eventId: "follow-up",
			threadKey: "unbound-thread",
		} as any);

		expect(createRunner).not.toHaveBeenCalled();
		expect(handler.listThreads()).toHaveLength(0);
	});

	it("starts a session for an initiating event", async () => {
		const adapter: ChatPlatformAdapter<TestEvent> = new TestChatAdapter(
			"bound-thread",
		);
		adapter.isSessionInitiatingEvent = () => true;

		const { handler, createRunner } = buildHandler(adapter);
		await handler.handleEvent({
			eventId: "mention",
			threadKey: "bound-thread",
		} as any);

		expect(createRunner).toHaveBeenCalledTimes(1);
		expect(handler.listThreads()).toHaveLength(1);
	});
});

describe("ChatSessionHandler processed acknowledgement", () => {
	it("calls acknowledgeProcessed when the runner emits a result", async () => {
		const adapter: ChatPlatformAdapter<TestEvent> = new TestChatAdapter(
			"ack-thread",
		);
		const acknowledgeProcessed = vi.fn().mockResolvedValue(undefined);
		adapter.acknowledgeProcessed = acknowledgeProcessed;

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
		const handler = new ChatSessionHandler(adapter, {
			cyrusHome: TEST_CYRUS_CHAT,
			chatRepositoryProvider: createStaticProvider([]),
			runnerConfigBuilder: createMockRunnerConfigBuilder(),
			createRunner,
			onWebhookStart: vi.fn(),
			onWebhookEnd: vi.fn(),
			onStateChange: vi.fn().mockResolvedValue(undefined),
			onClaudeError: vi.fn(),
		});

		const event = { eventId: "mention", threadKey: "ack-thread" };
		await handler.handleEvent(event as any);
		expect(capturedConfig?.onMessage).toBeDefined();

		await capturedConfig.onMessage({
			type: "result",
			subtype: "success",
			is_error: false,
			result: "done",
			session_id: "session-1",
		});
		// acknowledgeProcessed is fire-and-forget — let the microtask settle
		await new Promise((resolve) => setImmediate(resolve));

		expect(acknowledgeProcessed).toHaveBeenCalledTimes(1);
		expect(acknowledgeProcessed).toHaveBeenCalledWith(event);
	});

	it("acknowledges every queued message even when the agent merges them into fewer turns", async () => {
		const adapter: ChatPlatformAdapter<TestEvent> = new TestChatAdapter(
			"burst-thread",
		);
		const acknowledgeProcessed = vi.fn().mockResolvedValue(undefined);
		adapter.acknowledgeProcessed = acknowledgeProcessed;
		const postReply = vi
			.spyOn(adapter, "postReply")
			.mockResolvedValue(undefined);

		let capturedConfig: any;
		const createRunner = vi.fn((config: any) => {
			capturedConfig = config;
			return {
				supportsStreamingInput: false,
				start: vi.fn().mockResolvedValue({ sessionId: "session-1" }),
				stop: vi.fn(),
				// Running and streaming, so quick-succession follow-ups are
				// injected into the live session via addStreamMessage.
				isRunning: vi.fn().mockReturnValue(true),
				isStreaming: vi.fn().mockReturnValue(true),
				addStreamMessage: vi.fn(),
				getMessages: vi.fn().mockReturnValue([]),
			} as any;
		});
		const handler = new ChatSessionHandler(adapter, {
			cyrusHome: TEST_CYRUS_CHAT,
			chatRepositoryProvider: createStaticProvider([]),
			runnerConfigBuilder: createMockRunnerConfigBuilder(),
			createRunner,
			onWebhookStart: vi.fn(),
			onWebhookEnd: vi.fn(),
			onStateChange: vi.fn().mockResolvedValue(undefined),
			onClaudeError: vi.fn(),
		});

		// Three messages in quick succession: "Hi", "How are you?", "weather?"
		const eventA = { eventId: "msg-a", threadKey: "burst-thread" };
		const eventB = { eventId: "msg-b", threadKey: "burst-thread" };
		const eventC = { eventId: "msg-c", threadKey: "burst-thread" };
		await handler.handleEvent(eventA as any);
		await handler.handleEvent(eventB as any);
		await handler.handleEvent(eventC as any);

		const result = {
			type: "result",
			subtype: "success",
			is_error: false,
			result: "done",
			session_id: "session-1",
		};
		// The agent merges the queued prompts: 3 messages, only 2 results.
		await capturedConfig.onMessage(result);
		await capturedConfig.onMessage(result);
		await new Promise((resolve) => setImmediate(resolve));

		// Every message gets its reaction swapped — none left with stale 👀.
		expect(acknowledgeProcessed).toHaveBeenCalledTimes(3);
		expect(acknowledgeProcessed).toHaveBeenCalledWith(eventA);
		expect(acknowledgeProcessed).toHaveBeenCalledWith(eventB);
		expect(acknowledgeProcessed).toHaveBeenCalledWith(eventC);

		// Both turn replies are posted: the first against the first queued
		// event, the second via the remembered last event (queue already drained).
		expect(postReply).toHaveBeenCalledTimes(2);
		expect(postReply.mock.calls[0]?.[0]).toBe(eventA);
		expect(postReply.mock.calls[1]?.[0]).toBe(eventC);
	});
});

describe("SlackChatAdapter session initiation", () => {
	it("treats app_mention as session-initiating", () => {
		const adapter = new SlackChatAdapter(createStaticProvider([]));
		expect(
			adapter.isSessionInitiatingEvent({ eventType: "app_mention" } as any),
		).toBe(true);
	});

	it("ignores a non-upstream-gated message (direct mode, unbound thread)", () => {
		const adapter = new SlackChatAdapter(createStaticProvider([]));
		expect(
			adapter.isSessionInitiatingEvent({
				eventType: "message",
				upstreamGated: false,
			} as any),
		).toBe(false);
	});

	it("treats an upstream-gated message as session-initiating (proxy mode survives restart)", () => {
		const adapter = new SlackChatAdapter(createStaticProvider([]));
		expect(
			adapter.isSessionInitiatingEvent({
				eventType: "message",
				upstreamGated: true,
			} as any),
		).toBe(true);
	});
});

describe("SlackChatAdapter responding policy", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.SLACK_BOT_TOKEN;
	});

	const slackEvent = (text: string) =>
		({
			eventType: "message",
			eventId: "Ev1",
			teamId: "T1",
			slackBotToken: "xoxb-test",
			payload: {
				type: "message",
				user: "U1",
				channel: "C1",
				text,
				ts: "1700000000.000200",
				thread_ts: "1700000000.000100",
				event_ts: "1700000000.000200",
			},
		}) as any;

	const runnerWithReply = (text: string) =>
		({
			getMessages: () => [
				{ type: "assistant", message: { content: [{ type: "text", text }] } },
			],
		}) as any;

	it("documents the when-to-respond policy and the silence sentinel in the system prompt", () => {
		const adapter = new SlackChatAdapter(createStaticProvider([]));
		const prompt = adapter.buildSystemPrompt(slackEvent("anything"));
		expect(prompt).toContain("## When to Respond");
		expect(prompt).toContain("Someone addresses you directly");
		expect(prompt).toContain(SLACK_NO_RESPONSE_SENTINEL);
	});

	it("does NOT post to Slack when the agent emits the no-response sentinel", async () => {
		const adapter = new SlackChatAdapter(createStaticProvider([]));
		const postSpy = vi
			.spyOn(SlackMessageService.prototype, "postMessage")
			.mockResolvedValue({} as any);

		await adapter.postReply(
			slackEvent("thanks team!"),
			runnerWithReply(`  ${SLACK_NO_RESPONSE_SENTINEL}\n`),
		);

		expect(postSpy).not.toHaveBeenCalled();
	});

	it("does NOT post leaked deliberation surrounding the no-response sentinel", async () => {
		const adapter = new SlackChatAdapter(createStaticProvider([]));
		const postSpy = vi
			.spyOn(SlackMessageService.prototype, "postMessage")
			.mockResolvedValue({} as any);

		await adapter.postReply(
			slackEvent("how are you?"),
			runnerWithReply(
				`The user didn't address me by name, so I should stay quiet.\n${SLACK_NO_RESPONSE_SENTINEL}`,
			),
		);

		expect(postSpy).not.toHaveBeenCalled();
	});

	it("posts to Slack when the agent produces a real reply", async () => {
		const adapter = new SlackChatAdapter(createStaticProvider([]));
		const postSpy = vi
			.spyOn(SlackMessageService.prototype, "postMessage")
			.mockResolvedValue({} as any);

		await adapter.postReply(
			slackEvent("Cyrus, what does this function do?"),
			runnerWithReply("It memoizes the result."),
		);

		expect(postSpy).toHaveBeenCalledTimes(1);
		expect(postSpy.mock.calls[0]?.[0]).toMatchObject({
			channel: "C1",
			text: "It memoizes the result.",
			thread_ts: "1700000000.000100",
		});
	});

	it("swaps the receipt reaction for the processed one after the turn completes", async () => {
		const adapter = new SlackChatAdapter(createStaticProvider([]));
		const addSpy = vi
			.spyOn(SlackReactionService.prototype, "addReaction")
			.mockResolvedValue(undefined);
		const removeSpy = vi
			.spyOn(SlackReactionService.prototype, "removeReaction")
			.mockResolvedValue(undefined);

		await adapter.acknowledgeProcessed(slackEvent("thanks team!"));

		expect(removeSpy).toHaveBeenCalledTimes(1);
		expect(removeSpy.mock.calls[0]?.[0]).toMatchObject({
			channel: "C1",
			timestamp: "1700000000.000200",
			name: RECEIPT_REACTION,
		});
		expect(addSpy).toHaveBeenCalledTimes(1);
		expect(addSpy.mock.calls[0]?.[0]).toMatchObject({
			channel: "C1",
			timestamp: "1700000000.000200",
			name: PROCESSED_REACTION,
		});
		// Remove must precede add so both reactions are never visible together
		expect(removeSpy.mock.invocationCallOrder[0]).toBeLessThan(
			addSpy.mock.invocationCallOrder[0] ?? 0,
		);
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

	const appMentionEvent = {
		payload: {
			user: "U1",
			channel: "C1",
			text: "<@cyrus> hello",
			ts: "1700000000.000100",
			event_ts: "1700000000.000100",
			type: "app_mention",
		},
	} as any;

	it("includes stop-listening guidance with the Behaviours page link when a Cyrus app base URL is configured", () => {
		const adapter = new SlackChatAdapter(createStaticProvider([]), undefined, {
			cyrusAppBaseUrl: "https://app.atcyrus.com/",
		});
		const systemPrompt = adapter.buildSystemPrompt(appMentionEvent);

		expect(systemPrompt).toContain("## Stopping Automatic Listening");
		expect(systemPrompt).toContain(
			`<https://app.atcyrus.com${BEHAVIOURS_PAGE_ROUTE}|Behaviours page>`,
		);
		expect(systemPrompt).toContain("until someone asks you a direct question");
	});

	it("omits stop-listening guidance when no Cyrus app base URL is configured (community)", () => {
		const adapter = new SlackChatAdapter(createStaticProvider([]));
		const systemPrompt = adapter.buildSystemPrompt(appMentionEvent);

		expect(systemPrompt).not.toContain("## Stopping Automatic Listening");
		expect(systemPrompt).not.toContain(BEHAVIOURS_PAGE_ROUTE);
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
