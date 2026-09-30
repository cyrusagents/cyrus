import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationRuntime } from "../src/automations/AutomationRuntime.js";
import { AutomationCheckpointStore } from "../src/automations/CheckpointStore.js";
import {
	type AutomationAuthority,
	type AutomationRegistration,
	authorizeTool,
	checkpointKey,
	definitionSchema,
	digest,
	permittedToolNames,
	scopedToolResult,
	scopedToolSchemas,
	toolCallSchema,
} from "../src/automations/contract.js";
import { AutomationLedger } from "../src/automations/Ledger.js";
import { modelReadiness } from "../src/automations/Model.js";
import { registerConfiguredAutomations } from "../src/automations/register.js";
import { latestTick } from "../src/automations/scheduling.js";

const dirs: string[] = [];
const ledgers: AutomationLedger[] = [];
async function directory() {
	const dir = await mkdtemp(join(tmpdir(), "cyrus-automation-test-"));
	dirs.push(dir);
	return dir;
}
function definition(
	overrides: Partial<AutomationRegistration> = {},
): AutomationRegistration {
	return {
		id: "generic-daily-review",
		workspaceId: "workspace-a",
		ownerId: "operator",
		namespace: "general-ops",
		scopeRef: "operations-review",
		revision: 1,
		state: "enabled",
		role: "coordinator",
		instruction: "Review the assigned issue",
		schedule: null,
		target: { harness: "claude", model: "claude-fixture" },
		...overrides,
	};
}
function authority(
	overrides: Partial<AutomationAuthority> = {},
): AutomationAuthority {
	return {
		contractVersion: 1,
		definition: {
			...definition(),
			grants: [
				{
					id: "bound-grant",
					connectionId: "connected-linear",
					accountId: "account-a",
					resource: {
						provider: "linear",
						teamId: "team-a",
						issueId: "issue-a",
					},
					permissions: ["read", "write"],
				},
			],
		},
		occurrenceId: "occurrence-a",
		attemptId: "attempt-a",
		fence: 1,
		leaseUntil: new Date(Date.now() + 90000).toISOString(),
		phase: "execute",
		input: "Instruction",
		...overrides,
	};
}
async function ledger(now: () => number = Date.now) {
	const result = new AutomationLedger(await directory(), "workspace-a", now);
	ledgers.push(result);
	return result;
}
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const db of ledgers.splice(0)) db.close();
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("registered runtime transport", () => {
	it("uses existing pairing and configured model, rejects wrong key and cross-workspace re-pairing", async () => {
		vi.stubEnv("CYRUS_TEAM_ID", "workspace-a");
		vi.stubEnv("CYRUS_API_KEY", "supervisor-fixture");
		vi.stubEnv("CYRUS_APP_URL", "https://hosted.fixture");
		vi.stubEnv("ANTHROPIC_API_KEY", "model-fixture");
		vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
		vi.stubEnv("CYRUS_DEFAULT_RUNNER", "claude");
		vi.stubEnv("CYRUS_CLAUDE_DEFAULT_MODEL", "claude-fixture");
		const app = Fastify();
		registerConfiguredAutomations(app, await directory(), () => ({}));
		try {
			await app.ready();
			expect(
				(await app.inject({ url: "/api/automations/v1/capabilities" }))
					.statusCode,
			).toBe(401);
			const headers = { authorization: "Bearer supervisor-fixture" };
			const capabilities = (
				await app.inject({ url: "/api/automations/v1/capabilities", headers })
			).json();
			expect(capabilities.available).toBe(true);
			expect(capabilities.capabilities.nativeTools).toBe(false);
			expect(capabilities.target).toEqual({
				harness: "claude",
				model: "claude-fixture",
				adapter: "anthropic-messages-contained-v1",
			});
			vi.stubEnv("CYRUS_TEAM_ID", "workspace-b");
			expect(
				(await app.inject({ url: "/api/automations/v1/capabilities", headers }))
					.statusCode,
			).toBe(401);
		} finally {
			await app.close();
		}
	});
	it("does not break legacy HTTP setups or misreport incompatible harness readiness", async () => {
		vi.stubEnv("CYRUS_TEAM_ID", "workspace-a");
		vi.stubEnv("CYRUS_API_KEY", "supervisor-fixture");
		vi.stubEnv("CYRUS_APP_URL", "http://localhost:3000");
		vi.stubEnv("CYRUS_DEFAULT_RUNNER", "codex");
		const app = Fastify();
		registerConfiguredAutomations(app, await directory(), () => ({}));
		try {
			await app.ready();
			const headers = { authorization: "Bearer supervisor-fixture" };
			const result = await app.inject({
				url: "/api/automations/v1/capabilities",
				headers,
			});
			expect(result.statusCode).toBe(200);
			expect(result.json().available).toBe(false);
			expect(result.json().reason).toMatch(/HTTPS/);
		} finally {
			await app.close();
		}
	});
});

describe("generic durable automations", () => {
	it("persists non-customer instructions/revisions/tombstones and deduplicates redelivery", async () => {
		const path = await directory();
		const first = new AutomationLedger(path, "workspace-a");
		first.upsert(definition());
		const occurrence = first.enqueue(definition().id, 1, "event-a", "do work");
		expect(first.enqueue(definition().id, 1, "event-a", "do work")).toEqual(
			occurrence,
		);
		expect(() =>
			first.enqueue(definition().id, 1, "event-a", "changed"),
		).toThrow("payload conflict");
		first.close();
		const restarted = new AutomationLedger(path, "workspace-a");
		ledgers.push(restarted);
		expect(restarted.status(definition().id).occurrences).toHaveLength(1);
		expect(() =>
			restarted.upsert(definition({ instruction: "same revision changed" })),
		).toThrow("revision conflict");
		restarted.upsert(definition({ revision: 2, state: "paused" }));
		expect(restarted.claim(2)).toEqual([]);
		expect(() => restarted.upsert(definition())).toThrow("revision conflict");
		restarted.upsert(definition({ revision: 3, state: "deleted" }));
		expect(() => restarted.upsert(definition({ revision: 4 }))).toThrow(
			"immutable",
		);
	});
	it("coalesces offline ticks, preserves explicit FIFO and never catches up paused time", async () => {
		let now = Date.parse("2026-01-01T12:00:00Z");
		const db = await ledger(() => now);
		const d = definition({
			schedule: {
				intervalSeconds: 60,
				anchorAt: "2026-01-01T00:00:00Z",
				timezone: "UTC",
			},
		});
		db.upsert(d);
		db.enqueue(d.id, 1, "event-1", "first");
		db.enqueue(d.id, 1, "event-2", "second");
		const [one] = db.claim(2);
		expect(one?.occurrence.input).toBe("first");
		db.finish(one!.occurrence, true);
		const [two] = db.claim(2);
		expect(two?.occurrence.input).toBe("second");
		db.finish(two!.occurrence, true);
		const [tick] = db.claim(2);
		expect(tick?.occurrence.trigger).toBe("tick");
		db.finish(tick!.occurrence, true);
		expect(db.claim(2)).toEqual([]);
		db.upsert({ ...d, revision: 2, state: "paused" });
		now += 3600000;
		db.upsert({ ...d, revision: 3 });
		expect(db.claim(2)).toEqual([]);
		now += 60000;
		expect(db.claim(2)).toHaveLength(1);
	});
	it("serializes claims across SQLite connections and fences stale takeover/edited attempts", async () => {
		let now = Date.now();
		const dir = await directory();
		const a = new AutomationLedger(dir, "workspace-a", () => now);
		const b = new AutomationLedger(dir, "workspace-a", () => now);
		ledgers.push(a, b);
		a.upsert(definition());
		a.enqueue(definition().id, 1, "event", "work");
		const [first] = a.claim(2);
		expect(b.claim(2)).toEqual([]);
		now += 90001;
		const [takeover] = b.claim(2);
		expect(takeover!.occurrence.fence).toBe(2);
		expect(takeover!.occurrence.attemptId).not.toBe(
			first!.occurrence.attemptId,
		);
		expect(() => a.renew(first!.occurrence)).toThrow("Stale");
		a.finish(first!.occurrence, true);
		expect(b.status(definition().id).occurrences[0]!.status).toBe("running");
		b.upsert(definition({ revision: 2, state: "paused" }));
		expect(() => b.renew(takeover!.occurrence)).toThrow("unavailable");
	});
	it("bounds queue, workspace concurrency, per-namespace ownership and retry budget", async () => {
		let now = Date.now();
		const db = await ledger(() => now);
		for (let i = 0; i < 4; i++) {
			const d = definition({
				id: `a${i}`,
				namespace: i === 1 ? "n0" : `n${i}`,
			});
			db.upsert(d);
			db.enqueue(d.id, 1, "event", "work");
		}
		const claims = db.claim(10);
		expect(claims).toHaveLength(2);
		expect(new Set(claims.map((c) => c.definition.namespace)).size).toBe(2);
		for (const c of claims) db.finish(c.occurrence, false);
		const d = definition({ id: "queue" });
		db.upsert(d);
		for (let i = 0; i < 32; i++) db.enqueue(d.id, 1, `e${i}`, "work");
		expect(() => db.enqueue(d.id, 1, "e33", "work")).toThrow("queue full");
		const solo = await ledger(() => now);
		solo.upsert(definition());
		solo.enqueue(definition().id, 1, "e", "work");
		for (let attempt = 1; attempt <= 3; attempt++) {
			const [claim] = solo.claim(1);
			expect(claim!.occurrence.attempts).toBe(attempt);
			solo.finish(claim!.occurrence, false);
			now += 11000;
		}
		expect(solo.claim(1)).toEqual([]);
		expect(solo.status(definition().id).occurrences[0]!.status).toBe("blocked");
	});
	it("rejects cross-workspace definitions and invalid timezone; tick identity binds revision", async () => {
		const db = await ledger();
		expect(() => db.upsert(definition({ workspaceId: "workspace-b" }))).toThrow(
			"workspace",
		);
		const d = definition({
			schedule: {
				intervalSeconds: 60,
				anchorAt: "2026-01-01T00:00:00Z",
				timezone: "UTC",
			},
		});
		expect(latestTick(d, Date.parse(d.schedule!.anchorAt), null)?.key).not.toBe(
			latestTick({ ...d, revision: 2 }, Date.parse(d.schedule!.anchorAt), null)
				?.key,
		);
		expect(() =>
			db.upsert({ ...d, schedule: { ...d.schedule, timezone: "not/a/zone" } }),
		).toThrow();
	});
});

describe("resource-bound tools and private resume", () => {
	it.each([
		"workspaceId",
		"customerId",
		"accountId",
		"connectionId",
		"channelId",
		"threadTs",
		"issueId",
		"role",
		"runId",
		"grantId",
		"resourceRef",
		"actionId",
		"url",
	])("rejects model-selected %s even on a permitted tool", (field) => {
		expect(() =>
			authorizeTool(authority(), {
				name: "get_issue",
				arguments: { [field]: "foreign" },
			}),
		).toThrow();
	});
	it("denies aliases/search and worker escalation; coordinator writes remain exact-resource scoped", () => {
		for (const name of [
			"linear.get_issue",
			"mcp__linear__get_issue",
			"search",
			"fetch",
			"Bash",
		])
			expect(toolCallSchema.safeParse({ name, arguments: {} }).success).toBe(
				false,
			);
		const a = authority();
		expect(
			authorizeTool(a, {
				name: "add_comment",
				arguments: { text: "Approved text" },
			}),
		).toEqual(a.definition.grants[0]);
		for (const role of ["investigator", "engineering"] as const)
			expect(() =>
				authorizeTool(
					{ ...a, definition: { ...a.definition, role } },
					{ name: "add_comment", arguments: { text: "No" } },
				),
			).toThrow();
		expect(() =>
			authorizeTool(a, {
				name: "reply",
				arguments: { text: "wrong provider" },
			}),
		).toThrow();
	});
	it("allows only explicitly granted coordinator delegation with strict selector-free arguments", () => {
		const a = authority();
		const call = {
			name: "delegate_investigation",
			arguments: { instruction: "Investigate", tracking: "direct" },
		};
		expect(() => authorizeTool(a, call)).toThrow();
		a.definition.grants[0]!.permissions.push("delegate");
		for (const tracking of ["direct", "assigned_ticket"])
			expect(
				authorizeTool(a, {
					...call,
					arguments: { ...call.arguments, tracking },
				}),
			).toBe(a.definition.grants[0]);
		for (const field of [
			"role",
			"parentSessionId",
			"customerId",
			"workspaceId",
			"issueId",
			"grantId",
			"resource",
			"idempotencyKey",
			"linkIssue",
		]) {
			expect(() =>
				authorizeTool(a, {
					...call,
					arguments: { ...call.arguments, [field]: "foreign" },
				}),
			).toThrow();
		}
		for (const args of [
			{ instruction: "", tracking: "direct" },
			{ instruction: "x".repeat(10001), tracking: "direct" },
			{ instruction: "x" },
			{ instruction: "x", tracking: "arbitrary" },
		])
			expect(() => authorizeTool(a, { ...call, arguments: args })).toThrow();
		for (const role of ["investigator", "engineering"] as const) {
			const worker = { ...a, definition: { ...a.definition, role } };
			expect(permittedToolNames(worker)).not.toContain(call.name);
			expect(() => authorizeTool(worker, call)).toThrow();
		}
		a.definition.grants[0]!.permissions = ["delegate"];
		expect(() => authorizeTool(a, call)).toThrow();
	});
	it("rejects provider overreturn and hides fixed authority metadata in model tool results", () => {
		const a = authority(),
			grant = a.definition.grants[0]!;
		const result = {
			items: [
				{
					grantId: grant.id,
					connectionId: grant.connectionId,
					accountId: grant.accountId,
					resource: grant.resource,
					text: "Scoped issue",
				},
			],
			nextCursor: null,
		};
		expect(
			scopedToolResult(a, { name: "get_issue", arguments: {} }, result),
		).toEqual({ items: [{ text: "Scoped issue" }], nextCursor: null });
		expect(() =>
			scopedToolResult(
				a,
				{ name: "get_issue", arguments: {} },
				{ ...result, items: [{ ...result.items[0], accountId: "foreign" }] },
			),
		).toThrow();
		expect(
			definitionSchema.safeParse({ ...a.definition, grants: [grant, grant] })
				.success,
		).toBe(false);
	});
	it("isolates checkpoint keys by customer namespace, workspace, revision and occurrence, never attempt", async () => {
		const a = authority(),
			key = checkpointKey(a);
		const dir = await directory();
		const store = new AutomationCheckpointStore(dir);
		await store.save({
			version: 1,
			scopeKey: key,
			messages: [{ role: "user", content: "private" }],
			sequence: 0,
			status: "running",
		});
		for (const patch of [
			{ namespace: "customer-b" },
			{ workspaceId: "workspace-b" },
			{ revision: 2 },
		])
			expect(
				await store.load(
					checkpointKey({ ...a, definition: { ...a.definition, ...patch } }),
				),
			).toBeUndefined();
		expect(checkpointKey({ ...a, attemptId: "next", fence: 2 })).toBe(key);
		expect(
			await store.load(checkpointKey({ ...a, occurrenceId: "another" })),
		).toBeUndefined();
		expect(await readdir(dir)).toEqual([`${key}.json`]);
		expect(await readFile(join(dir, `${key}.json`), "utf8")).not.toContain(
			"token",
		);
		const other = checkpointKey({ ...a, occurrenceId: "symlink" });
		await symlink(join(dir, `${key}.json`), join(dir, `${other}.json`));
		expect(store.load(other)).rejects.toThrow();
		await writeFile(
			join(dir, `${key}.json`),
			JSON.stringify({
				version: 1,
				scopeKey: "f".repeat(64),
				messages: [],
				sequence: 0,
				status: "running",
			}),
		);
		expect(store.load(key)).rejects.toThrow("scope mismatch");
	});
	it("reports configured incompatible auth/harness/model rather than switching", () => {
		const good = {
			harness: "claude",
			model: "claude-fixture",
			apiKey: "fixture",
		};
		expect(modelReadiness(good)).toBeNull();
		for (const patch of [
			{ harness: "codex" },
			{ model: "sonnet" },
			{ apiKey: "" },
			{ oauthToken: "fixture-oauth" },
		])
			expect(modelReadiness({ ...good, ...patch })).not.toBeNull();
	});
});

it("reports the selected Codex model without borrowing Claude aliases or claiming its adapter", async () => {
	vi.stubEnv("CYRUS_TEAM_ID", "workspace-a");
	vi.stubEnv("CYRUS_API_KEY", "fixture");
	vi.stubEnv("CYRUS_APP_URL", "https://hosted.fixture");
	vi.stubEnv("CYRUS_DEFAULT_RUNNER", "codex");
	vi.stubEnv("CYRUS_CODEX_DEFAULT_MODEL", undefined);
	vi.stubEnv("CYRUS_CLAUDE_DEFAULT_MODEL", "opus");
	const app = Fastify();
	const runtime = registerConfiguredAutomations(app, await directory(), () => ({
		defaultRunner: "codex",
		codexDefaultModel: "gpt-5.5",
		claudeDefaultModel: "opus",
	}));
	try {
		const capabilities = runtime.capabilities();
		expect(capabilities.target).toEqual({
			harness: "codex",
			model: "gpt-5.5",
			adapter: null,
		});
		expect(capabilities.available).toBe(false);
		expect(capabilities.reason).toBe(
			"Contained Codex image has not been configured and verified",
		);
	} finally {
		await app.close();
	}
});

it.each([
	"linear",
	"slack-channel",
	"slack-unnegotiated",
])("enforces negotiated read sets and revocation without rotating the session (%s)", async (source) => {
	const db = await ledger();
	const d = definition();
	db.upsert(d);
	const occurrence = db.enqueue(
		d.id,
		1,
		"read-set-revocation",
		"Read current issues",
	);
	let modelStarted = false,
		modelAborted = false,
		admissions = 0,
		probes = 0,
		results = 0;
	const runtime = new AutomationRuntime({
		workspaceId: () => d.workspaceId,
		ledger: db,
		store: new AutomationCheckpointStore(await directory()),
		readiness: () => ({ ...d.target, reason: null }),
		renewMilliseconds: 10,
		model: {
			async next(_messages, _authority, signal) {
				modelStarted = true;
				return await new Promise<never>((_resolve, reject) => {
					const abort = () => {
						modelAborted = true;
						reject(new Error("Model aborted"));
					};
					signal.addEventListener("abort", abort, { once: true });
					if (signal.aborted) abort();
				});
			},
		},
		tools: () => ({
			async call() {
				throw new Error("No provider call expected");
			},
			async close() {},
			async renew(operation) {
				await operation();
			},
			async revalidate() {
				probes++;
				if (modelStarted) throw new Error("Current grant revoked");
			},
		}),
		gateway: {
			async call(endpoint, body) {
				if (endpoint === "authorize") {
					admissions++;
					return {
						...(source === "slack-channel" && { slackChannelRead: true }),
						authority: authority({
							definition: {
								...d,
								grants: [
									{
										...authority().definition.grants[0]!,
										resource:
											source === "linear"
												? {
														provider: "linear",
														customerId: "00000000-0000-4000-8000-000000000001",
													}
												: {
														provider: "slack",
														channelId: "channel-a",
														scope: "channel",
													},
										permissions: ["read"],
									},
								],
							},
							occurrenceId: occurrence.id,
							attemptId: String(body.attemptId),
							fence: Number(body.fence),
							input: occurrence.input,
						}),
						mcp: {
							token: "fixture-credential-not-a-live-secret",
							audience: "/mcp",
							grantId: "bound-grant",
							expiresAt: new Date(Date.now() + 60000).toISOString(),
						},
					};
				}
				if (endpoint === "result") results++;
				return {};
			},
		},
	});
	try {
		expect(runtime.capabilities().capabilities.customerReadSet).toBe(true);
		await runtime.wake();
		expect(runtime.capabilities().capabilities.slackChannelRead).toBe(true);
		expect(modelAborted).toBe(source !== "slack-unnegotiated");
		expect(modelStarted).toBe(source !== "slack-unnegotiated");
		expect(admissions).toBe(1);
		expect(probes).toBeGreaterThanOrEqual(
			source === "slack-unnegotiated" ? 0 : 2,
		);
		expect(results).toBe(0);
		expect(db.status(d.id).occurrences[0]?.status).toBe("queued");
	} finally {
		await runtime.stop();
	}
});

describe("terminal receipts survive definition and model changes", () => {
	it.each([
		"paused",
		"deleted",
		"enabled",
	] as const)("reconciles a lost ACK after %s revision without model/tool/progress reopening", async (state) => {
		let now = Date.now();
		const db = await ledger(() => now);
		const d = definition();
		db.upsert(d);
		const occurrence = db.enqueue(
			d.id,
			1,
			"receipt-event",
			"Immutable instruction",
		);
		const store = new AutomationCheckpointStore(await directory());
		let committed = false,
			unavailable = false,
			modelCalls = 0,
			progress = 0,
			toolCalls = 0;
		const results: Array<Record<string, unknown>> = [];
		const options = {
			workspaceId: () => d.workspaceId,
			ledger: db,
			store,
			readiness: () => ({
				...d.target,
				reason: unavailable ? "Configured model unavailable" : null,
			}),
			model: {
				async next() {
					modelCalls++;
					return { type: "result" as const, text: "Immutable result" };
				},
			},
			tools: () => ({
				async call() {
					toolCalls++;
					throw new Error("Receipt must not open tools");
				},
				async close() {},
				async renew(operation: () => Promise<void>) {
					await operation();
				},
			}),
			gateway: {
				async call(endpoint: string, body: Record<string, unknown>) {
					if (endpoint === "authorize")
						return {
							authority: authority({
								definition: { ...d, grants: authority().definition.grants },
								occurrenceId: occurrence.id,
								attemptId: String(body.attemptId),
								fence: Number(body.fence),
								input: occurrence.input,
								phase: committed ? "reconcile" : "execute",
							}),
							mcp: {
								token: "fixture-credential-not-a-live-secret",
								audience: "/mcp",
								expiresAt: new Date(Date.now() + 60000).toISOString(),
								grantId: "bound-grant",
							},
						};
					if (endpoint === "progress") {
						progress++;
						return {};
					}
					results.push(body);
					if (!committed) {
						committed = true;
						db.upsert({
							...d,
							revision: 2,
							state,
							instruction: "New revision",
						});
						unavailable = true;
						throw new Error("Lost result acknowledgement");
					}
					return {
						contractVersion: 1,
						acknowledged: true,
						occurrenceId: body.occurrenceId,
						idempotencyKey: body.idempotencyKey,
					};
				},
			},
		};
		const first = new AutomationRuntime(options);
		await first.wake();
		await first.stop();
		expect(db.status(d.id).occurrences[0]?.status).toBe("queued");
		now += 6000;
		const resumed = new AutomationRuntime(options);
		expect(resumed.capabilities().available).toBe(false);
		await resumed.wake();
		await resumed.stop();
		expect(db.status(d.id).occurrences[0]?.status).toBe("completed");
		expect(results).toHaveLength(2);
		expect(results[1]?.idempotencyKey).toBe(results[0]?.idempotencyKey);
		expect(results[1]?.revision).toBe(1);
		expect(results[1]?.attemptId).not.toBe(results[0]?.attemptId);
		expect({ modelCalls, progress, toolCalls }).toEqual({
			modelCalls: 1,
			progress: 1,
			toolCalls: 0,
		});
	});
});

it("retains admitted events in arrival order across running work/restart and scopes dedup to the automation", async () => {
	const path = await directory();
	let now = Date.now();
	const db = new AutomationLedger(path, "workspace-a", () => now);
	const a = definition({ id: "slack-events", namespace: "customer-a" });
	const b = definition({ id: "linear-events", namespace: "customer-b" });
	db.upsert(a);
	db.upsert(b);
	const active = db.enqueue(
		a.id,
		1,
		"newer-source-event",
		"Slack source time20",
		"event",
	);
	const [running] = db.claim(1);
	const late = db.enqueue(
		a.id,
		1,
		"older-source-event",
		"Slack source time10",
		"event",
	);
	expect(
		db.enqueue(a.id, 1, "older-source-event", "Slack source time10", "event")
			.id,
	).toBe(late.id);
	expect(() =>
		db.enqueue(a.id, 1, "older-source-event", "Changed", "event"),
	).toThrow("payload conflict");
	const other = db.enqueue(
		b.id,
		1,
		"older-source-event",
		"Linear update",
		"event",
	);
	expect(other.id).not.toBe(late.id);
	expect(db.claim(2).map((c) => c.occurrence.id)).toEqual([other.id]);
	db.finish(running!.occurrence, true);
	db.close();
	const reopened = new AutomationLedger(path, "workspace-a", () => now);
	ledgers.push(reopened);
	expect(reopened.claim(1).map((c) => c.occurrence.id)).toEqual([late.id]);
	expect(reopened.status(a.id).occurrences.map((o) => o.input)).toEqual([
		"Slack source time20",
		"Slack source time10",
	]);
	expect(reopened.status(a.id).occurrences[0]?.id).toBe(active.id);
	reopened.upsert({ ...a, revision: 2, state: "paused" });
	expect(reopened.status(a.id).occurrences[1]?.status).toBe("cancelled");
	expect(() =>
		reopened.enqueue(a.id, 1, "after-pause", "No access", "event"),
	).toThrow();
	now += 100000;
	expect(reopened.claim(2).every((c) => c.definition.id !== a.id)).toBe(true);
});

it("bounds receipt retries independently and does not resurrect them on definition edits", async () => {
	let now = Date.now();
	const db = await ledger(() => now);
	const d = definition();
	db.upsert(d);
	db.enqueue(d.id, 1, "receipt", "result");
	const [first] = db.claim(1);
	db.markReceipt(first!.occurrence, d, digest("private-checkpoint"));
	db.upsert({ ...d, revision: 2, state: "paused" });
	db.finish(first!.occurrence, false);
	for (const advance of [6000, 11000]) {
		now += advance;
		const [claim] = db.claim(1, false);
		expect(claim!.definition.revision).toBe(1);
		db.finish(claim!.occurrence, false);
	}
	expect(db.status(d.id).occurrences[0]?.status).toBe("blocked");
	db.upsert({ ...d, revision: 3 });
	now += 100000;
	expect(db.claim(2, false)).toEqual([]);
});

it.each(
	["root", "direct", "ticket"].flatMap((kind) =>
		[false, true].map((negotiated) => ({ kind, negotiated })),
	),
)("flushes immutable session receipts before completion and replays a lost result ACK without reopening tools/model: %j", async ({
	kind,
	negotiated,
}) => {
	let now = Date.now();
	const db = await ledger(() => now);
	const d = definition(
		kind === "root"
			? {}
			: {
					role: "investigator",
					session: {
						id: "assignment:12345678-1234-4123-8123-123456789abc",
						parentSessionId: "parent-session",
						scopeRef: "operations-review",
						role: "investigator",
						...(kind === "ticket" && {
							issueContext: {
								trackerId: "linear",
								issueId: "issue-1",
								issueIdentifier: "TEST-1",
							},
						}),
					},
				},
	);
	db.upsert(d);
	const occurrence = db.enqueue(d.id, 1, "session-event", "Review");
	const { sessionDeliveryDigest } = await import(
		"../src/sinks/session-delivery.js"
	);
	const receipts = new Map<number, string>();
	const measurements: number[] = [];
	const deliveries: Array<{ sequence: number; attempt: string; kind: string }> =
		[];
	let blocked = true,
		committed = false,
		modelCalls = 0,
		toolCalls = 0,
		results = 0;
	const options = {
		workspaceId: () => d.workspaceId,
		ledger: db,
		store: new AutomationCheckpointStore(await directory()),
		readiness: () => ({ ...d.target, reason: null }),
		sessions: {
			directory: await directory(),
			secrets: () => ["supervisor-secret"],
			transport: {
				async deliver(
					envelope: import("../src/sinks/session-delivery.js").SessionDeliveryEnvelope,
				) {
					const { item } = envelope;
					deliveries.push({
						sequence: item.sequence,
						attempt: envelope.attemptId,
						kind: item.kind,
					});
					if (item.kind === "lifecycle" && item.payload.status === "complete") {
						expect(item.payload.executionDurationComplete).toBe(true);
						expect(Number.isSafeInteger(item.payload.executionDurationMs)).toBe(
							true,
						);
						measurements.push(item.payload.executionDurationMs!);
					}
					const hash = sessionDeliveryDigest(item);
					if (receipts.has(item.sequence))
						expect(receipts.get(item.sequence)).toBe(hash);
					else {
						expect(committed).toBe(false);
						expect(item.sequence).toBe(receipts.size + 1);
						receipts.set(item.sequence, hash);
					}
					if (
						item.kind === "lifecycle" &&
						item.payload.status === "complete" &&
						blocked
					)
						throw new Error("Lost measured completion ACK");
					return {
						contractVersion: 1 as const,
						sessionId: item.sessionId,
						sequence: item.sequence,
						digest: hash,
					};
				},
			},
		},
		tools: () => ({
			async call() {
				toolCalls++;
				return { items: [{ text: "Scoped issue" }], nextCursor: null };
			},
			async close() {},
			async renew(fn: () => Promise<void>) {
				await fn();
			},
		}),
		model: {
			async next() {
				modelCalls++;
				return modelCalls === 1
					? {
							type: "tool" as const,
							call: { name: "get_issue" as const, arguments: {} },
						}
					: { type: "result" as const, text: "Completed review" };
			},
		},
		gateway: {
			async call(endpoint: string, body: Record<string, unknown>) {
				if (endpoint === "authorize")
					return {
						authority: authority({
							definition: {
								...d,
								grants: authority().definition.grants.map((g) => ({
									...g,
									permissions: ["read"],
								})),
							},
							occurrenceId: occurrence.id,
							attemptId: String(body.attemptId),
							fence: Number(body.fence),
							input: occurrence.input,
							phase: committed ? "reconcile" : "execute",
						}),
						mcp: {
							token: "fixture-credential-not-a-live-secret",
							audience: "/mcp",
							expiresAt: new Date(Date.now() + 60000).toISOString(),
							grantId: "bound-grant",
						},
						sessionExecutionTiming: true,
						...(negotiated && {
							sessionDeliveryAuthority: "current-admission-v1",
						}),
						sessionDelivery: {
							contractVersion: 1,
							path: "/api/agent-sessions/v1/deliver",
							session: d.session ?? {
								id: "session-root",
								scopeRef: d.scopeRef,
								role: d.role,
							},
						},
					};
				if (endpoint === "progress") return {};
				results++;
				expect(receipts.size).toBe(6);
				expect(blocked).toBe(false);
				if (!committed) {
					committed = true;
					throw new Error("Lost result ACK");
				}
				return {
					contractVersion: 1,
					acknowledged: true,
					occurrenceId: body.occurrenceId,
					idempotencyKey: body.idempotencyKey,
				};
			},
		},
	};
	let runtime = new AutomationRuntime(options);
	await runtime.wake();
	await runtime.stop();
	expect(results).toBe(0);
	expect(modelCalls).toBe(2);
	expect(toolCalls).toBe(1);
	blocked = false;
	now += 6000;
	runtime = new AutomationRuntime(options);
	await runtime.wake();
	await runtime.stop();
	expect(results).toBe(1);
	now += 11000;
	runtime = new AutomationRuntime(options);
	await runtime.wake();
	await runtime.stop();
	expect(db.status(d.id).occurrences[0]?.status).toBe("completed");
	expect({ results, modelCalls, toolCalls }).toEqual({
		results: 2,
		modelCalls: 2,
		toolCalls: 1,
	});
	expect(receipts.size).toBe(6);
	expect(measurements.length).toBeGreaterThan(1);
	expect(new Set(measurements).size).toBe(1);
	expect(
		new Set(deliveries.filter((d) => d.sequence === 1).map((d) => d.attempt))
			.size,
	).toBe(3);
});

it.skipIf(!process.env.CYRUS_TEST_CODEX_IMAGE)(
	"negotiates configured Codex readiness only after private login and actual isolated app-server initialization",
	async () => {
		const auth = await directory();
		await writeFile(
			join(auth, "auth.json"),
			JSON.stringify({
				tokens: {
					access_token: "synthetic-private-login",
					account_id: "synthetic-account",
				},
			}),
			{ mode: 0o600 },
		);
		vi.stubEnv("CODEX_HOME", auth);
		vi.stubEnv("CYRUS_TEAM_ID", "workspace-a");
		vi.stubEnv("CYRUS_API_KEY", "supervisor-fixture");
		vi.stubEnv("CYRUS_APP_URL", "https://hosted.fixture");
		vi.stubEnv("CYRUS_DEFAULT_RUNNER", "");
		vi.stubEnv("CYRUS_DEFAULT_MODEL", "");
		vi.stubEnv("CYRUS_CODEX_DEFAULT_MODEL", "");
		vi.stubEnv(
			"CYRUS_CONTAINED_CODEX_IMAGE",
			process.env.CYRUS_TEST_CODEX_IMAGE!,
		);
		vi.stubEnv(
			"CYRUS_CONTAINED_DOCKER_PATH",
			process.env.CYRUS_TEST_DOCKER_PATH || "/usr/local/bin/docker",
		);
		vi.stubEnv("CYRUS_CONTAINED_DOCKER_HOST", "unix:///var/run/docker.sock");
		const app = Fastify();
		registerConfiguredAutomations(app, await directory(), () => ({
			defaultRunner: "codex",
			codexDefaultModel: "gpt-5.5",
			claudeDefaultModel: "opus",
		}));
		try {
			await app.ready();
			const result = await app.inject({
				url: "/api/automations/v1/capabilities",
				headers: { authorization: "Bearer supervisor-fixture" },
			});
			expect(result.statusCode).toBe(200);
			expect(result.json()).toMatchObject({
				available: true,
				target: {
					harness: "codex",
					model: "gpt-5.5",
					adapter: "codex-app-server-contained-v1",
				},
				capabilities: { engineering: true },
				minimumPublishedVersion: null,
			});
		} finally {
			await app.close();
		}
	},
);

it.each([
	"parent",
	"role",
	"scope",
	"write",
	"delegate",
	"ticket",
	"external",
	"schedule",
	"id",
])("denies an invalid admitted child before model, MCP or session delivery: %s", async (kind) => {
	const db = await ledger();
	const session = {
		id: "assignment:12345678-1234-4123-8123-123456789abc",
		parentSessionId: "parent",
		scopeRef: "operations-review",
		role: "investigator" as const,
	};
	const d = definition({ role: "investigator", session });
	if (kind === "parent") delete (session as any).parentSessionId;
	if (kind === "role") (session as any).role = "coordinator";
	if (kind === "scope") session.scopeRef = "foreign-customer";
	if (kind === "external")
		(session as any).externalSessionId = "borrowed-linear-session";
	if (kind === "schedule")
		d.schedule = {
			intervalSeconds: 60,
			anchorAt: new Date(Date.now() + 60000).toISOString(),
			timezone: "UTC",
		};
	if (kind === "id") session.id = "self-selected";
	db.upsert(d);
	const occurrence = db.enqueue(d.id, 1, "child-event", "investigate");
	const next = vi.fn(),
		call = vi.fn(),
		deliver = vi.fn();
	const runtime = new AutomationRuntime({
		workspaceId: () => d.workspaceId,
		ledger: db,
		store: new AutomationCheckpointStore(await directory()),
		readiness: () => ({ ...d.target, reason: null }),
		model: { next },
		sessions: {
			directory: await directory(),
			secrets: () => [],
			transport: { deliver },
		},
		tools: () => ({
			call,
			async close() {},
			async renew(fn) {
				await fn();
			},
		}),
		gateway: {
			async call(endpoint, body) {
				if (endpoint !== "authorize") throw Error("No effect expected");
				return {
					authority: authority({
						definition: {
							...d,
							grants: authority().definition.grants.map((g) => ({
								...g,
								permissions:
									kind === "write"
										? ["read", "write"]
										: kind === "delegate"
											? ["read", "delegate"]
											: ["read"],
							})),
						},
						occurrenceId: occurrence.id,
						attemptId: String(body.attemptId),
						fence: Number(body.fence),
						input: occurrence.input,
					}),
					mcp: {
						token: "synthetic-long-credential-not-a-secret",
						audience: "/mcp",
						expiresAt: new Date(Date.now() + 60000).toISOString(),
						grantId: "bound-grant",
					},
					sessionDelivery: {
						contractVersion: 1,
						path: "/api/agent-sessions/v1/deliver",
						session: {
							...session,
							...(kind === "ticket" && {
								issueContext: {
									trackerId: "linear",
									issueId: "unadmitted-issue",
									issueIdentifier: "BAD-1",
								},
							}),
						},
					},
				};
			},
		},
	});
	try {
		await runtime.wake();
		expect(next).not.toHaveBeenCalled();
		expect(call).not.toHaveBeenCalled();
		expect(deliver).not.toHaveBeenCalled();
	} finally {
		await runtime.stop();
	}
});

it("keeps one write identity when native reconnect or repeated model calls repeat the same approved payload", async () => {
	const db = await ledger();
	const d = definition();
	db.upsert(d);
	const occurrence = db.enqueue(d.id, 1, "write-event", "approved reply");
	const keys: string[] = [];
	let models = 0;
	const runtime = new AutomationRuntime({
		workspaceId: () => d.workspaceId,
		ledger: db,
		store: new AutomationCheckpointStore(await directory()),
		readiness: () => ({ ...d.target, reason: null }),
		model: {
			async next() {
				return ++models <= 2
					? {
							type: "tool",
							call: {
								name: "add_comment",
								arguments: { text: "same approved text" },
							},
						}
					: { type: "result", text: "receipt accepted" };
			},
		},
		tools: () => ({
			async call(_call, key) {
				keys.push(key);
				return { items: [{ text: "immutable receipt" }], nextCursor: null };
			},
			async close() {},
			async renew(fn) {
				await fn();
			},
		}),
		gateway: {
			async call(endpoint, body) {
				if (endpoint === "authorize")
					return {
						authority: authority({
							definition: { ...d, grants: authority().definition.grants },
							occurrenceId: occurrence.id,
							attemptId: String(body.attemptId),
							fence: Number(body.fence),
							input: occurrence.input,
						}),
						mcp: {
							token: "synthetic-long-credential-not-a-secret",
							audience: "/mcp",
							expiresAt: new Date(Date.now() + 60000).toISOString(),
							grantId: "bound-grant",
						},
					};
				if (endpoint === "result")
					return {
						contractVersion: 1,
						acknowledged: true,
						occurrenceId: body.occurrenceId,
						idempotencyKey: body.idempotencyKey,
					};
				return {};
			},
		},
	});
	try {
		await runtime.wake();
		expect(db.status(d.id).occurrences[0]?.status).toBe("completed");
		expect(keys).toHaveLength(2);
		expect(keys[0]).toBe(keys[1]);
	} finally {
		await runtime.stop();
	}
});

describe("customer-derived opaque reference tools", () => {
	const customerId = "12345678-1234-4123-8123-123456789abc";
	const reference = "22345678-1234-4123-8123-123456789abc";
	function customerAuthority() {
		const a = authority();
		a.definition.grants[0]!.resource = { provider: "linear", customerId };
		a.definition.grants[0]!.permissions = ["read", "write", "delegate"];
		return a;
	}
	it("admits the authenticated customer resource and exposes only scoped read/delegation schemas", () => {
		const a = customerAuthority();
		expect(definitionSchema.parse(a.definition)).toEqual(a.definition);
		expect(permittedToolNames(a)).toEqual([
			"list_issues",
			"get_issue",
			"delegate_investigation",
		]);
		for (const call of [
			{ name: "list_issues", arguments: {} },
			{ name: "get_issue", arguments: { reference } },
			{
				name: "delegate_investigation",
				arguments: {
					reference,
					instruction: "Investigate",
					tracking: "direct",
				},
			},
			{
				name: "delegate_investigation",
				arguments: {
					reference,
					instruction: "Investigate",
					tracking: "assigned_ticket",
				},
			},
		])
			expect(() => authorizeTool(a, call)).not.toThrow();
		const schemas = scopedToolSchemas(a);
		expect(
			schemas
				.find((s) => s.shape.name.value === "get_issue")!
				.shape.arguments.safeParse({}).success,
		).toBe(false);
		expect(
			schemas
				.find((s) => s.shape.name.value === "get_issue")!
				.shape.arguments.parse({ reference }),
		).toEqual({ reference });
		expect(() =>
			authorizeTool(a, {
				name: "add_comment",
				arguments: { text: "unauthorized" },
			}),
		).toThrow();
	});
	it("denies forged authority/provider selectors, fixed-resource reference widening and worker delegation", () => {
		const a = customerAuthority();
		for (const field of [
			"customerId",
			"workspaceId",
			"connectionId",
			"issueId",
			"teamId",
			"grantId",
			"runId",
			"role",
		])
			for (const name of ["list_issues", "get_issue"])
				expect(() =>
					authorizeTool(a, {
						name,
						arguments: {
							...(name === "get_issue" ? { reference } : {}),
							[field]: customerId,
						},
					}),
				).toThrow();
		expect(() =>
			authorizeTool(a, {
				name: "get_issue",
				arguments: { reference: "provider-id" },
			}),
		).toThrow();
		expect(() =>
			authorizeTool(authority(), {
				name: "get_issue",
				arguments: { reference },
			}),
		).toThrow();
		expect(() =>
			authorizeTool(authority(), { name: "list_issues", arguments: {} }),
		).toThrow();
		expect(() =>
			authorizeTool(a, { name: "get_issue", arguments: {} }),
		).toThrow();
		a.definition.role = "investigator";
		expect(permittedToolNames(a)).toEqual(["list_issues", "get_issue"]);
		expect(() =>
			authorizeTool(a, {
				name: "delegate_investigation",
				arguments: { reference, instruction: "x", tracking: "direct" },
			}),
		).toThrow();
	});
	it("retains exact grant/customer/account checks on read-set results", () => {
		const a = customerAuthority(),
			g = a.definition.grants[0]!;
		const call = { name: "list_issues" as const, arguments: {} };
		const item = {
			grantId: g.id,
			connectionId: g.connectionId,
			accountId: g.accountId,
			resource: g.resource,
			text: JSON.stringify({
				issues: [{ reference, identifier: "FIX-1" }],
				held: 0,
			}),
		};
		const result = { items: [item], nextCursor: null };
		expect(scopedToolResult(a, call, result)).toEqual({
			items: [{ text: item.text }],
			nextCursor: null,
		});
		for (const patch of [
			{ resource: { provider: "linear", customerId: reference } },
			{ grantId: "foreign" },
			{ accountId: "foreign" },
			{ resource: { provider: "linear", teamId: "t", issueId: "i" } },
		])
			expect(() =>
				scopedToolResult(a, call, {
					...result,
					items: [{ ...item, ...patch }],
				}),
			).toThrow();
	});
});

it.each([
	false,
	true,
])("persists measured failed work across retry, excluding waits and rejecting negotiation downgrade: %s", async (downgrade) => {
	const { performance } = await import("node:perf_hooks");
	let monotonic = 0;
	const spy = vi.spyOn(performance, "now").mockImplementation(() => monotonic);
	let now = Date.now();
	const db = await ledger(() => now);
	const d = definition();
	db.upsert(d);
	const occurrence = db.enqueue(d.id, 1, "timed-retry", "Review");
	const { sessionDeliveryDigest } = await import(
		"../src/sinks/session-delivery.js"
	);
	const lifecycle: import("../src/sinks/session-delivery.js").SessionLifecycleUpdate[] =
		[];
	let modelCalls = 0;
	let negotiated = true;
	const options = {
		workspaceId: () => d.workspaceId,
		ledger: db,
		store: new AutomationCheckpointStore(await directory()),
		readiness: () => ({ ...d.target, reason: null }),
		sessions: {
			directory: await directory(),
			secrets: () => [],
			transport: {
				async deliver({
					item,
				}: import("../src/sinks/session-delivery.js").SessionDeliveryEnvelope) {
					monotonic += 60000; // receiver latency must never contribute to executing work
					if (item.kind === "lifecycle") lifecycle.push(item.payload);
					return {
						contractVersion: 1 as const,
						sessionId: item.sessionId,
						sequence: item.sequence,
						digest: sessionDeliveryDigest(item),
					};
				},
			},
		},
		tools: () => ({
			call: async () => ({}),
			close: async () => {},
			renew: async (fn: () => Promise<void>) => fn(),
		}),
		model: {
			async next() {
				monotonic += ++modelCalls * 100;
				if (modelCalls === 1) throw Error("Controlled interrupted model");
				return { type: "result" as const, text: "Measured result" };
			},
		},
		gateway: {
			async call(endpoint: string, body: Record<string, unknown>) {
				monotonic += 30000; // supervisor/progress/result latency is not executing work
				if (endpoint === "authorize")
					return {
						authority: authority({
							definition: { ...d, grants: authority().definition.grants },
							occurrenceId: occurrence.id,
							attemptId: String(body.attemptId),
							fence: Number(body.fence),
							input: occurrence.input,
						}),
						mcp: {
							token: "fixture-credential-not-a-live-secret",
							audience: "/mcp",
							expiresAt: new Date(Date.now() + 60000).toISOString(),
							grantId: "bound-grant",
						},
						...(negotiated && { sessionExecutionTiming: true }),
						sessionDelivery: {
							contractVersion: 1,
							path: "/api/agent-sessions/v1/deliver",
							session: {
								id: "timed-session",
								scopeRef: d.scopeRef,
								role: d.role,
							},
						},
					};
				if (endpoint === "progress") return {};
				return {
					contractVersion: 1,
					acknowledged: true,
					occurrenceId: body.occurrenceId,
					idempotencyKey: body.idempotencyKey,
				};
			},
		},
	};
	try {
		let runtime = new AutomationRuntime(options);
		await runtime.wake();
		await runtime.stop();
		expect(db.status(d.id).occurrences[0]?.status).toBe("queued");
		expect(lifecycle.at(-1)).toEqual({
			status: "error",
			executionDurationMs: 100,
			executionDurationComplete: true,
		});
		now += 6000;
		monotonic += 86400000;
		if (downgrade) {
			negotiated = false;
			const delivered = lifecycle.length;
			runtime = new AutomationRuntime(options);
			await runtime.wake();
			await runtime.stop();
			expect(db.status(d.id).occurrences[0]?.status).toBe("queued");
			expect(modelCalls).toBe(1);
			expect(lifecycle).toHaveLength(delivered);
			negotiated = true;
			now += 11000;
		}
		runtime = new AutomationRuntime(options);
		await runtime.wake();
		await runtime.stop();
		expect(db.status(d.id).occurrences[0]?.status).toBe("completed");
		expect(lifecycle.at(-1)).toEqual({
			status: "complete",
			executionDurationMs: 300,
			executionDurationComplete: true,
		});
		expect(modelCalls).toBe(2);
	} finally {
		spy.mockRestore();
	}
});

it("does not block model/tool execution on intermediate activity ACKs but flushes before result", async () => {
	const db = await ledger();
	const d = definition();
	db.upsert(d);
	const occurrence = db.enqueue(d.id, 1, "delayed-activity", "Read the issue");
	const { sessionDeliveryDigest } = await import(
		"../src/sinks/session-delivery.js"
	);
	let release!: () => void, entered!: () => void;
	const blocked = new Promise<void>((r) => {
		release = r;
	});
	const deliveryStarted = new Promise<void>((r) => {
		entered = r;
	});
	let modelCalls = 0,
		tools = 0,
		results = 0;
	const sequences: number[] = [];
	const runtime = new AutomationRuntime({
		workspaceId: () => d.workspaceId,
		ledger: db,
		store: new AutomationCheckpointStore(await directory()),
		readiness: () => ({ ...d.target, reason: null }),
		sessions: {
			directory: await directory(),
			secrets: () => [],
			transport: {
				async deliver({ item }) {
					if (item.sequence === 2) {
						entered();
						await blocked;
					}
					sequences.push(item.sequence);
					return {
						contractVersion: 1,
						sessionId: item.sessionId,
						sequence: item.sequence,
						digest: sessionDeliveryDigest(item),
					};
				},
			},
		},
		tools: () => ({
			call: async () => {
				tools++;
				return { items: [], nextCursor: null };
			},
			close: async () => {},
			renew: async (fn) => fn(),
		}),
		model: {
			async next() {
				modelCalls++;
				return modelCalls === 1
					? { type: "tool", call: { name: "get_issue", arguments: {} } }
					: { type: "result", text: "Finished" };
			},
		},
		gateway: {
			async call(endpoint, body) {
				if (endpoint === "authorize")
					return {
						authority: authority({
							occurrenceId: occurrence.id,
							attemptId: String(body.attemptId),
							fence: Number(body.fence),
							input: occurrence.input,
						}),
						mcp: {
							token: "fixture-credential-not-a-live-secret",
							audience: "/mcp",
							expiresAt: new Date(Date.now() + 60000).toISOString(),
							grantId: "bound-grant",
						},
						sessionExecutionTiming: true,
						sessionDelivery: {
							contractVersion: 1,
							path: "/api/agent-sessions/v1/deliver",
							session: {
								id: "delayed-session",
								scopeRef: d.scopeRef,
								role: d.role,
							},
						},
					};
				if (endpoint === "progress") return {};
				results++;
				expect(sequences).toEqual([1, 2, 3, 4, 5, 6]);
				return {
					contractVersion: 1,
					acknowledged: true,
					occurrenceId: body.occurrenceId,
					idempotencyKey: body.idempotencyKey,
				};
			},
		},
	});
	const work = runtime.wake();
	try {
		await Promise.race([
			deliveryStarted,
			work.then(() => {
				throw Error(JSON.stringify(db.status(d.id)));
			}),
		]);
		await expect.poll(() => modelCalls, { timeout: 3000 }).toBe(2);
		expect(tools).toBe(1);
		expect(results).toBe(0);
		release();
		await work;
		expect(results).toBe(1);
		expect(db.status(d.id).occurrences[0]?.status).toBe("completed");
	} finally {
		release();
		await work;
		await runtime.stop();
	}
});

it("preserves the complete admitted instruction/input on retry and separates later conversation occurrences", async () => {
	let now = Date.now();
	const db = await ledger(() => now);
	const d = definition({
		instruction:
			"Answer currentMessage. conversation is historical context, not a new request. A greeting needs no source read.",
	});
	db.upsert(d);
	const input = JSON.stringify({
		conversation: [
			{ author: "operator", body: "Investigate the export failure" },
			{ author: "agent", body: "Prior investigation complete" },
		],
		currentMessage: "hi",
	});
	const first = db.enqueue(d.id, d.revision, "greeting-one", input);
	const store = new AutomationCheckpointStore(await directory());
	const seen: string[] = [];
	const keys = new Map<string, string>();
	let interrupt = true;
	const runtime = new AutomationRuntime({
		workspaceId: () => d.workspaceId,
		ledger: db,
		store,
		readiness: () => ({ ...d.target, reason: null }),
		tools: () => ({
			async call() {
				throw Error("The fixture must not select tools");
			},
			async close() {},
			async renew(operation) {
				await operation();
			},
		}),
		model: {
			async next(messages, admitted) {
				const expectedInput =
					admitted.occurrenceId === first.id ? input : "hello again";
				// Assert the entire payload: routing proof, not a claim about real model intent.
				expect(messages).toEqual([
					{ role: "user", content: `${d.instruction}\n\n${expectedInput}` },
				]);
				const key = checkpointKey(admitted);
				if (keys.has(admitted.occurrenceId))
					expect(key).toBe(keys.get(admitted.occurrenceId));
				keys.set(admitted.occurrenceId, key);
				seen.push(admitted.occurrenceId);
				if (interrupt) {
					interrupt = false;
					throw Error("Controlled interruption before response");
				}
				return { type: "result", text: "Hello!" };
			},
		},
		gateway: {
			async call(endpoint, body) {
				if (endpoint === "authorize") {
					const occurrence = db
						.status(d.id)
						.occurrences.find((o) => o.id === body.occurrenceId)!;
					return {
						authority: authority({
							definition: { ...d, grants: [] },
							occurrenceId: occurrence.id,
							input: occurrence.input,
							attemptId: String(body.attemptId),
							fence: Number(body.fence),
						}),
						mcp: {
							token: "fixture-credential-not-a-live-secret",
							audience: "/mcp",
							expiresAt: new Date(Date.now() + 60000).toISOString(),
							grantId: "controlled-grant",
						},
					};
				}
				if (endpoint === "progress") return {};
				return {
					contractVersion: 1,
					acknowledged: true,
					occurrenceId: body.occurrenceId,
					idempotencyKey: body.idempotencyKey,
				};
			},
		},
	});
	try {
		await runtime.wake();
		expect(db.status(d.id).occurrences[0]!.status).toBe("queued");
		now += 5001;
		await runtime.wake();
		expect(db.status(d.id).occurrences[0]!.status).toBe("completed");
		const second = db.enqueue(d.id, d.revision, "greeting-two", "hello again");
		await runtime.wake();
		expect(seen).toEqual([first.id, first.id, second.id]);
		expect(keys.get(first.id)).not.toBe(keys.get(second.id));
		for (const key of keys.values()) {
			const saved = await store.load(key);
			expect(saved!.messages).toHaveLength(1);
		}
	} finally {
		await runtime.stop();
	}
});
