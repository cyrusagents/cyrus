import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const GPT56_MINIMUM_CODEX_VERSION = [0, 144, 0] as const;

function parseVersion(version: string): [number, number, number] {
	const [major, minor, patch] = version.split(".").map(Number);
	return [major || 0, minor || 0, patch || 0];
}

function compareVersions(
	left: readonly number[],
	right: readonly number[],
): number {
	for (let index = 0; index < 3; index += 1) {
		if (left[index] !== right[index]) {
			return (left[index] ?? 0) - (right[index] ?? 0);
		}
	}
	return 0;
}

describe("bundled Codex runtime", () => {
	it("meets the minimum version required by GPT-5.6", () => {
		const packageJsonPath = require.resolve("@openai/codex/package.json");
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
			version: string;
		};

		expect(
			compareVersions(
				parseVersion(packageJson.version),
				GPT56_MINIMUM_CODEX_VERSION,
			),
		).toBeGreaterThanOrEqual(0);
	});
});
