import { join } from "node:path";
import { getReadOnlyTools } from "atmiko-claude-runner";
import type { RepositoryConfig } from "atmiko-core";
import {
	type SlackMessageAttachment,
	SlackMessageService,
	SlackReactionService,
	type SlackWebhookEvent,
} from "atmiko-slack-event-transport";
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
import { TEST_ATMIKO_CHAT } from "./test-dirs.js";

function createMockRunnerConfigBuilder(): RunnerConfigBuilder {
	let defaultRunner: "claude" | "opencode" = "claude";
	return {
		buildChatConfig: (input: any) => {
			const repositoryPaths = Array.from(
				new Set((input.repositoryPaths ?? []).filter(Boolean)),
			);
			return {
				runnerType: input.runnerType ?? defaultRunner,
				workingDirectory: input.workspacePath,
				allowedTools: [
					...new Set([...getReadOnlyTools(), "Bash(git -C * pull)"]),
				],
				disallowedTools: [],
				allowedDirectories: [input.workspacePath, ...repositoryPaths],
				workspaceName: input.workspaceName,
				atmikoHome: input.atmikoHome,
				appendSystemPrompt: input.systemPrompt,
				...(input.resumeSessionId
					? { resumeSessionId: input.resumeSessionId }
					: {}),
				...(input.plugins ? { plugins: input.plugins } : {}),
				...(input.skills !== undefined ? { skills: input.skills } : {}),
				logger: input.logger,
				maxTurns: 200,
				onMessage: input.onMessage,
				onError: input.onError,
			};
		},
		setDefaultRunner: (runnerType: "claude" | "opencode") => {
			defaultRunner = runnerType;
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
	/** Thread position, used by adapters that support catch-up */
	ts?: string;
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
		const atmikoHome = TEST_ATMIKO_CHAT;
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
			atmikoHome,
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

		const expectedWorkspace = join(
			atmikoHome,
			"slack-workspaces",
			"thread-key",
		);
		expect(capturedConfig.allowedDirectories).toContain(expectedWorkspace);
		for (const path of chatRepositoryPaths) {
			expect(capturedConfig.allowedDirectories).toContain(path);
		}
	});

	it("passes scoped managed skills to chat runner configs", async () => {
		const event: TestEvent = {
			eventId: "test-event",
			threadKey: "test-thread",
		};
		const atmikoHome = TEST_ATMIKO_CHAT;
		const repository = {
			id: "repo-a",
			name: "Repo A",
			repositoryPath: "/repo/chat-one",
			allowedTools: [],
		} as unknown as RepositoryConfig;
		const chatRepositoryPaths = ["/repo/chat-one"];
		const plugins = [{ type: "local" as const, path: "/atmiko/user-skills" }];
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
		const resolveSkillsConfig = vi.fn().mockResolvedValue({
			plugins,
			skills: ["agent-browser", "test-user-skills"],
		});

		const handler = new ChatSessionHandler(adapter, {
			atmikoHome,
			chatRepositoryProvider: createStaticProvider(
				chatRepositoryPaths,
				repository,
				"workspace-1",
			),
			runnerConfigBuilder: createMockRunnerConfigBuilder(),
			createRunner,
			resolveSkillsConfig,
			onWebhookStart: vi.fn(),
			onWebhookEnd: vi.fn(),
			onStateChange: vi.fn().mockResolvedValue(undefined),
			onClaudeError: vi.fn(),
		});

		await handler.handleEvent(event as any);

		expect(resolveSkillsConfig).toHaveBeenCalledWith({
			repository,
			repositoryPaths: chatRepositoryPaths,
		});
		expect(capturedConfig.plugins).toEqual(plugins);
		expect(capturedConfig.skills).toEqual([
			"agent-browser",
			"test-user-skills",
		]);
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
			atmikoHome: TEST_ATMIKO_CHAT,
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
			atmikoHome: TEST_ATMIKO_CHAT,
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
			atmikoHome: TEST_ATMIKO_CHAT,
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

describe("ChatSessionHandler busy follow-up queueing", () => {
	it("queues a follow-up that can't be streamed and delivers it after the turn", async () => {
		const adapter: ChatPlatformAdapter<TestEvent> = new TestChatAdapter(
			"busy-thread",
		);
		const notifyBusy = vi
			.spyOn(adapter, "notifyBusy")
			.mockResolvedValue(undefined);
		vi.spyOn(adapter, "postReply").mockResolvedValue(undefined);

		let running = false;
		let capturedConfig: any;
		const createRunner = vi.fn((config: any) => {
			capturedConfig = config;
			running = true; // a freshly created runner is running
			return {
				supportsStreamingInput: false,
				start: vi.fn().mockResolvedValue({ sessionId: "session-1" }),
				startStreaming: vi.fn().mockResolvedValue({ sessionId: "session-1" }),
				stop: vi.fn(),
				// Running, but NOT streamable (exec-style backend) — follow-ups
				// can't be injected mid-turn.
				isRunning: vi.fn(() => running),
				isStreaming: vi.fn().mockReturnValue(false),
				addStreamMessage: vi.fn(),
				getMessages: vi.fn().mockReturnValue([]),
			} as any;
		});
		const handler = new ChatSessionHandler(adapter, {
			atmikoHome: TEST_ATMIKO_CHAT,
			chatRepositoryProvider: createStaticProvider([]),
			runnerConfigBuilder: createMockRunnerConfigBuilder(),
			createRunner,
			onWebhookStart: vi.fn(),
			onWebhookEnd: vi.fn(),
			onStateChange: vi.fn().mockResolvedValue(undefined),
			onClaudeError: vi.fn(),
		});

		// First message starts the session (running).
		await handler.handleEvent({
			eventId: "msg-a",
			threadKey: "busy-thread",
		} as any);
		expect(createRunner).toHaveBeenCalledTimes(1);

		// Second message arrives mid-turn → queued (not dropped) + user notified.
		await handler.handleEvent({
			eventId: "msg-b",
			threadKey: "busy-thread",
		} as any);
		expect(notifyBusy).toHaveBeenCalledTimes(1);
		expect(createRunner).toHaveBeenCalledTimes(1); // not yet delivered

		// Turn completes → the queued follow-up is re-dispatched as a new turn.
		running = false;
		await capturedConfig.onMessage({
			type: "result",
			subtype: "success",
			is_error: false,
			result: "done",
			session_id: "session-1",
		});
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(createRunner).toHaveBeenCalledTimes(2);
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

describe("SlackChatAdapter task instructions", () => {
	const mentionEvent = (
		text: string,
		attachments?: SlackMessageAttachment[],
	): SlackWebhookEvent => ({
		eventType: "app_mention",
		eventId: "Ev1",
		teamId: "T1",
		payload: {
			type: "app_mention",
			user: "U1",
			channel: "C1",
			text,
			ts: "1700000000.000200",
			event_ts: "1700000000.000200",
			attachments,
		},
	});

	it("folds a forwarded attachment body in alongside the comment", () => {
		const adapter = new SlackChatAdapter(createStaticProvider([]));
		expect(
			adapter.extractTaskInstructions(
				mentionEvent("<@U0BOT> please look", [
					{
						is_share: true,
						author_name: "Sentry",
						text: "[frontend] Error: page resources not found",
					},
				]),
			),
		).toBe(
			"please look\n\n" +
				"[Attachment from Sentry]\n" +
				"[frontend] Error: page resources not found",
		);
	});

	it("uses the forwarded attachment as the whole prompt when there is no comment", () => {
		const adapter = new SlackChatAdapter(createStaticProvider([]));
		expect(
			adapter.extractTaskInstructions(
				mentionEvent("<@U0BOT>", [
					{ is_share: true, author_name: "Sentry", text: "alert body" },
				]),
			),
		).toBe("[Attachment from Sentry]\nalert body");
	});

	it("falls back to the placeholder when neither comment nor attachment has content", () => {
		const adapter = new SlackChatAdapter(createStaticProvider([]));
		expect(adapter.extractTaskInstructions(mentionEvent("<@U0BOT>"))).toBe(
			"Ask the user for more context",
		);
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
			slackEvent("Atmiko, what does this function do?"),
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
				text: "<@atmiko> inspect code",
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
				text: "<@atmiko> assign this work",
				ts: "1700000000.000100",
				event_ts: "1700000000.000100",
				type: "app_mention",
			},
		} as any);

		expect(systemPrompt).toContain(repositoryRoutingContext);
		expect(systemPrompt).toContain("mcp__linear__get_user");
		expect(systemPrompt).toContain('query: "me"');
		expect(systemPrompt).toContain("linear_get_agent_sessions");
		expect(systemPrompt).toContain("[agent=opencode]");
	});

	const appMentionEvent = {
		payload: {
			user: "U1",
			channel: "C1",
			text: "<@atmiko> hello",
			ts: "1700000000.000100",
			event_ts: "1700000000.000100",
			type: "app_mention",
		},
	} as any;

	it("includes stop-listening guidance with the Behaviours page link when a Atmiko app base URL is configured", () => {
		const adapter = new SlackChatAdapter(createStaticProvider([]), undefined, {
			atmikoAppBaseUrl: "https://control-plane.example.com/",
		});
		const systemPrompt = adapter.buildSystemPrompt(appMentionEvent);

		expect(systemPrompt).toContain("## Stopping Automatic Listening");
		expect(systemPrompt).toContain(
			`<https://control-plane.example.com${BEHAVIOURS_PAGE_ROUTE}|Behaviours page>`,
		);
		expect(systemPrompt).toContain("until someone asks you a direct question");
	});

	it("omits stop-listening guidance when no Atmiko app base URL is configured (community)", () => {
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
			text: "<@atmiko> test",
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
		const atmikoHome = TEST_ATMIKO_CHAT;
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
			atmikoHome,
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
		const atmikoHome = TEST_ATMIKO_CHAT;
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
			atmikoHome,
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

describe("ChatSessionHandler session resume", () => {
	it("resumes with the stored OpenCode session id even if the default runner changes", async () => {
		const atmikoHome = TEST_ATMIKO_CHAT;
		const builder = createMockRunnerConfigBuilder() as RunnerConfigBuilder & {
			setDefaultRunner: (runnerType: "claude" | "opencode") => void;
		};
		builder.setDefaultRunner("opencode");

		const runnerStates = [false, false];
		const capturedConfigs: any[] = [];
		const createRunner = vi.fn((config: any) => {
			capturedConfigs.push(config);
			return {
				supportsStreamingInput: false,
				start: vi.fn().mockResolvedValue({
					sessionId:
						config.runnerType === "opencode"
							? "opencode-chat-session"
							: "claude-chat-session",
				}),
				stop: vi.fn(),
				isRunning: vi.fn(() => runnerStates.shift() ?? false),
				isStreaming: vi.fn().mockReturnValue(false),
				addStreamMessage: vi.fn(),
				getMessages: vi.fn().mockReturnValue([]),
			} as any;
		});

		const adapter = new TestChatAdapter("resume-thread");
		const handler = new ChatSessionHandler(adapter, {
			atmikoHome,
			chatRepositoryProvider: createStaticProvider([]),
			runnerConfigBuilder: builder,
			createRunner,
			onWebhookStart: vi.fn(),
			onWebhookEnd: vi.fn(),
			onStateChange: vi.fn().mockResolvedValue(undefined),
			onClaudeError: vi.fn(),
		});

		await handler.handleEvent({
			eventId: "initial-event",
			threadKey: "resume-thread",
		} as any);
		const sessionId = handler.listThreads()[0]!.sessionId;
		(handler as any).sessionManager.getSession(sessionId).opencodeSessionId =
			"opencode-chat-session";

		builder.setDefaultRunner("claude");
		await handler.handleEvent({
			eventId: "followup-event",
			threadKey: "resume-thread",
		} as any);

		expect(capturedConfigs[1].runnerType).toBe("opencode");
		expect(capturedConfigs[1].resumeSessionId).toBe("opencode-chat-session");
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

describe("SlackChatAdapter thread catch-up", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.SLACK_BOT_TOKEN;
	});

	const TRIGGER_TS = "1700000000.000500";
	const PARENT_TS = "1700000000.000100";

	const mentionEvent = (thread = true): SlackWebhookEvent =>
		({
			eventType: "app_mention",
			eventId: "Ev2",
			teamId: "T1",
			slackBotToken: "xoxb-test",
			payload: {
				type: "app_mention",
				user: "U1",
				channel: "C1",
				text: "<@U0BOT> where were we?",
				ts: TRIGGER_TS,
				...(thread ? { thread_ts: PARENT_TS } : {}),
				event_ts: TRIGGER_TS,
			},
		}) as SlackWebhookEvent;

	const mockIdentity = () =>
		vi
			.spyOn(SlackMessageService.prototype, "getIdentity")
			.mockResolvedValue({ bot_id: "B0BOT" } as any);

	it("returns nothing for a message outside a thread", async () => {
		const adapter = new SlackChatAdapter(createStaticProvider([]));
		await expect(
			adapter.fetchThreadContext(mentionEvent(false), "1"),
		).resolves.toBe("");
	});

	it("falls back to the full thread window when no cursor is known", async () => {
		const adapter = new SlackChatAdapter(createStaticProvider([]));
		mockIdentity();
		const fetchSpy = vi
			.spyOn(SlackMessageService.prototype, "fetchThreadMessages")
			.mockResolvedValue([
				{ user: "U1", text: "original ask", ts: PARENT_TS },
			] as any);

		const result = await adapter.fetchThreadContext(mentionEvent());

		// Delegates to the full-window fetch — no `oldest`, no catch-up preamble.
		expect(fetchSpy.mock.calls[0]?.[0]).not.toHaveProperty("oldest");
		expect(result).toBe(
			`<slack_thread_context>
  <message>
    <author>U1</author>
    <timestamp>${PARENT_TS}</timestamp>
    <content>
original ask
    </content>
  </message>
</slack_thread_context>`,
		);
	});

	it("asks Slack for messages after the cursor and drops the ones already known", async () => {
		const adapter = new SlackChatAdapter(createStaticProvider([]));
		mockIdentity();
		const fetchSpy = vi
			.spyOn(SlackMessageService.prototype, "fetchThreadMessages")
			.mockResolvedValue([
				// Slack returns the thread parent regardless of `oldest`
				{ user: "U1", text: "original ask", ts: PARENT_TS },
				// our own earlier reply — already in the session's memory
				{ text: "on it", ts: "1700000000.000300", bot_id: "B0BOT" },
				// the inter-tag discussion we actually want
				{
					user: "U2",
					text: "we decided to use redis",
					ts: "1700000000.000400",
				},
				// the triggering message — already in the task instructions
				{ user: "U1", text: "<@U0BOT> where were we?", ts: TRIGGER_TS },
			] as any);

		const result = await adapter.fetchThreadContext(
			mentionEvent(),
			"1700000000.000200",
		);

		expect(fetchSpy).toHaveBeenCalledWith({
			token: "xoxb-test",
			channel: "C1",
			thread_ts: PARENT_TS,
			limit: 2000,
			oldest: "1700000000.000200",
		});
		expect(result).toContain("since you last had context");
		expect(result).toContain("we decided to use redis");
		expect(result).not.toContain("original ask");
		expect(result).not.toContain("on it");
		expect(result).not.toContain("where were we?");
	});

	it("returns an empty string when nothing new was said", async () => {
		const adapter = new SlackChatAdapter(createStaticProvider([]));
		mockIdentity();
		vi.spyOn(
			SlackMessageService.prototype,
			"fetchThreadMessages",
		).mockResolvedValue([
			{ user: "U1", text: "original ask", ts: PARENT_TS },
			{ user: "U1", text: "<@U0BOT> where were we?", ts: TRIGGER_TS },
		] as any);

		await expect(
			adapter.fetchThreadContext(mentionEvent(), "1700000000.000200"),
		).resolves.toBe("");
	});

	it("drops a message sitting exactly on the cursor", async () => {
		const adapter = new SlackChatAdapter(createStaticProvider([]));
		mockIdentity();
		vi.spyOn(
			SlackMessageService.prototype,
			"fetchThreadMessages",
		).mockResolvedValue([
			// Slack can echo the cursor message back when `inclusive` is honoured
			{ user: "U2", text: "already seen", ts: "1700000000.000200" },
			{ user: "U2", text: "genuinely new", ts: "1700000000.000400" },
		] as any);

		const result = await adapter.fetchThreadContext(
			mentionEvent(),
			"1700000000.000200",
		);

		expect(result).toContain("genuinely new");
		expect(result).not.toContain("already seen");
	});

	it("returns null when there is no bot token", async () => {
		const adapter = new SlackChatAdapter(createStaticProvider([]));
		const event = mentionEvent();
		delete (event as any).slackBotToken;

		await expect(
			adapter.fetchThreadContext(event, "1700000000.000200"),
		).resolves.toBeNull();
	});

	it("keeps only the newest messages of an over-long gap", async () => {
		const adapter = new SlackChatAdapter(createStaticProvider([]));
		mockIdentity();
		// 60 new messages, more than a single context read carries
		vi.spyOn(
			SlackMessageService.prototype,
			"fetchThreadMessages",
		).mockResolvedValue(
			Array.from({ length: 60 }, (_, i) => ({
				user: "U2",
				text: `msg ${i}`,
				ts: `1700000000.00${String(1000 + i)}`,
			})) as any,
		);

		const result = await adapter.fetchThreadContext(
			mentionEvent(),
			"1700000000.000200",
		);

		// Trimmed to the last 50, so the stalest go and the freshest stay
		expect(result).not.toContain("msg 9\n");
		expect(result).toContain("msg 10");
		expect(result).toContain("msg 59");
	});

	it("returns null whether the read fails with a cursor or without one", async () => {
		const adapter = new SlackChatAdapter(createStaticProvider([]));
		mockIdentity();
		vi.spyOn(
			SlackMessageService.prototype,
			"fetchThreadMessages",
		).mockRejectedValue(new Error("ratelimited"));

		await expect(
			adapter.fetchThreadContext(mentionEvent()),
		).resolves.toBeNull();
		await expect(
			adapter.fetchThreadContext(mentionEvent(), "1700000000.000200"),
		).resolves.toBeNull();
	});
});

describe("ChatSessionHandler thread catch-up", () => {
	/** Adapter that supports catch-up, with a scripted queue of delta results */
	class CatchupAdapter extends TestChatAdapter {
		public sinceArgs: Array<string | undefined> = [];

		constructor(
			threadKey: string,
			private readonly deltas: Array<string | null>,
		) {
			super(threadKey);
		}

		getThreadContextTs(event: TestEvent): string | undefined {
			return event.ts;
		}

		async fetchThreadContext(
			_event: TestEvent,
			sinceTs?: string,
		): Promise<string | null> {
			this.sinceArgs.push(sinceTs);
			// Not `?? ""` — a scripted null means a fetch failure
			return this.deltas.length > 0
				? (this.deltas.shift() as string | null)
				: "";
		}
	}

	/**
	 * Handler whose runner is idle between events, so follow-ups resume it.
	 * With `streaming`, the runner stays live and follow-ups inject mid-turn.
	 */
	function buildHandler(
		adapter: ChatPlatformAdapter<TestEvent>,
		{ streaming = false } = {},
	) {
		const prompts: string[] = [];
		let running = false;
		let capturedConfig: any;

		const capture = async (prompt: string) => {
			prompts.push(prompt);
			return { sessionId: "session-1" };
		};

		const createRunner = vi.fn((config: any) => {
			capturedConfig = config;
			running = streaming;
			return {
				supportsStreamingInput: streaming,
				start: vi.fn(capture),
				startStreaming: vi.fn(capture),
				stop: vi.fn(),
				isRunning: vi.fn(() => running),
				isStreaming: vi.fn(() => streaming),
				addStreamMessage: vi.fn((prompt: string) => prompts.push(prompt)),
				getMessages: vi.fn().mockReturnValue([]),
			} as any;
		});

		const handler = new ChatSessionHandler(adapter, {
			atmikoHome: TEST_ATMIKO_CHAT,
			chatRepositoryProvider: createStaticProvider([]),
			runnerConfigBuilder: createMockRunnerConfigBuilder(),
			createRunner,
			onWebhookStart: vi.fn(),
			onWebhookEnd: vi.fn(),
			onStateChange: vi.fn().mockResolvedValue(undefined),
			onClaudeError: vi.fn(),
		});

		/** Give the session a runner session id so follow-ups resume it */
		const bindResumableSession = async () => {
			await capturedConfig.onMessage({
				type: "system",
				subtype: "init",
				session_id: "session-1",
				model: "claude-test",
				tools: [],
				permissionMode: "default",
				apiKeySource: "test",
			});
			await new Promise((resolve) => setImmediate(resolve));
		};

		return {
			handler,
			prompts,
			createRunner,
			bindResumableSession,
			setRunning: (value: boolean) => {
				running = value;
			},
		};
	}

	const TASK = "Inspect repository configuration";

	it("prefixes the resumed prompt with what was said between mentions", async () => {
		const adapter = new CatchupAdapter("catchup-thread", ["", "<catch-up/>"]);
		const { handler, prompts, bindResumableSession } = buildHandler(adapter);

		await handler.handleEvent({
			eventId: "mention-1",
			threadKey: "catchup-thread",
			ts: "100",
		} as any);
		await bindResumableSession();

		await handler.handleEvent({
			eventId: "mention-2",
			threadKey: "catchup-thread",
			ts: "200",
		} as any);

		// New session reads the full window; the second back-reads from there
		expect(adapter.sinceArgs).toEqual([undefined, "100"]);
		expect(prompts[1]).toBe(`<catch-up/>\n\n${TASK}`);
	});

	it("advances the cursor on a successful fetch even when nothing was said", async () => {
		const adapter = new CatchupAdapter("empty-thread", ["", "", "<catch-up/>"]);
		const { handler, prompts, bindResumableSession } = buildHandler(adapter);

		await handler.handleEvent({
			eventId: "m1",
			threadKey: "empty-thread",
			ts: "100",
		} as any);
		await bindResumableSession();
		await handler.handleEvent({
			eventId: "m2",
			threadKey: "empty-thread",
			ts: "200",
		} as any);
		await bindResumableSession();
		await handler.handleEvent({
			eventId: "m3",
			threadKey: "empty-thread",
			ts: "300",
		} as any);

		expect(adapter.sinceArgs).toEqual([undefined, "100", "200"]);
		// An empty catch-up leaves the prompt untouched.
		expect(prompts[1]).toBe(TASK);
	});

	it("holds the cursor when the catch-up fetch fails, retrying the window later", async () => {
		const adapter = new CatchupAdapter("failed-thread", [
			"",
			null,
			"<catch-up/>",
		]);
		const { handler, prompts, bindResumableSession } = buildHandler(adapter);

		await handler.handleEvent({
			eventId: "m1",
			threadKey: "failed-thread",
			ts: "100",
		} as any);
		await bindResumableSession();
		await handler.handleEvent({
			eventId: "m2",
			threadKey: "failed-thread",
			ts: "200",
		} as any);
		await bindResumableSession();
		await handler.handleEvent({
			eventId: "m3",
			threadKey: "failed-thread",
			ts: "300",
		} as any);

		// The failed window is retried rather than skipped.
		expect(adapter.sinceArgs).toEqual([undefined, "100", "100"]);
		expect(prompts[1]).toBe(TASK);
		expect(prompts[2]).toBe(`<catch-up/>\n\n${TASK}`);
	});

	it("holds the cursor when the initial full-window read fails", async () => {
		const adapter = new CatchupAdapter("cold-thread", [null, "<catch-up/>"]);
		const { handler, prompts, bindResumableSession } = buildHandler(adapter);

		await handler.handleEvent({
			eventId: "m1",
			threadKey: "cold-thread",
			ts: "100",
		} as any);
		await bindResumableSession();
		await handler.handleEvent({
			eventId: "m2",
			threadKey: "cold-thread",
			ts: "200",
		} as any);

		// No cursor was set, so the next mention re-reads the whole thread
		expect(adapter.sinceArgs).toEqual([undefined, undefined]);
		expect(prompts[1]).toBe(`<catch-up/>\n\n${TASK}`);
	});

	it("still delivers the message when the catch-up read throws", async () => {
		class ThrowingAdapter extends TestChatAdapter {
			getThreadContextTs(event: TestEvent): string | undefined {
				return event.ts;
			}

			async fetchThreadContext(
				_event: TestEvent,
				sinceTs?: string,
			): Promise<string | null> {
				if (sinceTs === undefined) {
					return "";
				}
				throw new Error("adapter blew up");
			}
		}

		const adapter = new ThrowingAdapter("throwing-thread");
		const { handler, prompts, bindResumableSession } = buildHandler(adapter);

		await handler.handleEvent({
			eventId: "m1",
			threadKey: "throwing-thread",
			ts: "100",
		} as any);
		await bindResumableSession();
		await handler.handleEvent({
			eventId: "m2",
			threadKey: "throwing-thread",
			ts: "200",
		} as any);

		// A throwing context read degrades to the bare task rather than losing it
		expect(prompts[1]).toBe(TASK);
	});

	it("never lets a concurrent mention move the cursor backwards", async () => {
		const releases: Array<() => void> = [];

		class GatedAdapter extends TestChatAdapter {
			public sinceArgs: Array<string | undefined> = [];

			getThreadContextTs(event: TestEvent): string | undefined {
				return event.ts;
			}

			async fetchThreadContext(
				_event: TestEvent,
				sinceTs?: string,
			): Promise<string | null> {
				this.sinceArgs.push(sinceTs);
				// Gate only the two mentions raced below, to finish them out of order
				if (this.sinceArgs.length === 2 || this.sinceArgs.length === 3) {
					await new Promise<void>((resolve) => {
						releases.push(resolve);
					});
				}
				return "";
			}
		}

		const adapter = new GatedAdapter("racy-thread");
		const { handler } = buildHandler(adapter, { streaming: true });

		await handler.handleEvent({
			eventId: "m1",
			threadKey: "racy-thread",
			ts: "100",
		} as any);

		// Two mentions in flight at once, both reading the same cursor
		const second = handler.handleEvent({
			eventId: "m2",
			threadKey: "racy-thread",
			ts: "200",
		} as any);
		const third = handler.handleEvent({
			eventId: "m3",
			threadKey: "racy-thread",
			ts: "300",
		} as any);
		// Wait until both are parked on their gated read
		for (let i = 0; i < 100 && releases.length < 2; i++) {
			await new Promise((resolve) => setImmediate(resolve));
		}
		expect(releases).toHaveLength(2);

		// Resolve them out of order: the newer mention lands first
		releases[1]();
		releases[0]();
		await Promise.all([second, third]);

		await handler.handleEvent({
			eventId: "m4",
			threadKey: "racy-thread",
			ts: "400",
		} as any);

		// The straggler must not drag the cursor back to its own ts
		expect(adapter.sinceArgs).toEqual([undefined, "100", "100", "300"]);
	});

	it("catches up when the follow-up is injected mid-turn", async () => {
		const adapter = new CatchupAdapter("live-thread", ["", "<catch-up/>"]);
		const { handler, prompts, createRunner } = buildHandler(adapter, {
			streaming: true,
		});

		await handler.handleEvent({
			eventId: "m1",
			threadKey: "live-thread",
			ts: "100",
		} as any);
		await handler.handleEvent({
			eventId: "m2",
			threadKey: "live-thread",
			ts: "200",
		} as any);

		expect(createRunner).toHaveBeenCalledTimes(1);
		expect(adapter.sinceArgs).toEqual([undefined, "100"]);
		expect(prompts[1]).toBe(`<catch-up/>\n\n${TASK}`);
	});

	it("leaves adapters without catch-up support untouched", async () => {
		const adapter = new TestChatAdapter("plain-thread");
		const { handler, prompts, bindResumableSession } = buildHandler(adapter);

		await handler.handleEvent({
			eventId: "m1",
			threadKey: "plain-thread",
		} as any);
		await bindResumableSession();
		await handler.handleEvent({
			eventId: "m2",
			threadKey: "plain-thread",
		} as any);

		expect(prompts).toEqual([TASK, TASK]);
	});
});
