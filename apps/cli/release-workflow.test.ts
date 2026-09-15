import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const workflow = readFileSync(
	resolve(repositoryRoot, ".github/workflows/release-cli.yml"),
	"utf8",
);
const ciWorkflow = readFileSync(
	resolve(repositoryRoot, ".github/workflows/ci.yml"),
	"utf8",
);
const installDependenciesAction = readFileSync(
	resolve(repositoryRoot, ".github/actions/install-dependencies/action.yml"),
	"utf8",
);
const releaseGuide = readFileSync(
	resolve(repositoryRoot, "apps/cli/RELEASING.md"),
	"utf8",
);
const releaseScript = readFileSync(
	resolve(repositoryRoot, "scripts/release-packages.mjs"),
	"utf8",
);

const configuredPackages = [
	...releaseScript.matchAll(
		/\{\s*directory:\s*"([^"]+)",\s*name:\s*"([^"]+)",?\s*\}/g,
	),
].map(([, directory, name]) => ({ directory, name }));

describe("trusted Cyrus release workflow", () => {
	it("is an on-demand, main-only, serialized workflow", () => {
		expect(workflow).toContain("workflow_dispatch:");
		expect(workflow).not.toMatch(/^\s+push:/m);
		expect(workflow).not.toMatch(/^\s+pull_request:/m);
		expect(workflow).toContain('"refs/heads/main"');
		expect(workflow).toContain("group: release-cyrus-cli");
		expect(workflow).toContain("cancel-in-progress: false");
		expect(workflow).not.toContain(
			`RELEASE_ARTIFACTS: \${{ runner.temp }}/cyrus-release`,
		);
		expect(workflow).toContain(
			'echo "RELEASE_ARTIFACTS=$RUNNER_TEMP/cyrus-release" >> "$GITHUB_ENV"',
		);
	});

	it("uses npm OIDC without a long-lived publish token", () => {
		expect(workflow).toContain("id-token: write");
		expect(workflow).toContain("contents: write");
		expect(workflow).toContain("runs-on: ubuntu-latest");
		expect(workflow).toContain("actions/checkout@v7");
		expect(workflow).toContain("actions/setup-node@v7");
		expect(workflow).toContain("actions/upload-artifact@v7");
		expect(workflow).toContain('node-version: "24.18.0"');
		expect(workflow).toContain("npm@11.18.0");
		expect(workflow).toContain("registry.npmjs.org");
		expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|_authToken/);
		expect(workflow.indexOf("pnpm install --frozen-lockfile")).toBeLessThan(
			workflow.indexOf("npm install --global npm@11.18.0"),
		);
	});

	it("uses supported Node releases and Node 24-based CI actions", () => {
		expect(ciWorkflow).toContain("node-version: [22.x, 24.x]");
		expect(ciWorkflow).toContain("actions/checkout@v7");
		expect(ciWorkflow).toContain("actions/setup-node@v7");
		expect(ciWorkflow).toContain("codecov/codecov-action@v7");
		expect(ciWorkflow).toContain("use_oidc: true");
		expect(ciWorkflow).not.toContain("20.x");
		expect(installDependenciesAction).toContain("pnpm/action-setup@v6");
		expect(installDependenciesAction).not.toContain("wyvox/action-setup-pnpm");
	});

	it("gates publishing on audit, tests, types, build, and package inspection", () => {
		expect(workflow).toContain("pnpm audit --audit-level low");
		expect(workflow).toContain("pnpm test:packages:run");
		expect(workflow).toContain("pnpm --filter cyrus-ai test:run");
		expect(workflow).toContain("pnpm typecheck");
		expect(workflow).toContain("pnpm build");
		expect(workflow.indexOf("run: pnpm build")).toBeLessThan(
			workflow.indexOf("run: pnpm typecheck"),
		);
		expect(workflow).toContain('pnpm --dir "$directory" pack');
		expect(workflow).toContain(
			`release_tarballs+=("$RELEASE_ARTIFACTS/\${package_name}-\${REQUESTED_VERSION}.tgz")`,
		);
		expect(workflow).toContain(
			`npm install --global "\${release_tarballs[@]}"`,
		);
		expect(workflow).not.toContain(
			`npm install --global "$RELEASE_ARTIFACTS/cyrus-ai-\${REQUESTED_VERSION}.tgz"`,
		);
		expect(workflow).toContain(
			'ACTUAL_VERSION="$(CYRUS_SENTRY_DISABLED=1 cyrus --version)"',
		);
		expect(workflow).toContain(
			'npm publish "$tarball" --access public --tag "$DIST_TAG"',
		);
	});

	it("publishes every public package in dependency order", () => {
		const publicDirectories = [
			...readdirSync(resolve(repositoryRoot, "packages"), {
				withFileTypes: true,
			})
				.filter((entry) => entry.isDirectory())
				.map((entry) => `packages/${entry.name}`)
				.filter((directory) =>
					existsSync(resolve(repositoryRoot, directory, "package.json")),
				),
			"apps/cli",
		].filter((directory) => {
			const manifest = JSON.parse(
				readFileSync(
					resolve(repositoryRoot, directory, "package.json"),
					"utf8",
				),
			);
			return manifest.private !== true;
		});

		expect(configuredPackages.map(({ directory }) => directory).sort()).toEqual(
			publicDirectories.sort(),
		);

		const indexByName = new Map(
			configuredPackages.map(({ name }, index) => [name, index]),
		);
		for (const [index, { directory }] of configuredPackages.entries()) {
			const manifest = JSON.parse(
				readFileSync(
					resolve(repositoryRoot, directory, "package.json"),
					"utf8",
				),
			);
			for (const [dependency, range] of Object.entries(
				manifest.dependencies ?? {},
			)) {
				if (!String(range).startsWith("workspace:")) continue;
				expect(indexByName.get(dependency)).toBeLessThan(index);
			}
		}
	});

	it("recovers safely from partially published npm releases", () => {
		expect(workflow).toContain("verify_registry_version() {");
		expect(workflow).toContain("tarball_contents_integrity() {");
		expect(workflow).toContain("local deadline=$((SECONDS + 600))");
		expect(workflow).toContain('if [[ "$SECONDS" -ge "$deadline" ]]');
		expect(workflow).toContain("sleep 10");
		expect(workflow).toContain("dist.tarball");
		expect(workflow).toContain('createHash("sha512")');
		expect(workflow).toContain(
			"gunzipSync(readFileSync(process.env.TARBALL_PATH))",
		);
		expect(workflow).toContain("curl --fail --location --silent --show-error");
		expect(workflow).toContain(
			`Skipping immutable \${package_name}@\${REQUESTED_VERSION}; verifying npm tag \${DIST_TAG}.`,
		);
		expect(workflow).toContain(
			`\${package_name}@\${REQUESTED_VERSION} does not contain the artifact packed by this run; refusing a mixed-commit release.`,
		);
		expect(workflow).toContain(
			`Dry run would publish \${package_name}@\${REQUESTED_VERSION} with npm tag \${DIST_TAG}.`,
		);
		expect(workflow).toContain(
			`\${package_name}@\${REQUESTED_VERSION} is not consistently visible with npm tag \${DIST_TAG} after 10 minutes.`,
		);
	});

	it("preflights package existence before any release work or publishing", () => {
		expect(workflow).toContain("missing_packages=()");
		expect(workflow).toContain(
			'npm view "$package_name" version >/dev/null 2>&1',
		);
		expect(workflow).toContain(
			"Every release package must already exist on npm before this workflow runs.",
		);
		expect(workflow).toContain(
			"npm trust github <package> --repo cyrusagents/cyrus --file release-cli.yml --allow-publish --yes",
		);
		expect(workflow.indexOf("missing_packages=()")).toBeLessThan(
			workflow.indexOf("Install locked dependencies"),
		);
		expect(workflow.indexOf("missing_packages=()")).toBeLessThan(
			workflow.indexOf('npm publish "$tarball"'),
		);
	});

	it("finishes a live release with a tag and GitHub release", () => {
		expect(workflow).toMatch(/git tag --annotate "v\$\{REQUESTED_VERSION\}"/);
		expect(workflow).toMatch(/git push origin "v\$\{REQUESTED_VERSION\}"/);
		expect(workflow).toMatch(/gh release create "v\$\{REQUESTED_VERSION\}"/);
	});

	it("documents the npm trust identity and complete release lifecycle", () => {
		expect(releaseGuide).toContain("`cyrusagents`");
		expect(releaseGuide).toContain("`cyrus`");
		expect(releaseGuide).toContain("`release-cli.yml`");
		expect(releaseGuide).toContain("`npm publish`");
		expect(releaseGuide).toContain("gh workflow run release-cli.yml");
		expect(releaseGuide).toContain("F1 release test-drive protocol");
		expect(releaseGuide).toContain("ReleasedMonitoring");
	});
});
