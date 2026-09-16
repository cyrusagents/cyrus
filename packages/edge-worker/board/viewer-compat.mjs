import { LazyLog } from "@melloware/react-logviewer";
import React from "react";

// Compatibility fixes for the pinned 6.5.5 release. Keep upstream source intact.
export class MonitorLog extends LazyLog {
	constructor(props) {
		super(props);
		const filter = this.filterLinesWithMatches;
		this.filterLinesWithMatches = () => {
			if (
				this.state.isFilteringLinesWithMatches &&
				!this.state.resultLines.length
			) {
				this.setState({
					filteredLines: this.state.lines.clear(),
					resultLineUniqueIndexes: [],
				});
			} else filter();
		};
	}
	handleScrollToLine(line = 0) {
		if (!this.state.isFilteringLinesWithMatches)
			return super.handleScrollToLine(line);
		const index = this.state.resultLineUniqueIndexes.indexOf(line);
		if (index < 0) return;
		this.setState({ scrollToLine: line, scrollToIndex: index });
		this.listRef.current?.scrollToIndex(index, { align: "nearest" });
	}
	followLatest() {
		this.searchBarRef.current?.setState({ keywords: "" });
		this.handleClearSearch();
		this.handleFilterLinesWithMatches(false);
		this.listRef.current?.scrollToIndex(Math.max(0, this.state.count - 1), {
			align: "end",
		});
	}
	render() {
		const empty =
			this.state.isFilteringLinesWithMatches && !this.state.filteredLines?.size;
		return React.createElement(
			React.Fragment,
			null,
			super.render(),
			empty
				? React.createElement(
						"div",
						{ className: "viewer-empty", role: "status" },
						"No matching lines.",
					)
				: null,
		);
	}
}
