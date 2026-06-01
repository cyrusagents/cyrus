import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	EdgeConfigPayloadSchema,
	EdgeConfigSchema,
	RepositoryConfigPayloadSchema,
	RepositoryConfigSchema,
} from "../src/config-schemas.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemasDir = resolve(__dirname, "../schemas");

function loadSchema(name: string) {
	return JSON.parse(readFileSync(resolve(schemasDir, `${name}.json`), "utf-8"));
}

describe("JSON Schema export", () => {
	describe("EdgeConfig schema", () => {
		const schema = loadSchema("EdgeConfig");

		it("is valid JSON Schema draft-2020-12", () => {
			expect(schema.$schema).toBe(
				"https://json-schema.org/draft/2020-12/schema",
			);
			expect(schema.type).toBe("object");
		});

		it("has $id", () => {
			expect(schema.$id).toBe("https://atcyrus.com/schemas/EdgeConfig.json");
		});

		it("requires repositories", () => {
			expect(schema.required).toContain("repositories");
		});

		it("includes all top-level fields from Zod schema", () => {
			const expectedFields = [
				"repositories",
				"linearWorkspaces",
				"claudeDefaultModel",
				"claudeDefaultFallbackModel",
				"geminiDefaultModel",
				"codexDefaultModel",
				"defaultRunner",
				"defaultModel",
				"defaultFallbackModel",
				"global_setup_script",
				"linearAllowedTools",
				"defaultAllowedTools",
				"defaultDisallowedTools",
				"slackAllowedTools",
				"githubAllowedTools",
				"slackMcpConfigs",
				"linearMcpConfigs",
				"githubMcpConfigs",
				"issueUpdateTrigger",
				"prReviewTrigger",
				"userAccessControl",
				"promptDefaults",
				"sandbox",
				"ngrokAuthToken",
				"stripeCustomerId",
				"linearWorkspaceSlug",
			];
			for (const field of expectedFields) {
				expect(schema.properties).toHaveProperty(field);
			}
		});

		it("represents defaultRunner as enum", () => {
			expect(schema.properties.defaultRunner.enum).toEqual([
				"claude",
				"gemini",
				"codex",
				"cursor",
			]);
		});

		it("represents userAccessControl as object with expected sub-fields", () => {
			const uac = schema.properties.userAccessControl;
			expect(uac.type).toBe("object");
			expect(uac.properties).toHaveProperty("allowedUsers");
			expect(uac.properties).toHaveProperty("blockedUsers");
			expect(uac.properties).toHaveProperty("blockBehavior");
			expect(uac.properties).toHaveProperty("blockMessage");
		});

		it("represents promptDefaults with prompt type keys", () => {
			const pd = schema.properties.promptDefaults;
			expect(pd.type).toBe("object");
			expect(pd.properties).toHaveProperty("debugger");
			expect(pd.properties).toHaveProperty("builder");
			expect(pd.properties).toHaveProperty("scoper");
			expect(pd.properties).toHaveProperty("orchestrator");
			expect(pd.properties).toHaveProperty("graphite-orchestrator");
		});

		it("represents linearWorkspaces as record with string keys", () => {
			const lw = schema.properties.linearWorkspaces;
			expect(lw.type).toBe("object");
			expect(lw.additionalProperties).toBeDefined();
			expect(lw.additionalProperties.properties).toHaveProperty("linearToken");
		});
	});

	describe("RepositoryConfig schema", () => {
		const schema = loadSchema("RepositoryConfig");

		it("requires core fields", () => {
			expect(schema.required).toContain("id");
			expect(schema.required).toContain("name");
			expect(schema.required).toContain("repositoryPath");
			expect(schema.required).toContain("baseBranch");
			expect(schema.required).toContain("workspaceBaseDir");
		});

		it("includes fields the Go server was missing", () => {
			const fields = [
				"disallowedTools",
				"appendInstruction",
				"model",
				"fallbackModel",
				"promptTemplatePath",
				"labelPrompts",
				"userAccessControl",
			];
			for (const field of fields) {
				expect(schema.properties).toHaveProperty(field);
			}
		});

		it("represents labelPrompts with union types", () => {
			const lp = schema.properties.labelPrompts;
			expect(lp.type).toBe("object");
			// Each prompt type should be anyOf (array | object with labels)
			const debugger_ = lp.properties.debugger;
			expect(debugger_.anyOf).toBeDefined();
			expect(debugger_.anyOf.length).toBe(2);
		});

		it("represents mcpConfigPath as union of string | string[]", () => {
			const mcp = schema.properties.mcpConfigPath;
			expect(mcp.anyOf).toBeDefined();
			expect(mcp.anyOf).toEqual([
				{ type: "string" },
				{ type: "array", items: { type: "string" } },
			]);
		});
	});

	describe("EdgeConfigPayload schema", () => {
		const schema = loadSchema("EdgeConfigPayload");

		it("makes workspaceBaseDir optional in repositories", () => {
			const repoSchema = schema.properties.repositories.items;
			// workspaceBaseDir should NOT be in required for payload version
			expect(repoSchema.required).not.toContain("workspaceBaseDir");
		});
	});

	describe("RepositoryConfigPayload schema", () => {
		const schema = loadSchema("RepositoryConfigPayload");

		it("makes workspaceBaseDir optional", () => {
			expect(schema.required).not.toContain("workspaceBaseDir");
		});

		it("still has workspaceBaseDir as a property", () => {
			expect(schema.properties).toHaveProperty("workspaceBaseDir");
		});
	});

	describe("schema sync check", () => {
		it("generated schemas match current Zod schemas", () => {
			// Re-generate in memory and compare to committed files
			const pairs = [
				{ name: "EdgeConfig", schema: EdgeConfigSchema },
				{ name: "EdgeConfigPayload", schema: EdgeConfigPayloadSchema },
				{ name: "RepositoryConfig", schema: RepositoryConfigSchema },
				{
					name: "RepositoryConfigPayload",
					schema: RepositoryConfigPayloadSchema,
				},
			] as const;

			for (const { name, schema } of pairs) {
				const generated = {
					$id: `https://atcyrus.com/schemas/${name}.json`,
					...schema.toJSONSchema({ target: "draft-2020-12" }),
				};
				const committed = loadSchema(name);
				expect(committed).toEqual(generated);
			}
		});
	});
});
