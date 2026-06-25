# Cross-Runner Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Linear issue started with Claude or Codex be handed to the other runner via `@Cyrus /handoff <runner>`, continuing in the same worktree with a context snapshot, never running both concurrently.

**Architecture:** A new unit-testable `HandoffService` (command parsing, snapshot building, prompt formatting, stop-polling) plus a thin `EdgeWorker.handleHandoffCommand` orchestration. Handoff forces a fresh target runner by threading an optional `runnerTypeOverride` through `resumeAgentSession` → `buildAgentRunnerConfig` → `buildIssueConfig`, bypassing the existing sticky-session runner binding. The shared git worktree is reused automatically because `resumeAgentSession` reuses `session.workspace`.

**Tech Stack:** TypeScript, pnpm monorepo, Vitest. Work happens in `packages/edge-worker` and `packages/core`.

## Global Constraints

- Target runners are restricted to `claude` and `codex`. Other targets are rejected with a comment.
- Handoff is sequential: the active runner is stopped (with a ~30s timeout) before the target starts. Never concurrent in the same worktree.
- Reuse the same `CyrusAgentSession` and Linear agent-session thread (swap runner in place).
- Stop timeout constant: `HANDOFF_STOP_TIMEOUT_MS = 30000`, poll interval `250` ms.
- No config schema changes. `runnerTypeOverride` is optional everywhere and defaults to today's behavior.
- All snapshot git reads are best-effort: failures yield empty string / `undefined`, never throw.
- Run `pnpm --filter cyrus-edge-worker test:run` and `pnpm typecheck` before the final commit.

---

### Task 1: `runnerTypeOverride` force-override in `RunnerConfigBuilder`

**Files:**
- Modify: `packages/edge-worker/src/RunnerConfigBuilder.ts` (interface `IssueRunnerConfigInput` ~line 113; method `buildIssueConfig` ~lines 324-354)
- Test: `packages/edge-worker/test/RunnerConfigBuilder.handoff-override.test.ts` (create)

**Interfaces:**
- Produces: `IssueRunnerConfigInput.runnerTypeOverride?: RunnerType`. When set, `buildIssueConfig` returns `{ runnerType: <override>, ... }` regardless of labels, description tags, or the session's existing `*SessionId`.

- [ ] **Step 1: Write the failing test**

Create `packages/edge-worker/test/RunnerConfigBuilder.handoff-override.test.ts`. This mirrors the existing harness in `RunnerConfigBuilder.additional-directories.test.ts` (the constructor takes three collaborators):

```typescript
import type { CyrusAgentSession, ILogger, RepositoryConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	type IChatToolResolver,
	type IMcpConfigProvider,
	type IRunnerSelector,
	RunnerConfigBuilder,
} from "../src/RunnerConfigBuilder.js";

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

function makeBuilder(): RunnerConfigBuilder {
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: () => ["Read(**)"],
	};
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => ({}),
		buildMergedMcpConfigPath: () => undefined,
	};
	// Normal selection always returns claude — so a codex result can only come
	// from the override path.
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => ({ runnerType: "claude" as const }),
		getDefaultModelForRunner: () => "opus",
		getDefaultFallbackModelForRunner: () => "sonnet",
	};
	return new RunnerConfigBuilder(
		chatToolResolver,
		mcpConfigProvider,
		runnerSelector,
	);
}

function baseInput(session: Partial<CyrusAgentSession>) {
	return {
		session: session as CyrusAgentSession,
		repository: {
			id: "repo-a",
			name: "Repo A",
			repositoryPath: "/repos/repo-a",
			allowedTools: [],
		} as unknown as RepositoryConfig,
		sessionId: "sess-1",
		systemPrompt: "test",
		allowedTools: ["Read(**)"],
		allowedDirectories: ["/repos/repo-a"],
		disallowedTools: [],
		cyrusHome: "/tmp/cyrus-home",
		linearWorkspaceId: "ws-1",
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws-1",
	};
}

describe("RunnerConfigBuilder runnerTypeOverride", () => {
	it("forces the override runner even when the session is sticky to claude", () => {
		const input = {
			...baseInput({
				issueId: "issue-1",
				issue: { identifier: "ABC-1" },
				workspace: { path: "/ws/root" },
				claudeSessionId: "claude-abc",
			} as unknown as Partial<CyrusAgentSession>),
			labels: ["claude"],
			runnerTypeOverride: "codex" as const,
		};

		const { runnerType } = makeBuilder().buildIssueConfig(input as any);

		expect(runnerType).toBe("codex");
	});

	it("falls back to normal selection when no override is given", () => {
		const input = baseInput({
			issueId: "issue-1",
			issue: { identifier: "ABC-1" },
			workspace: { path: "/ws/root" },
			claudeSessionId: "claude-abc",
		} as unknown as Partial<CyrusAgentSession>);

		const { runnerType } = makeBuilder().buildIssueConfig(input as any);

		expect(runnerType).toBe("claude");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-edge-worker test:run RunnerConfigBuilder.handoff-override`
Expected: FAIL — `runnerTypeOverride` is not honored (first test gets `"claude"`), or a type error on the unknown field.

- [ ] **Step 3: Add the field to the input interface**

In `packages/edge-worker/src/RunnerConfigBuilder.ts`, inside `interface IssueRunnerConfigInput` (after `issueDescription?: string;` ~line 123), add:

```typescript
	/**
	 * When set, forces this exact runner type for the session, bypassing
	 * label/description selection AND the sticky-resume binding. Used by
	 * cross-runner handoff. Leave undefined for all normal sessions.
	 */
	runnerTypeOverride?: RunnerType;
```

Ensure `RunnerType` is imported at the top of the file (it already imports from `cyrus-core`; add `RunnerType` to that import if missing).

- [ ] **Step 4: Apply the override in `buildIssueConfig`**

In `buildIssueConfig`, replace the block at ~lines 333-354 (the comment `// If the labels have changed...` through the closing brace of the `cursorSessionId` branch) with:

```typescript
		// Cross-runner handoff: an explicit override wins over everything —
		// label/description selection and the sticky-resume binding below.
		if (input.runnerTypeOverride) {
			runnerType = input.runnerTypeOverride;
			modelOverride = this.runnerSelector.getDefaultModelForRunner(runnerType);
			fallbackModelOverride =
				this.runnerSelector.getDefaultFallbackModelForRunner(runnerType);
		} else if (input.session.claudeSessionId && runnerType !== "claude") {
			// If the labels have changed, and we are resuming a session. Use the existing runner for the session.
			runnerType = "claude";
			modelOverride = this.runnerSelector.getDefaultModelForRunner("claude");
			fallbackModelOverride =
				this.runnerSelector.getDefaultFallbackModelForRunner("claude");
		} else if (input.session.geminiSessionId && runnerType !== "gemini") {
			runnerType = "gemini";
			modelOverride = this.runnerSelector.getDefaultModelForRunner("gemini");
			fallbackModelOverride =
				this.runnerSelector.getDefaultFallbackModelForRunner("gemini");
		} else if (input.session.codexSessionId && runnerType !== "codex") {
			runnerType = "codex";
			modelOverride = this.runnerSelector.getDefaultModelForRunner("codex");
			fallbackModelOverride =
				this.runnerSelector.getDefaultFallbackModelForRunner("codex");
		} else if (input.session.cursorSessionId && runnerType !== "cursor") {
			runnerType = "cursor";
			modelOverride = this.runnerSelector.getDefaultModelForRunner("cursor");
			fallbackModelOverride =
				this.runnerSelector.getDefaultFallbackModelForRunner("cursor");
		}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter cyrus-edge-worker test:run RunnerConfigBuilder.handoff-override`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add packages/edge-worker/src/RunnerConfigBuilder.ts packages/edge-worker/test/RunnerConfigBuilder.handoff-override.test.ts
git commit -m "feat(handoff): add runnerTypeOverride to RunnerConfigBuilder"
```

---

### Task 2: `HandoffService` scaffold + `parseHandoffCommand`

**Files:**
- Create: `packages/edge-worker/src/HandoffService.ts`
- Test: `packages/edge-worker/test/HandoffService.parse.test.ts` (create)

**Interfaces:**
- Produces:
  - `type HandoffTarget = "claude" | "codex"`
  - `interface HandoffCommand { targetRunner: HandoffTarget | null; rawTarget: string; remainder: string }`
  - `interface GitSnapshotReader { getCurrentBranch(p: string): string; getStatus(p: string): string; getRecentCommits(p: string, limit: number): string; getDiffSummary(p: string): string; getOpenPrUrl(p: string): string | undefined }`
  - `const HANDOFF_STOP_TIMEOUT_MS = 30000`
  - `class HandoffService` constructed as `new HandoffService(gitReader: GitSnapshotReader)`, with `parseHandoffCommand(text: string): HandoffCommand | null`.
- `parseHandoffCommand` returns `null` when no `/handoff` token is present (so normal routing proceeds). When `/handoff <word>` is present, `targetRunner` is `null` for unrecognized words.

- [ ] **Step 1: Write the failing test**

Create `packages/edge-worker/test/HandoffService.parse.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { HandoffService } from "../src/HandoffService.js";

function svc() {
	const reader = {
		getCurrentBranch: () => "branch",
		getStatus: () => "",
		getRecentCommits: () => "",
		getDiffSummary: () => "",
		getOpenPrUrl: () => undefined,
	};
	return new HandoffService(reader);
}

describe("HandoffService.parseHandoffCommand", () => {
	it("returns null when there is no handoff command", () => {
		expect(svc().parseHandoffCommand("please add tests")).toBeNull();
	});

	it("parses a codex target", () => {
		expect(svc().parseHandoffCommand("/handoff codex")).toEqual({
			targetRunner: "codex",
			rawTarget: "codex",
			remainder: "",
		});
	});

	it("parses a claude target with a leading mention and trailing instruction", () => {
		expect(
			svc().parseHandoffCommand("@Cyrus /handoff claude also add tests"),
		).toEqual({
			targetRunner: "claude",
			rawTarget: "claude",
			remainder: "also add tests",
		});
	});

	it("is case-insensitive for the target", () => {
		expect(svc().parseHandoffCommand("/handoff CODEX")?.targetRunner).toBe(
			"codex",
		);
	});

	it("flags an unrecognized target with targetRunner null", () => {
		expect(svc().parseHandoffCommand("/handoff gemini")).toEqual({
			targetRunner: null,
			rawTarget: "gemini",
			remainder: "",
		});
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-edge-worker test:run HandoffService.parse`
Expected: FAIL — cannot find module `../src/HandoffService.js`.

- [ ] **Step 3: Create the service with parsing**

Create `packages/edge-worker/src/HandoffService.ts`:

```typescript
/**
 * Cross-runner handoff support: parse `/handoff <runner>` commands, build a
 * context snapshot of the source runner's worktree state, format the target
 * runner's starting prompt, and poll for the source runner to stop.
 *
 * Pure/logic-only — no live runner wiring. The orchestration that stops the
 * source runner and starts the target lives in EdgeWorker.handleHandoffCommand.
 */

export type HandoffTarget = "claude" | "codex";

export interface HandoffCommand {
	/** Validated target, or null when the word after /handoff is unrecognized. */
	targetRunner: HandoffTarget | null;
	/** The raw word that followed /handoff (for error messages). */
	rawTarget: string;
	/** Any text after the target — becomes the target runner's instruction. */
	remainder: string;
}

/** Read-only git facts about a worktree. Implemented by GitService. */
export interface GitSnapshotReader {
	getCurrentBranch(worktreePath: string): string;
	getStatus(worktreePath: string): string;
	getRecentCommits(worktreePath: string, limit: number): string;
	getDiffSummary(worktreePath: string): string;
	getOpenPrUrl(worktreePath: string): string | undefined;
}

/** How long to wait for the active runner to stop before declaring handoff blocked. */
export const HANDOFF_STOP_TIMEOUT_MS = 30000;

const HANDOFF_RE = /\/handoff\s+(\S+)([\s\S]*)/i;

export class HandoffService {
	constructor(private readonly gitReader: GitSnapshotReader) {}

	parseHandoffCommand(text: string): HandoffCommand | null {
		const match = text.match(HANDOFF_RE);
		if (!match) {
			return null;
		}
		const rawTarget = (match[1] ?? "").toLowerCase();
		const remainder = (match[2] ?? "").trim();
		const targetRunner: HandoffTarget | null =
			rawTarget === "claude" || rawTarget === "codex" ? rawTarget : null;
		return { targetRunner, rawTarget, remainder };
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter cyrus-edge-worker test:run HandoffService.parse`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/edge-worker/src/HandoffService.ts packages/edge-worker/test/HandoffService.parse.test.ts
git commit -m "feat(handoff): add HandoffService with command parsing"
```

---

### Task 3: `getActiveRunnerType` helper

**Files:**
- Modify: `packages/edge-worker/src/HandoffService.ts`
- Test: `packages/edge-worker/test/HandoffService.runner-type.test.ts` (create)

**Interfaces:**
- Produces: exported function `getActiveRunnerType(session): RunnerType | "unknown"` — derives the session's current runner from its populated `*SessionId` field, falling back to `agentRunner.constructor.name`.

- [ ] **Step 1: Write the failing test**

Create `packages/edge-worker/test/HandoffService.runner-type.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { getActiveRunnerType } from "../src/HandoffService.js";

describe("getActiveRunnerType", () => {
	it("reads claude from claudeSessionId", () => {
		expect(getActiveRunnerType({ claudeSessionId: "x" } as any)).toBe("claude");
	});

	it("reads codex from codexSessionId", () => {
		expect(getActiveRunnerType({ codexSessionId: "x" } as any)).toBe("codex");
	});

	it("falls back to the runner constructor name", () => {
		const session = {
			agentRunner: { constructor: { name: "CodexRunner" } },
		} as any;
		expect(getActiveRunnerType(session)).toBe("codex");
	});

	it("returns unknown when nothing identifies the runner", () => {
		expect(getActiveRunnerType({} as any)).toBe("unknown");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-edge-worker test:run HandoffService.runner-type`
Expected: FAIL — `getActiveRunnerType` is not exported.

- [ ] **Step 3: Implement the helper**

In `packages/edge-worker/src/HandoffService.ts`, add an import and the function (top-level, after the interfaces):

```typescript
import type { CyrusAgentSession, RunnerType } from "cyrus-core";
```

```typescript
/** Identify the runner a session is currently bound to. */
export function getActiveRunnerType(
	session: Pick<
		CyrusAgentSession,
		| "claudeSessionId"
		| "geminiSessionId"
		| "codexSessionId"
		| "cursorSessionId"
		| "agentRunner"
	>,
): RunnerType | "unknown" {
	if (session.claudeSessionId) return "claude";
	if (session.geminiSessionId) return "gemini";
	if (session.codexSessionId) return "codex";
	if (session.cursorSessionId) return "cursor";
	switch (session.agentRunner?.constructor?.name) {
		case "ClaudeRunner":
			return "claude";
		case "GeminiRunner":
			return "gemini";
		case "CodexRunner":
			return "codex";
		case "CursorRunner":
			return "cursor";
		default:
			return "unknown";
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter cyrus-edge-worker test:run HandoffService.runner-type`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/edge-worker/src/HandoffService.ts packages/edge-worker/test/HandoffService.runner-type.test.ts
git commit -m "feat(handoff): add getActiveRunnerType helper"
```

---

### Task 4: Git snapshot reads on `GitService`

**Files:**
- Modify: `packages/edge-worker/src/GitService.ts` (add methods; uses already-imported `execSync`)
- Test: `packages/edge-worker/test/GitService.snapshot.test.ts` (create)

**Interfaces:**
- Produces (on `GitService`, satisfying `GitSnapshotReader`):
  - `getCurrentBranch(worktreePath: string): string`
  - `getStatus(worktreePath: string): string`
  - `getRecentCommits(worktreePath: string, limit: number): string`
  - `getDiffSummary(worktreePath: string): string`
  - `getOpenPrUrl(worktreePath: string): string | undefined`
- All are best-effort: on any thrown error they return `""` (or `undefined` for the PR url).

- [ ] **Step 1: Write the failing test**

Create `packages/edge-worker/test/GitService.snapshot.test.ts`:

```typescript
import { execSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { GitService } from "../src/GitService.js";

vi.mock("node:child_process", () => ({ execSync: vi.fn() }));

const logger = {
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	withContext: vi.fn().mockReturnThis(),
} as any;

describe("GitService snapshot reads", () => {
	it("returns trimmed porcelain status", () => {
		(execSync as any).mockReturnValue(" M file.ts\n");
		const git = new GitService(logger);
		expect(git.getStatus("/wt")).toBe("M file.ts");
	});

	it("returns recent commits with the requested limit", () => {
		(execSync as any).mockReturnValue("abc one\ndef two\n");
		const git = new GitService(logger);
		expect(git.getRecentCommits("/wt", 5)).toBe("abc one\ndef two");
		expect((execSync as any)).toHaveBeenCalledWith(
			"git log --oneline -n 5",
			expect.objectContaining({ cwd: "/wt" }),
		);
	});

	it("returns empty string when a git read throws", () => {
		(execSync as any).mockImplementation(() => {
			throw new Error("not a git repo");
		});
		const git = new GitService(logger);
		expect(git.getDiffSummary("/wt")).toBe("");
		expect(git.getCurrentBranch("/wt")).toBe("");
	});

	it("returns undefined for the PR url when gh fails", () => {
		(execSync as any).mockImplementation(() => {
			throw new Error("gh: no pr");
		});
		const git = new GitService(logger);
		expect(git.getOpenPrUrl("/wt")).toBeUndefined();
	});
});
```

> If `GitService`'s constructor signature differs from `new GitService(logger)`, match the existing constructor used in `packages/edge-worker/test/GitService.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-edge-worker test:run GitService.snapshot`
Expected: FAIL — methods do not exist.

- [ ] **Step 3: Implement the methods**

In `packages/edge-worker/src/GitService.ts`, add these public methods to the `GitService` class (place them near `findWorktreeByBranch`). `execSync` is already imported in this file:

```typescript
	/** Current branch checked out in a worktree (best-effort). */
	getCurrentBranch(worktreePath: string): string {
		try {
			return execSync("git rev-parse --abbrev-ref HEAD", {
				cwd: worktreePath,
				encoding: "utf-8",
			}).trim();
		} catch {
			return "";
		}
	}

	/** Porcelain working-tree status (best-effort). */
	getStatus(worktreePath: string): string {
		try {
			return execSync("git status --porcelain", {
				cwd: worktreePath,
				encoding: "utf-8",
			}).trim();
		} catch {
			return "";
		}
	}

	/** Last `limit` commits as `git log --oneline` (best-effort). */
	getRecentCommits(worktreePath: string, limit: number): string {
		try {
			return execSync(`git log --oneline -n ${limit}`, {
				cwd: worktreePath,
				encoding: "utf-8",
			}).trim();
		} catch {
			return "";
		}
	}

	/** `git diff --stat` against HEAD (best-effort). */
	getDiffSummary(worktreePath: string): string {
		try {
			return execSync("git diff --stat HEAD", {
				cwd: worktreePath,
				encoding: "utf-8",
			}).trim();
		} catch {
			return "";
		}
	}

	/** URL of the open PR for the current branch via gh, or undefined (best-effort). */
	getOpenPrUrl(worktreePath: string): string | undefined {
		try {
			const url = execSync("gh pr view --json url -q .url", {
				cwd: worktreePath,
				encoding: "utf-8",
			}).trim();
			return url || undefined;
		} catch {
			return undefined;
		}
	}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter cyrus-edge-worker test:run GitService.snapshot`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/edge-worker/src/GitService.ts packages/edge-worker/test/GitService.snapshot.test.ts
git commit -m "feat(handoff): add best-effort git snapshot reads to GitService"
```

---

### Task 5: `buildSnapshot` + `buildHandoffPrompt`

**Files:**
- Modify: `packages/edge-worker/src/HandoffService.ts`
- Test: `packages/edge-worker/test/HandoffService.snapshot.test.ts` (create)

**Interfaces:**
- Produces:
  - `interface HandoffSnapshotArgs { sourceRunner: RunnerType | "unknown"; targetRunner: HandoffTarget; issueId: string; sessionId: string; worktreePath: string; latestSummary?: string }`
  - `interface HandoffSnapshot extends HandoffSnapshotArgs { branch: string; gitStatus: string; recentCommits: string; diffSummary: string; prLink?: string }`
  - `HandoffService.buildSnapshot(args: HandoffSnapshotArgs): HandoffSnapshot`
  - `HandoffService.buildHandoffPrompt(snapshot: HandoffSnapshot, userText?: string): string`

- [ ] **Step 1: Write the failing test**

Create `packages/edge-worker/test/HandoffService.snapshot.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { HandoffService } from "../src/HandoffService.js";

function svc(overrides: Record<string, unknown> = {}) {
	const reader = {
		getCurrentBranch: () => "CYR-1-feature",
		getStatus: () => " M src/a.ts",
		getRecentCommits: () => "abc first\ndef second",
		getDiffSummary: () => " src/a.ts | 2 +-",
		getOpenPrUrl: () => "https://github.com/o/r/pull/9",
		...overrides,
	};
	return new HandoffService(reader as any);
}

const args = {
	sourceRunner: "claude" as const,
	targetRunner: "codex" as const,
	issueId: "issue-1",
	sessionId: "sess-1",
	worktreePath: "/ws/CYR-1",
	latestSummary: "Implemented the parser.",
};

describe("HandoffService.buildSnapshot", () => {
	it("collects all git fields from the reader", () => {
		const snap = svc().buildSnapshot(args);
		expect(snap).toMatchObject({
			sourceRunner: "claude",
			targetRunner: "codex",
			branch: "CYR-1-feature",
			gitStatus: " M src/a.ts",
			recentCommits: "abc first\ndef second",
			diffSummary: " src/a.ts | 2 +-",
			prLink: "https://github.com/o/r/pull/9",
			latestSummary: "Implemented the parser.",
		});
	});

	it("omits the PR link when none is available", () => {
		const snap = svc({ getOpenPrUrl: () => undefined }).buildSnapshot(args);
		expect(snap.prLink).toBeUndefined();
	});
});

describe("HandoffService.buildHandoffPrompt", () => {
	it("includes the handoff context block and the user instruction", () => {
		const snap = svc().buildSnapshot(args);
		const prompt = svc().buildHandoffPrompt(snap, "add tests too");
		expect(prompt).toContain("<handoff_context>");
		expect(prompt).toContain("<source_runner>claude</source_runner>");
		expect(prompt).toContain("<target_runner>codex</target_runner>");
		expect(prompt).toContain("<branch>CYR-1-feature</branch>");
		expect(prompt).toContain("https://github.com/o/r/pull/9");
		expect(prompt).toContain("Implemented the parser.");
		expect(prompt.trimEnd().endsWith("add tests too")).toBe(true);
	});

	it("uses a default instruction when the user gave none", () => {
		const snap = svc().buildSnapshot(args);
		const prompt = svc().buildHandoffPrompt(snap, "");
		expect(prompt).toContain(
			"Continue the work in this worktree from where the previous runner left off.",
		);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-edge-worker test:run HandoffService.snapshot`
Expected: FAIL — `buildSnapshot` / `buildHandoffPrompt` do not exist.

- [ ] **Step 3: Implement the methods**

In `packages/edge-worker/src/HandoffService.ts`, add the interfaces (near the top, after `HandoffCommand`):

```typescript
export interface HandoffSnapshotArgs {
	sourceRunner: RunnerType | "unknown";
	targetRunner: HandoffTarget;
	issueId: string;
	sessionId: string;
	worktreePath: string;
	latestSummary?: string;
}

export interface HandoffSnapshot extends HandoffSnapshotArgs {
	branch: string;
	gitStatus: string;
	recentCommits: string;
	diffSummary: string;
	prLink?: string;
}
```

Then add these methods to the `HandoffService` class:

```typescript
	buildSnapshot(args: HandoffSnapshotArgs): HandoffSnapshot {
		return {
			...args,
			branch: this.gitReader.getCurrentBranch(args.worktreePath),
			gitStatus: this.gitReader.getStatus(args.worktreePath),
			recentCommits: this.gitReader.getRecentCommits(args.worktreePath, 5),
			diffSummary: this.gitReader.getDiffSummary(args.worktreePath),
			prLink: this.gitReader.getOpenPrUrl(args.worktreePath),
		};
	}

	buildHandoffPrompt(snapshot: HandoffSnapshot, userText?: string): string {
		const lines = [
			"<handoff_context>",
			"  You are taking over an in-progress Linear issue from another agent.",
			"  The worktree, branch, files, and PR state below are already in place.",
			`  <source_runner>${snapshot.sourceRunner}</source_runner>`,
			`  <target_runner>${snapshot.targetRunner}</target_runner>`,
			`  <issue_id>${snapshot.issueId}</issue_id>`,
			`  <session_id>${snapshot.sessionId}</session_id>`,
			`  <worktree_path>${snapshot.worktreePath}</worktree_path>`,
			`  <branch>${snapshot.branch || "(unknown)"}</branch>`,
			`  <git_status>\n${snapshot.gitStatus || "(clean)"}\n  </git_status>`,
			`  <recent_commits>\n${snapshot.recentCommits || "(none)"}\n  </recent_commits>`,
			`  <diff_summary>\n${snapshot.diffSummary || "(no changes)"}\n  </diff_summary>`,
		];
		if (snapshot.prLink) {
			lines.push(`  <pull_request>${snapshot.prLink}</pull_request>`);
		}
		if (snapshot.latestSummary) {
			lines.push(
				`  <previous_agent_summary>\n${snapshot.latestSummary}\n  </previous_agent_summary>`,
			);
		}
		lines.push("</handoff_context>");

		const instruction =
			userText && userText.trim().length > 0
				? userText.trim()
				: "Continue the work in this worktree from where the previous runner left off.";
		return `${lines.join("\n")}\n\n${instruction}`;
	}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter cyrus-edge-worker test:run HandoffService.snapshot`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/edge-worker/src/HandoffService.ts packages/edge-worker/test/HandoffService.snapshot.test.ts
git commit -m "feat(handoff): build snapshot and target prompt"
```

---

### Task 6: `waitForStopped` poller

**Files:**
- Modify: `packages/edge-worker/src/HandoffService.ts`
- Test: `packages/edge-worker/test/HandoffService.wait.test.ts` (create)

**Interfaces:**
- Produces: `HandoffService.waitForStopped(isRunning: () => boolean, opts: { timeoutMs: number; pollIntervalMs: number; sleep: (ms: number) => Promise<void> }): Promise<boolean>` — resolves `true` if `isRunning()` becomes false within the timeout, else `false`. `sleep` is injected so tests don't use real timers.

- [ ] **Step 1: Write the failing test**

Create `packages/edge-worker/test/HandoffService.wait.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { HandoffService } from "../src/HandoffService.js";

function svc() {
	const reader = {
		getCurrentBranch: () => "",
		getStatus: () => "",
		getRecentCommits: () => "",
		getDiffSummary: () => "",
		getOpenPrUrl: () => undefined,
	};
	return new HandoffService(reader as any);
}

describe("HandoffService.waitForStopped", () => {
	it("returns true once the runner reports stopped", async () => {
		let calls = 0;
		const isRunning = () => {
			calls += 1;
			return calls < 3; // running for 2 polls, then stopped
		};
		const stopped = await svc().waitForStopped(isRunning, {
			timeoutMs: 1000,
			pollIntervalMs: 100,
			sleep: vi.fn().mockResolvedValue(undefined),
		});
		expect(stopped).toBe(true);
	});

	it("returns false when the runner never stops within the timeout", async () => {
		const stopped = await svc().waitForStopped(() => true, {
			timeoutMs: 300,
			pollIntervalMs: 100,
			sleep: vi.fn().mockResolvedValue(undefined),
		});
		expect(stopped).toBe(false);
	});

	it("returns true immediately when already stopped", async () => {
		const sleep = vi.fn().mockResolvedValue(undefined);
		const stopped = await svc().waitForStopped(() => false, {
			timeoutMs: 300,
			pollIntervalMs: 100,
			sleep,
		});
		expect(stopped).toBe(true);
		expect(sleep).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-edge-worker test:run HandoffService.wait`
Expected: FAIL — `waitForStopped` does not exist.

- [ ] **Step 3: Implement the poller**

Add to the `HandoffService` class:

```typescript
	async waitForStopped(
		isRunning: () => boolean,
		opts: {
			timeoutMs: number;
			pollIntervalMs: number;
			sleep: (ms: number) => Promise<void>;
		},
	): Promise<boolean> {
		let elapsed = 0;
		while (isRunning()) {
			if (elapsed >= opts.timeoutMs) {
				return false;
			}
			await opts.sleep(opts.pollIntervalMs);
			elapsed += opts.pollIntervalMs;
		}
		return true;
	}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter cyrus-edge-worker test:run HandoffService.wait`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/edge-worker/src/HandoffService.ts packages/edge-worker/test/HandoffService.wait.test.ts
git commit -m "feat(handoff): add waitForStopped poller"
```

---

### Task 7: `AgentSessionManager` accessors for handoff

**Files:**
- Modify: `packages/edge-worker/src/AgentSessionManager.ts` (add two public methods; `lastAssistantBodyBySession` is ~line 76, `sessions` ~line 71)
- Test: `packages/edge-worker/test/AgentSessionManager.handoff-accessors.test.ts` (create)

**Interfaces:**
- Produces:
  - `getLastAssistantBody(sessionId: string): string | undefined`
  - `clearRunnerSessionBindings(sessionId: string): void` — sets `claudeSessionId`/`geminiSessionId`/`codexSessionId`/`cursorSessionId` to `undefined` on the stored session so post-handoff routing follows the new runner.

- [ ] **Step 1: Write the failing test**

Create `packages/edge-worker/test/AgentSessionManager.handoff-accessors.test.ts`:

```typescript
import type { CyrusAgentSession } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";

// Minimal manager: we only exercise the new accessors against its internal maps.
function makeManager() {
	// Construct with no-op collaborators; the accessors touch only `sessions`
	// and `lastAssistantBodyBySession`. Match the real constructor arity used in
	// other AgentSessionManager tests if this differs.
	return new AgentSessionManager({} as any);
}

describe("AgentSessionManager handoff accessors", () => {
	it("clearRunnerSessionBindings nulls every runner session id", () => {
		const mgr = makeManager();
		const session = {
			id: "s1",
			claudeSessionId: "c",
			codexSessionId: undefined,
		} as unknown as CyrusAgentSession;
		(mgr as any).sessions.set("s1", session);

		mgr.clearRunnerSessionBindings("s1");

		expect(session.claudeSessionId).toBeUndefined();
		expect(session.geminiSessionId).toBeUndefined();
		expect(session.codexSessionId).toBeUndefined();
		expect(session.cursorSessionId).toBeUndefined();
	});

	it("clearRunnerSessionBindings is a no-op for an unknown session", () => {
		const mgr = makeManager();
		expect(() => mgr.clearRunnerSessionBindings("missing")).not.toThrow();
	});

	it("getLastAssistantBody returns the buffered body", () => {
		const mgr = makeManager();
		(mgr as any).lastAssistantBodyBySession.set("s1", "the summary");
		expect(mgr.getLastAssistantBody("s1")).toBe("the summary");
		expect(mgr.getLastAssistantBody("s2")).toBeUndefined();
	});
});
```

> If `new AgentSessionManager({} as any)` throws due to required constructor args, copy the exact construction used in `packages/edge-worker/test/AgentSessionManager.stop-session.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-edge-worker test:run AgentSessionManager.handoff-accessors`
Expected: FAIL — methods do not exist.

- [ ] **Step 3: Implement the accessors**

In `packages/edge-worker/src/AgentSessionManager.ts`, add these public methods (place near `getSession` ~line 1326):

```typescript
	/** Buffered last assistant text for a session (used as the handoff summary). */
	getLastAssistantBody(sessionId: string): string | undefined {
		return this.lastAssistantBodyBySession.get(sessionId);
	}

	/**
	 * Clear every runner-specific session id on a session so that, after a
	 * cross-runner handoff, normal routing follows the newly-bound runner
	 * instead of the previous one. The target runner repopulates its own id on
	 * its first system message.
	 */
	clearRunnerSessionBindings(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}
		session.claudeSessionId = undefined;
		session.geminiSessionId = undefined;
		session.codexSessionId = undefined;
		session.cursorSessionId = undefined;
	}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter cyrus-edge-worker test:run AgentSessionManager.handoff-accessors`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/edge-worker/src/AgentSessionManager.ts packages/edge-worker/test/AgentSessionManager.handoff-accessors.test.ts
git commit -m "feat(handoff): add session accessors for handoff"
```

---

### Task 8: Thread `runnerTypeOverride` through `buildAgentRunnerConfig` and `resumeAgentSession`

**Files:**
- Modify: `packages/edge-worker/src/EdgeWorker.ts` (`buildAgentRunnerConfig` ~line 6426; `resumeAgentSession` ~line 7132)

**Interfaces:**
- Consumes: `IssueRunnerConfigInput.runnerTypeOverride` (Task 1).
- Produces:
  - `buildAgentRunnerConfig(..., sessionPlatform?, runnerTypeOverride?: RunnerType)` — passes the override into `buildIssueConfig`.
  - `resumeAgentSession(..., commentTimestamp?, runnerTypeOverride?: RunnerType)` — when set, forces a fresh target runner: skips the streaming-add fast path, forces `needsNewSession`, clears `resumeSessionId`, and passes the override to `buildAgentRunnerConfig`.

This task has no standalone unit test — it is an internal plumbing change exercised end-to-end by Task 9's acceptance test. Verify via typecheck + the existing suite.

- [ ] **Step 1: Add the parameter to `buildAgentRunnerConfig`**

In `packages/edge-worker/src/EdgeWorker.ts`, in the `buildAgentRunnerConfig` signature, after the `sessionPlatform: "linear" | "github" | "gitlab" = "linear",` parameter (~line 6445) add a final parameter:

```typescript
		runnerTypeOverride?: RunnerType,
```

Then in the `this.runnerConfigBuilder.buildIssueConfig({ ... })` call (~line 6466), add the field (e.g. right after `issueDescription,`):

```typescript
			runnerTypeOverride,
```

- [ ] **Step 2: Add the parameter to `resumeAgentSession`**

In the `resumeAgentSession` signature (~line 7132), after `commentTimestamp?: string,` add a final parameter:

```typescript
		runnerTypeOverride?: RunnerType,
```

- [ ] **Step 3: Skip the streaming-add fast path during handoff**

In `resumeAgentSession`, change the existing condition (~line 7151) from:

```typescript
		if (
			existingRunner?.isRunning() &&
			existingRunner.supportsStreamingInput &&
			existingRunner.addStreamMessage
		) {
```

to:

```typescript
		if (
			!runnerTypeOverride &&
			existingRunner?.isRunning() &&
			existingRunner.supportsStreamingInput &&
			existingRunner.addStreamMessage
		) {
```

- [ ] **Step 4: Force a fresh session for the target runner**

In `resumeAgentSession`, update the `needsNewSession` computation (~line 7208) from:

```typescript
		const needsNewSession =
			isNewSession ||
			(!hasClaudeSession &&
				!hasGeminiSession &&
				!hasCodexSession &&
				!hasCursorSession);
```

to:

```typescript
		const needsNewSession =
			isNewSession ||
			Boolean(runnerTypeOverride) ||
			(!hasClaudeSession &&
				!hasGeminiSession &&
				!hasCodexSession &&
				!hasCursorSession);
```

(`resumeSessionId` already becomes `undefined` whenever `needsNewSession` is true, so no further change is needed there.)

- [ ] **Step 5: Pass the override into the config build**

In `resumeAgentSession`, in the `this.buildAgentRunnerConfig(...)` call (~line 7266), the existing last argument is `this.buildSkillSessionContext(repository, fullIssue, session),`. `buildAgentRunnerConfig` defaults `sessionPlatform` to `"linear"`, so pass both explicitly to reach the new param. Change the tail of that call to:

```typescript
				this.buildSkillSessionContext(repository, fullIssue, session),
				"linear",
				runnerTypeOverride,
			);
```

- [ ] **Step 6: Verify typecheck and existing tests still pass**

Run: `pnpm --filter cyrus-edge-worker typecheck`
Expected: PASS (no type errors).

Run: `pnpm --filter cyrus-edge-worker test:run EdgeWorker.runner-selection`
Expected: PASS (no regressions — the override defaults to undefined).

- [ ] **Step 7: Commit**

```bash
git add packages/edge-worker/src/EdgeWorker.ts
git commit -m "feat(handoff): thread runnerTypeOverride through resume path"
```

---

### Task 9: Wire `HandoffService` into `EdgeWorker` + `handleHandoffCommand`

**Files:**
- Modify: `packages/edge-worker/src/EdgeWorker.ts` (constructor: instantiate service; `handleUserPromptedAgentActivity` ~line 5179: add branch; add new method `handleHandoffCommand`)
- Test: `packages/edge-worker/test/EdgeWorker.handoff.test.ts` (create)

**Interfaces:**
- Consumes: `HandoffService` (Tasks 2-6), `getActiveRunnerType`, `HANDOFF_STOP_TIMEOUT_MS`, `AgentSessionManager.getLastAssistantBody`/`clearRunnerSessionBindings` (Task 7), `resumeAgentSession(..., runnerTypeOverride)` (Task 8).
- Produces: `private async handleHandoffCommand(webhook: AgentSessionPromptedWebhook, repositories: RepositoryConfig[], handoff: HandoffCommand): Promise<void>`.

- [ ] **Step 1: Write the failing acceptance test**

Create `packages/edge-worker/test/EdgeWorker.handoff.test.ts`. This drives `handleHandoffCommand` directly (the established pattern for these integration tests) with a mocked `AgentSessionManager` and a spied `resumeAgentSession`:

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { HandoffService } from "../src/HandoffService.js";

vi.mock("../src/SharedApplicationServer.js");

function makeRunner(running: boolean) {
	return {
		isRunning: vi.fn().mockReturnValue(running),
		stop: vi.fn(),
		constructor: { name: "ClaudeRunner" },
	};
}

function makeRepo() {
	return {
		id: "r1",
		name: "r1",
		repositoryPath: "/repo",
		workspaceBaseDir: "/ws",
		baseBranch: "main",
		linearWorkspaceId: "w1",
		isActive: true,
	} as any;
}

function makeWebhook() {
	return {
		organizationId: "w1",
		agentSession: { id: "sess-1", issue: { id: "issue-1" } },
		agentActivity: { content: { body: "/handoff codex" } },
	} as any;
}

// Build a partially-real EdgeWorker: bypass the constructor and attach only the
// collaborators handleHandoffCommand touches.
function makeEdgeWorker(session: any) {
	const ew: any = Object.create(EdgeWorker.prototype);
	const reader = {
		getCurrentBranch: () => "CYR-1",
		getStatus: () => " M a.ts",
		getRecentCommits: () => "abc c1",
		getDiffSummary: () => " a.ts | 1 +",
		getOpenPrUrl: () => undefined,
	};
	ew.handoffService = new HandoffService(reader);
	ew.logger = {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		withContext: vi.fn().mockReturnThis(),
	};
	ew.agentSessionManager = {
		getSession: vi.fn().mockReturnValue(session),
		getLastAssistantBody: vi.fn().mockReturnValue("prev summary"),
		clearRunnerSessionBindings: vi.fn(),
		requestSessionStop: vi.fn(),
		createResponseActivity: vi.fn().mockResolvedValue(undefined),
	};
	ew.resumeAgentSession = vi.fn().mockResolvedValue(undefined);
	return ew;
}

describe("EdgeWorker.handleHandoffCommand", () => {
	it("stops the active claude runner and starts codex in the same worktree", async () => {
		const runner = makeRunner(false); // already stopped after stop()
		const session = {
			id: "sess-1",
			claudeSessionId: "claude-x",
			agentRunner: runner,
			workspace: { path: "/ws/CYR-1" },
		};
		const ew = makeEdgeWorker(session);

		await ew.handleHandoffCommand(makeWebhook(), [makeRepo()], {
			targetRunner: "codex",
			rawTarget: "codex",
			remainder: "keep going",
		});

		// Source stopped
		expect(ew.agentSessionManager.requestSessionStop).toHaveBeenCalledWith(
			"sess-1",
		);
		expect(runner.stop).toHaveBeenCalled();
		// Bindings cleared so future routing follows codex
		expect(
			ew.agentSessionManager.clearRunnerSessionBindings,
		).toHaveBeenCalledWith("sess-1");
		// Target started via resume with the override + same worktree session
		expect(ew.resumeAgentSession).toHaveBeenCalledTimes(1);
		const callArgs = ew.resumeAgentSession.mock.calls[0];
		expect(callArgs[0]).toBe(session); // same session => same worktree
		expect(callArgs[callArgs.length - 1]).toBe("codex"); // runnerTypeOverride
		const promptArg = callArgs[4];
		expect(promptArg).toContain("<handoff_context>");
		expect(promptArg).toContain("keep going");
	});

	it("blocks handoff when the active runner never stops", async () => {
		const runner = makeRunner(true); // stays running forever
		const session = {
			id: "sess-1",
			claudeSessionId: "claude-x",
			agentRunner: runner,
			workspace: { path: "/ws/CYR-1" },
		};
		const ew = makeEdgeWorker(session);
		// Make the poll resolve instantly and time out quickly.
		ew.handoffService.waitForStopped = vi.fn().mockResolvedValue(false);

		await ew.handleHandoffCommand(makeWebhook(), [makeRepo()], {
			targetRunner: "codex",
			rawTarget: "codex",
			remainder: "",
		});

		expect(ew.agentSessionManager.createResponseActivity).toHaveBeenCalledWith(
			"sess-1",
			expect.stringContaining("blocked"),
		);
		expect(ew.resumeAgentSession).not.toHaveBeenCalled();
	});

	it("rejects an unknown target with an error comment", async () => {
		const session = {
			id: "sess-1",
			claudeSessionId: "claude-x",
			agentRunner: makeRunner(false),
			workspace: { path: "/ws/CYR-1" },
		};
		const ew = makeEdgeWorker(session);

		await ew.handleHandoffCommand(makeWebhook(), [makeRepo()], {
			targetRunner: null,
			rawTarget: "gemini",
			remainder: "",
		});

		expect(ew.agentSessionManager.createResponseActivity).toHaveBeenCalledWith(
			"sess-1",
			expect.stringContaining("gemini"),
		);
		expect(ew.resumeAgentSession).not.toHaveBeenCalled();
	});

	it("no-ops when the target equals the current runner", async () => {
		const session = {
			id: "sess-1",
			codexSessionId: "codex-x",
			agentRunner: makeRunner(false),
			workspace: { path: "/ws/CYR-1" },
		};
		const ew = makeEdgeWorker(session);

		await ew.handleHandoffCommand(makeWebhook(), [makeRepo()], {
			targetRunner: "codex",
			rawTarget: "codex",
			remainder: "",
		});

		expect(ew.resumeAgentSession).not.toHaveBeenCalled();
		expect(ew.agentSessionManager.createResponseActivity).toHaveBeenCalledWith(
			"sess-1",
			expect.stringContaining("Already running"),
		);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-edge-worker test:run EdgeWorker.handoff`
Expected: FAIL — `handleHandoffCommand` is not defined.

- [ ] **Step 3: Add imports and instantiate the service**

In `packages/edge-worker/src/EdgeWorker.ts`, add to the imports near the other local `./` imports:

```typescript
import {
	getActiveRunnerType,
	HANDOFF_STOP_TIMEOUT_MS,
	type HandoffCommand,
	HandoffService,
} from "./HandoffService.js";
```

Add a private field alongside the other service fields (e.g. near `private gitService`):

```typescript
	private handoffService: HandoffService;
```

In the constructor, after `this.gitService` is assigned, add:

```typescript
		this.handoffService = new HandoffService(this.gitService);
```

- [ ] **Step 4: Add the routing branch**

In `handleUserPromptedAgentActivity`, replace the final line (~5179):

```typescript
		await this.handleNormalPromptedActivity(webhook, repositories);
```

with:

```typescript
		const handoff = this.handoffService.parseHandoffCommand(activityBody);
		if (handoff) {
			await this.handleHandoffCommand(webhook, repositories, handoff);
			return;
		}

		await this.handleNormalPromptedActivity(webhook, repositories);
```

- [ ] **Step 5: Implement `handleHandoffCommand`**

Add this method to the `EdgeWorker` class (place it directly after `handleNormalPromptedActivity`, before `handleIssueUnassigned`):

```typescript
	/**
	 * Cross-runner handoff (Branch 3b of agentSessionPrompted).
	 * Stops the active runner (sequentially, with a timeout), snapshots the
	 * worktree/git/PR state, then starts the target runner fresh in the SAME
	 * worktree with the snapshot injected into its prompt. Never runs both
	 * runners concurrently.
	 */
	private async handleHandoffCommand(
		webhook: AgentSessionPromptedWebhook,
		repositories: RepositoryConfig[],
		handoff: HandoffCommand,
	): Promise<void> {
		const { agentSession } = webhook;
		const sessionId = agentSession.id;
		const issueId = agentSession.issue?.id ?? "";
		const linearWorkspaceId = webhook.organizationId;
		const repository = repositories[0]!;

		// Reject unsupported targets (only claude & codex are valid).
		if (!handoff.targetRunner) {
			await this.agentSessionManager.createResponseActivity(
				sessionId,
				`⚠️ Handoff failed: unknown runner "${handoff.rawTarget}". Supported targets: \`claude\`, \`codex\`.`,
			);
			return;
		}
		const target = handoff.targetRunner;

		const session = this.agentSessionManager.getSession(sessionId);
		if (!session) {
			// No session yet (and therefore no active runner): nothing to hand
			// off from. Ask the user to start the runner the normal way.
			await this.agentSessionManager.createResponseActivity(
				sessionId,
				`⚠️ Handoff to \`${target}\` could not start: no active session was found for this issue. Mention me with a prompt to start one.`,
			);
			return;
		}

		const source = getActiveRunnerType(session);
		if (source === target) {
			await this.agentSessionManager.createResponseActivity(
				sessionId,
				`ℹ️ Already running \`${target}\` for this issue — nothing to hand off.`,
			);
			return;
		}

		// Sequentially stop the active runner before starting the target.
		const runner = session.agentRunner;
		if (runner?.isRunning()) {
			this.agentSessionManager.requestSessionStop(sessionId);
			runner.stop();
			const stopped = await this.handoffService.waitForStopped(
				() => runner.isRunning(),
				{
					timeoutMs: HANDOFF_STOP_TIMEOUT_MS,
					pollIntervalMs: 250,
					sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
				},
			);
			if (!stopped) {
				this.logger.warn(
					`Handoff blocked: ${source} runner did not stop for session ${sessionId}`,
					{ from: source, to: target, sessionId },
				);
				await this.agentSessionManager.createResponseActivity(
					sessionId,
					`⚠️ Handoff to \`${target}\` is blocked: the current \`${source}\` runner did not stop in time. It may be mid-operation — please try again in a moment.`,
				);
				return;
			}
		}

		// Snapshot the source worktree state for the target's starting prompt.
		const snapshot = this.handoffService.buildSnapshot({
			sourceRunner: source,
			targetRunner: target,
			issueId,
			sessionId,
			worktreePath: session.workspace.path,
			latestSummary: this.agentSessionManager.getLastAssistantBody(sessionId),
		});
		const handoffPrompt = this.handoffService.buildHandoffPrompt(
			snapshot,
			handoff.remainder,
		);

		// Clear the old runner binding so post-handoff routing follows the target.
		this.agentSessionManager.clearRunnerSessionBindings(sessionId);

		this.logger.info("Handoff starting", {
			from: source,
			to: target,
			sessionId,
			worktreePath: snapshot.worktreePath,
			branch: snapshot.branch,
		});

		try {
			await this.resumeAgentSession(
				session,
				repository,
				sessionId,
				this.agentSessionManager,
				handoffPrompt,
				"", // attachmentManifest
				false, // isNewSession — session already exists
				[], // additionalAllowedDirectories
				linearWorkspaceId,
				undefined, // maxTurns
				undefined, // commentAuthor
				undefined, // commentTimestamp
				target, // runnerTypeOverride — forces the target runner
			);
			this.logger.info("Handoff complete", {
				from: source,
				to: target,
				sessionId,
			});
		} catch (error) {
			this.logger.error(
				`Handoff failed to start ${target} runner for session ${sessionId}`,
				error,
			);
			await this.agentSessionManager.createResponseActivity(
				sessionId,
				`⚠️ Handoff to \`${target}\` failed to start: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
```

- [ ] **Step 6: Run the acceptance test to verify it passes**

Run: `pnpm --filter cyrus-edge-worker test:run EdgeWorker.handoff`
Expected: PASS (4 tests).

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter cyrus-edge-worker typecheck`
Expected: PASS. (If `RunnerType` is not yet imported in `EdgeWorker.ts`, add it to the `cyrus-core` import. If `AgentSessionPromptedWebhook` / `RepositoryConfig` are not imported, they already are — they're used by `handleUserPromptedAgentActivity`.)

- [ ] **Step 8: Commit**

```bash
git add packages/edge-worker/src/EdgeWorker.ts packages/edge-worker/test/EdgeWorker.handoff.test.ts
git commit -m "feat(handoff): wire /handoff command into EdgeWorker"
```

---

### Task 10: Full suite, changelog, and final verification

**Files:**
- Modify: `CHANGELOG.md` (under `## [Unreleased]`)

- [ ] **Step 1: Run the full edge-worker test suite**

Run: `pnpm --filter cyrus-edge-worker test:run`
Expected: PASS (all tests, including the new handoff tests and the pre-existing suite).

- [ ] **Step 2: Typecheck the whole repo**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Update the changelog**

In `CHANGELOG.md`, under `## [Unreleased]` → `### Added`, add:

```markdown
- Cross-runner handoff: comment `@Cyrus /handoff codex` or `@Cyrus /handoff claude` on a Linear issue to hand the in-progress work to the other runner. The target runner continues in the same worktree, branch, and PR, with a snapshot of the current state. Cyrus stops the active runner first and never runs both at once; if the active runner can't be stopped, it posts a comment explaining the handoff is blocked.
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for cross-runner handoff"
```

---

## Self-Review Notes

- **Spec coverage:** command parsing (Task 2), runner selection / force-override (Task 1 + 8), same-worktree reuse (Task 9 — `resumeAgentSession` reuses `session.workspace`; acceptance test asserts same session object), blocked handoff (Tasks 6 + 9), snapshot creation (Tasks 4 + 5), failure handling (Task 9 try/catch + test), no-runner-active / same-runner no-op (Task 9), event logging (Task 9 `logger.info`/`logger.warn` with `{ from, to, sessionId }`), backward compatibility (Task 8 override defaults to undefined; Task 1 sticky logic preserved in `else`).
- **Acceptance criteria mapping:** `[agent=...]` unchanged → Task 1 keeps the sticky path under `else`, regression-guarded by `EdgeWorker.runner-selection` (Task 8 Step 6). `/handoff codex` after Claude and `/handoff claude` after Codex → symmetric via `getActiveRunnerType` + override (Task 9 test covers claude→codex; the codex→claude path is identical logic). Never concurrent → source stopped + awaited before target starts (Task 9). Both report to same issue → same `CyrusAgentSession`/thread reused.
- **Type consistency:** `runnerTypeOverride` is `RunnerType` in `IssueRunnerConfigInput`, `buildAgentRunnerConfig`, and `resumeAgentSession`; `handleHandoffCommand` passes a `HandoffTarget` (`"claude" | "codex"`), which is assignable to `RunnerType`. `getActiveRunnerType` returns `RunnerType | "unknown"`; only used for display + equality, never passed where `RunnerType` is required.
- **Constructor-arity caveats:** the `RunnerConfigBuilder`, `GitService`, and `AgentSessionManager` test helpers note to match the real constructor signature used in neighboring tests if the simplified construction throws.
