// Background-bash detection probe for CYPACK-1310 follow-up.
// Has the agent start a long-running command in the background, then end its
// turn, and logs exactly what the Stop hook reports in background_tasks +
// the subprocess lifecycle. Usage: node bgbash-lab.mjs <variant>
//   variant=runbg   -> instruct the agent to use Bash run_in_background:true
//   variant=amp     -> instruct the agent to launch with a trailing &
import { execSync } from "node:child_process";

const SDK_PATH = process.env.SDK_PATH;
const { query } = await import(`${SDK_PATH}/sdk.mjs`);

const variant = process.argv[2] || "runbg";
const T0 = Date.now();
function log(kind, data) {
	console.log(
		JSON.stringify({ t: ((Date.now() - T0) / 1000).toFixed(2), kind, data }),
	);
}

class Input {
	queue = [];
	waiters = [];
	done = false;
	push(m) {
		this.queue.push(m);
		for (const w of this.waiters.splice(0)) w();
	}
	complete() {
		this.done = true;
		for (const w of this.waiters.splice(0)) w();
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

const prompt =
	variant === "amp"
		? "Run this exact bash command and then immediately end your turn: `sleep 120 &`. Do not wait for it. Reply with exactly STARTED."
		: "Use the Bash tool with run_in_background set to true to run `sleep 120`. Then immediately end your turn. Reply with exactly STARTED.";

const input = new Input();
input.push({
	type: "user",
	message: { role: "user", content: [{ type: "text", text: prompt }] },
	parent_tool_use_id: null,
	session_id: "",
});

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
		allowedTools: ["Bash", "BashOutput"],
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
								last_assistant_message: hookInput.last_assistant_message,
							});
							return {};
						},
					],
				},
			],
		},
	},
});

let closed = false;
(async () => {
	try {
		for await (const m of q) {
			const summary = { type: m.type, subtype: m.subtype };
			if (m.type === "result") summary.result = String(m.result).slice(0, 80);
			if (m.subtype === "session_state_changed") summary.state = m.state;
			if (m.type === "assistant")
				summary.content = (m.message?.content || [])
					.map((c) => c.type + (c.name ? `:${c.name}` : ""))
					.join(",");
			if (m.type === "system" && m.subtype !== "thinking_tokens")
				log("msg", summary);
			else if (m.type !== "system") log("msg", summary);
			// Dump any task-notification-ish messages verbatim
			if (
				m.type?.includes("task") ||
				m.subtype?.includes("task") ||
				m.type === "task_notification"
			) {
				log("TASK_MSG", m);
			}
			if (m.type === "result" && !closed) {
				closed = true;
				// Mirror cold-mode: complete the input shortly after result.
				setTimeout(() => input.complete(), 1000);
			}
		}
		log("for_await_ended", {});
	} catch (e) {
		log("query_error", { message: String(e?.message || e) });
	}
})();

const hardCap = setTimeout(() => {
	log("hard_cap_exit", {});
	process.exit(0);
}, 60000);
let emptySince = null;
setInterval(() => {
	if (!closed) return;
	if (lastChildren === "") {
		emptySince ??= Date.now();
		if (Date.now() - emptySince > 6000) {
			log("lab_done", {});
			clearInterval(watcher);
			clearTimeout(hardCap);
			process.exit(0);
		}
	} else emptySince = null;
}, 500);
