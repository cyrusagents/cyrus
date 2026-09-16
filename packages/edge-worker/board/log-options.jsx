import { useEffect, useRef } from "react";
import { formatSpan } from "./activity-model.mjs";

export function LogOptions({
	source,
	errorsOnly,
	follow,
	wrap,
	paused,
	refreshing,
	taskDetail,
	stats,
	entries,
	onControlsChange,
	onPause,
	onRefresh,
	onClearTask,
}) {
	const options = useRef(null);
	useEffect(() => {
		function close(event) {
			const element = options.current;
			if (!element?.open) return;
			if (event.type === "keydown") {
				if (event.key !== "Escape") return;
				element.open = false;
				element.querySelector("summary").focus();
			} else if (!element.contains(event.target)) element.open = false;
		}
		document.addEventListener("pointerdown", close);
		document.addEventListener("keydown", close);
		return () => {
			document.removeEventListener("pointerdown", close);
			document.removeEventListener("keydown", close);
		};
	}, []);
	const filtered = source !== "all" || errorsOnly;
	return (
		<details className="log-options" ref={options}>
			<summary
				aria-label="Log options"
				title={`Log options${filtered ? " · Filters active" : ""}${paused ? " · Display paused" : ""}`}
			>
				<svg viewBox="0 0 24 24" aria-hidden="true">
					<circle cx="5" cy="12" r="1.7" />
					<circle cx="12" cy="12" r="1.7" />
					<circle cx="19" cy="12" r="1.7" />
				</svg>
				{(filtered || paused) && <i className="options-indicator" />}
			</summary>
			<div className="options-panel">
				<label className="source-option">
					Source
					<select
						aria-label="Log source"
						value={source}
						onChange={(event) =>
							onControlsChange({ source: event.target.value })
						}
					>
						<option value="all">All sources</option>
						<option value="agent">Agent activity</option>
						<option value="cyrus">Cyrus logs</option>
					</select>
				</label>
				{[
					["errorsOnly", "Errors only", errorsOnly],
					["wrap", "Wrap details", wrap],
					["follow", "Follow", follow],
				].map(([key, label, checked]) => (
					<label className="toggle" key={key}>
						<input
							type="checkbox"
							checked={checked}
							onChange={(event) =>
								onControlsChange({ [key]: event.target.checked })
							}
						/>
						{label}
					</label>
				))}
				<div className="option-actions">
					<button type="button" onClick={onPause}>
						{paused ? "Resume updates" : "Pause updates"}
					</button>
					<button type="button" onClick={onRefresh} disabled={refreshing}>
						{refreshing ? "Refreshing…" : "Refresh now"}
					</button>
				</div>
				{taskDetail && (
					<div className="option-task">
						<p>{taskDetail}</p>
						<button type="button" onClick={onClearTask}>
							Show all tasks
						</button>
					</div>
				)}
				<div
					className="activity-stats"
					title="Statistics for loaded entries, including idle gaps; not lifetime totals."
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
					<span>{entries} entries</span>
				</div>
			</div>
		</details>
	);
}
