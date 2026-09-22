// The API bounds the loaded window to 650 live / 100 archived entries.
// Pair only explicit IDs in the same Atmiko and runner session. Old archives
// without IDs keep standalone results rather than guessing which tool ran.
export function activityRows(logs) {
	const rows = [],
		pending = new Map(),
		occurrences = new Map();
	for (const log of logs) {
		const identity = JSON.stringify([
			log.sessionId,
			log.issue,
			log.at,
			log.kind,
			log.toolCallId,
			log.text,
		]);
		const occurrence = occurrences.get(identity) || 0;
		occurrences.set(identity, occurrence + 1);
		const pairKey =
			log.sessionId && log.toolCallId
				? JSON.stringify([log.sessionId, log.toolCallId])
				: null;
		if (log.kind === "output" && pairKey && pending.get(pairKey)?.length) {
			const row = pending.get(pairKey).shift();
			row.output = log;
			if (
				row.level !== "error" &&
				(log.level === "error" || log.level === "warning")
			)
				row.level = log.level;
			continue;
		}
		const separator = log.text.indexOf("\n");
		const row = {
			key: `${identity}:${occurrence}`,
			log,
			level: log.level,
			name:
				log.kind === "tool"
					? separator < 0
						? log.text
						: log.text.slice(0, separator)
					: "",
			input:
				log.kind === "tool" && separator >= 0
					? log.text.slice(separator + 1)
					: "",
		};
		rows.push(row);
		if (log.kind === "tool" && pairKey) {
			if (!pending.has(pairKey)) pending.set(pairKey, []);
			pending.get(pairKey).push(row);
		}
	}
	return rows;
}

export function rowLabel(row) {
	if (row.log.source !== "agent") return "ATMIKO";
	return (
		{
			tool: "TOOL",
			output: "RESULT",
			lifecycle: "TURN",
			activity: "ASSISTANT",
		}[row.log.kind] || "EVENT"
	);
}

export function visibleRows(rows, query, errorsOnly) {
	const needle = query.trim().toLowerCase();
	return rows.filter(
		(row) =>
			(!errorsOnly || row.level === "error") &&
			(!needle ||
				[rowLabel(row), row.log.issue, row.log.text, row.output?.text]
					.join("\n")
					.toLowerCase()
					.includes(needle)),
	);
}

export function activityStats(logs) {
	const times = logs.map((log) => log.at).filter(Number.isFinite);
	return {
		span:
			times.length > 1
				? Math.max(0, Math.max(...times) - Math.min(...times))
				: 0,
		calls: logs.filter((log) => log.kind === "tool").length,
		errors: activityRows(logs).filter((row) => row.level === "error").length,
	};
}

export function formatSpan(ms) {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return minutes < 60
		? `${minutes}m ${seconds % 60}s`
		: `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
