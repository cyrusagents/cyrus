import { expect, test } from "vitest";
import { validateRuntimeProvenance } from "../../../scripts/verify-runner-provenance.mjs";

const treeSha256 = "a".repeat(64);
const commit = "b".repeat(40);
const featureCommit = "300ab4ad31842abab37249c97d5683d33b9ab9e3";
const testRelease = {
	channel: "test",
	repository: "https://github.com/cyrusagents/cyrus",
	schemaVersion: 1,
	sourceSha: commit,
	version: "0.2.84-test.2",
};
const expectedProvenance = () => ({
	artifacts: {
		consumerLock: {
			sha256:
				"2eb4e15d83c1d9f11053570245e307227e8a5a522a898c4e54f758a4eafe552f",
		},
		core: {
			path: "packages/cyrus-core-0.2.84-test.2.tgz",
			sha256:
				"b07526457da8d91f993c4316e3763a143e66c6b024c2599d7644e51de037e574",
			treeSha256,
		},
		runner: {
			path: "packages/cyrus-claude-runner-0.2.84-test.2.tgz",
			sha256:
				"a15716536375f28400bb49fe1d8007eef008b78146f4f900b2dc50af3339998e",
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
		agentSdk: { name: "@anthropic-ai/claude-agent-sdk", version: "0.3.330" },
		apiSdk: { name: "@anthropic-ai/sdk", version: "1.12.0" },
		core: { name: "cyrus-core", version: "0.2.84-test.2" },
		native: {
			claudeCodeVersion: "2.1.330",
			executableSha256:
				"f7c5093b9dd6560d08af28bc27b123fb55091deae3180ac39df199522da86815",
			name: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
			version: "0.3.330",
		},
		runner: { name: "cyrus-claude-runner", version: "0.2.84-test.2" },
	},
	schemaVersion: 1,
	source: {
		commit,
		featureCommit,
		pullRequest: 1618,
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
		prHead: featureCommit,
		pullRequest: 1618,
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
	const observed = observedProvenance(expected);
	expected.artifacts.runner.sha256 = "c".repeat(64);
	expect(() => validateRuntimeProvenance(expected, observed)).toThrow(
		/sha256 did not match provenance/,
	);
});

test("rejects an installed package without the immutable candidate stamp", () => {
	const expected = expectedProvenance();
	const observed = observedProvenance(expected);
	delete observed.installed.runner.cyrusTestRelease;
	expect(() => validateRuntimeProvenance(expected, observed)).toThrow(
		/immutable candidate provenance stamp/,
	);
});

test("rejects a provenance record that names a different account", () => {
	const expected = expectedProvenance();
	expected.identity.accountEmailSha256 = "c".repeat(64);
	expect(() =>
		validateRuntimeProvenance(expected, observedProvenance(expected)),
	).toThrow(/intended Claude account/);
});
