import { useEffect, useRef, useState } from "react";

import { isAboveBottom, JumpToBottom } from "./jump-to-bottom.jsx";
import { MonitorLog } from "./viewer-compat.mjs";

const gray = "\x1b[90m",
	reset = "\x1b[0m";
function formatLogs(logs) {
	return `${logs
		.map((log) => {
			const at = log.at
				? new Date(log.at).toLocaleTimeString("en-GB", { hour12: false })
				: "--:--:--";
			const origin =
				log.source === "agent"
					? log.kind === "tool"
						? "TOOL"
						: log.kind === "output"
							? "RESULT"
							: "AGENT"
					: "MIKO";
			const level =
				log.level === "error"
					? "ERROR"
					: log.level === "warning"
						? "WARN"
						: "INFO";
			const color =
				log.level === "error"
					? "\x1b[31m"
					: log.level === "warning"
						? "\x1b[33m"
						: log.kind === "lifecycle"
							? "\x1b[32m"
							: "";
			const prefix =
				gray +
				at +
				"  " +
				origin.padEnd(6) +
				" " +
				level.padEnd(5) +
				" " +
				reset;
			return String(log.text)
				.replace(/\r\n?/g, "\n")
				.split("\n")
				.map(
					(line, index) =>
						(index ? " ".repeat(23) : prefix) + color + line + reset,
				)
				.join("\n");
		})
		.join("\n")}\n`;
}

export function RawLogView({ logs, follow, wrap, scope, onFollow }) {
	const viewer = useRef(null);
	const [aboveBottom, setAboveBottom] = useState(false);
	const text = logs.length ? formatLogs(logs) : "";
	useEffect(() => {
		// Recompute matches when an SSE snapshot replaces the text.
		// stream mode bypasses the static-file search-result cache.
		const search = viewer.current?.searchBarRef.current;
		if (search?.state.keywords && viewer.current?.props.text === (text || "\n"))
			search.search();
	}, [text]);
	useEffect(() => {
		if (follow) viewer.current?.followLatest();
	}, [follow]);
	return (
		<>
			<MonitorLog
				ref={viewer}
				key={scope}
				text={text || "\n"}
				stream
				enableSearch
				enableSearchNavigation
				caseInsensitive
				searchMinCharacters={1}
				enableLineNumbers
				enableMultilineHighlight
				selectableLines
				enableLinks={false}
				follow={follow}
				onScroll={(position) => setAboveBottom(isAboveBottom(position))}
				wrapLines={wrap}
				rowHeight={23}
				extraLines={0}
				lineClassName="viewer-line"
				highlightLineClassName="viewer-selected"
				searchBarClassName="viewer-search"
				className={`viewer-list ${wrap ? "viewer-wrap" : "viewer-nowrap"}`}
				loadingComponent={<div className="empty">Loading logs…</div>}
				internacionalization={{
					searchBar: {
						searchPlaceholder: "Search logs…",
						filterLinesTitle: "Show matching lines only",
						previousButtonTitle: "Previous match (Shift+Enter)",
						nextButtonTitle: "Next match (Enter)",
					},
				}}
			/>
			{aboveBottom && logs.length > 0 && (
				<JumpToBottom
					onClick={() => {
						viewer.current?.followLatest();
						onFollow();
					}}
				/>
			)}
			{!logs.length && (
				<div className="viewer-empty">No logs match these filters.</div>
			)}
		</>
	);
}
