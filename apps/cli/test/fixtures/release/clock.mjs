import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const clockPath = `${process.env.FAKE_RELEASE_ROOT}/clock`;
const eventsPath = `${process.env.FAKE_RELEASE_ROOT}/events`;
const originalNow = performance.now.bind(performance);
Object.defineProperty(performance, "now", {
	value: () => originalNow() + Number(readFileSync(clockPath, "utf8")),
});
const originalTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, ms, ...args) => {
	if (ms === 10000 || ms > 30000) {
		appendFileSync(eventsPath, `${JSON.stringify({ command: "sleep", ms })}\n`);
		writeFileSync(
			clockPath,
			String(
				Number(readFileSync(clockPath, "utf8")) +
					Number(process.env.FAKE_CLOCK_TICK || ms),
			),
		);
		return originalTimeout(callback, 0, ...args);
	}
	return originalTimeout(callback, ms, ...args);
};
