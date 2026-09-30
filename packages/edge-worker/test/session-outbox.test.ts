import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexEventMapper, CodexRunner } from "cyrus-codex-runner";
import { AgentSessionStatus } from "cyrus-core";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { DurableCyrusSessionSink } from "../src/sinks/DurableCyrusSessionSink.js";
import { SessionActivityJournal } from "../src/sinks/SessionActivityJournal.js";
import { HttpSessionDeliveryTransport } from "../src/sinks/SessionDeliveryTransport.js";
import {
	parseSessionDeliveryEnvelope,
	type SessionDeliveryEnvelope,
	sessionDeliveryDigest,
} from "../src/sinks/session-delivery.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
	vi.unstubAllGlobals();
});
const parent = {
	id: "parent",
	scopeRef: "customer-a:parent",
	role: "coordinator" as const,
};
const child = {
	id: "child",
	parentSessionId: "parent",
	scopeRef: "customer-a:child",
	role: "investigator" as const,
};
const authority = {
	contractVersion: 1 as const,
	instanceId: "instance",
	automationId: "automation",
	revision: 1,
	occurrenceId: "occurrence",
	attemptId: "attempt-1",
	fence: 1,
};

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "cyrus-session-journal-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const journals: SessionActivityJournal[] = [];
	cleanup.push(() => {
		for (const journal of journals) journal.close();
	});
	const journal = (workspace = "workspace", namespace = "customer-a") => {
		const result = new SessionActivityJournal(root, workspace, namespace);
		journals.push(result);
		return result;
	};
	const server = Fastify({ forceCloseConnections: true });
	cleanup.push(() => server.close());
	const state = {
		revoked: false,
		loseAck: false,
		wrongAck: false,
		attempt: "attempt-1",
		deliveries: [] as SessionDeliveryEnvelope[],
		receipts: new Map<string, string>(),
	};
	server.post("/api/agent-sessions/v1/deliver", async (request, reply) => {
		if (
			request.headers.authorization !== "Bearer fixture-supervisor" ||
			request.headers["x-cyrus-team-id"] !== "workspace"
		)
			return reply.code(401).send({ error: "denied" });
		const envelope = parseSessionDeliveryEnvelope(request.body);
		state.deliveries.push(envelope);
		if (
			state.revoked ||
			envelope.attemptId !== state.attempt ||
			(envelope.item.kind === "session" &&
				envelope.item.payload.id !== "parent" &&
				envelope.item.payload.role === "coordinator")
		)
			return reply.code(403).send({ error: "denied" });
		const key = `${envelope.item.sessionId}:${envelope.item.sequence}`;
		const digest = sessionDeliveryDigest(envelope.item);
		if (state.receipts.has(key) && state.receipts.get(key) !== digest)
			return reply.code(409).send({ error: "conflict" });
		state.receipts.set(key, digest);
		if (state.loseAck) {
			state.loseAck = false;
			return reply.code(503).send({ error: "lost acknowledgement" });
		}
		return {
			contractVersion: 1,
			sessionId: envelope.item.sessionId,
			sequence: envelope.item.sequence,
			digest: state.wrongAck ? "0".repeat(64) : digest,
		};
	});
	const origin = await server.listen({ port: 0, host: "127.0.0.1" });
	const realFetch = globalThis.fetch;
	vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
		expect(url).toBe(
			"https://cyrus-preview-cyhost-1321.vercel.app/api/agent-sessions/v1/deliver",
		);
		expect(init.redirect).toBe("error");
		return realFetch(`${origin}/api/agent-sessions/v1/deliver`, init);
	});
	const transport = new HttpSessionDeliveryTransport(
		"https://cyrus-preview-cyhost-1321.vercel.app/",
		() => ({ workspaceId: "workspace", apiKey: "fixture-supervisor" }),
	);
	const sink = (
		storage: SessionActivityJournal,
		attempt = () => state.attempt,
	) =>
		new DurableCyrusSessionSink(
			storage,
			transport,
			async () => ({ ...authority, attemptId: attempt() }),
			() => ["fixture-supervisor", "opaque-provider-secret"],
		);
	return { root, state, journal, sink };
}

describe("durable session sink (actual HTTP transport, controlled receiver)", () => {
	it("refuses registration workspace changes before transmitting a pending item", async () => {
		const credentials = { workspaceId: "workspace-a", apiKey: "fixture-key" };
		const transport = new HttpSessionDeliveryTransport(
			"https://cyrus-preview-cyhost-1321.vercel.app",
			() => credentials,
		);
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		credentials.workspaceId = "workspace-b";
		await expect(
			transport.deliver(
				{
					...authority,
					item: {
						sessionId: "parent",
						sequence: 1,
						kind: "session",
						payload: parent,
					},
				},
				AbortSignal.timeout(1000),
			),
		).rejects.toThrow("not paired");
		expect(fetcher).not.toHaveBeenCalled();
	});
	it.each([
		false,
		true,
	])("routes Codex-normalized child tools, response and lifecycle through the durable sink: ticket=%s", async (ticket) => {
		const f = await fixture();
		const journal = f.journal();
		const sink = f.sink(journal);
		const returned = vi.fn().mockResolvedValue(undefined);
		const manager = new AgentSessionManager(undefined, returned);
		const workspace = { path: f.root, isGitWorktree: false };
		await manager.createOwnedSession(parent, workspace, sink);
		await manager.createOwnedSession(
			{
				...child,
				...(ticket && {
					issueContext: {
						trackerId: "linear",
						issueId: "issue-1",
						issueIdentifier: "TEST-1",
					},
					externalSessionId: "external-linear-session",
				}),
			},
			workspace,
			sink,
		);
		manager.addAgentRunner(
			"child",
			new CodexRunner({ workingDirectory: f.root }),
		);
		const mapper = new CodexEventMapper({
			workingDirectory: f.root,
			model: "gpt-5.5",
			getSessionId: () => "native-codex",
			getStagedSkillNames: () => [],
			emitMessage() {},
			onThreadStarted() {},
		});
		mapper.reset();
		mapper.handle({ kind: "thread-started", threadId: "native-codex" });
		mapper.handle({
			kind: "item-started",
			item: {
				type: "command_execution",
				id: "tool-1",
				command: "cat fixture.txt",
				aggregated_output: "",
				status: "in_progress",
			},
		});
		mapper.handle({
			kind: "item-completed",
			item: {
				type: "command_execution",
				id: "tool-1",
				command: "cat fixture.txt",
				aggregated_output: "synthetic findings",
				exit_code: 0,
				status: "completed",
			},
		});
		mapper.handle({
			kind: "item-completed",
			item: { type: "reasoning", id: "hidden", text: "not-public-reasoning" },
		});
		mapper.handle({
			kind: "item-completed",
			item: {
				type: "agent_message",
				id: "response-1",
				text: "Synthetic findings returned to parent.",
			},
		});
		mapper.handle({
			kind: "turn-completed",
			usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
		});
		for (const message of mapper.finalize({ wasStopped: false }))
			await manager.handleClaudeMessage("child", message);
		const items = f.state.deliveries
			.filter((d) => d.item.sessionId === "child")
			.map((d) => d.item);
		expect(items.map((i) => i.sequence)).toEqual(
			items.map((_, index) => index + 1),
		);
		expect(
			items.filter(
				(i) => i.kind === "activity" && i.payload.content.type === "action",
			),
		).toHaveLength(2);
		expect(items.at(-2)).toMatchObject({
			kind: "activity",
			payload: {
				content: {
					type: "response",
					body: "Synthetic findings returned to parent.",
				},
			},
		});
		expect(items.at(-1)).toMatchObject({
			kind: "lifecycle",
			payload: {
				status: "complete",
				harness: { type: "codex", sessionId: "native-codex" },
			},
		});
		expect(JSON.stringify(items)).not.toContain("not-public-reasoning");
		expect(returned).not.toHaveBeenCalled();
		expect(journal.peek()).toBeUndefined();
		expect(manager.serializeState()).toEqual({ sessions: {}, entries: {} });
		expect(manager.serializeState(sink.id).entries.child).toEqual([]);
	});
	it("replays a lost ACK after reopening SQLite with a new attempt and identical redacted bytes", async () => {
		const f = await fixture();
		const journal = f.journal();
		const sink = f.sink(journal);
		await sink.createCyrusSession(parent);
		await sink.createCyrusSession(child);
		f.state.loseAck = true;
		await sink.postActivity("child", {
			type: "action",
			action: "Read",
			parameter: "fixture.ts",
			result: "opaque-provider-secret",
		});
		const pending = journal.peek()!;
		expect(pending).toMatchObject({
			sequence: 2,
			payload: { content: { result: "[redacted credential material]" } },
		});
		f.state.attempt = "attempt-2";
		const reopened = f.journal();
		await f.sink(reopened).flush();
		expect(reopened.peek()).toBeUndefined();
		const attempts = f.state.deliveries.filter(
			(d) => d.item.sessionId === "child" && d.item.sequence === 2,
		);
		expect(attempts.map((a) => a.attemptId)).toEqual([
			"attempt-1",
			"attempt-2",
		]);
		expect(attempts[0]?.item).toEqual(attempts[1]?.item);
		expect(f.state.receipts.size).toBe(3);
		for (const name of await readdir(f.root)) {
			expect((await stat(join(f.root, name))).mode & 0o777).toBe(0o600);
			const bytes = (await readFile(join(f.root, name))).toString("utf8");
			for (const secret of ["opaque-provider-secret", "fixture-supervisor"])
				expect(bytes).not.toContain(secret);
		}
	});

	it("rejects stale/revoked delivery and revalidates creation on reconnect", async () => {
		const f = await fixture();
		const journal = f.journal();
		const sink = f.sink(journal);
		await sink.createCyrusSession(parent);
		f.state.revoked = true;
		await sink.postActivity("parent", {
			type: "response",
			body: "retained output",
		});
		expect(journal.peek()?.sequence).toBe(2);
		await expect(
			f.sink(f.journal()).createCyrusSession(parent),
		).rejects.toThrow("not acknowledged");
		f.state.revoked = false;
		f.state.attempt = "takeover";
		await expect(f.sink(journal, () => "attempt-1").flush()).rejects.toThrow(
			"not acknowledged",
		);
		expect(journal.peek()?.sequence).toBe(2);
		await f.sink(journal).flush();
		expect(journal.peek()).toBeUndefined();
	});

	it("keeps unknown customer/workspace sessions isolated and denies changed identity/escalation", async () => {
		const f = await fixture();
		const journal = f.journal();
		const sink = f.sink(journal);
		await sink.createCyrusSession(parent);
		for (const other of [
			f.journal("workspace", "customer-b"),
			f.journal("other-workspace", "customer-a"),
		]) {
			expect(other.id).not.toBe(journal.id);
			expect(other.isCreated("parent")).toBe(false);
			expect(() =>
				other.append("parent", {
					kind: "activity",
					payload: { content: { type: "response", body: "forged" } },
				}),
			).toThrow("no admitted creation");
		}
		await expect(
			sink.createCyrusSession({ ...parent, scopeRef: "customer-b" }),
		).rejects.toThrow("identity cannot change");
		await expect(
			sink.createCyrusSession({ ...child, role: "coordinator" }),
		).rejects.toThrow("not acknowledged");
		expect(journal.isCreated("child")).toBe(false);
		// A denied child cannot block another separately admitted session.
		await sink.createCyrusSession({ ...child, id: "another-child" });
		expect(journal.isCreated("another-child")).toBe(true);
		expect(journal.peek()?.sessionId).toBe("child");
	});

	it("refuses a wrong ACK and keeps concurrent producer sequences contiguous", async () => {
		const f = await fixture();
		const one = f.journal();
		const two = f.journal();
		const sink = f.sink(one);
		await sink.createCyrusSession(parent);
		const first = one.append("parent", {
			kind: "activity",
			payload: {
				content: { type: "thought", body: "one" },
				options: { ephemeral: true },
			},
		});
		const second = two.append("parent", {
			kind: "activity",
			payload: { content: { type: "response", body: "two" } },
		});
		expect([first.sequence, second.sequence]).toEqual([2, 3]);
		expect(() =>
			one.acknowledge(second, {
				contractVersion: 1,
				sessionId: "parent",
				sequence: 3,
				digest: sessionDeliveryDigest(second),
			}),
		).toThrow("Out-of-order");
		f.state.wrongAck = true;
		await expect(sink.flush()).rejects.toThrow("not acknowledged");
		expect(one.peek()).toEqual(first);
		f.state.wrongAck = false;
		await sink.flush();
		expect(two.peek()).toBeUndefined();
	});

	it.each([
		"Bearer fixture-token",
		"cmcp_fixture-token",
		"cysk_fixture-token",
		"sk-ant-fixture",
		"xoxb-fixture",
		"-----BEGIN PRIVATE KEY----- secret",
		"ANTHROPIC_API_KEY=fixture",
	])("redacts recognizable material before storage: %#", async (secret) => {
		const f = await fixture();
		const journal = f.journal();
		const sink = f.sink(journal);
		await sink.createCyrusSession(parent);
		f.state.revoked = true;
		await sink.postActivity("parent", { type: "response", body: secret });
		expect(journal.peek()).toMatchObject({
			payload: { content: { body: "[redacted credential material]" } },
		});
	});
});

it.each([
	false,
	true,
])("admits a child in a separate private journal only after current remote parent-link ACK: ticket=%s", async (ticket) => {
	const f = await fixture();
	const parentJournal = f.journal("workspace", "parent-scope");
	await f.sink(parentJournal).createCyrusSession(parent);
	const childJournal = f.journal("workspace", "child-scope");
	const descriptor = {
		...child,
		...(ticket && {
			issueContext: {
				trackerId: "linear",
				issueId: "issue-1",
				issueIdentifier: "TEST-1",
			},
		}),
	};
	const sink = f.sink(childJournal);
	f.state.loseAck = true;
	await expect(sink.createCyrusSession(descriptor)).rejects.toThrow();
	expect(childJournal.isCreated(child.id)).toBe(false);
	expect(childJournal.peek()).toBeUndefined();
	await sink.createCyrusSession(descriptor);
	expect(childJournal.isCreated(child.id)).toBe(true);
	expect(childJournal.isCreated(parent.id)).toBe(false);
	expect(parentJournal.isCreated(child.id)).toBe(false);
	await sink.postActivity(child.id, {
		type: "response",
		body: "Returned scoped findings",
	});
	expect(f.state.receipts.size).toBe(3);
	const reopened = f.journal("workspace", "child-scope");
	f.state.revoked = true;
	await expect(
		f.sink(reopened).createCyrusSession(descriptor),
	).rejects.toThrow();
	expect(reopened.isCreated(parent.id)).toBe(false);
	f.state.revoked = false;
	await f.sink(reopened).createCyrusSession(descriptor);
	await expect(
		f
			.sink(reopened)
			.createCyrusSession({ ...descriptor, parentSessionId: "foreign-parent" }),
	).rejects.toThrow("identity cannot change");
	expect(f.state.receipts.size).toBe(3);
});

it("settles aborted background delivery before journal close and retains ordered receipts for current-authority recovery", async () => {
	const f = await fixture();
	const journal = f.journal();
	const controller = new AbortController();
	let entered!: () => void;
	const delivering = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const calls: number[] = [];
	const sink = new DurableCyrusSessionSink(
		journal,
		{
			deliver: async ({ item }, signal) => {
				calls.push(item.sequence);
				if (item.sequence > 1) {
					entered();
					await new Promise<void>((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), {
							once: true,
						});
					});
				}
				return {
					contractVersion: 1,
					sessionId: item.sessionId,
					sequence: item.sequence,
					digest: sessionDeliveryDigest(item),
				};
			},
		},
		async () => authority,
		() => [],
		controller.signal,
	);
	await sink.createCyrusSession(parent);
	await sink.postActivity(parent.id, {
		type: "action",
		action: "get_issue",
		parameter: "bound issue",
	});
	await delivering;
	await sink.postActivity(parent.id, {
		type: "response",
		body: "Scoped findings",
	});
	controller.abort();
	await sink.settled();
	expect(calls).toEqual([1, 2]);
	expect(journal.peek()?.sequence).toBe(2);
	// Reopen the same durable scope as recovery would; no old credentials persist.
	const reopened = f.journal();
	const recovered: number[] = [];
	let revoked = true;
	const recovery = new DurableCyrusSessionSink(
		reopened,
		{
			deliver: async ({ item }) => {
				recovered.push(item.sequence);
				return {
					contractVersion: 1,
					sessionId: item.sessionId,
					sequence: item.sequence,
					digest: sessionDeliveryDigest(item),
				};
			},
		},
		async () => {
			if (revoked) throw new Error("Current authority denied");
			return { ...authority, attemptId: "attempt-2", fence: 2 };
		},
		() => [],
	);
	await expect(recovery.flush()).rejects.toThrow("durable items retained");
	expect(recovered).toEqual([]);
	expect(reopened.peek()?.sequence).toBe(2);
	revoked = false;
	await recovery.flush();
	expect(recovered).toEqual([2, 3]);
	expect(reopened.peek()).toBeUndefined();
});

it("terminal flush retries a failed in-flight background ACK using the same immutable receipt", async () => {
	const f = await fixture();
	const journal = f.journal();
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const sent: SessionDeliveryEnvelope["item"][] = [];
	let lost = false;
	let authorized = 0;
	const sink = new DurableCyrusSessionSink(
		journal,
		{
			deliver: async ({ item }) => {
				sent.push(item);
				if (item.sequence === 2 && !lost) {
					lost = true;
					entered();
					await gate;
					throw new Error("Receiver committed; ACK lost");
				}
				return {
					contractVersion: 1,
					sessionId: item.sessionId,
					sequence: item.sequence,
					digest: sessionDeliveryDigest(item),
				};
			},
		},
		async () => {
			authorized++;
			return authority;
		},
		() => [],
		new AbortController().signal,
	);
	await sink.createCyrusSession(parent);
	await sink.postActivity(parent.id, {
		type: "response",
		body: "Scoped findings",
	});
	await started;
	await sink.updateCyrusSession(parent.id, {
		status: AgentSessionStatus.Complete,
	});
	const flushed = sink.flush();
	release();
	await flushed;
	expect(sent.map((item) => item.sequence)).toEqual([1, 2, 2, 3]);
	expect(sent[1]).toEqual(sent[2]);
	expect(authorized).toBe(4);
	expect(journal.peek()).toBeUndefined();
});
