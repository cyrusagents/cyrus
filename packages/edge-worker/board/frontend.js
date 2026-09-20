import "./layout.css";
import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
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
	taskKey = "",
	refreshing = false;
const controls = { source: "all", errorsOnly: false, follow: true, wrap: true };
const viewer = createLogViewer($("logs"), {
	onStopFollowing: () => {
		controls.follow = false;
	},
	onControlsChange: (patch) => {
		Object.assign(controls, patch);
		renderLogs();
	},
	onPause: () => {
		paused = !paused;
		if (!paused && latest) render(latest);
		else {
			renderConnection();
			renderLogs();
		}
	},
	onRefresh: refresh,
	onClearTask: () => {
		selected = null;
		renderTasks();
		renderLogs();
	},
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
function fastLabel(task) {
	return task.fastMode === true ? " · Fast" : "";
}

function linearIssueLink(identifier, workspaceSlug) {
	if (!/^[a-z0-9][a-z0-9_-]*$/i.test(workspaceSlug || "")) return null;
	if (!/^[a-z0-9]+-\d+$/i.test(identifier || "")) return null;
	const link = element("a", "task-issue-link");
	link.href = `https://linear.app/${encodeURIComponent(workspaceSlug)}/issue/${encodeURIComponent(identifier)}/`;
	link.target = "_blank";
	link.rel = "noopener noreferrer";
	link.title = `Open ${identifier} in Linear`;
	link.setAttribute("aria-label", `${link.title} (new tab)`);
	const namespace = "http://www.w3.org/2000/svg";
	const icon = document.createElementNS(namespace, "svg");
	icon.setAttribute("viewBox", "0 0 24 24");
	icon.setAttribute("fill", "none");
	icon.setAttribute("aria-hidden", "true");
	icon.setAttribute("focusable", "false");
	for (const [tag, attributes] of ArrowUpRight01Icon) {
		const shape = document.createElementNS(namespace, tag);
		for (const [name, value] of Object.entries(attributes)) {
			if (name !== "key")
				shape.setAttribute(
					name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
					String(value),
				);
		}
		icon.append(shape);
	}
	link.append(icon);
	return link;
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
		text +
		" · " +
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
			t.linearWorkspaceSlug,
			t.title,
			t.model,
			t.reasoningEffort,
			t.fastMode,
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
		const card = element("div", `task${selected === t.id ? " selected" : ""}`);
		const b = element("button", "task-select");
		b.type = "button";
		b.setAttribute("aria-pressed", String(selected === t.id));
		b.setAttribute(
			"aria-label",
			`View logs for ${t.issue || "task"}: ${t.title || "Loading task title"}`,
		);
		b.title =
			t.reason +
			(t.quiet ? " · No activity for over 2 minutes" : "") +
			`\nModel: ${t.model || "Unknown"}` +
			`\nReasoning effort: ${t.reasoningEffort || "Unknown"}` +
			(t.fastMode === true ? "\nFast" : "") +
			"\nSession " +
			t.id;
		const top = element("div", "task-top");
		const identifier = element("div", "task-identifier");
		identifier.append(element("span", "issue", t.issue || "Untitled task"));
		const issueLink = linearIssueLink(t.issue, t.linearWorkspaceSlug);
		if (issueLink) identifier.append(issueLink);
		top.append(
			identifier,
			element(
				"span",
				"task-time",
				t.status === "running"
					? duration(t.turnStartedAt)
					: clock(t.lastActivityAt),
			),
		);
		const meta = element("div", "task-meta");
		const context = element("div", "task-context");
		context.append(
			element(
				"span",
				"task-repository",
				(t.repositories?.join(", ") || "Repository unconfirmed") +
					(t.archived ? " · Archived" : ""),
			),
			element(
				"span",
				"task-model",
				`${t.model || "Model unknown"} · ${t.reasoningEffort || "Effort unknown"}${fastLabel(t)}`,
			),
		);
		meta.append(
			context,
			element(
				"span",
				`pill ${stale && t.status === "running" ? "unknown" : t.status}`,
				stale && t.status === "running"
					? "Previously running"
					: names[t.status] || t.status,
			),
		);
		card.append(
			b,
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
		$("tasks").append(card);
	}
}
function renderLogs() {
	const task = displayed?.tasks?.find((t) => t.id === selected);
	const taskDetail = task
		? `${task.issue || "Task"} · ` +
			(task.model || "Unknown model") +
			" · " +
			(task.reasoningEffort || "Effort unknown") +
			fastLabel(task) +
			" · " +
			(names[task.status] || task.status) +
			" · Last activity " +
			ago(task.lastActivityAt) +
			(task.archived ? " · Archived · Up to 100 recent entries" : "") +
			(task.quiet ? " · No activity for over 2 minutes" : "")
		: "";
	const { source } = controls;
	const logs = (
		task?.archived ? history.get(task.id)?.logs || [] : displayed?.logs || []
	).filter(
		(l) =>
			(!task ||
				(l.sessionId ? l.sessionId === task.id : l.issue === task.issue)) &&
			(source === "all" || l.source === source),
	);
	viewer.update({
		logs,
		...controls,
		paused,
		refreshing,
		taskDetail,
		showIssue: !task,
		scope: [selected, source, controls.errorsOnly].join("|"),
	});
}
$("running-only").onchange = renderTasks;
$("task-search").addEventListener("input", renderTasks);
async function refresh() {
	if (refreshing) return;
	refreshing = true;
	renderLogs();
	try {
		const r = await fetch("/board/api/snapshot", { cache: "no-store" });
		if (!r.ok) throw Error();
		latest = await r.json();
		paused = false;
		render(latest);
	} catch {
		$("warnings").textContent =
			"Cannot reach the monitor. Reconnecting automatically.";
	} finally {
		refreshing = false;
		renderLogs();
	}
}
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
