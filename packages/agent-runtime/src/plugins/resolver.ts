import type { PluginInput, RuntimePlugin } from "../types.js";

/**
 * Resolve a PluginInput to a fully-inline RuntimePlugin.
 *
 * v1 supports inline only — `{ rootPath }` (reading
 * `<rootPath>/cyrus-plugin.json` from disk) throws "not yet implemented".
 * The contract is locked so callers can write code against rootPath today;
 * we'll flesh out disk reading in a follow-up.
 */
export async function resolvePlugin(
	input: PluginInput,
): Promise<RuntimePlugin> {
	if ("rootPath" in input) {
		throw new Error(
			`plugins.rootPath resolution is not implemented yet — supply an inline RuntimePlugin instead (rootPath=${input.rootPath}).`,
		);
	}
	return input;
}
