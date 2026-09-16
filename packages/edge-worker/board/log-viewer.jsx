import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	activityRows,
	activityStats,
	formatSpan,
	rowLabel,
	visibleRows,
} from "./activity-model.mjs";
import { RawLogView } from "./raw-log-viewer.jsx";
import "./viewer.css";

function time(at) {
	return Number.isFinite(at)
		? new Date(at).toLocaleTimeString("en-GB", { hour12: false })
		: "—";
}

function Highlight({ text = "", query }) {
	const index = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
	return index < 0 ? (
		text
	) : (
		<>
			{text.slice(0, index)}
			<mark>{text.slice(index, index + query.length)}</mark>
			{text.slice(index + query.length)}
		</>
	);
}

function ActivityRow({ row, query, expanded, onToggle, showIssue, wrap }) {
	const { log, output, name, input } = row;
	return (
		<div
			className={`activity-row kind-${log.kind} level-${row.level}${expanded ? " expanded" : ""}`}
		>
			<button
				type="button"
				className="activity-summary"
				aria-expanded={expanded}
				onClick={onToggle}
			>
				<span className="activity-chevron" aria-hidden="true">
					{expanded ? "⌄" : "›"}
				</span>
				<time
					className="activity-time"
					dateTime={
						Number.isFinite(log.at) ? new Date(log.at).toISOString() : undefined
					}
				>
					{time(log.at)}
				</time>
				<span className={`activity-badge badge-${log.kind}`}>
					{rowLabel(row)}
				</span>
				{showIssue && log.issue && (
					<span className="activity-issue">{log.issue}</span>
				)}
				<span className={`activity-preview${name ? " tool-preview" : ""}`}>
					{name ? (
						<>
							<strong className="tool-name">
								<Highlight text={name} query={query} />
							</strong>
							<span className="tool-input">
								<Highlight text={input} query={query} />
							</span>
							{output && (
								<>
									<span className="result-arrow" aria-hidden="true">
										→
									</span>
									<span className="tool-output">
										<Highlight
											text={output.text || "(empty result)"}
											query={query}
										/>
									</span>
								</>
							)}
						</>
					) : (
						<span className="message-preview">
							<Highlight text={log.text || "(empty result)"} query={query} />
						</span>
					)}
				</span>
				{row.level === "error" && <span className="activity-error">Error</span>}
			</button>
			{expanded && (
				<div className={`activity-detail${wrap ? " detail-wrap" : ""}`}>
					{name ? (
						<>
							<div className="detail-label">{name} · Input</div>
							<pre>
								<Highlight
									text={input || "(no input recorded)"}
									query={query}
								/>
							</pre>
							<div className="detail-label">
								{output
									? `Result · ${time(output.at)}`
									: "No result in the loaded logs"}
							</div>
							{output && (
								<pre className={output.level === "error" ? "error-output" : ""}>
									<Highlight
										text={output.text || "(empty result)"}
										query={query}
									/>
								</pre>
							)}
						</>
					) : (
						<pre>
							<Highlight text={log.text || "(empty result)"} query={query} />
						</pre>
					)}
				</div>
			)}
		</div>
	);
}

const lanes = [
	{ label: "Agent", kinds: ["activity", "lifecycle"] },
	{ label: "Tools", kinds: ["tool", "output"] },
	{ label: "Cyrus", kinds: ["service"] },
];
function Timeline({ rows, selected, onSelect }) {
	return (
		<section
			className="activity-timeline"
			aria-label="Activity in recorded order"
			title="Recorded event order. Markers show entries, not execution duration."
		>
			{lanes.map((lane) => (
				<div className="timeline-lane" key={lane.label}>
					<span className="timeline-label">{lane.label}</span>
					<div className="timeline-track">
						{rows.map(
							(row, index) =>
								lane.kinds.includes(row.log.kind) && (
									<button
										type="button"
										key={row.key}
										className={`timeline-event kind-${row.log.kind} level-${row.level}${selected === row.key ? " active" : ""}`}
										style={{
											left: `${(index / rows.length) * 100}%`,
											width: `${100 / rows.length}%`,
										}}
										title={`${time(row.log.at)} · ${rowLabel(row)} · ${row.name || row.log.text.slice(0, 100)}`}
										aria-label={`Jump to event ${index + 1}: ${rowLabel(row)} at ${time(row.log.at)}`}
										onClick={() => onSelect(row.key)}
									/>
								),
						)}
					</div>
				</div>
			))}
		</section>
	);
}

function LogView({
	logs,
	follow,
	wrap,
	scope,
	errorsOnly,
	showIssue,
	stopFollowing,
}) {
	const [mode, setMode] = useState("activity"),
		[query, setQuery] = useState(""),
		[expanded, setExpanded] = useState(null);
	const list = useRef(null),
		rowNodes = useRef(new Map());
	const rows = useMemo(() => activityRows(logs), [logs]);
	const stats = useMemo(() => activityStats(logs), [logs]);
	const visible = useMemo(
		() => visibleRows(rows, query, errorsOnly),
		[rows, query, errorsOnly],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Reset expansion when the selected task or source changes.
	useEffect(() => {
		setExpanded(null);
	}, [scope]);
	useEffect(() => {
		if (follow) {
			setQuery("");
			setExpanded(null);
		}
	}, [follow]);
	useEffect(() => {
		if (follow && mode === "activity" && visible.length && list.current)
			list.current.scrollTop = list.current.scrollHeight;
	}, [follow, visible, mode]);
	function jump(key) {
		stopFollowing();
		setExpanded(key);
		rowNodes.current.get(key)?.scrollIntoView({ block: "center" });
	}
	return (
		<>
			<div className="activity-toolbar">
				<div
					className="activity-stats"
					title="Statistics for the loaded logs. Span is the time between the first and last recorded entries, including idle gaps."
				>
					<span>
						Span <b>{formatSpan(stats.span)}</b>
					</span>
					<span>
						Calls <b>{stats.calls}</b>
					</span>
					<span className={stats.errors ? "has-errors" : ""}>
						Errors <b>{stats.errors}</b>
					</span>
				</div>
				<fieldset className="view-switch" aria-label="Log view">
					{["activity", "raw"].map((value) => (
						<button
							type="button"
							key={value}
							aria-pressed={mode === value}
							onClick={() => setMode(value)}
						>
							{value === "activity" ? "Activity" : "Raw"}
						</button>
					))}
				</fieldset>
				{mode === "activity" && (
					<label className="activity-search">
						<span className="sr-only">Search activity</span>
						<input
							type="search"
							placeholder="Search logs…"
							value={query}
							onChange={(event) => {
								stopFollowing();
								setQuery(event.target.value);
							}}
						/>
						<span className="search-count" aria-live="polite">
							{visible.length}/{rows.length}
						</span>
					</label>
				)}
			</div>
			{mode === "activity" ? (
				<>
					<Timeline rows={visible} selected={expanded} onSelect={jump} />
					<section
						className="activity-list"
						ref={list}
						aria-label="Activity entries"
					>
						{visible.length ? (
							visible.map((row) => (
								<div
									key={row.key}
									ref={(node) => {
										if (node) rowNodes.current.set(row.key, node);
										else rowNodes.current.delete(row.key);
									}}
								>
									<ActivityRow
										row={row}
										query={query.trim()}
										expanded={expanded === row.key}
										showIssue={showIssue}
										wrap={wrap}
										onToggle={() => {
											stopFollowing();
											setExpanded(expanded === row.key ? null : row.key);
										}}
									/>
								</div>
							))
						) : (
							<div className="empty" role="status">
								{logs.length
									? "No logs match these filters."
									: "No logs available yet."}
							</div>
						)}
					</section>
				</>
			) : (
				<div className="raw-view">
					<RawLogView
						logs={
							errorsOnly ? logs.filter((log) => log.level === "error") : logs
						}
						follow={follow}
						wrap={wrap}
						scope={scope}
					/>
				</div>
			)}
		</>
	);
}

export function createLogViewer(container, onStopFollowing) {
	const root = createRoot(container);
	let current,
		signature = "";
	function stopFollowing() {
		if (!current?.follow) return;
		current = { ...current, follow: false };
		signature = "";
		onStopFollowing();
		draw();
	}
	function draw() {
		root.render(<LogView {...current} stopFollowing={stopFollowing} />);
	}
	container.addEventListener(
		"wheel",
		(event) => {
			if (event.deltaY < 0) stopFollowing();
		},
		{ passive: true },
	);
	container.addEventListener("keydown", (event) => {
		if (
			!["INPUT", "TEXTAREA"].includes(event.target.tagName) &&
			["ArrowUp", "PageUp", "Home"].includes(event.key)
		)
			stopFollowing();
	});
	container.addEventListener("input", (event) => {
		if (
			event.target.matches(".react-lazylog-searchbar-input") &&
			event.target.value
		)
			stopFollowing();
	});
	container.addEventListener("pointerdown", (event) => {
		const list = event.target.closest(".react-lazylog, .activity-list");
		if (list && event.clientX >= list.getBoundingClientRect().right - 18)
			stopFollowing();
	});
	return {
		update(props) {
			const nextSignature = JSON.stringify(props);
			if (signature === nextSignature) return;
			signature = nextSignature;
			current = props;
			draw();
		},
	};
}
