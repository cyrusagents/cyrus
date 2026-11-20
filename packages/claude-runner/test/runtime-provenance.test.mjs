import { expect, test } from "vitest";
import { validateRuntimeProvenance } from "../../../scripts/verify-runner-provenance.mjs";

const treeSha256 = "a".repeat(64);
const commit = "b".repeat(40);
const featureCommit = "1a5475b923ff41eb1ceb051d4a9fcb4ce85aa42f";
const testRelease = {
	channel: "test",
	repository: "https://github.com/cyrusagents/cyrus",
	schemaVersion: 1,
	sourceSha: commit,
	version: "0.2.84-test.4",
};
const expectedProvenance = () => ({
	artifacts: {
		consumerLock: {
			sha256: "d".repeat(64),
		},
		core: {
			path: "packages/cyrus-core-0.2.84-test.4.tgz",
			sha256: "e".repeat(64),
			treeSha256,
		},
		runner: {
			path: "packages/cyrus-claude-runner-0.2.84-test.4.tgz",
			sha256: "f".repeat(64),
			treeSha256,
		},
	},
	configuration: {
		configDir: "/Users/agentops",
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
		agentSdk: { name: "@anthropic-ai/claude-agent-sdk", version: "0.3.329" },
		apiSdk: { name: "@anthropic-ai/sdk", version: "1.12.0" },
		core: { name: "cyrus-core", version: "0.2.84-test.4" },
		native: {
			claudeCodeVersion: "2.1.329",
			executableSha256:
				"8c1729568b19cdadedd0a978bf692f9f279ef554c8a333c4e132b94fd8725550",
			name: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
			version: "0.3.329",
		},
		runner: { name: "cyrus-claude-runner", version: "0.2.84-test.4" },
	},
	schemaVersion: 1,
	source: {
		commit,
		featureCommit,
		pullRequest: 1617,
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
		pullRequest: 1617,
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
