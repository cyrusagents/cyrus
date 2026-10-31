// Receipt validation only. Synthetic tests of this module are never runtime proof.
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

function contentText(content) {
	return typeof content === "string"
		? content
		: content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
}

export function validateRuntimeMessages(
	messages,
	workingDirectory,
	packageText,
) {
	const events = messages.flatMap((message) => {
		if (!["assistant", "user"].includes(message.type)) return [message];
		assert.equal(
			message.parent_tool_use_id ?? null,
			null,
			"Unexpected subagent message",
		);
		return Array.isArray(message.message?.content)
			? message.message.content
			: [];
	});
	const uses = events.filter((event) => event.type === "tool_use");
	assert.deepEqual(
		uses.map((tool) => tool.name),
		["Read", "Bash"],
		"Expected exactly Read then Bash",
	);
	const [readUse, bashUse] = uses;
	assert.equal(
		realpathSync(resolve(workingDirectory, readUse.input.file_path)),
		realpathSync(join(workingDirectory, "package.json")),
		"Read targeted another package.json",
	);
	assert.equal(bashUse.input.command, "pwd");
	assert.equal(bashUse.input.timeout, 10_000);
	assert.equal(bashUse.input.run_in_background ?? false, false);
	assert.notEqual(readUse.id, bashUse.id);
	const results = events.filter((event) => event.type === "tool_result");
	assert.equal(results.length, 2, "Expected two tool results");
	const readResult = results.find((event) => event.tool_use_id === readUse.id);
	const bashResult = results.find((event) => event.tool_use_id === bashUse.id);
	for (const [name, result] of [
		["Read", readResult],
		["Bash", bashResult],
	]) {
		assert.ok(result, `${name} result missing`);
		assert.equal(result.is_error ?? false, false, `${name} failed`);
	}
	// Read normally prefixes each line with its line number and a tab/arrow.
	const readText = contentText(readResult.content);
	assert.ok(
		readText.includes(packageText.trim()) ||
			readText.replace(/^\s*\d+[→\t]/gm, "").includes(packageText.trim()),
		"Read result does not contain the consumer manifest",
	);
	assert.equal(
		realpathSync(contentText(bashResult.content).trim()),
		realpathSync(workingDirectory),
		"pwd returned another directory",
	);
	const result = messages.findLast((message) => message.type === "result");
	assert.ok(result, "Terminal result missing");
	assert.equal(result.subtype, "success");
	assert.equal(result.is_error, false);
	const texts = events.filter(
		(event) => event.type === "text" && event.text.trim(),
	);
	assert.equal(
		texts
			.map((event) => event.text)
			.join("")
			.trim(),
		"SDK_RUNTIME_OK",
	);
	const ordered = [
		readUse,
		readResult,
		bashUse,
		bashResult,
		texts[0],
		result,
	].map((event) => events.indexOf(event));
	assert.ok(
		ordered.every(
			(position, index) =>
				position >= 0 && (index === 0 || position > ordered[index - 1]),
		),
		"Receipt events out of order",
	);
	return { readUse, bashUse, result };
}
