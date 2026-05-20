// Real-Daytona two-turn resume smoke. Proves Claude remembers turn 1's
// context when turn 2 runs in a brand-new sandbox that mounts the same
// Daytona Volume at CLAUDE_CONFIG_DIR.
//
// Prereqs (env):
//   DAYTONA_API_KEY              — your Daytona key
//   CLAUDE_CODE_OAUTH_TOKEN      — portable Claude Code token
//   CYRUS_TEST_VOLUME_ID         — id of a pre-created Daytona volume
//
// Build first: pnpm --filter cyrus-agent-runtime build
// Run from packages/agent-runtime: node test-scripts/resume-smoke.mjs

import { daytona } from "@computesdk/daytona";
import { createAgentSession } from "../dist/index.js";
import { createComputeSdkSandboxProvider } from "../dist/sandbox/compute-sdk.js";

const VOLUME_ID = process.env.CYRUS_TEST_VOLUME_ID;
if (!VOLUME_ID) throw new Error("Set CYRUS_TEST_VOLUME_ID");

// Pick a per-run subpath so reruns don't see each other's state. In real
// Cyrus, AgentSessionManager would derive this from its own session id.
const SUBPATH = `smoke/${Date.now()}`;
const MOUNT = "/var/cyrus/context";

const provider = createComputeSdkSandboxProvider({
	compute: daytona({ apiKey: process.env.DAYTONA_API_KEY, timeout: 300000 }),
});
const sandboxProviders = { daytona: provider };

function commonConfig(userPrompt, resumeHarnessSessionId) {
	return {
		harness: { kind: "claude" },
		userPrompt,
		env: {
			PATH: "/home/daytona/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			CLAUDE_CONFIG_DIR: `${MOUNT}/.claude`,
		},
		secrets: {
			CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
		},
		packages: {
			commands: [
				"npm config set prefix /home/daytona/.npm-global",
				"npm install -g @anthropic-ai/claude-code",
			],
		},
		sandbox: {
			provider: "daytona",
			name: `agent-runtime-resume-${Date.now()}`,
			workingDirectory: "/home/daytona",
			timeoutMs: 300000,
			// Same volume + same subpath on both turns. Sandbox is fresh each
			// turn; the volume's contents survive sandbox.destroy().
			volumes: [
				{ name: VOLUME_ID, mountPath: MOUNT, subpath: SUBPATH, kind: "fuse" },
			],
		},
		resumeHarnessSessionId,
	};
}

// ---- Turn 1 ----------------------------------------------------------------
console.log("[turn 1] starting");
const session1 = await createAgentSession(
	commonConfig("Remember this token: BANANA-7. Reply 'noted'."),
	{ sandboxProviders },
);
const result1 = await session1.start();
await result1.destroy();

console.log("[turn 1]", {
	success: result1.success,
	result: result1.result,
	harnessSessionId: result1.harnessSessionId,
});

if (!result1.harnessSessionId) {
	throw new Error("No harnessSessionId captured on turn 1");
}

// ---- Turn 2 — brand-new sandbox, same volume + subpath, resume id ---------
console.log("[turn 2] starting with resume id", result1.harnessSessionId);
const session2 = await createAgentSession(
	commonConfig(
		"What token did I ask you to remember? Reply with just the token, no extra words.",
		result1.harnessSessionId,
	),
	{ sandboxProviders },
);
const result2 = await session2.start();
await result2.destroy();

console.log("[turn 2]", {
	success: result2.success,
	result: result2.result,
	harnessSessionId: result2.harnessSessionId,
});

const remembered = result2.result?.includes("BANANA-7");
console.log(remembered ? "PASS — resume works" : "FAIL — turn 2 did not recall turn 1");
process.exit(remembered ? 0 : 1);
