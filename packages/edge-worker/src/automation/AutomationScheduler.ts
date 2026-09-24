import { CronExpressionParser } from "cron-parser";
import { AutomationError, type AutomationInput } from "./types.js";

export function nextOccurrence(
	input: Pick<AutomationInput, "schedule" | "timezone">,
	after: number,
): number | null {
	try {
		new Intl.DateTimeFormat("en", { timeZone: input.timezone }).format(after);
		const schedule = input.schedule;
		if (schedule.kind === "once") {
			const at = Date.parse(schedule.at);
			return at > after ? at : null;
		}
		const expression =
			schedule.kind === "cron"
				? schedule.expression
				: (() => {
						const [hour, minute] = schedule.time.split(":").map(Number);
						return `${minute} ${hour} * * ${schedule.kind === "weekly" ? schedule.days.join(",") : "*"}`;
					})();
		if (expression.trim().split(/\s+/).length !== 5)
			throw new Error("Use a five-field cron expression");
		return CronExpressionParser.parse(expression, {
			tz: input.timezone,
			currentDate: after,
		})
			.next()
			.getTime();
	} catch (error) {
		throw new AutomationError(
			`Invalid schedule: ${error instanceof Error ? error.message : error}`,
		);
	}
}
export function previewSchedule(
	input: Pick<AutomationInput, "schedule" | "timezone">,
	now = Date.now(),
): number[] {
	const result: number[] = [];
	let cursor = now;
	for (let i = 0; i < 5; i++) {
		const next = nextOccurrence(input, cursor);
		if (next === null) break;
		result.push(next);
		cursor = next;
	}
	return result;
}

export class AutomationScheduler {
	private timer?: ReturnType<typeof setInterval>;
	private previous = 0;
	constructor(
		private tick: (now: number, missed: boolean) => Promise<void>,
		private onError: (error: unknown) => void,
	) {}
	start() {
		this.previous = Date.now();
		this.timer = setInterval(() => {
			const now = Date.now();
			const missed = now - this.previous > 60000;
			this.previous = now;
			void this.tick(now, missed).catch(this.onError);
		}, 1000);
		this.timer.unref();
	}
	stop() {
		clearInterval(this.timer);
	}
}
