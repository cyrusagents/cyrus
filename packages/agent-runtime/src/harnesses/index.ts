import type {
	HarnessAdapter,
	HarnessCommand,
	HarnessKind,
	NormalizedAgentSessionConfig,
} from "../types.js";
import { claudeHarness } from "./claude.js";
import { codexHarness } from "./codex.js";
import { cursorHarness } from "./cursor.js";
import { geminiHarness } from "./gemini.js";
import { opencodeHarness } from "./opencode.js";

export type {
	HarnessAdapter,
	HarnessCommand,
	TranscriptParseContext,
} from "../types.js";

export {
	claudeHarness,
	codexHarness,
	cursorHarness,
	geminiHarness,
	opencodeHarness,
};

export const harnessAdapters: Record<HarnessKind, HarnessAdapter> = {
	claude: claudeHarness,
	codex: codexHarness,
	cursor: cursorHarness,
	gemini: geminiHarness,
	opencode: opencodeHarness,
};

export function getHarnessAdapter(kind: HarnessKind): HarnessAdapter {
	return harnessAdapters[kind];
}

export function buildHarnessInvocation(
	config: NormalizedAgentSessionConfig,
	options: { userPrompt: string; continueSession?: boolean },
): HarnessCommand {
	return getHarnessAdapter(config.harness.kind).buildCommand(config, {
		userPrompt: options.userPrompt,
		continueSession: options.continueSession ?? false,
	});
}
