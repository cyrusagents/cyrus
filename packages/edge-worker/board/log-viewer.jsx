import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	activityRows,
	activityStats,
	rowLabel,
	visibleRows,
} from "./activity-model.mjs";
import { selectionText, selectRows } from "./activity-selection.mjs";
import { isAboveBottom, JumpToBottom } from "./jump-to-bottom.jsx";
import { LogOptions } from "./log-options.jsx";
import { RawLogView } from "./raw-log-viewer.jsx";
import { useMarquee } from "./use-marquee.jsx";
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

function ActivityRow({
	row,
	query,
	expanded,
	onToggle,
	showIssue,
	wrap,
	checked,
	onSelect,
}) {
	const { log, output, name, input } = row;
	return (
		<div
			className={`activity-row kind-${log.kind} level-${row.level}${expanded ? " expanded" : ""}${checked ? " row-checked" : ""}${showIssue ? " with-issue" : ""}`}
		>
			<div className="activity-heading">
				<label
					className="row-select"
					title="Select row · Shift-click to select a range"
				>
					<input
						type="checkbox"
						checked={checked}
						aria-label={`Select ${rowLabel(row)} at ${time(log.at)}${row.name ? `: ${row.name}` : ""}`}
						onChange={(event) =>
							onSelect(
								Boolean(event.nativeEvent.shiftKey),
								event.target.checked,
							)
						}
					/>
				</label>
				<button
					type="button"
					className="activity-summary"
					aria-expanded={expanded}
					onClick={(event) => {
						if (event.shiftKey || event.ctrlKey || event.metaKey)
							onSelect(event.shiftKey, !checked);
						else onToggle();
					}}
				>
					<HugeiconsIcon
						icon={ArrowRight01Icon}
						className="activity-chevron"
						size={14}
						strokeWidth={2}
						aria-hidden="true"
						focusable="false"
					/>
					<time
						className="activity-time"
						dateTime={
							Number.isFinite(log.at)
								? new Date(log.at).toISOString()
								: undefined
						}
					>
						{time(log.at)}
					</time>
					<span className={`activity-badge badge-${log.kind}`}>
						{rowLabel(row)}
					</span>
					{showIssue && (
						<span
							className="activity-issue"
							aria-hidden={!log.issue}
							title={log.issue}
						>
							{log.issue || ""}
						</span>
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
					{row.level === "error" && (
						<span className="activity-error">Error</span>
					)}
				</button>
			</div>
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
	{ label: "Atmiko", kinds: ["service"] },
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
	rootElement,
	source,
	paused,
	refreshing,
	taskDetail,
	onControlsChange,
	onPause,
	onRefresh,
	onClearTask,
}) {
	const [mode, setMode] = useState("activity"),
		[query, setQuery] = useState(""),
		[expanded, setExpanded] = useState(null);
	const [selected, setSelected] = useState(new Set()),
		[copyStatus, setCopyStatus] = useState("");
	const [aboveBottom, setAboveBottom] = useState(false);
	const anchor = useRef(null),
		selectAll = useRef(null),
		copyRequest = useRef(0);
	const list = useRef(null),
		rowNodes = useRef(new Map());
	const marquee = useMarquee({
		list,
		rowNodes,
		selected,
		setSelected,
		stopFollowing,
		scope: `${scope}|${query}|${mode}`,
	});
	const cancelMarquee = marquee.cancel;
	const clearSelection = useCallback(() => {
		cancelMarquee();
		setSelected(new Set());
		anchor.current = null;
		copyRequest.current++;
		setCopyStatus("");
	}, [cancelMarquee]);
	const hasMarquee = Boolean(marquee.box);
	useEffect(() => {
		function onEscape(event) {
			if (
				event.key !== "Escape" ||
				event.isComposing ||
				mode !== "activity" ||
				(!selected.size && !hasMarquee)
			)
				return;
			event.preventDefault();
			clearSelection();
		}
		document.addEventListener("keydown", onEscape);
		return () => document.removeEventListener("keydown", onEscape);
	}, [mode, selected.size, hasMarquee, clearSelection]);
	const rows = useMemo(() => activityRows(logs), [logs]);
	const stats = useMemo(() => activityStats(logs), [logs]);
	const visible = useMemo(
		() => visibleRows(rows, query, errorsOnly),
		[rows, query, errorsOnly],
	);
	const selectedCount = visible.filter((row) => selected.has(row.key)).length;
	const copyText = useMemo(
		() => selectionText(visible, selected),
		[visible, selected],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Selection belongs to the current task, filters and view.
	useEffect(() => {
		setSelected(new Set());
		anchor.current = null;
	}, [scope, query, mode]);
	useEffect(() => {
		const keys = new Set(visible.map((row) => row.key));
		setSelected((previous) => {
			const retained = new Set([...previous].filter((key) => keys.has(key)));
			return retained.size === previous.size ? previous : retained;
		});
	}, [visible]);
	useEffect(() => {
		if (selectAll.current)
			selectAll.current.indeterminate =
				selectedCount > 0 && selectedCount < visible.length;
	}, [selectedCount, visible.length]);
	useEffect(() => {
		copyRequest.current++;
		setCopyStatus("");
		function copy(event) {
			// Native text selection and editable fields keep their normal copy behavior.
			if (
				!copyText ||
				mode !== "activity" ||
				!event.clipboardData ||
				window.getSelection()?.toString() ||
				event.target.closest?.(
					'input:not([type="checkbox"]), textarea, [contenteditable="true"]',
				)
			)
				return;
			event.clipboardData.setData("text/plain", copyText);
			event.preventDefault();
			setCopyStatus(
				`Copied ${selectedCount} ${selectedCount === 1 ? "row" : "rows"}`,
			);
		}
		rootElement.addEventListener("copy", copy);
		return () => rootElement.removeEventListener("copy", copy);
	}, [copyText, mode, rootElement, selectedCount]);
	function select(row, range, checked) {
		stopFollowing();
		const previousAnchor = anchor.current;
		setSelected((previous) =>
			selectRows(visible, previous, row.key, previousAnchor, range, checked),
		);
		if (!range || !visible.some((item) => item.key === anchor.current))
			anchor.current = row.key;
	}
	async function copySelected() {
		const request = ++copyRequest.current;
		try {
			await navigator.clipboard.writeText(copyText);
			if (request === copyRequest.current)
				setCopyStatus(
					`Copied ${selectedCount} ${selectedCount === 1 ? "row" : "rows"}`,
				);
		} catch {
			if (request === copyRequest.current)
				setCopyStatus(
					"Clipboard unavailable. Press Ctrl+C / ⌘C to copy selected rows.",
				);
		}
	}
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
	// biome-ignore lint/correctness/useExhaustiveDependencies: These changes can alter the list's scroll height without a scroll event.
	useEffect(() => {
		const element = list.current;
		if (mode !== "activity" || !element) return;
		const measure = () => setAboveBottom(isAboveBottom(element));
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [mode, visible, expanded, wrap]);
	function jumpToBottom() {
		setQuery("");
		setExpanded(null);
		if (list.current) list.current.scrollTop = list.current.scrollHeight;
		onControlsChange({ follow: true });
	}
	function jump(key) {
		stopFollowing();
		setExpanded(key);
		rowNodes.current.get(key)?.scrollIntoView({ block: "center" });
	}
	return (
		<>
			<div className="activity-toolbar">
				{mode === "activity" && (
					<label className="select-visible" title="Select all visible rows">
						<input
							ref={selectAll}
							type="checkbox"
							aria-label="Select all visible rows"
							checked={visible.length > 0 && selectedCount === visible.length}
							disabled={!visible.length}
							onChange={(event) => {
								stopFollowing();
								setSelected(
									new Set(
										event.target.checked ? visible.map((row) => row.key) : [],
									),
								);
								anchor.current = null;
							}}
						/>
					</label>
				)}
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
				<select
					className="compact-view-switch"
					aria-label="Log view"
					value={mode}
					onChange={(event) => setMode(event.target.value)}
				>
					<option value="activity">Activity</option>
					<option value="raw">Raw</option>
				</select>
				{mode === "activity" && selectedCount > 0 && (
					<div className="selection-actions">
						<button
							type="button"
							title="Copy selected rows (Ctrl+C / ⌘C)"
							onClick={copySelected}
						>
							Copy ({selectedCount})
						</button>
						{selectedCount > 0 && (
							<button
								type="button"
								title="Clear selection (Esc)"
								aria-keyshortcuts="Escape"
								onClick={clearSelection}
							>
								<span aria-hidden="true">×</span>
								<span className="sr-only">Clear selection</span>
							</button>
						)}
					</div>
				)}
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
				{mode === "raw" && <span className="toolbar-spacer" />}
				<LogOptions
					{...{
						source,
						errorsOnly,
						follow,
						wrap,
						paused,
						refreshing,
						taskDetail,
						stats,
						onControlsChange,
						onPause,
						onRefresh,
						onClearTask,
					}}
					entries={logs.length}
				/>
			</div>
			{copyStatus && (
				<div className="sr-only" role="status">
					{copyStatus}
				</div>
			)}
			{mode === "activity" ? (
				<>
					<Timeline rows={visible} selected={expanded} onSelect={jump} />
					<section
						className={`activity-list${marquee.box ? " marquee-selecting" : ""}`}
						ref={list}
						tabIndex={-1}
						onPointerDown={marquee.onPointerDown}
						onScroll={(event) =>
							setAboveBottom(isAboveBottom(event.currentTarget))
						}
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
										checked={selected.has(row.key)}
										onSelect={(range, checked) => select(row, range, checked)}
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
						{marquee.box && (
							<div
								className="selection-marquee"
								aria-hidden="true"
								style={{
									left: marquee.box.left,
									top: marquee.box.top,
									width: marquee.box.right - marquee.box.left,
									height: marquee.box.bottom - marquee.box.top,
								}}
							/>
						)}
					</section>
					{aboveBottom && <JumpToBottom onClick={jumpToBottom} />}
				</>
			) : (
				<div className="raw-view">
					<RawLogView
						key={scope}
						logs={
							errorsOnly ? logs.filter((log) => log.level === "error") : logs
						}
						follow={follow}
						wrap={wrap}
						scope={scope}
						onFollow={() => onControlsChange({ follow: true })}
					/>
				</div>
			)}
		</>
	);
}

export function createLogViewer(container, { onStopFollowing, ...actions }) {
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
		root.render(
			<LogView
				{...current}
				{...actions}
				rootElement={container}
				stopFollowing={stopFollowing}
			/>,
		);
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
