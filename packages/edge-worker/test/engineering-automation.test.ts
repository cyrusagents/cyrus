import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AutomationRuntime } from "../src/automations/AutomationRuntime.js";
import { AutomationCheckpointStore } from "../src/automations/CheckpointStore.js";
import {
	type AutomationAdmission,
	type AutomationRegistration,
	authorizeTool,
	checkpointKey,
	executionAuthority,
} from "../src/automations/contract.js";
import {
	type EngineeringEnvelope,
	engineeringDiagnostics,
	engineeringEnvelopeSchema,
	publicationFiles,
	publicationMetadata,
} from "../src/automations/Engineering.js";
import { AutomationHttpGateway } from "../src/automations/Gateway.js";
import { AutomationLedger } from "../src/automations/Ledger.js";
import type { AutomationModel } from "../src/automations/Model.js";
import {
	DockerSandbox,
	type EngineeringSandbox,
} from "../src/customer-runtime/DockerSandbox.js";
import { sessionDeliveryDigest } from "../src/sinks/session-delivery.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const clean of cleanups.splice(0).reverse()) await clean();
});
function handoff(): EngineeringEnvelope {
	return {
		assignmentId: randomUUID(),
		repository: "fixture/calculator",
		baseSha: "a".repeat(40),
		headBranch: "reviewed-fix",
		reviewId: randomUUID(),
		generation: 1,
		revision: 1,
		operations: ["execute", "publish"],
		environment: "isolated",
		deployment: "deny",
		technicalBrief: "Repair addition",
		syntheticReproduction: "sum(2,3) must equal 5",
		allowedPaths: ["sum.cjs", "sum.test.cjs", "retained.txt"],
		files: {
			"sum.cjs": "exports.sum=(a,b)=>a-b;",
			"sum.test.cjs":
				"const {test}=require('node:test'),assert=require('node:assert/strict'),{sum}=require('./sum.cjs');test('sum',()=>assert.equal(sum(2,3),5));",
		},
	};
}
async function fixture(
	model: AutomationModel,
	sandbox: () => EngineeringSandbox,
	mutate: (a: AutomationAdmission) => void = () => {},
) {
	const root = await mkdtemp(join(tmpdir(), "cyrus-engineering-automation-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	let now = Date.now();
	const db = new AutomationLedger(
		join(root, "ledger"),
		"workspace-a",
		() => now,
	);
	cleanups.push(() => db.close());
	const engineering = handoff(),
		scope = `engineering:${engineering.assignmentId}`;
	const definition: AutomationRegistration = {
		id: engineering.assignmentId,
		workspaceId: "workspace-a",
		ownerId: "operator",
		namespace: scope,
		scopeRef: scope,
		revision: 1,
		state: "enabled",
		role: "engineering",
		instruction: "PRIVATE_SPONSOR_PROMPT_MUST_NOT_ENTER_MODEL",
		schedule: null,
		target: { harness: "codex", model: "gpt-5.5" },
		session: {
			id: `assignment:${engineering.assignmentId}`,
			scopeRef: scope,
			role: "engineering",
		},
	};
	db.upsert(definition);
	const occurrence = db.enqueue(
		definition.id,
		1,
		"reviewed-work",
		"PRIVATE_SPONSOR_INPUT_MUST_NOT_ENTER_MODEL",
	);
	const store = new AutomationCheckpointStore(join(root, "checkpoints"));
	let admission: AutomationAdmission | undefined,
		revoked = false,
		losePublish = false,
		loseResult = false,
		committedResult = false,
		available = true;
	const publications: { key: string; files: unknown }[] = [],
		results: unknown[] = [],
		deliveries: unknown[] = [];
	const call = vi.fn(async (_call, key, _signal, files) => {
		publications.push({ key, files: structuredClone(files) });
		if (losePublish) {
			losePublish = false;
			throw Error("lost publication ACK");
		}
		return {
			items: [{ text: "Published reviewed artifact" }],
			nextCursor: null,
		};
	});
	const runtime = new AutomationRuntime({
		workspaceId: () => "workspace-a",
		ledger: db,
		store,
		model,
		readiness: () => ({
			...definition.target,
			reason: available ? null : "model unavailable",
		}),
		engineering: { available: () => available, sandbox },
		sessions: {
			directory: join(root, "sessions"),
			secrets: () => [],
			transport: {
				async deliver(e) {
					deliveries.push(e.item);
					return {
						contractVersion: 1,
						sessionId: e.item.sessionId,
						sequence: e.item.sequence,
						digest: sessionDeliveryDigest(e.item),
					};
				},
			},
		},
		tools: () => ({
			call,
			async renew(fn) {
				await fn();
			},
			async close() {},
		}),
		gateway: {
			async call(endpoint, body) {
				if (revoked) throw Error("revoked");
				if (endpoint === "authorize") {
					admission = {
						authority: {
							contractVersion: 1,
							definition: { ...definition, grants: [] },
							occurrenceId: occurrence.id,
							attemptId: String(body.attemptId),
							fence: Number(body.fence),
							leaseUntil: new Date(Date.now() + 90000).toISOString(),
							phase: committedResult ? "reconcile" : "execute",
							input: occurrence.input,
						},
						engineering: structuredClone(engineering),
						mcp: {
							token: "synthetic-credential-long-enough-for-fixture",
							audience: "/mcp",
							expiresAt: new Date(Date.now() + 60000).toISOString(),
							grantId: "engineering-stable-grant",
						},
						sessionDelivery: {
							contractVersion: 1,
							path: "/api/agent-sessions/v1/deliver",
							session: definition.session!,
						},
					};
					mutate(admission);
					return admission;
				}
				if (endpoint === "result") {
					results.push(body);
					committedResult = true;
					if (loseResult) {
						loseResult = false;
						throw Error("lost result ACK");
					}
					return {
						contractVersion: 1,
						acknowledged: true,
						occurrenceId: body.occurrenceId,
						idempotencyKey: body.idempotencyKey,
					};
				}
				return {};
			},
		},
	});
	cleanups.push(() => runtime.stop());
	return {
		runtime,
		db,
		definition,
		engineering,
		publications,
		results,
		deliveries,
		call,
		store,
		advance() {
			now += 11000;
		},
		get admission() {
			return admission!;
		},
		revoke() {
			revoked = true;
		},
		losePublication() {
			losePublish = true;
		},
		loseResult() {
			loseResult = true;
		},
		unavailable() {
			available = false;
		},
	};
}

it.each([
	"customerId",
	"parentSessionId",
	"providerToken",
])("rejects private/authority handoff field %s", (field) => {
	expect(() =>
		engineeringEnvelopeSchema.parse({ ...handoff(), [field]: "private" }),
	).toThrow();
});
it("rejects unsafe/oversized/unreviewed snapshots and fixed publication selectors", () => {
	const h = handoff();
	for (const files of [
		{ "../bad": "x" },
		{ ".env": "x" },
		{ ".git/config": "x" },
		{ secret: "é".repeat(410000) },
	])
		expect(() => engineeringEnvelopeSchema.parse({ ...h, files })).toThrow();
	expect(() => publicationFiles(h, { unreviewed: "x" })).toThrow();
	expect(() => publicationMetadata(h, "model-selected-key", h.files)).toThrow();
	expect(() => publicationMetadata(h, "a".repeat(64), undefined)).toThrow();
	expect(publicationMetadata(h, "a".repeat(64), h.files)).toEqual({
		idempotencyKey: "a".repeat(64),
		engineeringFiles: h.files,
	});
});

it("rejects a changed stable MCP grant during renewal before engineering execution", async () => {
	let authorizations = 0;
	const next = vi.fn(),
		sandbox = vi.fn();
	const f = await fixture({ next }, sandbox, (a) => {
		if (++authorizations > 1) a.mcp.grantId = "foreign-assignment-grant";
	});
	await f.runtime.wake();
	expect(authorizations).toBe(2);
	expect(next).not.toHaveBeenCalled();
	expect(sandbox).not.toHaveBeenCalled();
	expect(f.call).not.toHaveBeenCalled();
});
it("keeps the delivery preflight for engineering even with a customer-only mode", async () => {
	let authorizations = 0;
	const next = vi.fn(),
		sandbox = vi.fn();
	const f = await fixture({ next }, sandbox, (a) => {
		a.sessionDeliveryAuthority = "current-admission-v1";
		a.lifecycleAuthority = "current-action-v1";
		if (++authorizations === 3) throw Error("Delivery preflight denied");
	});
	await f.runtime.wake();
	expect(authorizations).toBe(3);
	expect(f.deliveries).toHaveLength(0);
	expect(next).not.toHaveBeenCalled();
	expect(sandbox).not.toHaveBeenCalled();
});
it.each([
	"parent",
	"customer-grant",
	"scope",
	"missing-envelope",
	"foreign-assignment",
])("denies engineering %s before model or sandbox", async (kind) => {
	const next = vi.fn(),
		sandbox = vi.fn();
	const f = await fixture({ next }, sandbox, (a) => {
		if (kind === "parent")
			a.authority.definition.session!.parentSessionId = "private-parent";
		if (kind === "scope") a.authority.definition.namespace = "customer-a";
		if (kind === "missing-envelope") delete a.engineering;
		if (kind === "foreign-assignment")
			a.engineering!.assignmentId = randomUUID();
		if (kind === "customer-grant")
			a.authority.definition.grants = [
				{
					id: "customer-grant",
					connectionId: "connection",
					accountId: "account",
					resource: { provider: "linear", teamId: "team", issueId: "issue" },
					permissions: ["read"],
				},
			];
	});
	await f.runtime.wake();
	expect(next).not.toHaveBeenCalled();
	expect(sandbox).not.toHaveBeenCalled();
	expect(f.call).not.toHaveBeenCalled();
	expect(f.deliveries).toEqual([]);
});
it.each([
	"generation",
	"revision",
	"reviewId",
	"files",
])("pins assignment %s across retry instead of opening a new checkpoint", async (field) => {
	const next = vi.fn(async () => {
			throw Error("interrupt");
		}),
		sandbox = vi.fn();
	const f = await fixture({ next }, sandbox);
	await f.runtime.wake();
	expect(next).toHaveBeenCalledTimes(1);
	if (field === "generation") f.engineering.generation++;
	if (field === "revision") f.engineering.revision++;
	if (field === "reviewId") f.engineering.reviewId = randomUUID();
	if (field === "files") f.engineering.files["sum.cjs"] = "changed review";
	f.advance();
	await f.runtime.wake();
	expect(next).toHaveBeenCalledTimes(1);
	expect(sandbox).not.toHaveBeenCalled();
});
it("revocation denies recovery without restoring worker customer-write authority", async () => {
	const next = vi.fn(async () => {
			throw Error("interrupt");
		}),
		sandbox = vi.fn();
	const f = await fixture({ next }, sandbox);
	await f.runtime.wake();
	const authority = executionAuthority(f.admission);
	for (const name of ["get_issue", "add_comment", "delegate_investigation"])
		expect(() =>
			authorizeTool(authority, { name, arguments: { text: "bad" } }),
		).toThrow();
	expect(() =>
		authorizeTool(authority, {
			name: "publish_artifact",
			arguments: { title: "x", summary: "x", assignmentId: randomUUID() },
		}),
	).toThrow();
	f.revoke();
	f.advance();
	await f.runtime.wake();
	expect(next).toHaveBeenCalledTimes(1);
	expect(f.call).not.toHaveBeenCalled();
});
it.skipIf(!process.env.CYRUS_TEST_CODEX_IMAGE)(
	"repairs failing tests, freezes publication files across lost ACK and performs terminal receipt-only recovery",
	async () => {
		let turns = 0;
		const sandbox = vi.fn(
			() =>
				new DockerSandbox({
					image: process.env.CYRUS_TEST_CODEX_IMAGE!,
					dockerPath:
						process.env.CYRUS_TEST_DOCKER_PATH || "/usr/local/bin/docker",
					dockerHost:
						process.env.CYRUS_TEST_DOCKER_HOST || "unix:///var/run/docker.sock",
					javascriptRuntime: "node",
				}),
		);
		const f = await fixture(
			{
				async next(messages) {
					expect(JSON.stringify(messages)).not.toContain("PRIVATE_SPONSOR");
					const turn = turns++;
					if (turn === 0)
						return {
							type: "tool",
							call: {
								name: "execute",
								arguments: {
									command: "printf retained > retained.txt; node --test",
								},
							},
						};
					if (turn === 1) {
						const result = JSON.parse(
							JSON.parse(messages.at(-1)!.content).items[0].text,
						);
						expect(result.exitCode).toBe(1);
						expect(result.stdout).toContain("ERR_ASSERTION");
						return {
							type: "tool",
							call: {
								name: "execute",
								arguments: {
									command:
										"printf 'exports.sum=(a,b)=>a+b;' > sum.cjs; node --test",
								},
							},
						};
					}
					if (turn === 2) {
						expect(
							JSON.parse(JSON.parse(messages.at(-1)!.content).items[0].text)
								.exitCode,
						).toBe(0);
						return {
							type: "tool",
							call: {
								name: "publish_artifact",
								arguments: {
									title: "Repair addition",
									summary: "Synthetic test passes",
								},
							},
						};
					}
					return { type: "result", text: "Published reviewed repair" };
				},
			},
			sandbox,
		);
		f.losePublication();
		f.loseResult();
		await f.runtime.wake();
		expect(f.publications).toHaveLength(1);
		expect(turns).toBe(3);
		const saved = await f.store.load(
			checkpointKey(executionAuthority(f.admission)),
		);
		expect(saved?.engineeringFiles?.["retained.txt"]).toBe("retained");
		f.advance();
		await f.runtime.wake();
		expect(f.publications).toHaveLength(2);
		expect(f.publications[1]).toEqual(f.publications[0]);
		expect(f.results).toHaveLength(1);
		expect(sandbox).toHaveBeenCalledTimes(1);
		f.unavailable();
		f.advance();
		await f.runtime.wake();
		expect(f.results).toHaveLength(2);
		expect(turns).toBe(4);
		expect(sandbox).toHaveBeenCalledTimes(1);
		expect(f.db.status(f.definition.id).occurrences[0]?.status).toBe(
			"completed",
		);
	},
	15000,
);

it("aborts an active engineering command on current-authority revocation and never publishes its output", async () => {
	let started!: () => void;
	const began = new Promise<void>((resolve) => {
		started = resolve;
	});
	const stop = vi.fn(async () => {});
	const execute = vi.fn(async (_command: string, signal: AbortSignal) => {
		started();
		return new Promise<never>((_resolve, reject) =>
			signal.addEventListener("abort", () => reject(Error("revoked")), {
				once: true,
			}),
		);
	});
	const f = await fixture(
		{
			async next() {
				return {
					type: "tool",
					call: { name: "execute", arguments: { command: "slow command" } },
				};
			},
		},
		() => ({
			async start() {},
			execute,
			async snapshot() {
				throw Error("must not snapshot revoked command");
			},
			stop,
		}),
	);
	const running = f.runtime.wake();
	await began;
	f.revoke();
	await running;
	expect(stop).toHaveBeenCalledTimes(1);
	expect(f.publications).toEqual([]);
	expect(f.results).toEqual([]);
	f.advance();
	await f.runtime.wake();
	expect(execute).toHaveBeenCalledTimes(1);
}, 10000);

it("bounds escaped diagnostics while preserving nonzero completion and explicit truncation", () => {
	const result = engineeringDiagnostics({
		exitCode: 1,
		stdout: "\0".repeat(40000),
		stderr: "\u0001".repeat(40000),
	});
	expect(result.items[0]!.text.length).toBeLessThanOrEqual(90000);
	expect(JSON.parse(result.items[0]!.text)).toMatchObject({
		exitCode: 1,
		truncated: true,
	});
});

it("negotiates engineering and session delivery for receipt authorization without model readiness", async () => {
	const requests: RequestInit[] = [];
	const mock = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async (_url, init) => {
			requests.push(init!);
			return new Response("{}");
		});
	try {
		const gateway = new AutomationHttpGateway(
			"https://hosted.fixture",
			() => ({ apiKey: "supervisor", workspaceId: "workspace" }),
			true,
			() => true,
		);
		await gateway.call(
			"authorize",
			{ phase: "renew" },
			new AbortController().signal,
		);
		const headers = new Headers(requests[0]!.headers);
		expect(headers.get("X-Cyrus-Engineering")).toBe("1");
		expect(headers.get("X-Cyrus-Session-Delivery")).toBe("1");
		expect(JSON.parse(requests[0]!.body as string)).toEqual({
			phase: "renew",
			contractVersion: 1,
		});
		const old = new AutomationHttpGateway(
			"https://hosted.fixture",
			() => ({ apiKey: "supervisor", workspaceId: "workspace" }),
			true,
		);
		await old.call("authorize", {}, new AbortController().signal);
		expect(new Headers(requests[1]!.headers).has("X-Cyrus-Engineering")).toBe(
			false,
		);
	} finally {
		mock.mockRestore();
	}
});
