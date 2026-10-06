import { describe, expect, it } from "vitest";
import { readBoundedJson } from "../src/utils/readBoundedJson.js";

describe("bounded supervisor JSON transport", () => {
	it("parses a streamed UTF-8 response within its byte limit", async () => {
		const bytes = new TextEncoder().encode('{"text":"日本語"}');
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes.slice(0, 11));
				controller.enqueue(bytes.slice(11));
				controller.close();
			},
		});
		expect(await readBoundedJson(new Response(stream), bytes.length)).toEqual({
			text: "日本語",
		});
	});
	it("cancels an oversized stream without parsing or reading the remainder", async () => {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(9));
			},
			cancel() {
				cancelled = true;
			},
		});
		await expect(readBoundedJson(new Response(stream), 8)).rejects.toThrow(
			"exceeds limit",
		);
		expect(cancelled).toBe(true);
	});
	it("rejects missing and malformed response bodies", async () => {
		await expect(readBoundedJson(new Response(null), 10)).rejects.toThrow(
			"Empty gateway response",
		);
		await expect(readBoundedJson(new Response("{"), 10)).rejects.toThrow();
	});
});
