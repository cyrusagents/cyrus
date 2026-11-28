import { describe, expect, it } from "vitest";
import { StreamingPrompt } from "../src/StreamingPrompt.js";

describe("StreamingPrompt", () => {
	it("leaves a genuine user message non-synthetic", async () => {
		const prompt = new StreamingPrompt("session");
		prompt.addMessage("human follow-up");

		const message = (await prompt[Symbol.asyncIterator]().next()).value;

		expect(message).toMatchObject({
			type: "user",
			message: { role: "user", content: "human follow-up" },
			session_id: "session",
		});
		expect(message).not.toHaveProperty("isSynthetic");
	});

	it("marks relayed system text synthetic for SDK mid-turn semantics", async () => {
		const prompt = new StreamingPrompt("session");
		prompt.addMessage("automated CI follow-up", { isSynthetic: true });

		const message = (await prompt[Symbol.asyncIterator]().next()).value;

		expect(message).toMatchObject({
			type: "user",
			message: { role: "user", content: "automated CI follow-up" },
			isSynthetic: true,
			session_id: "session",
		});
	});
});
