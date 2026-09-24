import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(
	new URL("../board/frontend.js", import.meta.url),
	"utf8",
).replace(/^import .*;\n/gm, "");

function element() {
	return {
		value: "",
		textContent: "",
		children: [] as unknown[],
		append(...children: unknown[]) {
			this.children.push(...children);
		},
		replaceChildren() {
			this.children = [];
		},
		setAttribute: vi.fn(),
		addEventListener: vi.fn(),
	};
}

describe("board frontend snapshot rendering", () => {
	it.each([
		false,
		true,
	])("renders a complete update (has tasks: %s)", (hasTasks) => {
		const nodes = new Map(
			["logs", "task-search", "warnings", "connection", "tasks"].map((id) => [
				id,
				element(),
			]),
		);
		const update = vi.fn();
		let stream: { onmessage?: (event: { data: string }) => void } = {};
		runInNewContext(source, {
			document: {
				getElementById: (id: string) => nodes.get(id),
				createElement: element,
			},
			createLogViewer: () => ({ update }),
			initializeAutomations: vi.fn(),
			setInterval: vi.fn(),
			EventSource: class {
				constructor() {
					stream = this;
				}
				onmessage?: (event: { data: string }) => void;
				addEventListener = vi.fn();
			},
		});
		stream.onmessage?.({
			data: JSON.stringify({
				collectedAt: new Date().toISOString(),
				service: { online: true, status: "idle" },
				warnings: [],
				logs: [],
				tasks: hasTasks
					? [
							{
								id: "session",
								issue: "TEST-1",
								title: "Example",
								status: "completed",
							},
						]
					: [],
			}),
		});
		expect(nodes.get("warnings")?.textContent).toBe("");
		expect(nodes.get("tasks")?.children).toHaveLength(1);
		expect(update).toHaveBeenCalled();
	});
});
