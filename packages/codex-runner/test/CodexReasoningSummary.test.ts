/**
 * Codex reasoning: only the provider's public `summary[]` is normalized, as a
 * distinct typed message that never becomes assistant text or the final
 * answer. Raw `content[]` is dropped at translation. Synthetic markers only.
 */
import type { SDKMessage } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { translateAppServerItem } from "../src/backend/appServerEvents.js";
import {
	CodexEventMapper,
	type MapperContext,
} from "../src/CodexEventMapper.js";

const RAW = "SYNTHETIC-RAW-REASONING-91c2";

function mapper() {
	const emitted: SDKMessage[] = [];
	const ctx: MapperContext = {
		workingDirectory: "/ws",
		model: "gpt-5.5",
		getSessionId: () => "session-1",
		getStagedSkillNames: () => [],
		emitMessage: (m) => emitted.push(m),
		onThreadStarted: () => {},
	};
	const m = new CodexEventMapper(ctx);
	m.reset();
	return { m, emitted };
}

describe("Codex reasoning summary provenance", () => {
	it("keeps summary[] and drops content[]", () => {
		const item = translateAppServerItem({
			type: "reasoning",
			id: "r1",
			summary: ["Checked the parser.", "", 7],
			content: [RAW],
		});
		expect(item).toEqual({
			type: "reasoning",
			id: "r1",
			summary: ["Checked the parser."],
		});
		expect(JSON.stringify(item)).not.toContain(RAW);
		// The empty arrays real app-server notifications carry today.
		expect(
			translateAppServerItem({
				type: "reasoning",
				id: "r2",
				summary: [],
				content: [],
			}),
		).toEqual({ type: "reasoning", id: "r2" });
	});

	it("emits a typed summary that never becomes the final answer", () => {
		const { m, emitted } = mapper();
		m.handle({
			kind: "item-completed",
			item: translateAppServerItem({
				type: "reasoning",
				id: "r1",
				summary: ["Checked the parser."],
				content: [RAW],
			})!,
		});
		const out = m.finalize({ wasStopped: false });
		const all = [...emitted, ...out];
		expect(JSON.stringify(all)).not.toContain(RAW);
		const summary = emitted.find(
			(e) => (e as { subtype?: string }).subtype === "cyrus_reasoning_summary",
		) as unknown as { type: string; summary: string[] };
		expect(summary.type).toBe("system");
		expect(summary.summary).toEqual(["Checked the parser."]);
		// No assistant text was produced from it.
		expect(all.some((e) => e.type === "assistant")).toBe(false);
		const result = all.find((e) => e.type === "result") as
			| { result?: string }
			| undefined;
		if (result) expect(result.result).not.toContain("Checked the parser.");
	});
});
