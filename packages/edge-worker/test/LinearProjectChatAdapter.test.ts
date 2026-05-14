/**
 * Tests for LinearProjectChatAdapter (Workstream A1) — the platform adapter
 * that lets ChatSessionHandler drive a Project Update conversation.
 */

import type { RepositoryConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import type { ChatRepositoryProvider } from "../src/ChatRepositoryProvider.js";
import {
	LinearProjectChatAdapter,
	stripLinearSelfMention,
} from "../src/LinearProjectChatAdapter.js";
import { mockProjectUpdateWebhook } from "./setup.js";

const repoProvider = (
	overrides: Partial<ChatRepositoryProvider> = {},
): ChatRepositoryProvider => ({
	getRepositoryPaths: () => [],
	getDefaultRepository: () => undefined,
	getDefaultLinearWorkspaceId: () => undefined,
	...overrides,
});

const makeAdapter = (
	selfName: string | undefined = "Mara",
	provider: ChatRepositoryProvider = repoProvider(),
) =>
	new LinearProjectChatAdapter(
		provider,
		() => undefined, // no Linear service needed for these pure-method tests
		() => selfName,
	);

describe("stripLinearSelfMention", () => {
	it("removes a bare @mention of the agent", () => {
		expect(
			stripLinearSelfMention("@Mara what about the pricing section?", "Mara"),
		).toBe("what about the pricing section?");
	});

	it("removes a markdown-link mention of the agent", () => {
		expect(
			stripLinearSelfMention(
				"[@Mara](https://linear.app/x) please review",
				"Mara",
			),
		).toBe("please review");
	});

	it("is case-insensitive", () => {
		expect(stripLinearSelfMention("@MARA hello", "Mara")).toBe("hello");
	});

	it("leaves other agents' mentions intact", () => {
		expect(stripLinearSelfMention("@Greta and @Mara sync up", "Mara")).toBe(
			"@Greta and  sync up".trim(),
		);
	});

	it("returns the trimmed body unchanged when selfName is undefined", () => {
		expect(stripLinearSelfMention("  @Mara hi  ", undefined)).toBe("@Mara hi");
	});
});

describe("LinearProjectChatAdapter", () => {
	it("uses the project id as the thread key (project = conversation)", () => {
		const adapter = makeAdapter();
		const event = mockProjectUpdateWebhook({ projectId: "project-abc" });
		expect(adapter.getThreadKey(event as never)).toBe(
			"linear-project:project-abc",
		);
	});

	it("uses the project update id as the event id", () => {
		const adapter = makeAdapter();
		const event = mockProjectUpdateWebhook({ id: "pu-xyz" });
		expect(adapter.getEventId(event as never)).toBe("pu-xyz");
	});

	it("strips the agent's own mention from the task instructions", () => {
		const adapter = makeAdapter("Mara");
		const event = mockProjectUpdateWebhook({
			body: "@Mara what about the pricing section?",
		});
		expect(adapter.extractTaskInstructions(event as never)).toBe(
			"what about the pricing section?",
		);
	});

	it("falls back to a prompt when the body is only a mention", () => {
		const adapter = makeAdapter("Mara");
		const event = mockProjectUpdateWebhook({ body: "@Mara" });
		expect(adapter.extractTaskInstructions(event as never)).toBe(
			"Ask the user what they need.",
		);
	});

	it("builds a system prompt naming the project and including the persona", () => {
		const persona = "You are Mara, the marketing strategist.";
		const provider = repoProvider({
			getDefaultRepository: () =>
				({ appendInstruction: persona }) as RepositoryConfig,
		});
		const adapter = makeAdapter("Mara", provider);
		const event = mockProjectUpdateWebhook({
			project: {
				id: "project-123",
				name: "My Trousseau — Ongoing",
				url: "https://linear.app/x",
			},
		});
		const prompt = adapter.buildSystemPrompt(event as never);
		expect(prompt).toContain("My Trousseau — Ongoing");
		expect(prompt).toContain(persona);
		expect(prompt).toContain("Project Update");
	});

	it("has the linear platform name", () => {
		expect(makeAdapter().platformName).toBe("linear");
	});
});
