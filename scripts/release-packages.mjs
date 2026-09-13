import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const trustedSkillName = "cyrus-fleet-operator";

export function createTrustedSkillArchive(version, outputDirectory) {
	if (!exactSemver.test(version))
		throw new Error(
			`Version must be an exact semantic version without a leading v; received ${version}.`,
		);
	const source = join(repositoryRoot, "skills", trustedSkillName);
	const files = walkFiles(source).sort();
	const blocks = [];
	for (const relativePath of files) {
		const data = readFileSync(join(source, relativePath));
		blocks.push(
			tarHeader(`${trustedSkillName}/${relativePath}`, data.length),
			data,
			Buffer.alloc((512 - (data.length % 512)) % 512),
		);
	}
	blocks.push(Buffer.alloc(1024));
	mkdirSync(outputDirectory, { recursive: true });
	const filename = `${trustedSkillName}-${version}.tar.gz`;
	const archivePath = join(outputDirectory, filename);
	const archive = gzipSync(Buffer.concat(blocks), { level: 9, mtime: 0 });
	writeFileSync(archivePath, archive);
	const digest = createHash("sha256").update(archive).digest("hex");
	writeFileSync(`${archivePath}.sha256`, `${digest}  ${filename}\n`);
	return {
		archivePath,
		checksumPath: `${archivePath}.sha256`,
		checksum: `sha256:${digest}`,
	};
}

function walkFiles(directory, prefix = "") {
	const files = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isSymbolicLink())
			throw new Error(
				`Trusted skill source contains a symlink: ${relativePath}`,
			);
		if (entry.isDirectory())
			files.push(...walkFiles(join(directory, entry.name), relativePath));
		else if (entry.isFile()) files.push(relativePath);
		else
			throw new Error(
				`Trusted skill source contains an unsupported entry: ${relativePath}`,
			);
	}
	return files;
}

function tarHeader(name, size) {
	if (Buffer.byteLength(name) > 100)
		throw new Error(`Trusted skill archive path is too long: ${name}`);
	const header = Buffer.alloc(512);
	header.write(name, 0, 100, "utf8");
	writeOctal(header, 100, 8, 0o644);
	writeOctal(header, 108, 8, 0);
	writeOctal(header, 116, 8, 0);
	writeOctal(header, 124, 12, size);
	writeOctal(header, 136, 12, 0);
	header.fill(0x20, 148, 156);
	header[156] = "0".charCodeAt(0);
	header.write("ustar\0", 257, 6, "ascii");
	header.write("00", 263, 2, "ascii");
	header.write("cyrus", 265, 5, "ascii");
	header.write("cyrus", 297, 5, "ascii");
	writeOctal(
		header,
		148,
		8,
		header.reduce((sum, byte) => sum + byte, 0),
	);
	return header;
}

function writeOctal(buffer, offset, length, value) {
	const text = value.toString(8).padStart(length - 1, "0");
	buffer.write(`${text}\0`, offset, length, "ascii");
}

export const repositoryUrl = "git+https://github.com/cyrusagents/cyrus.git";

// Keep this dependency ordered. validateRelease() rejects internal workspace
// dependencies that appear at or after their consumer.
export const releasePackages = [
	{
		directory: "packages/cloudflare-tunnel-client",
		name: "cyrus-cloudflare-tunnel-client",
	},
	// core precedes mcp-tools: mcp-tools depends on it.
	{ directory: "packages/core", name: "cyrus-core" },
	// Depends only on core, and sits this early because claude-runner (three
	// entries below) emits the agent-session span. Note the contrast with
	// otel-logs further down: that one is consumed only by the router, whereas
	// tracing call sites are spread across the runner, the executors, the
	// router-client and the router — so it has to precede all of them.
	{ directory: "packages/otel-traces", name: "cyrus-otel-traces" },
	{ directory: "packages/mcp-tools", name: "cyrus-mcp-tools" },
	{ directory: "packages/claude-runner", name: "cyrus-claude-runner" },
	{ directory: "packages/config-updater", name: "cyrus-config-updater" },
	{
		directory: "packages/linear-event-transport",
		name: "cyrus-linear-event-transport",
	},
	{
		directory: "packages/github-event-transport",
		name: "cyrus-github-event-transport",
	},
	{
		directory: "packages/gitlab-event-transport",
		name: "cyrus-gitlab-event-transport",
	},
	{
		directory: "packages/slack-event-transport",
		name: "cyrus-slack-event-transport",
	},
	{
		directory: "packages/zulip-event-transport",
		name: "cyrus-zulip-event-transport",
	},
	{
		directory: "packages/simple-agent-runner",
		name: "cyrus-simple-agent-runner",
	},
	{ directory: "packages/opencode-runner", name: "cyrus-opencode-runner" },
	{ directory: "packages/codex-runner", name: "cyrus-codex-runner" },
	{ directory: "packages/cursor-runner", name: "cyrus-cursor-runner" },
	{ directory: "packages/gemini-runner", name: "cyrus-gemini-runner" },
	// Depends only on core, and is consumed by router (which wires the Azure
	// Monitor exporter into it), so it must precede the router block below.
	{ directory: "packages/otel-logs", name: "cyrus-otel-logs" },
	// Router mode. Ordered among themselves as well as ahead of their
	// consumers: edge-worker depends on router-client and workspace-sync, and
	// apps/cli on router and workspace-sync.
	{ directory: "packages/router-protocol", name: "cyrus-router-protocol" },
	// The operator wire contract is depended on by BOTH router and apps/cli, so
	// it precedes both. It depends on nothing in the workspace.
	{
		directory: "packages/operator-protocol",
		name: "cyrus-operator-protocol",
	},
	{ directory: "packages/router-executors", name: "cyrus-router-executors" },
	{ directory: "packages/workspace-sync", name: "cyrus-workspace-sync" },
	{ directory: "packages/router-client", name: "cyrus-router-client" },
	{ directory: "packages/router", name: "cyrus-router" },
	{ directory: "packages/edge-worker", name: "cyrus-edge-worker" },
	{ directory: "apps/cli", name: "cyrus-ai" },
];

const exactSemver =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function readManifest(directory) {
	return JSON.parse(
		readFileSync(join(repositoryRoot, directory, "package.json"), "utf8"),
	);
}

function publishedWorkspaceDirectories() {
	const packageDirectories = readdirSync(join(repositoryRoot, "packages"), {
		withFileTypes: true,
	})
		.filter((entry) => entry.isDirectory())
		.map((entry) => `packages/${entry.name}`)
		.filter((directory) =>
			existsSync(join(repositoryRoot, directory, "package.json")),
		);

	return [...packageDirectories, "apps/cli"].filter((directory) => {
		const manifest = readManifest(directory);
		return manifest.private !== true;
	});
}

function releaseSection(changelog, version) {
	const heading = `## [${version}]`;
	const start = changelog.indexOf(heading);
	if (start === -1) {
		throw new Error(`CHANGELOG.md does not contain ${heading}.`);
	}
	const next = changelog.indexOf("\n## [", start + heading.length);
	return changelog.slice(start, next === -1 ? undefined : next).trim();
}

export function validateRelease(version) {
	if (!exactSemver.test(version)) {
		throw new Error(
			`Version must be an exact semantic version without a leading v; received ${version}.`,
		);
	}

	const configuredDirectories = new Set(
		releasePackages.map(({ directory }) => directory),
	);
	const discoveredDirectories = publishedWorkspaceDirectories();
	const missing = discoveredDirectories.filter(
		(directory) => !configuredDirectories.has(directory),
	);
	const stale = [...configuredDirectories].filter(
		(directory) => !discoveredDirectories.includes(directory),
	);
	if (missing.length > 0 || stale.length > 0) {
		throw new Error(
			`Release package list is out of sync (missing: ${missing.join(", ") || "none"}; stale: ${stale.join(", ") || "none"}).`,
		);
	}

	const packageIndex = new Map(
		releasePackages.map(({ name }, index) => [name, index]),
	);
	for (const [index, releasePackage] of releasePackages.entries()) {
		const manifest = readManifest(releasePackage.directory);
		if (manifest.name !== releasePackage.name) {
			throw new Error(
				`${releasePackage.directory} is configured as ${releasePackage.name}, but its manifest is ${manifest.name}.`,
			);
		}
		if (manifest.version !== version) {
			throw new Error(
				`${manifest.name} is ${manifest.version}; expected every release package to be ${version}.`,
			);
		}
		if (
			manifest.repository?.type !== "git" ||
			manifest.repository?.url !== repositoryUrl ||
			manifest.repository?.directory !== releasePackage.directory
		) {
			throw new Error(
				`${manifest.name} must identify ${repositoryUrl} and directory ${releasePackage.directory} for npm trusted publishing.`,
			);
		}

		const dependencyGroups = [
			manifest.dependencies,
			manifest.optionalDependencies,
			manifest.peerDependencies,
		];
		for (const dependencies of dependencyGroups) {
			for (const [dependency, range] of Object.entries(dependencies ?? {})) {
				if (!String(range).startsWith("workspace:")) continue;
				const dependencyIndex = packageIndex.get(dependency);
				if (dependencyIndex === undefined) {
					throw new Error(
						`${manifest.name} depends on unlisted workspace package ${dependency}.`,
					);
				}
				if (dependencyIndex >= index) {
					throw new Error(
						`${dependency} must be published before ${manifest.name}.`,
					);
				}
			}
		}
	}

	const changelog = readFileSync(join(repositoryRoot, "CHANGELOG.md"), "utf8");
	const section = releaseSection(changelog, version);
	for (const { name } of releasePackages) {
		if (!section.includes(`${name}@${version}`)) {
			throw new Error(
				`CHANGELOG.md release section is missing ${name}@${version}.`,
			);
		}
	}

	const internalChangelog = readFileSync(
		join(repositoryRoot, "CHANGELOG.internal.md"),
		"utf8",
	);
	if (!internalChangelog.includes(`## [${version}]`)) {
		throw new Error(
			`CHANGELOG.internal.md does not contain a ${version} release section.`,
		);
	}

	const releaseDriveSuffix = `-release-v${version}.md`;
	const hasReleaseDrive = readdirSync(
		join(repositoryRoot, "apps/f1/test-drives"),
	).some((file) => file.endsWith(releaseDriveSuffix));
	if (!hasReleaseDrive) {
		throw new Error(
			`apps/f1/test-drives is missing an F1 release test drive ending in ${releaseDriveSuffix}.`,
		);
	}

	return { section };
}

function run() {
	const [command, version] = process.argv.slice(2);
	if (command === "list") {
		for (const { directory, name } of releasePackages) {
			console.log(`${directory}\t${name}`);
		}
		return;
	}
	if (command === "skill-archive") {
		if (!version || !process.argv[4])
			throw new Error(
				"Usage: node scripts/release-packages.mjs skill-archive <version> <output-directory>",
			);
		const result = createTrustedSkillArchive(version, resolve(process.argv[4]));
		console.log(
			`${result.archivePath}\n${result.checksumPath}\n${result.checksum}`,
		);
		return;
	}
	if (!version) {
		throw new Error(
			"Usage: node scripts/release-packages.mjs <validate|notes> <version>",
		);
	}
	const { section } = validateRelease(version);
	if (command === "validate") {
		console.log(
			`Validated ${releasePackages.length} release packages at ${version}.`,
		);
		return;
	}
	if (command === "notes") {
		console.log(section);
		return;
	}
	throw new Error(`Unknown command: ${command}`);
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	run();
}
