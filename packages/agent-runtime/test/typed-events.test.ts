/**
 * Type-narrowing smoke tests. These are intentionally compile-time
 * assertions — if the generics don't propagate correctly the file
 * fails `tsc`. The runtime `expect`s are belt-and-suspenders.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { JsonStreamEvent } from "@google/gemini-cli-core";
import type { ThreadEvent } from "@openai/codex-sdk";
import { describe, expect, it } from "vitest";
import type {
	AgentSession,
	AgentSessionResult,
	HarnessRawByKind,
	OpenCodeStreamEvent,
	TranscriptEvent,
} from "../src/types.js";

// Helper: assert two types are equal at the type level.
type Equals<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: false;
type ExpectTrue<T extends true> = T;

describe("typed events — compile-time narrowing", () => {
	it("AgentSession<'claude'> events carry SDKMessage as raw", () => {
		// If the generic narrowing is broken this file fails tsc, not vitest.
		type _Claude = ExpectTrue<Equals<HarnessRawByKind["claude"], SDKMessage>>;
		type _Codex = ExpectTrue<Equals<HarnessRawByKind["codex"], ThreadEvent>>;
		type _Gemini = ExpectTrue<
			Equals<HarnessRawByKind["gemini"], JsonStreamEvent>
		>;
		type _OpenCode = ExpectTrue<
			Equals<HarnessRawByKind["opencode"], OpenCodeStreamEvent>
		>;
		type _CursorUnknown = ExpectTrue<
			Equals<HarnessRawByKind["cursor"], unknown>
		>;

		// Use a fake to anchor the test in the runtime too.
		type ClaudeSession = AgentSession<"claude">;
		const fakeEvent = {
			sessionId: "s",
			harness: "claude" as const,
			timestamp: "t",
			kind: "assistant",
			raw: { type: "assistant" } as unknown as SDKMessage,
		} satisfies TranscriptEvent<HarnessRawByKind["claude"]>;
		expect(fakeEvent.harness).toBe("claude");
	});

	it("AgentSessionResult<'codex'>.events are typed to ThreadEvent", () => {
		type CodexResult = AgentSessionResult<"codex">;
		type _Check = ExpectTrue<
			Equals<CodexResult["events"], TranscriptEvent<ThreadEvent>[]>
		>;
		type _HarnessTag = ExpectTrue<Equals<CodexResult["harness"], "codex">>;
		expect(true).toBe(true);
	});

	it("Defaulted AgentSession (no H) keeps a usable union for raw", () => {
		// Consumers that don't supply H see `unknown` (the union over all
		// HarnessRawByKind values is widened to unknown via the default).
		// This is the back-compat path — current code reading `event.raw`
		// without narrowing is unchanged.
		type Default = AgentSession;
		type _Harness = ExpectTrue<Equals<Default["harness"], HarnessKindLoose>>;
		expect(true).toBe(true);
	});
});

// Helper alias used in the back-compat test above. Keeping it local so
// the test file declares its own expectations rather than importing
// internals.
type HarnessKindLoose = "claude" | "codex" | "cursor" | "gemini" | "opencode";

describe("AgentSession.transcript() shape", () => {
	it("is typed to TranscriptEvent<HarnessRawByKind[H]>[] for a typed session", () => {
		type ClaudeTranscript = ReturnType<AgentSession<"claude">["transcript"]>;
		type _Claude = ExpectTrue<
			Equals<ClaudeTranscript, readonly TranscriptEvent<SDKMessage>[]>
		>;

		type CodexTranscript = ReturnType<AgentSession<"codex">["transcript"]>;
		type _Codex = ExpectTrue<
			Equals<CodexTranscript, readonly TranscriptEvent<ThreadEvent>[]>
		>;

		expect(true).toBe(true);
	});

	it("defaults to readonly TranscriptEvent<unknown>[] when H is not specified", () => {
		type DefaultTranscript = ReturnType<AgentSession["transcript"]>;
		type _Default = ExpectTrue<
			Equals<DefaultTranscript, readonly TranscriptEvent<unknown>[]>
		>;
		expect(true).toBe(true);
	});
});
