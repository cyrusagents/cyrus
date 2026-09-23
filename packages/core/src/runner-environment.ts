import type { AgentRunnerConfig } from "./agent-runner-types.js";

/** Snapshot an independent tool environment without changing the Cyrus process. */
export function buildRunnerEnvironment(
	config: Pick<AgentRunnerConfig, "additionalEnv" | "omitEnv">,
	inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries({
		...inherited,
		...config.additionalEnv,
	})) {
		if (value !== undefined) result[key] = value;
	}
	for (const key of config.omitEnv ?? []) delete result[key];
	return result;
}
