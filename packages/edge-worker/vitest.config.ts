import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		setupFiles: ["./test/setup.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			exclude: [
				"node_modules",
				"test",
				"dist",
				"**/*.d.ts",
				"**/*.config.*",
				"**/mockData.ts",
			],
		},
		testTimeout: 30000,
		hookTimeout: 30000,
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
			"@test": path.resolve(__dirname, "./test"),
			"atmiko-claude-runner": path.resolve(
				__dirname,
				"../claude-runner/src/index.ts",
			),
			"atmiko-codex-runner": path.resolve(
				__dirname,
				"../codex-runner/src/index.ts",
			),
			"atmiko-cursor-runner": path.resolve(
				__dirname,
				"../cursor-runner/src/index.ts",
			),
			"atmiko-gemini-runner": path.resolve(
				__dirname,
				"../gemini-runner/src/index.ts",
			),
			"atmiko-simple-agent-runner": path.resolve(
				__dirname,
				"../simple-agent-runner/src/index.ts",
			),
			"atmiko-config-updater": path.resolve(
				__dirname,
				"../config-updater/src/index.ts",
			),
			"atmiko-linear-event-transport": path.resolve(
				__dirname,
				"../linear-event-transport/src/index.ts",
			),
			"atmiko-mcp-tools": path.resolve(__dirname, "../mcp-tools/src/index.ts"),
			"atmiko-cloudflare-tunnel-client": path.resolve(
				__dirname,
				"../cloudflare-tunnel-client/src/index.ts",
			),
		},
	},
});
