import { expect, test } from "vitest";
import { validateRuntimeReceipt } from "../../../scripts/verify-runner-runtime-receipt.mjs";

const toolUse = (name, id, input = {}) => ({
	message: { content: [{ id, input, name, type: "tool_use" }] },
	type: "assistant",
});
const toolResult = (toolUseId, isError = false) => ({
	message: {
		content: [
			{ is_error: isError, tool_use_id: toolUseId, type: "tool_result" },
		],
	},
	type: "user",
});
const finalText = {
	message: { content: [{ text: "SDK_RUNTIME_OK", type: "text" }] },
	type: "assistant",
};
const validReceipt = () => [
	toolUse("Read", "read-1", { file_path: "/tmp/package.json" }),
	toolResult("read-1"),
	toolUse("Bash", "bash-1", {
		command: "pwd",
		run_in_background: false,
		timeout: 10_000,
	}),
	toolResult("bash-1"),
	finalText,
];

test("accepts ordered successful Read and foreground Bash results", () => {
	const receipt = validateRuntimeReceipt(validReceipt());
	expect(receipt.readResult.is_error).toBe(false);
	expect(receipt.bashResult.is_error).toBe(false);
});

test("rejects an errored Read result", () => {
	const messages = validReceipt();
	messages[1] = toolResult("read-1", true);
	expect(() => validateRuntimeReceipt(messages)).toThrow(
		/Read tool result failed/,
	);
});

test("rejects Bash before the successful Read result", () => {
	const messages = validReceipt();
	[messages[1], messages[2]] = [messages[2], messages[1]];
	expect(() => validateRuntimeReceipt(messages)).toThrow(
		/Bash ran before the successful Read result/,
	);
});

test("rejects an errored Bash result", () => {
	const messages = validReceipt();
	messages[3] = toolResult("bash-1", true);
	expect(() => validateRuntimeReceipt(messages)).toThrow(
		/Bash tool result failed/,
	);
});

test("rejects the success text before the successful Bash result", () => {
	const messages = validReceipt();
	[messages[3], messages[4]] = [messages[4], messages[3]];
	expect(() => validateRuntimeReceipt(messages)).toThrow(
		/Final text preceded the successful Bash result/,
	);
});

test("rejects a post-result session write loss", () => {
	const messages = validReceipt();
	messages.push({
		error_code: "ENOSPC",
		lost: ["transcript"],
		session_id: "runtime-receipt",
		subtype: "session_writes_lost",
		type: "system",
		uuid: "writes-lost",
	});
	expect(() => validateRuntimeReceipt(messages)).toThrow(
		/runtime receipt is not durable/,
	);
});
