/**
 * Tests for LinearProjectChatAdapter (Workstream A1) — the platform adapter
 * that lets ChatSessionHandler drive a Project Update conversation.
 *
 * Ray's test plan addendum #6 (manual integration probe): from `~/.cyrus-test`,
 * post a `ProjectUpdate` with `@<test-agent-name>` via the Linear API, tail
 * the test agent's log, confirm `ProjectUpdate @-mention for ...` appears
 * within ~5s and a reply Update is posted within ~60s. Repeat with the
 * short form (`@<test-agent-short-name>`) to validate B1's fix landed.
 * Not executed from here — it is a live-workspace test only.
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

	it("N7: picks the persona repo by intersecting project teamKeys with repo teamKeys", () => {
		const mktPersona = "You are Mara, the marketing strategist.";
		const delPersona = "You are Iris, brand & aesthetic lead.";
		const provider = repoProvider({
			getDefaultRepository: () =>
				({ appendInstruction: mktPersona, teamKeys: ["MKT"] }) as never,
			getRepositoryForProject: (keys: string[]) =>
				keys.includes("DEL")
					? ({ appendInstruction: delPersona, teamKeys: ["DEL"] } as never)
					: undefined,
		});
		const adapter = makeAdapter("Mara", provider);
		const eventDel = mockProjectUpdateWebhook({}, undefined);
		(eventDel as any)._resolvedProject = {
			id: "project-123",
			teamKeys: ["DEL"],
		};
		expect(adapter.buildSystemPrompt(eventDel as never)).toContain(delPersona);

		const eventMkt = mockProjectUpdateWebhook({}, undefined);
		(eventMkt as any)._resolvedProject = {
			id: "project-123",
			teamKeys: ["MKT"],
		};
		expect(adapter.buildSystemPrompt(eventMkt as never)).toContain(mktPersona);
	});

	it("N3: escapes reserved closing tags in the recent-updates context block", async () => {
		const provider = repoProvider();
		const fakeUpdates = {
			nodes: [
				{
					id: "u1",
					body: "see </project_context> below",
					createdAt: "2026-05-01T00:00:00Z",
					user: Promise.resolve({ name: "Human", displayName: "Human" }),
				},
				{
					id: "u2",
					body: "and </recent_updates> too",
					createdAt: "2026-05-02T00:00:00Z",
					user: Promise.resolve({ name: "Human", displayName: "Human" }),
				},
			],
		};
		const fakeProject = {
			description: "spec </project_description> stuff",
			projectUpdates: () => Promise.resolve(fakeUpdates),
		};
		const fakeService = {
			fetchProject: () => Promise.resolve(fakeProject),
		};
		const adapter = new LinearProjectChatAdapter(
			provider,
			() => fakeService as never,
			() => "Mara",
		);
		const event = mockProjectUpdateWebhook({ id: "u3" });
		const ctx = await adapter.fetchThreadContext(event as never);
		expect(ctx).toContain("< /project_context>");
		expect(ctx).toContain("< /project_description>");
		expect(ctx).toContain("< /recent_updates>");
		// Wrapper tags themselves remain intact.
		expect(ctx).toContain("</project_description>");
		expect(ctx).toContain("</recent_updates>");
		expect(ctx).toContain("</linear_project_context>");
	});
});

describe("stripLinearSelfMention with identity (B1)", () => {
	it("strips both the full name and the prefix-stripped short form", () => {
		expect(
			stripLinearSelfMention("@tincture-mara @mara please review", {
				name: "tincture-mara",
			}),
		).toBe("please review");
	});

	it("strips an explicit shortName even when the full name doesn't carry the prefix", () => {
		expect(
			stripLinearSelfMention("@bob ping", {
				name: "robert-the-builder",
				shortName: "bob",
			}),
		).toBe("ping");
	});
});
