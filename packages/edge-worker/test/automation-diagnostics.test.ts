import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AutomationRuntime } from "../src/automations/AutomationRuntime.js";
import { AutomationCheckpointStore } from "../src/automations/CheckpointStore.js";
import type { AutomationRegistration } from "../src/automations/contract.js";
import {
	AutomationDiagnosticError,
	safeDiagnostic,
} from "../src/automations/Diagnostics.js";
import { AutomationHttpGateway } from "../src/automations/Gateway.js";
import { AutomationLedger } from "../src/automations/Ledger.js";

it.each([
	"http",
	"schema",
	"identity",
	"mcp",
])("persists safe %s failure before checkpoint, through retry exhaustion and restart", async (kind) => {
	const root = await mkdtemp(join(tmpdir(), "automation-diagnostic-"));
	let now = Date.now();
	let db = new AutomationLedger(join(root, "ledger"), "workspace", () => now);
	const d: AutomationRegistration = {
		id: "binding",
		workspaceId: "workspace",
		ownerId: "operator",
		namespace: "private",
		scopeRef: "scope",
		revision: 2,
		state: "enabled",
		role: "coordinator",
		instruction: "private input must never be diagnostics",
		schedule: null,
		target: { harness: "codex", model: "gpt-5.5" },
	};
	db.upsert(d);
	db.enqueue(d.id, 2, "event", "private customer content");
	const next = vi.fn();
	const runtime = new AutomationRuntime({
		workspaceId: () => "workspace",
		ledger: db,
		store: new AutomationCheckpointStore(join(root, "checkpoints")),
		readiness: () => ({ ...d.target, reason: null }),
		model: { next },
		tools: () => ({
			call: vi.fn(),
			close: async () => {},
			renew: async (op) => {
				await op();
			},
			revalidate: async () => {
				throw new AutomationDiagnosticError(
					{ phase: "mcp", code: "http_denied", httpStatus: 403 },
					"sensitive provider response",
				);
			},
		}),
		gateway: {
			async call(endpoint, body) {
				if (endpoint !== "authorize") throw Error("Unexpected callback");
				if (kind === "http")
					throw new AutomationDiagnosticError(
						{ phase: "authorize", code: "http_denied", httpStatus: 403 },
						"Bearer private-secret",
					);
				if (kind === "schema")
					return {
						mcp: { token: "private-secret", audience: "evil-private-host" },
						"sensitive-key": "private value",
					};
				return {
					authority: {
						contractVersion: 1,
						definition: {
							...d,
							grants: [
								{
									id: "grant",
									connectionId: "connection",
									accountId: "account",
									resource: {
										provider: "linear",
										customerId: "00000000-0000-4000-8000-000000000001",
									},
									permissions: ["read"],
								},
							],
						},
						occurrenceId: kind === "identity" ? "foreign" : body.occurrenceId,
						attemptId: body.attemptId,
						fence: body.fence,
						leaseUntil: new Date(Date.now() + 90000).toISOString(),
						phase: "execute",
						input: "private customer content",
					},
					mcp: {
						token: "fixture-credential-not-a-live-secret",
						audience: "/mcp",
						grantId: "grant",
						expiresAt: new Date(Date.now() + 60000).toISOString(),
					},
				};
			},
		},
	});
	try {
		for (let n = 0; n < 3; n++) {
			await runtime.wake();
			now += 11000;
		}
		const expected =
			kind === "http"
				? { phase: "authorize", code: "http_denied", httpStatus: 403 }
				: kind === "schema"
					? { phase: "admission", code: "admission_invalid" }
					: kind === "identity"
						? { phase: "admission", code: "identity_mismatch" }
						: { phase: "mcp", code: "http_denied", httpStatus: 403 };
		const occurrence = db.status(d.id).occurrences[0]!;
		expect(occurrence).toMatchObject({
			status: "blocked",
			attempts: 3,
			lastFailure: expected,
		});
		expect(JSON.stringify(occurrence.lastFailure)).not.toMatch(
			/private|Bearer|sensitive|evil/,
		);
		expect(next).not.toHaveBeenCalled();
		expect(await readdir(join(root, "checkpoints")).catch(() => [])).toEqual(
			[],
		);
		db.close();
		db = new AutomationLedger(join(root, "ledger"), "workspace", () => now);
		expect(db.status(d.id).occurrences[0]!.lastFailure).toEqual(
			occurrence.lastFailure,
		);
	} finally {
		await runtime.stop();
		db.close();
		await rm(root, { recursive: true, force: true });
	}
});

it("fences late failure writers and clears a recovered failure on success", async () => {
	const root = await mkdtemp(join(tmpdir(), "automation-diagnostic-fence-"));
	let now = Date.now();
	const db = new AutomationLedger(root, "workspace", () => now);
	expect(safeDiagnostic(Error("constructor"), "execute")).toEqual({
		phase: "execute",
		code: "execution_interrupted",
	});
	try {
		db.upsert({
			id: "binding",
			workspaceId: "workspace",
			ownerId: "operator",
			namespace: "private",
			scopeRef: "scope",
			revision: 1,
			state: "enabled",
			role: "coordinator",
			instruction: "Review",
			schedule: null,
			target: { harness: "codex", model: "gpt-5.5" },
		});
		db.enqueue("binding", 1, "event", "input");
		const first = db.claim(1)[0]!.occurrence;
		db.finish(first, false, {
			phase: "authorize",
			code: "http_denied",
			httpStatus: 403,
		});
		now += 6000;
		const second = db.claim(1)[0]!.occurrence;
		db.finish(first, false, {
			phase: "execute",
			code: "execution_interrupted",
		});
		expect(db.status("binding").occurrences[0]!.lastFailure?.code).toBe(
			"http_denied",
		);
		db.finish(second, true);
		expect(db.status("binding").occurrences[0]!.lastFailure).toBeUndefined();
		expect(
			safeDiagnostic(Error("private input Bearer credential"), "execute"),
		).toEqual({ phase: "execute", code: "execution_interrupted" });
	} finally {
		db.close();
		await rm(root, { recursive: true, force: true });
	}
});

it("records HTTP status only, never authority response bodies or network errors", async () => {
	const gateway = new AutomationHttpGateway("https://fixture.invalid", () => ({
		apiKey: "private",
		workspaceId: "workspace",
	}));
	try {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response("private SQL error and credential", { status: 403 }),
		);
		await expect(
			gateway.call("authorize", {}, new AbortController().signal),
		).rejects.toMatchObject({
			diagnostic: { phase: "authorize", code: "http_denied", httpStatus: 403 },
		});
		vi.stubGlobal("fetch", async () => {
			throw Error("private proxy credentials");
		});
		await expect(
			gateway.call("authorize", {}, new AbortController().signal),
		).rejects.toMatchObject({
			diagnostic: { phase: "authorize", code: "transport_failed" },
		});
	} finally {
		vi.unstubAllGlobals();
	}
});

it("preserves the first recorded failure and bounded retry history across denial, restart and recovery", async () => {
	const root = await mkdtemp(join(tmpdir(), "automation-first-failure-"));
	let now = Date.now();
	let db = new AutomationLedger(root, "workspace", () => now);
	const definition = {
		id: "binding",
		workspaceId: "workspace",
		ownerId: "operator",
		namespace: "scope",
		scopeRef: "scope",
		revision: 1,
		state: "enabled" as const,
		role: "coordinator" as const,
		instruction: "Private input",
		schedule: null,
		target: { harness: "codex", model: "gpt-5.5" },
	};
	try {
		db.upsert(definition);
		const id = db.enqueue("binding", 1, "event", "Private greeting").id;
		for (let n = 1; n <= 18; n++) {
			if (n > 1 && (n - 1) % 3 === 0)
				db.recover({
					contractVersion: 1,
					workspaceId: "workspace",
					automationId: "binding",
					revision: 1,
					occurrenceId: id,
					commandId: randomUUID(),
					expectedFence: n - 1,
				});
			const claim = db.claim(1)[0]!.occurrence;
			db.finish(
				claim,
				false,
				n === 1
					? safeDiagnostic(Error("Private body Bearer secret"), "execute")
					: { phase: "authorize", code: "http_denied", httpStatus: 409 },
			);
			// A stale writer may not alter either the latest failure or its history.
			if (n === 1)
				db.finish(claim, false, {
					phase: "mcp",
					code: "http_denied",
					httpStatus: 403,
				});
			now += 11000;
		}
		const blocked = db.status("binding").occurrences[0]!;
		expect(blocked.status).toBe("blocked");
		expect(blocked.lastFailure).toMatchObject({
			code: "http_denied",
			httpStatus: 409,
		});
		expect(blocked.failureHistory).toHaveLength(16);
		expect(blocked.failureHistory![0]).toMatchObject({
			attempt: 1,
			fence: 1,
			phase: "execute",
			code: "execution_interrupted",
		});
		expect(
			blocked.failureHistory!.slice(1).map((failure) => failure.attempt),
		).toEqual(Array.from({ length: 15 }, (_, i) => i + 4));
		expect(JSON.stringify(blocked.failureHistory)).not.toMatch(
			/Private|Bearer|secret/,
		);
		db.close();
		db = new AutomationLedger(root, "workspace", () => now);
		expect(db.status("binding").occurrences[0]!.failureHistory).toEqual(
			blocked.failureHistory,
		);
		db.recover({
			contractVersion: 1,
			workspaceId: "workspace",
			automationId: "binding",
			revision: 1,
			occurrenceId: id,
			commandId: randomUUID(),
			expectedFence: 18,
		});
		db.finish(db.claim(1)[0]!.occurrence, true);
		const completed = db.status("binding").occurrences[0]!;
		expect(completed.lastFailure).toBeUndefined();
		expect(completed.failureHistory).toEqual(blocked.failureHistory);
	} finally {
		db.close();
		await rm(root, { recursive: true, force: true });
	}
});

it("distinguishes initial admission from renewal failures using fixed request metadata only", async () => {
	const gateway = new AutomationHttpGateway("https://fixture.invalid", () => ({
		apiKey: "private",
		workspaceId: "workspace",
	}));
	try {
		vi.stubGlobal(
			"fetch",
			async () => new Response("private server reason", { status: 409 }),
		);
		for (const phase of ["admit", "renew"] as const)
			await expect(
				gateway.call("authorize", { phase }, new AbortController().signal),
			).rejects.toMatchObject({
				diagnostic: {
					phase: "authorize",
					code: "http_denied",
					httpStatus: 409,
					authorizePhase: phase,
				},
			});
		await expect(
			gateway.call(
				"authorize",
				{ phase: "private input" },
				new AbortController().signal,
			),
		).rejects.toMatchObject({
			diagnostic: { phase: "authorize", code: "http_denied", httpStatus: 409 },
		});
		try {
			await gateway.call(
				"authorize",
				{ phase: "private input" },
				new AbortController().signal,
			);
		} catch (error) {
			expect(
				JSON.stringify((error as AutomationDiagnosticError).diagnostic),
			).not.toContain("private");
		}
	} finally {
		vi.unstubAllGlobals();
	}
});
