import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const repositoryUrl = "git+https://github.com/cyrusagents/cyrus.git";

// Keep this dependency ordered. validateRelease() rejects internal workspace
// dependencies that appear at or after their consumer.
export const releasePackages = [
	{
		directory: "packages/cloudflare-tunnel-client",
		name: "cyrus-cloudflare-tunnel-client",
	},
	{ directory: "packages/mcp-tools", name: "cyrus-mcp-tools" },
	{ directory: "packages/core", name: "cyrus-core" },
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
