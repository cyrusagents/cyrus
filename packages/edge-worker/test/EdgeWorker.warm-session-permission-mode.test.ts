import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WarmQuery } from "@anthropic-ai/claude-agent-sdk";
import { query, startup } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeRunner } from "cyrus-claude-runner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(),
	startup: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs")>()),
	createWriteStream: vi.fn(() => ({
		write: vi.fn(),
		end: vi.fn(),
		on: vi.fn(),
	})),
}));

const roots: string[] = [];

afterEach(() => {
	vi.clearAllMocks();
	for (const root of roots.splice(0)) {
		rmSync(root, { force: true, recursive: true });
	}
});

describe("EdgeWorker warm-session permission policy", () => {
	it("keeps default mode through startup and the attached query when settings request auto modes", async () => {
		const root = mkdtempSync(join(tmpdir(), "cyrus-warm-permission-mode-"));
		roots.push(root);
		mkdirSync(join(root, ".claude"));
		const settingsPath = join(root, ".claude", "settings.json");
		const localSettingsPath = join(root, ".claude", "settings.local.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({ permissions: { defaultMode: "auto" } }),
		);
		writeFileSync(
			localSettingsPath,
			JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }),
		);

		const attachedQuery = vi.fn(async function* () {});
		const warmQuery = {
			query: attachedQuery,
			close: vi.fn(),
			[Symbol.asyncDispose]: vi.fn(),
		} as unknown as WarmQuery;
		vi.mocked(startup).mockResolvedValue(warmQuery);

		const session = {
			id: "agent-session-1",
			claudeSessionId: "claude-session-1",
			workspace: { path: root },
			updatedAt: 1,
			issueContext: { issueIdentifier: "CYPACK-1623" },
		};
		const repository = {
			id: "repo-1",
			name: "Cyrus",
			linearWorkspaceId: "workspace-1",
		};
		const worker = Object.create(EdgeWorker.prototype) as EdgeWorker &
			Record<string, any>;
		worker.agentSessionManager = {
			getAllSessions: vi.fn(() => [session]),
		};
		worker.sessionRepositories = new Map([[session.id, repository.id]]);
		worker.repositories = new Map([[repository.id, repository]]);
		worker.mcpConfigService = {
			buildMcpConfig: vi.fn(() => ({})),
			buildMergedMcpConfigPath: vi.fn(() => undefined),
		};
		worker.config = { linearMcpConfigs: [], strictMcpConfig: true };
		worker.warmInstances = new Map();
		worker.logger = {
			debug: vi.fn(),
			info: vi.fn(),
		};
		worker.buildAllowedTools = vi.fn(() => ["Read", "Bash(pwd)"]);
		worker.buildDisallowedTools = vi.fn(() => ["Write"]);

		await worker.warmupRecentSessions(1);

		expect(startup).toHaveBeenCalledExactlyOnceWith({
			options: expect.objectContaining({
				resume: session.claudeSessionId,
				cwd: root,
				permissionMode: "default",
				settingSources: ["user", "project", "local"],
				allowedTools: ["Read", "Bash(pwd)"],
				disallowedTools: ["Write"],
			}),
		});
		expect(worker.warmInstances.get(session.id)).toBe(warmQuery);

		const runner = new ClaudeRunner({
			workingDirectory: root,
			cyrusHome: root,
			warmSession: worker.warmInstances.get(session.id),
			allowedTools: ["Read", "Bash(pwd)"],
			disallowedTools: ["Write"],
		});
		await runner.start("Use the attached warm query");

		expect(attachedQuery).toHaveBeenCalledExactlyOnceWith(
			"Use the attached warm query",
		);
		expect(query).not.toHaveBeenCalled();
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
			permissions: { defaultMode: "auto" },
		});
		expect(JSON.parse(readFileSync(localSettingsPath, "utf8"))).toEqual({
			permissions: { defaultMode: "acceptEdits" },
		});
	});
});
