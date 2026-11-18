import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const HEX_SHA256 = /^[a-f0-9]{64}$/;
const FULL_GIT_SHA = /^[a-f0-9]{40}$/;
const REQUIRED_PROVENANCE = {
	artifacts: {
		consumerLockSha256:
			"ce02091b7fb90f73c3fd4969c5a0fb241cb9713f4d9e9f822baa1c85159774f0",
		coreSha256:
			"71d38b5ec8307137c54fcd214b1431fc9cd49c07ce6fc103d140677f3747df97",
		runnerSha256:
			"8685d51a65aa757fd5075ecdfd0f16cf0b9202b0990f6d549a0d69a79540dd27",
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
		osUser: "agentops",
		subscriptionType: "max",
	},
	installed: {
		agentSdk: ["@anthropic-ai/claude-agent-sdk", "0.3.327"],
		apiSdk: ["@anthropic-ai/sdk", "1.10.0"],
		core: ["cyrus-core", "0.2.83-test.0"],
		native: ["@anthropic-ai/claude-agent-sdk-darwin-arm64", "0.3.327"],
		nativeClaudeCodeVersion: "2.1.327",
		nativeExecutableSha256:
			"76d48205c926c8a6978cfc2171b631bcd01e20bbadd085638bb2ec57bea91c5b",
		runner: ["cyrus-claude-runner", "0.2.83-test.0"],
	},
	source: {
		featureCommit: "1830d64e950dbcb489a1047ad95d45a1e0cd0a65",
		pullRequest: 1609,
		repository: "cyrusagents/cyrus",
	},
};

function run(command, args, options = {}) {
	const { redactFailureOutput = false, ...spawnOptions } = options;
	const result = spawnSync(command, args, {
		encoding: "utf8",
		...spawnOptions,
	});
	assert.equal(
		result.status,
		0,
		redactFailureOutput
			? `${command} failed with status ${result.status}`
			: `${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
	);
	return result.stdout.trim();
}

export function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function sha256Tree(root, ignoredTopLevelNames = new Set()) {
	const hash = createHash("sha256");
	const walk = (directory) => {
		for (const name of readdirSync(directory).sort()) {
			if (directory === root && ignoredTopLevelNames.has(name)) continue;
			const path = join(directory, name);
			const entry = lstatSync(path);
			const entryPath = relative(root, path).split("\\").join("/");
			if (entry.isDirectory()) {
				hash.update(`D\0${entryPath}\0`);
				walk(path);
			} else if (entry.isSymbolicLink()) {
				hash.update(`L\0${entryPath}\0${readlinkSync(path)}\0`);
			} else if (entry.isFile()) {
				hash.update(`F\0${entryPath}\0`);
				hash.update(readFileSync(path));
				hash.update("\0");
			}
		}
	};
	walk(root);
	return hash.digest("hex");
}

export function sha256TarballTree(path) {
	const temporaryDirectory = mkdtempSync(join(tmpdir(), "runtime-provenance-"));
	try {
		run("tar", ["-xzf", path, "-C", temporaryDirectory]);
		return sha256Tree(join(temporaryDirectory, "package"));
	} finally {
		rmSync(temporaryDirectory, { force: true, recursive: true });
	}
}

function readManifest(packageRoot) {
	return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
}

function artifactPath(provenancePath, artifact) {
	assert.equal(typeof artifact?.path, "string");
	return resolve(dirname(provenancePath), artifact.path);
}

function assertSafeIdentity(identity) {
	assert.equal(identity.loggedIn, true, "Claude account is not logged in");
	for (const field of [
		"accountEmailSha256",
		"osUser",
		"authMethod",
		"apiProvider",
		"subscriptionType",
	]) {
		assert.equal(typeof identity[field], "string", `Missing identity.${field}`);
		assert.ok(identity[field].length > 0, `Empty identity.${field}`);
	}
	assertHash(identity.accountEmailSha256, "identity.accountEmailSha256");
}

function assertHash(value, name) {
	assert.match(value, HEX_SHA256, `${name} is not a SHA-256 digest`);
}

export function validateRuntimeProvenance(expected, observed) {
	assert.equal(expected.schemaVersion, 1);
	assert.match(expected.source.commit, FULL_GIT_SHA);
	assert.match(expected.source.featureCommit, FULL_GIT_SHA);
	assert.deepEqual(
		{
			featureCommit: expected.source.featureCommit,
			pullRequest: expected.source.pullRequest,
			repository: expected.source.repository,
		},
		REQUIRED_PROVENANCE.source,
		"Provenance does not target the reviewed pull request",
	);
	assert.deepEqual(
		expected.configuration,
		REQUIRED_PROVENANCE.configuration,
		"Provenance does not target the preserved Claude configuration",
	);
	assertSafeIdentity(expected.identity);
	assert.deepEqual(
		{
			accountEmailSha256: expected.identity.accountEmailSha256,
			apiProvider: expected.identity.apiProvider,
			authMethod: expected.identity.authMethod,
			osUser: expected.identity.osUser,
			subscriptionType: expected.identity.subscriptionType,
		},
		REQUIRED_PROVENANCE.identity,
		"Provenance does not target the intended Claude account",
	);
	assert.deepEqual(
		{
			consumerLockSha256: expected.artifacts.consumerLock.sha256,
			coreSha256: expected.artifacts.core.sha256,
			runnerSha256: expected.artifacts.runner.sha256,
		},
		REQUIRED_PROVENANCE.artifacts,
		"Provenance does not target the reviewed packed artifacts",
	);
	assert.deepEqual(
		{
			agentSdk: [
				expected.installed.agentSdk.name,
				expected.installed.agentSdk.version,
			],
			apiSdk: [
				expected.installed.apiSdk.name,
				expected.installed.apiSdk.version,
			],
			core: [expected.installed.core.name, expected.installed.core.version],
			native: [
				expected.installed.native.name,
				expected.installed.native.version,
			],
			nativeClaudeCodeVersion: expected.installed.native.claudeCodeVersion,
			nativeExecutableSha256: expected.installed.native.executableSha256,
			runner: [
				expected.installed.runner.name,
				expected.installed.runner.version,
			],
		},
		REQUIRED_PROVENANCE.installed,
		"Provenance does not target the reviewed installed runtime",
	);

	const comparisons = [
		["source.commit", expected.source.commit, observed.source.commit],
		["source.prHead", expected.source.featureCommit, observed.source.prHead],
		[
			"source.repository",
			expected.source.repository,
			observed.source.repository,
		],
		[
			"source.pullRequest",
			expected.source.pullRequest,
			observed.source.pullRequest,
		],
		["source.trackedClean", true, observed.source.trackedClean],
		[
			"configuration.configDir",
			expected.configuration.configDir,
			observed.configuration.configDir,
		],
		[
			"configuration.secureStorageConfigDir",
			expected.configuration.secureStorageConfigDir,
			observed.configuration.secureStorageConfigDir,
		],
		[
			"artifacts.runner.sha256",
			expected.artifacts.runner.sha256,
			observed.artifacts.runner.sha256,
		],
		[
			"artifacts.runner.treeSha256",
			expected.artifacts.runner.treeSha256,
			observed.artifacts.runner.treeSha256,
		],
		[
			"artifacts.core.sha256",
			expected.artifacts.core.sha256,
			observed.artifacts.core.sha256,
		],
		[
			"artifacts.core.treeSha256",
			expected.artifacts.core.treeSha256,
			observed.artifacts.core.treeSha256,
		],
		[
			"artifacts.consumerLock.sha256",
			expected.artifacts.consumerLock.sha256,
			observed.artifacts.consumerLock.sha256,
		],
		[
			"installed.runner.name",
			expected.installed.runner.name,
			observed.installed.runner.name,
		],
		[
			"installed.runner.version",
			expected.installed.runner.version,
			observed.installed.runner.version,
		],
		[
			"installed.runner.treeSha256",
			expected.artifacts.runner.treeSha256,
			observed.installed.runner.treeSha256,
		],
		[
			"installed.core.name",
			expected.installed.core.name,
			observed.installed.core.name,
		],
		[
			"installed.core.version",
			expected.installed.core.version,
			observed.installed.core.version,
		],
		[
			"installed.core.treeSha256",
			expected.artifacts.core.treeSha256,
			observed.installed.core.treeSha256,
		],
		[
			"installed.agentSdk.name",
			expected.installed.agentSdk.name,
			observed.installed.agentSdk.name,
		],
		[
			"installed.agentSdk.version",
			expected.installed.agentSdk.version,
			observed.installed.agentSdk.version,
		],
		[
			"installed.apiSdk.name",
			expected.installed.apiSdk.name,
			observed.installed.apiSdk.name,
		],
		[
			"installed.apiSdk.version",
			expected.installed.apiSdk.version,
			observed.installed.apiSdk.version,
		],
		[
			"installed.native.name",
			expected.installed.native.name,
			observed.installed.native.name,
		],
		[
			"installed.native.version",
			expected.installed.native.version,
			observed.installed.native.version,
		],
		[
			"installed.native.executableSha256",
			expected.installed.native.executableSha256,
			observed.installed.native.executableSha256,
		],
		[
			"installed.native.claudeCodeVersion",
			expected.installed.native.claudeCodeVersion,
			observed.installed.native.claudeCodeVersion,
		],
		["identity.osUser", expected.identity.osUser, observed.identity.osUser],
		[
			"identity.loggedIn",
			expected.identity.loggedIn,
			observed.identity.loggedIn,
		],
		[
			"identity.authMethod",
			expected.identity.authMethod,
			observed.identity.authMethod,
		],
		[
			"identity.apiProvider",
			expected.identity.apiProvider,
			observed.identity.apiProvider,
		],
		[
			"identity.accountEmailSha256",
			expected.identity.accountEmailSha256,
			observed.identity.accountEmailSha256,
		],
		[
			"identity.subscriptionType",
			expected.identity.subscriptionType,
			observed.identity.subscriptionType,
		],
	];
	for (const [name, expectedValue, observedValue] of comparisons) {
		assert.deepEqual(
			observedValue,
			expectedValue,
			`${name} did not match provenance`,
		);
	}

	for (const [name, value] of [
		["artifacts.runner.sha256", expected.artifacts.runner.sha256],
		["artifacts.runner.treeSha256", expected.artifacts.runner.treeSha256],
		["artifacts.core.sha256", expected.artifacts.core.sha256],
		["artifacts.core.treeSha256", expected.artifacts.core.treeSha256],
		["artifacts.consumerLock.sha256", expected.artifacts.consumerLock.sha256],
		[
			"installed.native.executableSha256",
			expected.installed.native.executableSha256,
		],
	]) {
		assertHash(value, name);
	}

	return observed;
}

export function verifyRuntimeProvenance({
	packageRoot,
	provenancePath,
	sourceRoot,
	workingDirectory,
}) {
	const expected = JSON.parse(readFileSync(provenancePath, "utf8"));
	const runnerRoot = realpathSync(packageRoot);
	const consumerRoot = realpathSync(workingDirectory);
	assert.equal(
		runnerRoot,
		realpathSync(join(consumerRoot, "node_modules", "cyrus-claude-runner")),
		"Runner path is not the retained consumer's installed runner",
	);

	for (const name of [
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_AUTH_TOKEN",
		"CLAUDE_CODE_OAUTH_TOKEN",
		"ANTHROPIC_BASE_URL",
		"CLAUDE_CODE_USE_BEDROCK",
		"CLAUDE_CODE_USE_VERTEX",
		"CLAUDE_CODE_USE_FOUNDRY",
		"CLAUDE_CODE_USE_MANTLE",
	]) {
		assert.equal(
			Object.hasOwn(process.env, name),
			false,
			`${name} would replace the intended provider or account`,
		);
	}
	assert.equal(
		process.env.CLAUDE_CONFIG_DIR,
		expected.configuration.configDir,
		"CLAUDE_CONFIG_DIR does not select the preserved Claude configuration",
	);
	assert.equal(
		process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
		expected.configuration.secureStorageConfigDir,
		"CLAUDE_SECURESTORAGE_CONFIG_DIR does not preserve the intended keychain service",
	);

	const runnerArtifact = artifactPath(
		provenancePath,
		expected.artifacts.runner,
	);
	const coreArtifact = artifactPath(provenancePath, expected.artifacts.core);
	const lockPath = artifactPath(
		provenancePath,
		expected.artifacts.consumerLock,
	);
	const coreRoot = join(consumerRoot, "node_modules", "cyrus-core");
	const agentSdkRoot = join(
		consumerRoot,
		"node_modules",
		"@anthropic-ai",
		"claude-agent-sdk",
	);
	const apiSdkRoot = join(consumerRoot, "node_modules", "@anthropic-ai", "sdk");
	const nativeRoot = join(
		consumerRoot,
		"node_modules",
		...expected.installed.native.name.split("/"),
	);
	const nativeExecutable = join(nativeRoot, "claude");
	const authStatus = JSON.parse(
		run(nativeExecutable, ["auth", "status", "--json"], {
			redactFailureOutput: true,
		}),
	);
	const versionOutput = run(nativeExecutable, ["--version"]);
	const head = run("git", ["-C", sourceRoot, "rev-parse", "HEAD"]);
	const trackedChanges = run("git", [
		"-C",
		sourceRoot,
		"status",
		"--porcelain",
		"--untracked-files=no",
	]);
	const pr = JSON.parse(
		run("gh", [
			"pr",
			"view",
			String(expected.source.pullRequest),
			"--repo",
			expected.source.repository,
			"--json",
			"headRefOid,number",
		]),
	);
	const observed = {
		schemaVersion: 1,
		source: {
			commit: head,
			prHead: pr.headRefOid,
			pullRequest: pr.number,
			repository: expected.source.repository,
			trackedClean: trackedChanges.length === 0,
		},
		configuration: {
			configDir: process.env.CLAUDE_CONFIG_DIR,
			secureStorageConfigDir: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
		},
		artifacts: {
			consumerLock: { sha256: sha256File(lockPath) },
			core: {
				sha256: sha256File(coreArtifact),
				treeSha256: sha256TarballTree(coreArtifact),
			},
			runner: {
				sha256: sha256File(runnerArtifact),
				treeSha256: sha256TarballTree(runnerArtifact),
			},
		},
		installed: {
			agentSdk: readManifest(agentSdkRoot),
			apiSdk: readManifest(apiSdkRoot),
			core: {
				...readManifest(coreRoot),
				treeSha256: sha256Tree(coreRoot, new Set(["node_modules"])),
			},
			native: {
				...readManifest(nativeRoot),
				claudeCodeVersion: versionOutput.split(" ")[0],
				executableSha256: sha256File(nativeExecutable),
			},
			runner: {
				...readManifest(runnerRoot),
				treeSha256: sha256Tree(runnerRoot, new Set(["node_modules"])),
			},
		},
		identity: {
			accountEmailSha256: createHash("sha256")
				.update(authStatus.email)
				.digest("hex"),
			apiProvider: authStatus.apiProvider,
			authMethod: authStatus.authMethod,
			loggedIn: authStatus.loggedIn,
			osUser: userInfo().username,
			subscriptionType: authStatus.subscriptionType,
		},
	};
	validateRuntimeProvenance(expected, observed);
	return { expected, observed };
}
