import assert from "node:assert/strict";
import { test } from "vitest";
import { MonitorLog } from "../board/viewer-compat.mjs";

// Exercise the actual component methods; only React's update scheduler is replaced.
function viewer() {
	const component = new MonitorLog({ follow: false });
	component.props = { follow: false };
	component.setState = (update, callback) => {
		Object.assign(
			component.state,
			typeof update === "function"
				? update(component.state, component.props)
				: update,
		);
		callback?.();
	};
	return component;
}
test("matching-line filter clears previously matched rows when the query has no matches", () => {
	const component = viewer();
	component.state.lines = component.state.lines.push(
		new TextEncoder().encode("first"),
		new TextEncoder().encode("error"),
	);
	component.state.isFilteringLinesWithMatches = true;
	component.state.resultLines = [2];
	component.filterLinesWithMatches();
	assert.equal(component.state.filteredLines.size, 1);
	component.state.resultLines = [];
	component.filterLinesWithMatches();
	assert.equal(component.state.filteredLines.size, 0);
	assert.deepEqual(component.state.resultLineUniqueIndexes, []);
});
test("next match scrolls to the filtered row while retaining its original line number", () => {
	const component = viewer();
	component.state.isFilteringLinesWithMatches = true;
	component.state.resultLineUniqueIndexes = [5, 100, 250];
	const calls = [];
	component.listRef.current = { scrollToIndex: (...args) => calls.push(args) };
	component.handleScrollToLine(100);
	assert.equal(component.state.scrollToLine, 100);
	assert.equal(calls[0][0], 1);
});
