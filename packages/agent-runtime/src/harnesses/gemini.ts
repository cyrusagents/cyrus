import type {
	HarnessAdapter,
	HarnessRunOptions,
	NormalizedAgentSessionConfig,
} from "../types.js";
import { createCommand, parseJsonLine, resolveModel } from "./common.js";

export const geminiHarness: HarnessAdapter = {
	kind: "gemini",
	stateDirectories: [".gemini"],
	buildCommand(
		config: NormalizedAgentSessionConfig,
		options: HarnessRunOptions,
	) {
		const args = ["--output-format", "stream-json"];
		const model = resolveModel(config) ?? "gemini-2.5-pro";

		args.push("--model", model, "--yolo");

		if (config.permissions?.mode && config.permissions.mode !== "default") {
			args.push("--approval-mode", config.permissions.mode);
		}

		args.push("-p", options.userPrompt);

		return createCommand(config, "gemini", args, {
			env: {
				GEMINI_SYSTEM_MD: options.continueSession
					? undefined
					: config.systemPrompt,
			},
		});
	},
	parseStdoutLine(line, context) {
		return parseJsonLine("gemini", line, context);
	},
	buildStateEnv(mountPath) {
		// Gemini CLI doesn't have a dir-specific override env var; it
		// overrides what its `homedir()` helper returns via
		// `GEMINI_CLI_HOME` (see `@google/gemini-cli-core` →
		// `dist/src/utils/paths.js::homedir`). The dir suffix is hardcoded
		// to `.gemini`, so the CLI ends up reading/writing
		// `${mountPath}/.gemini/` — which sits as a sibling to other
		// harnesses' `.<name>/` dirs under the same mount.
		return { GEMINI_CLI_HOME: mountPath };
	},
};
