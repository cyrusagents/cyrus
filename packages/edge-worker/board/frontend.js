import "./layout.css";
import { createLogViewer } from "./log-viewer.jsx";

const $ = (id) => document.getElementById(id);
const names = {
	running: "Running",
	completed: "Turn completed",
	error: "Failed",
	stopped: "Stopped",
	interrupted: "Worker exited",
	unknown: "Unconfirmed",
	idle: "Idle",
};
let latest = null,
	displayed = null,
	selected = null,
	paused = false,
	connected = false,
	taskKey = "";
const viewer = createLogViewer($("logs"), () => {
	$("follow").checked = false;
});
const history = new Map();
async function loadHistory(task) {
	if (!task?.archived || history.has(task.id)) return;
	try {
		const response = await fetch(
			`/board/api/history/${encodeURIComponent(task.id)}`,
			{ cache: "no-store" },
		);
		if (!response.ok) throw Error();
		history.set(task.id, {
			at: task.lastActivityAt,
			logs: (await response.json()).logs,
		});
		if (selected === task.id) renderLogs();
	} catch {
		$("warnings").textContent =
			"Cannot load archived logs. Select the task to retry.";
	}
}
function element(tag, cls, text) {
	const el = document.createElement(tag);
	if (cls) el.className = cls;
	if (text !== undefined) el.textContent = text;
	return el;
}
function clock(value) {
	return value
		? new Date(value).toLocaleTimeString("en", { hour12: false })
		: "—";
}
function ago(value) {
	if (!value) return "Unknown";
	const sec = Math.max(0, Math.floor((Date.now() - value) / 1000));
	if (sec < 60) return `${sec}s ago`;
	if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
	return `${Math.floor(sec / 3600)}h ago`;
}
function duration(value) {
	const min = Math.max(0, Math.floor((Date.now() - value) / 60000));
	return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`;
}
function isStale(data) {
	return (
		!data?.collectedAt ||
		data.stale ||
		Date.now() - Date.parse(data.collectedAt) > 16000
	);
}
function renderConnection() {
	const stale = !connected || isStale(latest),
		state = latest?.service;
	const text = stale
		? "Waiting for updates"
		: paused
			? "Display paused"
			: !state?.online
				? "Cyrus offline"
				: state.status === "busy"
					? "Cyrus busy"
					: "Cyrus idle";
	$("connection").className =
		`connection${stale || !state?.online ? " off" : ""}`;
	$("connection").lastElementChild.textContent = text;
	$("connection").title =
		(stale ? "Waiting for fresh data" : "Live connection") +
		" · Last collected " +
		clock(latest?.collectedAt);
}
function render(data) {
	displayed = data;
	for (const [id, cached] of history) {
		const task = data.tasks?.find((task) => task.id === id);
		if (!task?.archived || task.lastActivityAt !== cached.at)
			history.delete(id);
	}
	renderConnection();
	$("warnings").textContent = (data.warnings || []).join(" ");
	$("task-count").textContent = (data.tasks || []).length;
	renderTasks();
	renderLogs();
	loadHistory(data.tasks?.find((task) => task.id === selected));
}
function renderTasks() {
	const needle = $("task-search").value.trim().toLowerCase(),
		runningOnly = $("running-only").checked;
	const tasks = (displayed?.tasks || []).filter(
		(t) =>
			(!runningOnly || t.status === "running") &&
			(!needle ||
				[t.issue, t.title, t.repositories?.join(" ")]
					.join(" ")
					.toLowerCase()
					.includes(needle)),
	);
	const stale = isStale(displayed);
	const key = JSON.stringify([
		tasks.map((t) => [
			t.id,
			t.issue,
			t.title,
			t.status,
			t.reason,
			t.quiet,
			t.repositories,
			t.lastActivityAt,
			t.status === "running" ? duration(t.turnStartedAt) : null,
		]),
		selected,
		needle,
		runningOnly,
		stale,
	]);
	if (key === taskKey) return;
	taskKey = key;
	$("tasks").replaceChildren();
	if (!tasks.length) {
		$("tasks").append(
			element(
				"div",
				"empty",
				needle
					? "No matching tasks"
					: runningOnly
						? "No confirmed running tasks"
						: "No tasks yet",
			),
		);
		return;
	}
	for (const t of tasks) {
		const b = element("button", `task${selected === t.id ? " selected" : ""}`);
		b.setAttribute("aria-pressed", String(selected === t.id));
		b.title =
			t.reason +
			(t.quiet ? " · No activity for over 2 minutes" : "") +
			"\nSession " +
			t.id;
		const top = element("div", "task-top");
		top.append(
			element("span", "issue", t.issue || "Untitled task"),
			element(
				"span",
				"task-time",
				t.status === "running"
					? duration(t.turnStartedAt)
					: clock(t.lastActivityAt),
			),
		);
		const meta = element("div", "task-meta");
		meta.append(
			element(
				"span",
				"",
				(t.repositories?.join(", ") || "Repository unconfirmed") +
					(t.archived ? " · Archived" : ""),
			),
			element(
				"span",
				`pill ${stale && t.status === "running" ? "unknown" : t.status}`,
				stale && t.status === "running"
					? "Previously running"
					: names[t.status] || t.status,
			),
		);
		b.append(
			top,
			element("div", "task-title", t.title || "Loading task title"),
			meta,
		);
		b.addEventListener("click", () => {
			selected = selected === t.id ? null : t.id;
			renderTasks();
			renderLogs();
			loadHistory(t);
		});
		$("tasks").append(b);
	}
}
function renderLogs() {
	const task = displayed?.tasks?.find((t) => t.id === selected);
	$("detail").replaceChildren();
	$("scope").textContent = task
		? `${task.issue || "Task"} · Logs`
		: "Live logs";
	if (task) {
		$("detail").append(
			element(
				"span",
				"",
				(task.model || "Unknown model") +
					" · " +
					(names[task.status] || task.status) +
					" · Last activity " +
					ago(task.lastActivityAt) +
					(task.archived ? " · Archived · Up to 100 recent entries" : "") +
					(task.quiet ? " · No activity for over 2 minutes" : ""),
			),
		);
	}
	const source = $("source").value;
	const logs = (
		task?.archived ? history.get(task.id)?.logs || [] : displayed?.logs || []
	).filter(
		(l) =>
			(!task ||
				(l.sessionId ? l.sessionId === task.id : l.issue === task.issue)) &&
			(source === "all" || l.source === source),
	);
	$("log-count").textContent = `${logs.length} entries`;
	viewer.update({
		logs,
		follow: $("follow").checked,
		wrap: $("wrap").checked,
		errorsOnly: $("errors").checked,
		showIssue: !task,
		scope: [selected, source, $("errors").checked].join("|"),
	});
}
$("running-only").onchange = renderTasks;
$("task-search").addEventListener("input", renderTasks);
$("clear-task").onclick = () => {
	selected = null;
	renderTasks();
	renderLogs();
};
for (const id of ["source", "errors", "wrap"])
	$(id).addEventListener("input", renderLogs);
$("follow").onchange = renderLogs;
$("pause").onclick = () => {
	paused = !paused;
	$("pause").textContent = paused ? "Resume" : "Pause";
	if (!paused && latest) render(latest);
	else renderConnection();
};
$("refresh").onclick = async () => {
	const b = $("refresh");
	b.disabled = true;
	try {
		const r = await fetch("/board/api/snapshot", { cache: "no-store" });
		if (!r.ok) throw Error();
		latest = await r.json();
		paused = false;
		$("pause").textContent = "Pause";
		render(latest);
	} catch {
		$("warnings").textContent =
			"Cannot reach the monitor. Reconnecting automatically.";
	} finally {
		b.disabled = false;
	}
};
const stream = new EventSource("/board/events");
stream.onopen = () => {
	connected = true;
	renderConnection();
};
stream.onerror = () => {
	connected = false;
	renderConnection();
};
stream.addEventListener("unavailable", () => {
	connected = false;
	renderConnection();
});
stream.onmessage = (event) => {
	try {
		latest = JSON.parse(event.data);
		connected = true;
		if (!paused) render(latest);
	} catch {
		$("warnings").textContent =
			"Incomplete update received. Waiting for the next refresh.";
	}
};
setInterval(() => {
	renderConnection();
	if (!paused && displayed && isStale(displayed)) renderTasks();
}, 3000);
