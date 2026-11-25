import { expect, test } from "vitest";
import { validateRuntimeProvenance } from "../../../scripts/verify-runner-provenance.mjs";

const treeSha256 = "a".repeat(64);
const commit = "b".repeat(40);
const featureCommit = "d5f2c7edf0e2a2a0f5e0ac0d8a466c05b9ad8765";
const prHead = "c".repeat(40);
const testRelease = {
	channel: "test",
	repository: "https://github.com/cyrusagents/cyrus",
	schemaVersion: 1,
	sourceSha: commit,
	version: "0.2.84-test.1",
};
const expectedProvenance = () => ({
	artifacts: {
		consumerLock: {
			sha256: "d".repeat(64),
		},
		core: {
			path: "packages/cyrus-core-0.2.84-test.1.tgz",
			sha256: "e".repeat(64),
			treeSha256,
		},
		runner: {
			path: "packages/cyrus-claude-runner-0.2.84-test.1.tgz",
			sha256: "f".repeat(64),
			treeSha256,
		},
	},
	configuration: {
		configDir: "/Users/agentops",
		sandbox: {
			allowUnsandboxedCommands: false,
			autoAllowBashIfSandboxed: true,
			enabled: true,
			filesystem: {
				allowRead: ["."],
				allowWrite: ["."],
			},
		},
		secureStorageConfigDir: "",
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
		agentSdk: { name: "@anthropic-ai/claude-agent-sdk", version: "0.3.332" },
		apiSdk: { name: "@anthropic-ai/sdk", version: "1.14.0" },
		core: { name: "cyrus-core", version: "0.2.84-test.1" },
		native: {
			claudeCodeVersion: "2.1.331",
			executableSha256:
				"4874591dc39bff1188921b82cbeb8a44e3a33b0f92c888b3d43639b9344101f7",
			name: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
			version: "0.3.332",
		},
		runner: { name: "cyrus-claude-runner", version: "0.2.84-test.1" },
	},
	schemaVersion: 1,
	source: {
		commit,
		featureCommit,
		pullRequest: 1620,
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
	configuration: structuredClone(expected.configuration),
	identity: structuredClone(expected.identity),
	installed: {
		agentSdk: structuredClone(expected.installed.agentSdk),
		apiSdk: structuredClone(expected.installed.apiSdk),
		core: {
			...expected.installed.core,
			cyrusTestRelease: structuredClone(testRelease),
			treeSha256,
		},
		native: structuredClone(expected.installed.native),
		runner: {
			...expected.installed.runner,
			cyrusTestRelease: structuredClone(testRelease),
			treeSha256,
		},
	},
	schemaVersion: 1,
	source: {
		commit,
		featureCommitInCandidate: true,
		featureCommitInPrHead: true,
		prHead,
		pullRequest: 1620,
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
	[
		"feature source outside final PR head",
		(observed) => (observed.source.featureCommitInPrHead = false),
	],
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
	[
		"sandbox configuration",
		(observed) => (observed.configuration.sandbox.enabled = false),
	],
	[
		"candidate provenance stamp",
		(observed) =>
			(observed.installed.runner.cyrusTestRelease.sourceSha = prHead),
	],
])("rejects a different %s", (_name, mutate) => {
	const expected = expectedProvenance();
	const observed = observedProvenance(expected);
	mutate(observed);
	expect(() => validateRuntimeProvenance(expected, observed)).toThrow();
});

test("rejects a provenance record that names a different artifact", () => {
	const expected = expectedProvenance();
	const observed = observedProvenance(expected);
	expected.artifacts.runner.sha256 = "c".repeat(64);
	expect(() => validateRuntimeProvenance(expected, observed)).toThrow(
		/sha256 did not match provenance/,
	);
});

test("rejects a provenance record that names a different account", () => {
	const expected = expectedProvenance();
	expected.identity.accountEmailSha256 = "c".repeat(64);
	expect(() =>
		validateRuntimeProvenance(expected, observedProvenance(expected)),
	).toThrow(/intended Claude account/);
});
