import { rowLabel } from "./activity-model.mjs";

export function selectRows(rows, selected, key, anchor, range, checked) {
	const next = new Set(selected);
	const end = rows.findIndex((row) => row.key === key);
	if (end < 0) return next;
	const start = range ? rows.findIndex((row) => row.key === anchor) : -1;
	const targets =
		start < 0
			? [rows[end]]
			: rows.slice(Math.min(start, end), Math.max(start, end) + 1);
	for (const row of targets) {
		if (checked) next.add(row.key);
		else next.delete(row.key);
	}
	return next;
}

export function selectionText(rows, selected) {
	function entry(log, label) {
		const at = new Date(log.at);
		const timestamp = Number.isFinite(at.getTime())
			? at.toISOString()
			: "Unknown time";
		return `[${timestamp}] ${log.issue ? `[${log.issue}] ` : ""}${label} ${log.level.toUpperCase()}\n${log.text || "(empty result)"}`;
	}
	return rows
		.filter((row) => selected.has(row.key))
		.map(
			(row) =>
				entry(row.log, rowLabel(row)) +
				(row.output ? `\n${entry(row.output, "RESULT")}` : ""),
		)
		.join("\n\n");
}
