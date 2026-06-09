import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { AgentSessionLifecycleService } from "../src/AgentSessionLifecycleService.js";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import type { ChatRepositoryProvider } from "../src/ChatRepositoryProvider.js";
import { GenericAgentSessionAdapter } from "../src/GenericAgentSessionAdapter.js";
import { GenericAgentSessionTransport } from "../src/GenericAgentSessionTransport.js";
import {
	GENERIC_AGENT_SESSION_ROUTE,
	type GenericAgentSessionWebhook,
} from "../src/GenericAgentSessionTypes.js";
import type { RunnerConfigBuilder } from "../src/RunnerConfigBuilder.js";
import { TEST_CYRUS_CHAT } from "./test-dirs.js";

function createStaticProvider(paths: string[] = []): ChatRepositoryProvider {
	return {
		getRepositoryPaths: () => paths,
		getDefaultRepository: () => undefined,
		getDefaultLinearWorkspaceId: () => undefined,
	};
}

function createMockRunnerConfigBuilder(): RunnerConfigBuilder {
	return {
		buildChatConfig: (input: any) => ({
			workingDirectory: input.workspacePath,
			allowedTools: ["Read"],
			disallowedTools: [],
			allowedDirectories: [input.workspacePath],
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
		}),
		buildIssueConfig: vi.fn(),
	} as unknown as RunnerConfigBuilder;
}

function genericEvent(
	overrides: Partial<GenericAgentSessionWebhook> = {},
): GenericAgentSessionWebhook {
	return {
		version: 1,
		event: {
			id: "evt-1",
			type: "agent_session.created",
			createdAt: "2026-06-09T19:05:00.000Z",
		},
		session: {
			id: "session-1",
			title: "Generic session",
		},
		surface: {
			type: "cyrus-hosted",
			id: "surface-1",
			threadId: "thread-1",
			url: "https://app.atcyrus.com/sessions/session-1",
		},
		actor: {
			id: "user-1",
			name: "Payton",
		},
		message: {
			id: "msg-1",
			body: "Inspect repository configuration",
			createdAt: "2026-06-09T19:05:00.000Z",
		},
		...overrides,
	};
}

describe("GenericAgentSessionTransport", () => {
	it("authenticates, validates, emits, and deduplicates generic webhooks", async () => {
		const app = Fastify({ logger: false });
		const transport = new GenericAgentSessionTransport({
			fastifyServer: app,
			secret: "secret",
		});
		const events: GenericAgentSessionWebhook[] = [];
		transport.on("event", (event) => events.push(event));
		transport.register();

		const payload = genericEvent();
		const first = await app.inject({
			method: "POST",
			url: GENERIC_AGENT_SESSION_ROUTE,
			headers: { Authorization: "Bearer secret" },
			payload,
		});
		const duplicate = await app.inject({
			method: "POST",
			url: GENERIC_AGENT_SESSION_ROUTE,
			headers: { Authorization: "Bearer secret" },
			payload,
		});

		expect(first.statusCode).toBe(200);
		expect(duplicate.statusCode).toBe(200);
		expect(duplicate.json()).toMatchObject({ duplicate: true });
		expect(events).toHaveLength(1);
		expect(events[0]?.session.id).toBe("session-1");

		await app.close();
	});

	it("rejects missing auth and invalid prompted payloads", async () => {
		const app = Fastify({ logger: false });
		const transport = new GenericAgentSessionTransport({
			fastifyServer: app,
			secret: "secret",
		});
		transport.register();

		const missingAuth = await app.inject({
			method: "POST",
			url: GENERIC_AGENT_SESSION_ROUTE,
			payload: genericEvent(),
		});
		const invalidPayload = await app.inject({
			method: "POST",
			url: GENERIC_AGENT_SESSION_ROUTE,
			headers: { Authorization: "Bearer secret" },
			payload: genericEvent({
				event: { id: "evt-2", type: "agent_session.prompted" },
				message: undefined,
			}),
		});

		expect(missingAuth.statusCode).toBe(401);
		expect(invalidPayload.statusCode).toBe(400);
		expect(invalidPayload.json().issues).toContainEqual(
			expect.objectContaining({ path: "message.body" }),
		);

		await app.close();
	});
});

describe("GenericAgentSessionAdapter lifecycle integration", () => {
	it("uses stable session ids so prompted webhooks resume persisted generic sessions", async () => {
		const sessionManager = new AgentSessionManager();
		const createRunner = vi.fn((config: any) => ({
			supportsStreamingInput: false,
			start: vi.fn().mockResolvedValue({ sessionId: "runner-session" }),
			stop: vi.fn(),
			isRunning: vi.fn().mockReturnValue(false),
			isStreaming: vi.fn().mockReturnValue(false),
			addStreamMessage: vi.fn(),
			getMessages: vi.fn().mockReturnValue([]),
			config,
		}));
		const provider = createStaticProvider(["/repo/one"]);
		const makeLifecycle = () =>
			new AgentSessionLifecycleService(
				new GenericAgentSessionAdapter(provider),
				{
					cyrusHome: TEST_CYRUS_CHAT,
					sessionManager,
					repositoryProvider: provider,
					runnerConfigBuilder: createMockRunnerConfigBuilder(),
					createRunner,
					onWebhookStart: vi.fn(),
					onWebhookEnd: vi.fn(),
					onStateChange: vi.fn().mockResolvedValue(undefined),
					onClaudeError: vi.fn(),
				},
			);

		const createdLifecycle = makeLifecycle();
		await createdLifecycle.handleEvent(genericEvent());

		const stableSessionId = "generic-cyrus-hosted-session-1";
		const session = sessionManager.getSession(stableSessionId);
		expect(session).toBeDefined();
		session!.claudeSessionId = "claude-session-1";

		const promptedLifecycle = makeLifecycle();
		await promptedLifecycle.handleEvent(
			genericEvent({
				event: { id: "evt-2", type: "agent_session.prompted" },
				message: { id: "msg-2", body: "Follow up" },
			}),
		);

		expect(createRunner).toHaveBeenCalledTimes(2);
		expect(createRunner.mock.calls[1]?.[0]).toMatchObject({
			resumeSessionId: "claude-session-1",
		});
		expect(promptedLifecycle.listThreads()).toEqual([
			{ threadKey: "thread-1", sessionId: stableSessionId },
		]);
	});
});
