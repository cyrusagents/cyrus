import { describe, expect, it } from "vitest";
import { EdgeConfigSchema } from "../src/config-schemas.js";

const baseRepository = {
	id: "repo-1",
	name: "Repo 1",
	repositoryPath: "/path/to/repo",
	baseBranch: "main",
	workspaceBaseDir: "/workspaces",
};

describe("EdgeConfigSchema", () => {
	it("preserves per-workspace app credentials alongside legacy workspaces", () => {
		const linearWorkspaces = {
			legacy: { linearToken: "legacy-token" },
			private: {
				linearToken: "new-token",
				linearOAuth: {
					clientId: "client-id",
					clientSecret: "client-secret",
					webhookSecret: "webhook-secret",
				},
			},
		};
		expect(
			EdgeConfigSchema.parse({ repositories: [], linearWorkspaces })
				.linearWorkspaces,
		).toEqual(linearWorkspaces);
	});

	it.each([
		{ clientId: "client-id" },
		{ clientId: "", clientSecret: "secret" },
		{ clientId: "id", clientSecret: "" },
		{ clientId: "id", clientSecret: "secret", webhookSecret: "" },
	])("rejects incomplete scoped app credentials: %j", (linearOAuth) => {
		expect(
			EdgeConfigSchema.safeParse({
				repositories: [],
				linearWorkspaces: {
					private: { linearToken: "token", linearOAuth },
				},
			}).success,
		).toBe(false);
	});

	it("accepts strict MCP configuration as a top-level boolean", () => {
		const enabled = EdgeConfigSchema.parse({
			repositories: [baseRepository],
			strictMcpConfig: true,
		});
		const disabled = EdgeConfigSchema.parse({
			repositories: [baseRepository],
			strictMcpConfig: false,
		});

		expect(enabled.strictMcpConfig).toBe(true);
		expect(disabled.strictMcpConfig).toBe(false);
	});

	it("accepts arbitrary JSON-compatible OpenCode config at global and repository levels", () => {
		const config = {
			repositories: [
				{
					...baseRepository,
					opencode: {
						config: {
							model: "anthropic/claude-sonnet-4.5",
							disableCache: false,
							maxTokens: 12000,
							provider: null,
							experimental: {
								tools: ["bash", { name: "linear", enabled: true }],
							},
						},
					},
				},
			],
			opencode: {
				config: {
					theme: "system",
					autoshare: true,
					agent: {
						build: {
							description: "Build agent",
							temperature: 0.2,
						},
					},
					mcp: ["linear", "github"],
				},
			},
		};

		const result = EdgeConfigSchema.safeParse(config);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.opencode?.config).toEqual(config.opencode.config);
			expect(result.data.repositories[0]?.opencode?.config).toEqual(
				config.repositories[0].opencode.config,
			);
		}
	});

	it("rejects non-object OpenCode config at global and repository levels", () => {
		const globalResult = EdgeConfigSchema.safeParse({
			repositories: [baseRepository],
			opencode: { config: "anthropic/claude-sonnet-4.5" },
		});
		const repositoryResult = EdgeConfigSchema.safeParse({
			repositories: [
				{
					...baseRepository,
					opencode: { config: ["not", "an", "object"] },
				},
			],
		});

		expect(globalResult.success).toBe(false);
		expect(repositoryResult.success).toBe(false);
	});
});
