import { expect, test } from "vitest";
import { validateRuntimeProvenance } from "../../../scripts/verify-runner-provenance.mjs";

const treeSha256 = "a".repeat(64);
const commit = "b".repeat(40);
const expectedProvenance = () => ({
	artifacts: {
		consumerLock: {
			sha256:
				"aab96b4a73ab8ceef592814246e9944b686c9be3d72991ced010055b1e2259ab",
		},
		core: {
			path: "packages/cyrus-core-0.2.75.tgz",
			sha256:
				"a361bab54d3e02093155eba1a7ed569704ce9ffb22cd9626f280755183e2ef07",
			treeSha256,
		},
		runner: {
			path: "packages/cyrus-claude-runner-0.2.75.tgz",
			sha256:
				"91f5ed141cd8ef2c344408fc32b94f0c7327c2d04388734e0c8bf7e460186ced",
			treeSha256,
		},
	},
	identity: {
		accountEmailSha256:
			"d3f063f14875fb814af753daad734c68f131c5680ca5f190dc18e0a2fded380a",
		apiProvider: "firstParty",
		authMethod: "claude.ai",
		loggedIn: true,
		osUser: "agentops",
		subscriptionType: "max",
	},
	installed: {
		agentSdk: { name: "@anthropic-ai/claude-agent-sdk", version: "0.3.318" },
		apiSdk: { name: "@anthropic-ai/sdk", version: "1.5.0" },
		core: { name: "cyrus-core", version: "0.2.75" },
		native: {
			claudeCodeVersion: "2.1.318",
			executableSha256:
				"677a2ea7bf576cedd20e191d973914ed8a41796f53a63b1923381ddc4d5b5e7d",
			name: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
			version: "0.3.318",
		},
		runner: { name: "cyrus-claude-runner", version: "0.2.75" },
	},
	schemaVersion: 1,
	source: {
		commit,
		pullRequest: 1583,
		repository: "cyrusagents/cyrus",
	},
});

const observedProvenance = (expected) => ({
	artifacts: {
		consumerLock: { sha256: expected.artifacts.consumerLock.sha256 },
		core: {
			sha256: expected.artifacts.core.sha256,
			treeSha256: expected.artifacts.core.treeSha256,
		},
		runner: {
			sha256: expected.artifacts.runner.sha256,
			treeSha256: expected.artifacts.runner.treeSha256,
		},
	},
	identity: structuredClone(expected.identity),
	installed: {
		agentSdk: structuredClone(expected.installed.agentSdk),
		apiSdk: structuredClone(expected.installed.apiSdk),
		core: { ...expected.installed.core, treeSha256 },
		native: structuredClone(expected.installed.native),
		runner: { ...expected.installed.runner, treeSha256 },
	},
	schemaVersion: 1,
	source: {
		commit,
		prHead: commit,
		pullRequest: 1583,
		repository: "cyrusagents/cyrus",
		trackedClean: true,
	},
});

test("accepts the exact reviewed source, artifacts, runtime, and identity", () => {
	const expected = expectedProvenance();
	expect(
		validateRuntimeProvenance(expected, observedProvenance(expected)),
	).toBeDefined();
});

test.each([
	["final PR head", (observed) => (observed.source.prHead = "c".repeat(40))],
	[
		"installed runner tree",
		(observed) => (observed.installed.runner.treeSha256 = "c".repeat(64)),
	],
	[
		"Agent SDK version",
		(observed) => (observed.installed.agentSdk.version = "0.3.317"),
	],
	[
		"native Claude version",
		(observed) => (observed.installed.native.claudeCodeVersion = "2.1.317"),
	],
	[
		"Claude provider",
		(observed) => (observed.identity.apiProvider = "bedrock"),
	],
	[
		"Claude account",
		(observed) => (observed.identity.accountEmailSha256 = "c".repeat(64)),
	],
])("rejects a different %s", (_name, mutate) => {
	const expected = expectedProvenance();
	const observed = observedProvenance(expected);
	mutate(observed);
	expect(() => validateRuntimeProvenance(expected, observed)).toThrow();
});

test("rejects a provenance record that names a different artifact", () => {
	const expected = expectedProvenance();
	expected.artifacts.runner.sha256 = "c".repeat(64);
	expect(() =>
		validateRuntimeProvenance(expected, observedProvenance(expected)),
	).toThrow(/reviewed packed artifacts/);
});

test("rejects a provenance record that names a different account", () => {
	const expected = expectedProvenance();
	expected.identity.accountEmailSha256 = "c".repeat(64);
	expect(() =>
		validateRuntimeProvenance(expected, observedProvenance(expected)),
	).toThrow(/intended Claude account/);
});
