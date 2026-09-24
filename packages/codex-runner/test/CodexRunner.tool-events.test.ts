import type { SDKAssistantMessage, SDKUserMessage } from "miko-core";
import { describe, expect, it } from "vitest";
import type { NormalizedCodexEvent } from "../src/backend/types.js";
import {
	CodexEventMapper,
	type MapperContext,
} from "../src/CodexEventMapper.js";

function createMapper(
	workingDirectory = "/Users/connor/code/miko",
): CodexEventMapper {
	const ctx: MapperContext = {
		workingDirectory,
		model: "gpt-5.5",
		getSessionId: () => "session-1",
		getStagedSkillNames: () => [],
		emitMessage: () => {},
		onThreadStarted: () => {},
	};
	const mapper = new CodexEventMapper(ctx);
	mapper.reset();
	return mapper;
}

function handle(mapper: CodexEventMapper, event: NormalizedCodexEvent): void {
	mapper.handle(event);
}

describe("CodexEventMapper tool event mapping", () => {
	it("emits Grep tool_use and tool_result for command executions", () => {
		const mapper = createMapper();

		handle(mapper, {
			kind: "item-completed",
			item: {
				id: "cmd_1",
				type: "command_execution",
				command: "/bin/zsh -lc 'rg -n \"CodexRunner\" packages'",
				aggregated_output: "packages/codex-runner/src/CodexRunner.ts:1:import",
				exit_code: 0,
				status: "completed",
			},
		});

		const messages = mapper.getMessages();
		expect(messages).toHaveLength(2);

		const assistant = messages[0] as SDKAssistantMessage;
		const assistantBlock = (assistant.message as any).content[0];
		expect(assistant.type).toBe("assistant");
		expect(assistantBlock.type).toBe("tool_use");
		expect(assistantBlock.id).toBe("cmd_1");
		expect(assistantBlock.name).toBe("Grep");
		expect(assistantBlock.input).toEqual({
			command: "/bin/zsh -lc 'rg -n \"CodexRunner\" packages'",
		});

		const user = messages[1] as SDKUserMessage;
		const userBlock = (user.message as any).content[0];
		expect(user.type).toBe("user");
		expect(userBlock.type).toBe("tool_result");
		expect(userBlock.tool_use_id).toBe("cmd_1");
		expect(userBlock.is_error).toBe(false);
		expect(userBlock.content).toContain("CodexRunner.ts");
	});

	it("emits tool_use only once when item-started and item-completed share the same id", () => {
		const mapper = createMapper();

		handle(mapper, {
			kind: "item-started",
			item: {
				id: "cmd_2",
				type: "command_execution",
				command: "/bin/zsh -lc 'wc -l README.md'",
				aggregated_output: "",
				status: "in_progress",
			},
		});

		handle(mapper, {
			kind: "item-completed",
			item: {
				id: "cmd_2",
				type: "command_execution",
				command: "/bin/zsh -lc 'wc -l README.md'",
				aggregated_output: "12 README.md",
				exit_code: 0,
				status: "completed",
			},
		});

		const messages = mapper.getMessages();
		expect(messages).toHaveLength(2);

		const assistantMessages = messages.filter((m) => m.type === "assistant");
		const userMessages = messages.filter((m) => m.type === "user");
		expect(assistantMessages).toHaveLength(1);
		expect(userMessages).toHaveLength(1);
	});

	it("maps file_change events to Edit tool entries with normalized paths", () => {
		const mapper = createMapper("/Users/connor/code/miko");

		handle(mapper, {
			kind: "item-completed",
			item: {
				id: "patch_1",
				type: "file_change",
				changes: [
					{
						path: "/Users/connor/code/miko/packages/codex-runner/src/CodexRunner.ts",
						kind: "update",
					},
				],
				status: "completed",
			},
		});

		const messages = mapper.getMessages();
		const assistantBlock = ((messages[0] as SDKAssistantMessage).message as any)
			.content[0];
		const userBlock = ((messages[1] as SDKUserMessage).message as any)
			.content[0];

		expect(assistantBlock.name).toBe("Edit");
		expect(assistantBlock.input.file_path).toBe(
			"packages/codex-runner/src/CodexRunner.ts",
		);
		expect(userBlock.content).toContain(
			"update packages/codex-runner/src/CodexRunner.ts",
		);
	});

	it("maps open_page web_search events to WebFetch tool entries", () => {
		const mapper = createMapper();

		handle(mapper, {
			kind: "item-completed",
			item: {
				id: "ws_1",
				type: "web_search",
				query: "https://uuithub.com/openai/codex/tree/main/sdk/typescript/src",
				action: {
					type: "open_page",
					url: "https://uuithub.com/openai/codex/tree/main/sdk/typescript/src",
				},
			},
		});

		const messages = mapper.getMessages();
		const assistantBlock = ((messages[0] as SDKAssistantMessage).message as any)
			.content[0];

		expect(assistantBlock.name).toBe("WebFetch");
		expect(assistantBlock.input.url).toBe(
			"https://uuithub.com/openai/codex/tree/main/sdk/typescript/src",
		);
	});
});
