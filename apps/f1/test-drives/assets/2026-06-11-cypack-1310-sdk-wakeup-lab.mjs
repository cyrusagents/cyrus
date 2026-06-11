// SDK learning-test harness for CYPACK-1310 follow-up.
// Usage: node lab.mjs <name> <wakeup:1|0> <mode:close|hold> [holdMs]
//   wakeup=1  -> agent is told to call ScheduleWakeup(delaySeconds=60)
//   mode=close -> complete the streaming input ~1s after the first result message
//   mode=hold  -> keep the input stream open for holdMs (default 150000), then complete
// Logs every SDK message, Stop-hook input, and the CLI child PID lifecycle as NDJSON on stdout.
import { execSync } from "node:child_process";

const SDK_PATH = process.env.SDK_PATH;
const { query } = await import(SDK_PATH + "/sdk.mjs");

const [name, wakeupArg, mode, holdMsArg] = process.argv.slice(2);
const WAKEUP = wakeupArg === "1";
const HOLD_MS = Number(holdMsArg || 150000);
const T0 = Date.now();

function log(kind, data) {
	console.log(
		JSON.stringify({ t: ((Date.now() - T0) / 1000).toFixed(2), kind, data }),
	);
}

// --- async streaming input we control ---
class Input {
	queue = [];
	waiters = [];
	done = false;
	push(m) {
		this.queue.push(m);
		this.waiters.splice(0).forEach((w) => w());
	}
	complete() {
		this.done = true;
		this.waiters.splice(0).forEach((w) => w());
		log("input_completed", {});
	}
	async *[Symbol.asyncIterator]() {
		for (;;) {
			while (this.queue.length) yield this.queue.shift();
			if (this.done) return;
			await new Promise((r) => this.waiters.push(r));
		}
	}
}

const promptText = WAKEUP
	? "Call the ScheduleWakeup tool exactly once with delaySeconds=60, reason='sdk lab', prompt='WAKEUP: reply with exactly WOKE and end your turn.'. Then reply with exactly SCHEDULED and end your turn. Do not use any other tool."
	: "Reply with exactly HELLO and end your turn. Do not use any tools.";

const input = new Input();
input.push({
	type: "user",
	message: { role: "user", content: [{ type: "text", text: promptText }] },
	parent_tool_use_id: null,
	session_id: "",
});

// --- child process watcher (the CLI is spawned as a child of this node process) ---
let lastChildren = "";
const watcher = setInterval(() => {
	let cur = "";
	try {
		cur = execSync(`pgrep -P ${process.pid} || true`, { encoding: "utf8" })
			.trim()
			.split("\n")
			.filter(Boolean)
			.join(",");
	} catch {}
	if (cur !== lastChildren) {
		log("children_changed", { from: lastChildren, to: cur });
		lastChildren = cur;
	}
}, 300);

const q = query({
	prompt: input,
	options: {
		cwd: "/tmp/sdk-wakeup-lab/ws",
		model: "sonnet",
		maxTurns: 10,
		allowedTools: ["ScheduleWakeup"],
		systemPrompt: { type: "preset", preset: "claude_code" },
		settingSources: [],
		hooks: {
			Stop: [
				{
					hooks: [
						async (hookInput) => {
							log("STOP_HOOK", {
								background_tasks: hookInput.background_tasks,
								session_crons: hookInput.session_crons,
								stop_hook_active: hookInput.stop_hook_active,
								last_assistant_message: hookInput.last_assistant_message,
							});
							return { continue: true };
						},
					],
				},
			],
		},
	},
});

let resultCount = 0;
let closed = false;
(async () => {
	try {
		for await (const m of q) {
			const summary = { type: m.type, subtype: m.subtype };
			if (m.type === "result") summary.result = String(m.result).slice(0, 120);
			if (m.subtype === "session_state_changed") summary.state = m.state;
			if (m.type === "assistant")
				summary.content = (m.message?.content || [])
					.map((c) => c.type + (c.name ? ":" + c.name : ""))
					.join(",");
			log("msg", summary);
			if (m.type === "result") {
				resultCount++;
				log("RESULT_FULL", m); // capture every field for diffing
				if (mode === "close" && !closed) {
					closed = true;
					setTimeout(() => input.complete(), 1000);
				}
				if (mode === "hold" && resultCount >= 2 && !closed) {
					// second result = post-wakeup turn finished; we can end
					closed = true;
					setTimeout(() => input.complete(), 1000);
				}
			}
		}
		log("for_await_ended", {});
	} catch (e) {
		log("query_error", { message: String(e?.message || e) });
	}
})();

if (mode === "hold") {
	setTimeout(() => {
		if (!closed) {
			closed = true;
			log("hold_timeout_completing_input", {});
			input.complete();
		}
	}, HOLD_MS);
}

// exit when no more children for 8s after input completed (or hard cap)
const hardCap = setTimeout(() => {
	log("hard_cap_exit", {});
	process.exit(0);
}, HOLD_MS + 120000);
let emptySince = null;
setInterval(() => {
	if (!closed) return;
	if (lastChildren === "") {
		emptySince ??= Date.now();
		if (Date.now() - emptySince > 8000) {
			log("lab_done", {});
			clearInterval(watcher);
			clearTimeout(hardCap);
			process.exit(0);
		}
	} else emptySince = null;
}, 500);
