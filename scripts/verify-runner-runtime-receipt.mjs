import assert from "node:assert/strict";

export function validateRuntimeReceipt(messages) {
	assert.equal(
		messages.some(
			(message) =>
				message.type === "system" && message.subtype === "session_writes_lost",
		),
		false,
		"Claude reported session writes lost; the runtime receipt is not durable",
	);

	const events = messages.flatMap((message, messageIndex) =>
		Array.isArray(message.message?.content)
			? message.message.content.map((block, blockIndex) => ({
					block,
					blockIndex,
					messageIndex,
				}))
			: [],
	);
	const findEvent = (predicate) => events.find(({ block }) => predicate(block));
	const eventPosition = (event) => events.indexOf(event);

	const readUseEvent = findEvent(
		(block) => block.type === "tool_use" && block.name === "Read",
	);
	assert.ok(readUseEvent, "Claude did not invoke Read");
	const readResultEvent = findEvent(
		(block) =>
			block.type === "tool_result" &&
			block.tool_use_id === readUseEvent.block.id,
	);
	assert.ok(readResultEvent, "Read did not return a tool result");
	assert.equal(
		readResultEvent.block.is_error,
		false,
		"Read tool result failed",
	);

	const bashUseEvent = findEvent(
		(block) => block.type === "tool_use" && block.name === "Bash",
	);
	assert.ok(bashUseEvent, "Claude did not invoke Bash");
	const bashResultEvent = findEvent(
		(block) =>
			block.type === "tool_result" &&
			block.tool_use_id === bashUseEvent.block.id,
	);
	assert.ok(bashResultEvent, "Bash did not return a tool result");
	assert.equal(
		bashResultEvent.block.is_error,
		false,
		"Bash tool result failed",
	);

	assert.ok(
		eventPosition(readUseEvent) < eventPosition(readResultEvent),
		"Read result preceded its tool invocation",
	);
	assert.ok(
		eventPosition(readResultEvent) < eventPosition(bashUseEvent),
		"Bash ran before the successful Read result",
	);
	assert.ok(
		eventPosition(bashUseEvent) < eventPosition(bashResultEvent),
		"Bash result preceded its tool invocation",
	);

	const textEvents = events.filter(
		({ block }) => block.type === "text" && block.text.trim().length > 0,
	);
	const text = textEvents
		.map(({ block }) => block.text)
		.join("")
		.trim();
	assert.equal(text, "SDK_RUNTIME_OK");
	assert.ok(
		textEvents.every(
			(event) => eventPosition(bashResultEvent) < eventPosition(event),
		),
		"Final text preceded the successful Bash result",
	);

	return {
		bashResult: bashResultEvent.block,
		bashUse: bashUseEvent.block,
		readResult: readResultEvent.block,
		readUse: readUseEvent.block,
		text,
	};
}
