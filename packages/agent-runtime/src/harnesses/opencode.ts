import type {
	HarnessAdapter,
	HarnessRunOptions,
	NormalizedAgentSessionConfig,
} from "../types.js";
import { createCommand, parseJsonLine, resolveModel } from "./common.js";

export const opencodeHarness: HarnessAdapter = {
	kind: "opencode",
	stateDirectories: [],
	buildCommand(
		config: NormalizedAgentSessionConfig,
		options: HarnessRunOptions,
	) {
		// `--format json` (not `--output-format json`) — the CLI's actual flag
		// per `opencode run --help` on v1.15.5. Mis-named in earlier versions
		// of this adapter; would have failed at runtime on first invocation.
		const args = ["run", "--format", "json"];
		const model = resolveModel(config);

		if (model) {
			args.push("--model", model);
		}

		if (config.systemPrompt && !options.continueSession) {
			args.push("--system", config.systemPrompt);
		}

		args.push(options.userPrompt);

		return createCommand(config, "opencode", args);
	},
	parseStdoutLine(line, context) {
		return parseJsonLine("opencode", line, context);
	},
	buildStateEnv(mountPath) {
		// opencode doesn't ship a single state-dir override env var. Its
		// `Global.make()` (see `packages/core/src/global.ts` in
		// `github.com/sst/opencode`) resolves all four storage roots via
		// the `xdg-basedir` npm package and appends `/opencode` to each.
		// To corral every dir under our persistent mount we must override
		// all four XDG vars. We scope them under `.opencode-xdg/` so we
		// don't accidentally claim the XDG hierarchy for unrelated tools
		// that happen to run in the sandbox (git, npm, etc.).
		//
		// Resulting on-disk layout under the mount:
		//   .opencode-xdg/config/opencode/   (config files)
		//   .opencode-xdg/data/opencode/     (logs, repos)
		//   .opencode-xdg/state/opencode/    (sessions, flock)
		//   .opencode-xdg/cache/opencode/    (bin cache)
		const root = `${mountPath}/.opencode-xdg`;
		return {
			XDG_CONFIG_HOME: `${root}/config`,
			XDG_DATA_HOME: `${root}/data`,
			XDG_STATE_HOME: `${root}/state`,
			XDG_CACHE_HOME: `${root}/cache`,
		};
	},
};
