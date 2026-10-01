import { AsyncLocalStorage } from "node:async_hooks";
import {
	type HostedTiming,
	readHostedTiming,
	type SupervisorTiming,
} from "./HostedTiming.js";

type FinishLatency = ((failed?: boolean, until?: number) => void) & {
	readHosted?: (response: Response) => void;
};

/** Diagnostic data only. No authority, payload, error text, identifier or wall clock. */
const stages = [
	"dispatch.received",
	"dispatch.enqueue",
	"queue.wait",
	"ledger.claim",
	"ledger.bindCheckpoint",
	"attempt",
	"authorize.admit",
	"authorize.renew",
	"progress",
	"result",
	"interrupt",
	"checkpoint.load",
	"authority.check",
	"mcp.queue",
	"mcp.initialize",
	"mcp.catalog",
	"native.snapshot",
	"session.delivery",
	"session.create",
	"session.finalFlush",
	"model.next",
	"container.initialize",
	"native.thread",
	"native.turnStart",
	"native.started",
	"native.activity",
	"native.completed",
	"model.request",
	"provider.headers",
	"provider.body",
	"credential.read",
	"credential.refresh",
	"cleanup",
] as const;
export type LatencyStage = (typeof stages)[number];
const permitted = new Set<string>(stages);
const supervisorStages = new Set<LatencyStage>([
	"authorize.admit",
	"authorize.renew",
	"progress",
	"result",
	"interrupt",
	"session.delivery",
]);
const context = new AsyncLocalStorage<LatencyTrace>();
const MAX_SPANS = 128;
const MAX_TRACES = 64;
const milliseconds = (value: number) =>
	Math.max(0, Math.round(value * 1000) / 1000);
interface Span {
	stage: LatencyStage;
	startMs: number;
	durationMs?: number;
	failed?: true;
	hosted?: HostedTiming;
}
export class LatencyTrace {
	private readonly spans: Span[] = [];
	private dropped = 0;
	private ended?: number;
	constructor(private readonly start: number = performance.now()) {}
	begin(stage: LatencyStage, at = performance.now()): FinishLatency {
		// Enforce the same allowlist at runtime even for an untyped callback caller.
		if (!permitted.has(stage)) return () => {};
		if (this.ended !== undefined || this.spans.length >= MAX_SPANS) {
			this.dropped++;
			return () => {};
		}
		const span: Span = { stage, startMs: milliseconds(at - this.start) };
		this.spans.push(span);
		const finish: FinishLatency = (
			failed = false,
			until = performance.now(),
		) => {
			if (span.durationMs !== undefined) return;
			span.durationMs = milliseconds(until - at);
			if (failed) span.failed = true;
		};
		if (supervisorStages.has(stage))
			finish.readHosted = (response) => {
				const timing = readHostedTiming(response);
				if (timing) span.hosted = timing;
			};
		return finish;
	}
	mark(stage: LatencyStage): void {
		this.begin(stage)();
	}
	run<T>(work: () => T): T {
		return context.run(this, work);
	}
	finish(): void {
		this.ended ??= performance.now();
	}
	snapshot() {
		return {
			version: 1,
			retention: "process-memory" as const,
			elapsedMs: milliseconds((this.ended ?? performance.now()) - this.start),
			finished: this.ended !== undefined,
			droppedSpans: this.dropped,
			spans: this.spans.map((s) => ({
				...s,
				...(s.hosted && { hosted: structuredClone(s.hosted) }),
			})),
		};
	}
}
export function beginLatency(stage: LatencyStage): FinishLatency {
	return context.getStore()?.begin(stage) ?? (() => {});
}
export async function measureLatency<T>(
	stage: LatencyStage,
	work: (timing?: SupervisorTiming) => Promise<T>,
): Promise<T> {
	const end = beginLatency(stage);
	try {
		const value = await work(
			end.readHosted
				? {
						headers: { "X-Cyrus-Latency-Diagnostics": "1" },
						read: end.readHosted,
					}
				: undefined,
		);
		end();
		return value;
	} catch (error) {
		end(true);
		throw error;
	}
}
export function markLatency(stage: LatencyStage): void {
	context.getStore()?.mark(stage);
}

/** Bounded recent traces; keyed internally by existing occurrence identity, never exported in spans. */
export class AutomationLatency {
	private readonly records = new Map<
		string,
		{ trace: LatencyTrace; attempt?: number; queuedAt?: number }
	>();
	private set(
		id: string,
		value: { trace: LatencyTrace; attempt?: number; queuedAt?: number },
	) {
		this.records.delete(id);
		this.records.set(id, value);
		if (this.records.size > MAX_TRACES)
			this.records.delete(this.records.keys().next().value!);
	}
	enqueued(id: string, start: number, receivedAt = start): void {
		if (this.records.has(id)) return; // Idempotent dispatch must not reset an existing trace.
		const trace = new LatencyTrace(receivedAt);
		trace.begin("dispatch.received", receivedAt)(false, receivedAt);
		trace.begin("dispatch.enqueue", start)();
		this.set(id, { trace, queuedAt: performance.now() });
	}
	claimed(
		id: string,
		attempt: number,
		claimStart: number,
		claimEnd = performance.now(),
	): LatencyTrace {
		const prior = this.records.get(id);
		const trace =
			prior?.attempt === undefined && prior
				? prior.trace
				: new LatencyTrace(claimStart);
		if (prior?.queuedAt !== undefined && prior.attempt === undefined)
			trace.begin("queue.wait", prior.queuedAt)(false, claimStart);
		trace.begin("ledger.claim", claimStart)(false, claimEnd);
		this.set(id, { trace, attempt });
		return trace;
	}
	snapshot(id: string) {
		const entry = this.records.get(id);
		return entry
			? { attempt: entry.attempt ?? null, ...entry.trace.snapshot() }
			: undefined;
	}
}
