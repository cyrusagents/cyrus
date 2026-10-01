import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	AutomationLatency,
	type LatencySnapshot,
} from "../src/automations/Latency.js";
import { PrivateLatencyRetention } from "../src/automations/LatencyRetention.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
const directories: string[] = [];
const directory = () => {
	const path = mkdtempSync(join(tmpdir(), "cyrus-latency-test-"));
	directories.push(path);
	return path;
};
const sample = (attempt = 1): LatencySnapshot => ({
	version: 1,
	retention: "process-memory",
	attempt,
	elapsedMs: 100,
	finished: true,
	droppedSpans: 0,
	spans: [
		{
			stage: "authorize.admit",
			startMs: 0,
			durationMs: 50,
			hosted: { cyrus_total: { durationMs: 40 } },
		},
	],
});
afterEach(() => {
	for (const path of directories.splice(0))
		rmSync(path, { recursive: true, force: true });
});

describe("private optional finished latency retention", () => {
	it("survives a new collector, namespaces workspaces, and never restores authority or an active trace", () => {
		const path = directory();
		const first = new AutomationLatency(
			new PrivateLatencyRetention(path, "workspace-private"),
		);
		const trace = first.claimed("occurrence-private", 1, performance.now());
		trace.mark("native.started");
		expect(
			new AutomationLatency(
				new PrivateLatencyRetention(path, "workspace-private"),
			).snapshot("occurrence-private"),
		).toBeUndefined();
		first.completed("occurrence-private", trace);
		const second = new AutomationLatency(
			new PrivateLatencyRetention(path, "workspace-private"),
		);
		expect(second.snapshot("occurrence-private")).toEqual({
			...first.snapshot("occurrence-private"),
			retention: "private-disk",
		});
		expect(
			new AutomationLatency(
				new PrivateLatencyRetention(path, "other-workspace"),
			).snapshot("occurrence-private"),
		).toBeUndefined();
		const retry = second.claimed("occurrence-private", 2, performance.now());
		expect(
			second.snapshot("occurrence-private")!.spans.map((s) => s.stage),
		).toEqual(["ledger.claim"]);
		expect(second.snapshot("occurrence-private")!.finished).toBe(false);
		second.completed("occurrence-private", retry);
		expect(
			new PrivateLatencyRetention(path, "workspace-private").read(
				"occurrence-private",
			)!.attempt,
		).toBe(2);
		for (const name of readdirSync(path)) {
			const body = readFileSync(join(path, name));
			expect(body.includes(Buffer.from("workspace-private"))).toBe(false);
			expect(body.includes(Buffer.from("occurrence-private"))).toBe(false);
			expect(statSync(join(path, name)).mode & 0o777).toBe(0o600);
		}
	});
	it("bounds count, expires after 24h, and does not let stale writers replace a newer attempt", () => {
		const path = directory();
		let now = 100000;
		const store = new PrivateLatencyRetention(path, "workspace", () => now);
		store.save("old", sample(2));
		store.save("old", sample(1));
		expect(store.read("old")!.attempt).toBe(2);
		for (let n = 0; n < 64; n++) store.save(`run-${n}`, sample());
		expect(store.read("old")).toBeUndefined();
		expect(store.read("run-63")).toBeDefined();
		now += 24 * 60 * 60 * 1000;
		expect(store.read("run-63")).toBeUndefined();
	});
	it("rejects extra fields, unknown stages, invalid hosted metrics, unfinished and nonfinite snapshots", () => {
		const store = new PrivateLatencyRetention(directory(), "workspace");
		for (const bad of [
			{ ...sample(), prompt: "private" },
			{ ...sample(), finished: false },
			{ ...sample(), elapsedMs: Infinity },
			{ ...sample(), spans: [{ stage: "private-tool", startMs: 0 }] },
			{
				...sample(),
				spans: [{ stage: "result", startMs: 0, hosted: { token: "private" } }],
			},
			{ ...sample(), spans: Array(129).fill({ stage: "result", startMs: 0 }) },
		]) {
			store.save("invalid", bad as LatencySnapshot);
			expect(store.read("invalid")).toBeUndefined();
		}
	});
	it("treats unsafe directories/files, corrupt data and lock contention as unavailable without affecting work", () => {
		const path = directory(),
			target = join(path, "target");
		writeFileSync(target, "untouched", { mode: 0o600 });
		const file = join(
			path,
			`${createHash("sha256").update("workspace").digest("hex")}.sqlite`,
		);
		symlinkSync(target, file);
		const store = new PrivateLatencyRetention(path, "workspace");
		store.save("run", sample());
		expect(store.read("run")).toBeUndefined();
		expect(readFileSync(target, "utf8")).toBe("untouched");
		rmSync(file);
		chmodSync(path, 0o755);
		store.save("run", sample());
		expect(store.read("run")).toBeUndefined();
		chmodSync(path, 0o700);
		store.save("run", sample());
		const db = new DatabaseSync(file);
		try {
			db.exec("BEGIN IMMEDIATE");
			expect(() => store.save("locked", sample())).not.toThrow();
			db.exec("ROLLBACK");
			expect(store.read("locked")).toBeUndefined();
			db.prepare("UPDATE traces SET body=?").run(
				JSON.stringify([{ ...sample(), token: "not diagnostic" }]),
			);
			expect(store.read("run")).toBeUndefined();
		} finally {
			db.close();
		}
	});
	it("keeps the byte bound even for maximum hosted spans", () => {
		const path = directory(),
			store = new PrivateLatencyRetention(path, "workspace");
		const hosted = Object.fromEntries(
			[
				"auth",
				"body",
				"event",
				"admit",
				"commit",
				"callback",
				"interrupt",
				"total",
			].map((n) => [`cyrus_${n}`, { durationMs: 600000, flag: "capped" }]),
		);
		const large = {
			...sample(),
			spans: Array(128).fill({
				stage: "authorize.admit",
				startMs: 1,
				durationMs: 600000,
				hosted,
			}),
		} as LatencySnapshot;
		for (let n = 0; n < 70; n++) store.save(`run-${n}`, large);
		expect(store.read("run-69")).toBeDefined();
		expect(store.read("run-0")).toBeUndefined();
		const file = join(path, readdirSync(path)[0]!);
		expect(statSync(file).size).toBeLessThanOrEqual(4 * 1024 * 1024);
		const db = new DatabaseSync(file);
		try {
			expect(
				Buffer.byteLength(db.prepare("SELECT body FROM traces").get().body),
			).toBeLessThanOrEqual(2 * 1024 * 1024);
		} finally {
			db.close();
		}
	});
	it("ignores diagnostic store failure even during completed attempt handling", () => {
		const records = new AutomationLatency({
			save() {
				throw new Error("private disk error");
			},
			readMany() {
				throw new Error("private disk error");
			},
		});
		const trace = records.claimed("run", 1, performance.now());
		expect(() => records.completed("run", trace)).not.toThrow();
		expect(records.snapshot("run")!.finished).toBe(true);
		expect(records.snapshot("missing")).toBeUndefined();
	});
});
