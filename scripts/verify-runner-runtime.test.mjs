import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { validateRuntimeMessages } from "./runner-runtime-receipt.mjs";

// These are negative acceptance-gate tests, never authenticated runtime evidence.
const root = mkdtempSync(join(tmpdir(), "runtime-receipt-test-"));
const packageText = '{"name":"receipt-fixture"}';
writeFileSync(join(root, "package.json"), packageText);
const other = mkdtempSync(join(tmpdir(), "runtime-receipt-other-"));
writeFileSync(join(other, "package.json"), packageText);
after(() => {
	rmSync(root, { recursive: true });
	rmSync(other, { recursive: true });
});
function fixture() {
	return [
		{
			type: "assistant",
			message: {
				content: [
					{
						type: "tool_use",
						id: "read",
						name: "Read",
						input: { file_path: join(root, "package.json") },
					},
				],
			},
		},
		{
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "read",
						content: `1→${packageText}`,
						is_error: false,
					},
				],
			},
		},
		{
			type: "assistant",
			message: {
				content: [
					{
						type: "tool_use",
						id: "bash",
						name: "Bash",
						input: { command: "pwd", timeout: 10000 },
					},
				],
			},
		},
		{
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "bash",
						content: root,
						is_error: false,
					},
				],
			},
		},
		{
			type: "assistant",
			message: { content: [{ type: "text", text: "SDK_RUNTIME_OK" }] },
		},
		{ type: "result", subtype: "success", is_error: false },
	];
}
test("accepts a successful ordered receipt shape", () => {
	assert.doesNotThrow(() =>
		validateRuntimeMessages(fixture(), root, packageText),
	);
});
for (const [name, mutate] of [
	[
		"Read error despite a success-shaped final result",
		(m) => {
			m[1].message.content[0].is_error = true;
		},
	],
	[
		"Bash error despite a success-shaped final result",
		(m) => {
			m[3].message.content[0].is_error = true;
		},
	],
	[
		"Read of another package.json",
		(m) => {
			m[0].message.content[0].input.file_path = join(other, "package.json");
		},
	],
	[
		"Read content missing manifest",
		(m) => {
			m[1].message.content[0].content = "Permission denied";
		},
	],
	[
		"wrong pwd directory",
		(m) => {
			m[3].message.content[0].content = other;
		},
	],
	[
		"background Bash",
		(m) => {
			m[2].message.content[0].input.run_in_background = true;
		},
	],
	[
		"wrong timeout",
		(m) => {
			m[2].message.content[0].input.timeout = 20000;
		},
	],
	[
		"missing result",
		(m) => {
			m.splice(3, 1);
		},
	],
	[
		"out-of-order execution",
		(m) => {
			[m[1], m[2]] = [m[2], m[1]];
		},
	],
	[
		"early success marker",
		(m) => {
			m.unshift(m.splice(4, 1)[0]);
		},
	],
	[
		"extra tool",
		(m) => {
			m.splice(4, 0, structuredClone(m[2]));
		},
	],
	[
		"provider error",
		(m) => {
			m[5].is_error = true;
		},
	],
]) {
	test(`rejects ${name}`, () => {
		const messages = fixture();
		mutate(messages);
		assert.throws(() => validateRuntimeMessages(messages, root, packageText));
	});
}
