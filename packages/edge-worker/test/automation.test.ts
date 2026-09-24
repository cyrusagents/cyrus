import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	nextOccurrence,
	previewSchedule,
} from "../src/automation/AutomationScheduler.js";
import { AutomationService } from "../src/automation/AutomationService.js";
import { AutomationStore } from "../src/automation/AutomationStore.js";
import {
	type AutomationAdapter,
	AutomationError,
	type AutomationInput,
} from "../src/automation/types.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const input = (overrides: Partial<AutomationInput> = {}): AutomationInput => ({
	name: "Update documentation",
	instructions: "Fix the outdated examples and open a PR",
	repositoryId: "repo",
	timezone: "Asia/Shanghai",
	schedule: { kind: "daily", time: "09:00" },
	target: { kind: "direct_repository" },
	enabled: true,
	...overrides,
});
async function fixture(adapterOverrides: Partial<AutomationAdapter> = {}) {
	const directory = await mkdtemp(join(tmpdir(), "automation-test-"));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	const adapter: AutomationAdapter = {
		validate: vi.fn(async () => {}),
		dispatch: vi.fn(async () => ({ status: "running" as const })),
		reconcile: vi.fn(async () => ({ status: "uncertain" as const })),
		...adapterOverrides,
	};
	const store = new AutomationStore(directory);
	const service = new AutomationService(store, adapter);
	await service.start(false);
	cleanups.push(() => service.stop());
	return { directory, adapter, store, service };
}
async function dispatched(service: AutomationService, id: string) {
	// Dispatch persists multiple fsync-backed transactions; shared CI disks can
	// exceed waitFor's one-second default while the package suite runs in parallel.
	await vi.waitFor(
		() => {
			const run = service.runs(id)[0];
			expect(run).toBeDefined();
			expect(run.status).not.toBe("dispatching");
		},
		{ timeout: 10000 },
	);
}

describe("automation time calculations", () => {
	it("uses the configured timezone and the same calculation for daily, weekly and cron previews", () => {
		const now = Date.parse("2026-09-23T00:00:00Z");
		expect(previewSchedule(input(), now)[0]).toBe(
			Date.parse("2026-09-23T01:00:00Z"),
		);
		expect(previewSchedule(input(), now)).toEqual(
			previewSchedule(
				input({ schedule: { kind: "cron", expression: "0 9 * * *" } }),
				now,
			),
		);
		expect(
			nextOccurrence(
				input({ schedule: { kind: "weekly", time: "09:00", days: [1] } }),
				now,
			),
		).toBe(Date.parse("2026-09-28T01:00:00Z"));
	});
	it("handles single appointments and rejects invalid timezone and second-granularity cron", () => {
		const at = "2026-09-24T01:00:00Z";
		expect(
			previewSchedule(
				input({ schedule: { kind: "once", at } }),
				Date.parse(at) - 1,
			),
		).toEqual([Date.parse(at)]);
		expect(
			previewSchedule(
				input({ schedule: { kind: "once", at } }),
				Date.parse(at),
			),
		).toEqual([]);
		expect(() => previewSchedule(input({ timezone: "Not/AZone" }))).toThrow(
			"Invalid schedule",
		);
		expect(() =>
			previewSchedule(
				input({ schedule: { kind: "cron", expression: "* * * * * *" } }),
			),
		).toThrow("five-field");
	});
	it("keeps local daily time across DST and produces strictly increasing occurrences", () => {
		const dates = previewSchedule(
			input({ timezone: "America/New_York" }),
			Date.parse("2026-03-07T00:00:00Z"),
		);
		expect(dates.slice(0, 3).map((d) => new Date(d).toISOString())).toEqual([
			"2026-03-07T14:00:00.000Z",
			"2026-03-08T13:00:00.000Z",
			"2026-03-09T13:00:00.000Z",
		]);
		expect(new Set(dates).size).toBe(5);
	});
});

describe("durable automation dispatch", () => {
	it("keeps due schedules paused during candidate probation until activation", async () => {
		const { service, directory, adapter, store } = await fixture();
		const definition = await service.save(input());
		await store.transact((state) => {
			state.definitions[0]!.nextRunAt = Date.now() - 1;
		});
		await service.stop();
		const candidate = new AutomationService(
			new AutomationStore(directory),
			adapter,
		);
		cleanups.push(() => candidate.stop());
		await candidate.start(false, true);
		await candidate.tick(Date.now());
		expect(adapter.dispatch).not.toHaveBeenCalled();
		candidate.enableScheduling();
		await candidate.tick(Date.now());
		await dispatched(candidate, definition.id);
		expect(adapter.dispatch).toHaveBeenCalledTimes(1);
	});
	it("persists the run before dispatch and deduplicates simultaneous manual requests", async () => {
		const { service, directory, adapter } = await fixture();
		vi.mocked(adapter.dispatch).mockImplementation(async (run) => {
			const saved = JSON.parse(
				await readFile(join(directory, "state.json"), "utf8"),
			);
			expect(saved.runs[0].id).toBe(run.id);
			return { status: "running" };
		});
		const definition = await service.save(input());
		const before = definition.nextRunAt;
		const [a, b] = await Promise.all([
			service.runNow(definition.id, "same"),
			service.runNow(definition.id, "same"),
		]);
		expect(a.id).toBe(b.id);
		await dispatched(service, definition.id);
		expect(adapter.dispatch).toHaveBeenCalledTimes(1);
		expect(service.get(definition.id).nextRunAt).toBe(before);
	});
	it("skips overlap until a terminal outcome and preserves the run's configuration snapshot", async () => {
		const { service } = await fixture();
		const definition = await service.save(input());
		const first = await service.runNow(definition.id, "one");
		await dispatched(service, definition.id);
		await service.save(
			input({ name: "Changed" }),
			definition.id,
			definition.revision,
		);
		await service.update(first.id, { status: "awaiting_input" });
		const second = await service.runNow(definition.id, "two");
		expect(second.status).toBe("skipped");
		expect(
			service.runs(definition.id).find((r) => r.id === first.id)?.snapshot.name,
		).toBe("Update documentation");
		await service.update(first.id, { status: "succeeded" });
		expect((await service.runNow(definition.id, "three")).status).toBe(
			"dispatching",
		);
	});
	it("deduplicates ticks, advances the schedule and ignores clock rollback", async () => {
		const { service, adapter } = await fixture();
		const definition = await service.save(input());
		await Promise.all([
			service.tick(definition.nextRunAt!),
			service.tick(definition.nextRunAt!),
		]);
		await dispatched(service, definition.id);
		await service.tick(definition.nextRunAt! - 60000);
		await service.tick(definition.nextRunAt!);
		expect(adapter.dispatch).toHaveBeenCalledTimes(1);
		expect(service.runs(definition.id)).toHaveLength(1);
	});
	it("skips missed periods once and never catches up in a burst", async () => {
		const { service, adapter } = await fixture();
		const definition = await service.save(input());
		const later = definition.nextRunAt! + 5 * 86400000;
		await service.tick(later, true);
		expect(service.runs(definition.id)).toHaveLength(1);
		expect(service.runs(definition.id)[0].status).toBe("skipped");
		expect(service.get(definition.id).nextRunAt).toBeGreaterThan(later);
		expect(adapter.dispatch).not.toHaveBeenCalled();
	});
	it("marks missed one-shot appointments and supports manual execution afterwards", async () => {
		const { service } = await fixture();
		const at = Date.now() + 10000;
		const definition = await service.save(
			input({ schedule: { kind: "once", at: new Date(at).toISOString() } }),
		);
		await service.tick(at + 60001);
		expect(service.get(definition.id)).toMatchObject({
			enabled: false,
			nextRunAt: null,
			scheduleState: "missed",
		});
		expect((await service.runNow(definition.id, "manual")).status).toBe(
			"dispatching",
		);
	});
	it("rejects stale edits and preserves history when archived", async () => {
		const { service } = await fixture();
		const definition = await service.save(input());
		await service.runNow(definition.id, "one");
		const paused = await service.setEnabled(
			definition.id,
			definition.revision,
			false,
		);
		await expect(
			service.save(input(), definition.id, definition.revision),
		).rejects.toMatchObject({ statusCode: 409 });
		const archived = await service.setEnabled(
			definition.id,
			paused.revision,
			false,
			true,
		);
		expect(archived.scheduleState).toBe("archived");
		await expect(service.runNow(definition.id, "two")).rejects.toMatchObject({
			statusCode: 404,
		});
		expect(service.runs(definition.id)).toHaveLength(1);
	});
	it("does not re-dispatch unknown work after restart", async () => {
		const { service, directory } = await fixture();
		const definition = await service.save(input());
		await service.runNow(definition.id, "one");
		await dispatched(service, definition.id);
		await service.stop();
		const dispatch = vi.fn();
		const restarted = new AutomationService(new AutomationStore(directory), {
			validate: async () => {},
			dispatch,
			reconcile: async () => ({ status: "uncertain" }),
		});
		await restarted.start(false);
		cleanups.push(() => restarted.stop());
		expect(dispatch).not.toHaveBeenCalled();
		expect(restarted.runs(definition.id)[0].status).toBe("uncertain");
		expect((await restarted.runNow(definition.id, "two")).status).toBe(
			"skipped",
		);
	});
	it("permanent validation errors fail without dispatch or retry", async () => {
		const { service, adapter } = await fixture();
		const definition = await service.save(input());
		vi.mocked(adapter.validate).mockRejectedValue(
			new AutomationError("Connection removed"),
		);
		await service.runNow(definition.id, "one");
		await dispatched(service, definition.id);
		expect(service.runs(definition.id)[0]).toMatchObject({
			status: "failed",
			attempts: 1,
		});
		expect(adapter.dispatch).not.toHaveBeenCalled();
	});
	it("never overwrites completion that arrives before dispatch returns", async () => {
		const { service, adapter } = await fixture();
		vi.mocked(adapter.dispatch).mockImplementation(async (run) => {
			await service.update(run.id, { status: "succeeded" });
			return { status: "waiting_session" };
		});
		const definition = await service.save(input());
		await service.runNow(definition.id, "one");
		await dispatched(service, definition.id);
		expect(service.runs(definition.id)[0].status).toBe("succeeded");
	});
	it("enforces one owner and refuses malformed persisted state", async () => {
		const { directory, service } = await fixture();
		await expect(new AutomationStore(directory).open()).rejects.toThrow(
			"Another worker",
		);
		await service.stop();
		await writeFile(join(directory, "state.json"), "broken");
		await expect(new AutomationStore(directory).open()).rejects.toThrow();
	});
	it("ignores stale reconciliation after a live completion", async () => {
		const { service, adapter } = await fixture();
		const definition = await service.save(input());
		const run = await service.runNow(definition.id, "one");
		await dispatched(service, definition.id);
		vi.mocked(adapter.reconcile).mockImplementation(async () => {
			await service.update(run.id, {
				status: "succeeded",
				message: "Verified",
			});
			return { status: "running" };
		});
		expect(await service.reconcile(run.id)).toMatchObject({
			status: "succeeded",
			message: "Verified",
		});
	});
	it("fails closed when durable replacement fails before dispatch", async () => {
		const { service, directory, adapter } = await fixture();
		const definition = await service.save(input());
		await rm(join(directory, "state.json"));
		await mkdir(join(directory, "state.json"));
		await expect(service.runNow(definition.id, "one")).rejects.toThrow();
		expect(service.list().error).toContain("storage failed");
		await service.tick(definition.nextRunAt!);
		expect(adapter.dispatch).not.toHaveBeenCalled();
		expect(service.runs(definition.id)).toEqual([]);
	});
	it("retries transient Linear dispatch with the same durable identity", async () => {
		const { service, adapter } = await fixture();
		const definition = await service.save(
			input({
				target: { kind: "linear_issue", workspaceId: "ws", teamId: "team" },
			}),
		);
		vi.mocked(adapter.dispatch)
			.mockRejectedValueOnce(new Error("Response lost"))
			.mockResolvedValue({ status: "waiting_session" });
		await service.runNow(definition.id, "one");
		await vi.waitFor(
			() =>
				expect(service.runs(definition.id)[0].status).toBe("waiting_session"),
			{ timeout: 4000 },
		);
		const calls = vi.mocked(adapter.dispatch).mock.calls;
		expect(calls).toHaveLength(2);
		expect(calls[0][0].issueId).toBe(calls[1][0].issueId);
		expect(calls[0][0].id).toBe(calls[1][0].id);
	});
	it("never retries a direct task after an ambiguous launch", async () => {
		const { service, adapter } = await fixture();
		const definition = await service.save(input());
		vi.mocked(adapter.dispatch).mockRejectedValue(
			new Error("Process connection lost"),
		);
		await service.runNow(definition.id, "one");
		await dispatched(service, definition.id);
		expect(adapter.dispatch).toHaveBeenCalledTimes(1);
		expect(service.runs(definition.id)[0].status).toBe("uncertain");
	});
	it("will not clear a run whose execution is still active", async () => {
		const { service, adapter } = await fixture();
		const definition = await service.save(input());
		const run = await service.runNow(definition.id, "one");
		await dispatched(service, definition.id);
		await service.update(run.id, { status: "uncertain" });
		vi.mocked(adapter.reconcile).mockResolvedValue({ status: "running" });
		await expect(service.confirmEnded(run.id)).rejects.toMatchObject({
			statusCode: 409,
		});
		expect(service.runs(definition.id)[0].status).toBe("running");
	});
});
