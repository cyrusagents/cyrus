import type { SDKMessage } from "cyrus-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ActivityCorrelation,
	extractActivityEvents,
} from "../src/jira-agent/JiraActivity.js";
import {
	MAX_TOOL_DETAIL_BYTES,
	redactToolDetail,
	toolDetail,
} from "../src/jira-agent/JiraToolDetails.js";

afterEach(() => vi.unstubAllEnvs());

describe("Jira tool details", () => {
	it("shows actual commands for both Bash and Codex's inferred tool names", () => {
		for (const name of ["Bash", "Read", "Grep", "Glob", "Write"]) {
			expect(toolDetail(name, { command: "rg -n 'parse' src/parser.ts" })).toBe(
				"rg -n 'parse' src/parser.ts",
			);
		}
		expect(toolDetail("Read", { file_path: "src/parser.ts" })).toBe(
			"src/parser.ts",
		);
		expect(
			toolDetail("Edit", {
				file_path: "src/parser.ts",
				new_string: "DO_NOT_PUBLISH",
			}),
		).toBe("src/parser.ts");
		expect(toolDetail("Grep", { pattern: "parse", path: "src" })).toBe(
			"parse in src",
		);
		expect(
			toolDetail("mcp__service__fetch", { token: "DO_NOT_PUBLISH" }),
		).toBeUndefined();
		expect(toolDetail("Unknown", { query: "DO_NOT_PUBLISH" })).toBeUndefined();
	});

	it("redacts credentials before display bounds, including quoted and encoded values", () => {
		const secret = "test-credential/with space";
		vi.stubEnv("EXAMPLE_API_TOKEN", secret);
		for (const value of [secret, encodeURIComponent(secret)]) {
			expect(redactToolDetail(`echo '${value}'`)).not.toContain(value);
		}
		for (const command of [
			"TOKEN='a secret value' pnpm test",
			'curl -H "Authorization: Bearer synthetic_secret" https://example.com',
			"curl -u 'alice:synthetic_secret' https://example.com",
			"runner --token synthetic_secret",
			"runner --token=synthetic_secret",
			"runner --api_key synthetic_secret",
			"curl -H'X-Api-Key: synthetic_secret' https://example.com",
			"curl -ualice:synthetic_secret https://example.com",
			'curl --data \'{"password":"synthetic_secret"}\' https://example.com',
			"Authorization: synthetic_secret",
			"Authorization\u001b[0m: synthetic_secret",
			"printf '%s' '{\"client_secret\":\"synthetic_secret\"}'",
			'cat > config.json <<\'EOF\'\n{"password":"synthetic_secret"}\nEOF',
			"curl https://alice:synthetic_secret@example.com/path?key=synthetic_secret",
		])
			expect(redactToolDetail(command)).not.toMatch(
				/synthetic_secret|a secret value|alice/,
			);
		expect(
			redactToolDetail(
				"-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----",
			),
		).toBe("[Credential material omitted]");
	});

	it("keeps Unicode bounded and removes terminal escapes without truncating a credential first", () => {
		expect(redactToolDetail("\u001b[31mpnpm test\u001b[0m")).toBe("pnpm test");
		const text = redactToolDetail("推".repeat(3000));
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_TOOL_DETAIL_BYTES);
		expect(text).not.toContain("�");
		expect(redactToolDetail("x".repeat(20_000))).toBe(
			"[Detail omitted: too long]",
		);
	});

	it("retains immutable selected detail in a finish, including cloned correlation", () => {
		const input = { command: "pnpm test", secret: "MUST_NOT_COPY" };
		const events = extractActivityEvents({
			type: "assistant",
			message: {
				content: [{ type: "tool_use", id: "tool-1", name: "Bash", input }],
			},
		} as unknown as SDKMessage).events;
		input.command = "mutated after delivery";
		const correlation = new ActivityCorrelation("runner");
		const start = correlation.apply(events);
		const end = correlation
			.clone()
			.apply([{ kind: "finish", id: "tool-1", failed: true }]);
		expect(start).toEqual([
			{
				kind: "tool_started",
				toolId: "tool-1",
				text: "Command",
				toolName: "Bash",
				detail: "pnpm test",
			},
		]);
		expect(end).toEqual([
			{
				kind: "tool_finished",
				toolId: "tool-1",
				text: "Command",
				toolName: "Bash",
				detail: "pnpm test",
				outcome: "failed",
			},
		]);
	});
});
