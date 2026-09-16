import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const workflow = readFileSync(
	join(root, ".github/workflows/release-cli.yml"),
	"utf8",
);
const fixture = join(import.meta.dirname, "test/fixtures/release");
const names = execFileSync(
	process.execPath,
	["scripts/release-packages.mjs", "list"],
	{ cwd: root, encoding: "utf8" },
)
	.trim()
	.split("\n")
	.map((line) => line.split("\t")[1]);
const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

type Event = {
	command: string;
	args?: string[];
	name?: string;
	clock?: number;
	ms?: number;
};
type Scenario = {
	existing?: number[];
	delays?: number[];
	wrongContent?: number;
	wrongIntegrity?: number;
	wrongTag?: number;
	missing?: number;
	tagDrift?: number;
	publishError?: boolean;
	rejectedPublish?: boolean;
	preflightError?: boolean;
	finalError?: boolean;
	permanentError?: boolean;
	curlError?: boolean;
	existingGitTag?: boolean;
	dryRun?: boolean;
	nonMain?: boolean;
	tick?: number;
};
function step(name: string) {
	const block = workflow
		.split(/(?=^ {6}- name: )/m)
		.find((part) => part.startsWith(`      - name: ${name}\n`));
	if (!block) throw new Error(`Missing workflow step ${name}`);
	const match = block.match(/^ {8}run: (.*)\n/m);
	if (!match) throw new Error(`No executable run for ${name}`);
	return {
		liveOnly: block.includes("if: " + "$" + "{{ !inputs.dry_run }}"),
		script:
			match[1] === "|"
				? block
						.slice((match.index ?? 0) + match[0].length)
						.replace(/^ {10}/gm, "")
						.trimEnd()
				: match[1],
	};
}

function runScenario(config: Scenario = {}) {
	const directory = mkdtempSync(join(tmpdir(), "cypack-1521-"));
	directories.push(directory);
	mkdirSync(join(directory, "bin"));
	mkdirSync(join(directory, "artifacts"));
	writeFileSync(
		join(directory, "config.json"),
		JSON.stringify({ ...config, names }),
	);
	writeFileSync(join(directory, "clock"), "0");
	writeFileSync(join(directory, "events"), "");
	const command = readFileSync(join(fixture, "command.mjs"), "utf8");
	for (const tool of ["npm", "curl", "git", "gh"]) {
		const path = join(directory, "bin", tool);
		writeFileSync(path, `#!${process.execPath}\n${command}`);
		chmodSync(path, 0o755);
	}
	for (const [index, name] of names.entries()) {
		const contents = Buffer.from(`tar stream for ${name}`);
		const local = gzipSync(contents, { level: 1 });
		// Different gzip bytes must pass if the complete tar stream matches.
		const remote = gzipSync(
			config.wrongContent === index
				? Buffer.from("different tar contents")
				: contents,
			{ level: 9 },
		);
		writeFileSync(join(directory, "artifacts", `${name}-1.2.3.tgz`), local);
		writeFileSync(join(directory, `registry-${name}.tgz`), remote);
	}
	const env = {
		...process.env,
		PATH: `${directory}/bin:${process.env.PATH}`,
		FAKE_RELEASE_ROOT: directory,
		FAKE_CLOCK_TICK: String(config.tick || 10000),
		REQUESTED_VERSION: "1.2.3",
		DIST_TAG: "latest",
		DRY_RUN: String(config.dryRun || false),
		RELEASE_ARTIFACTS: join(directory, "artifacts"),
		RUNNER_TEMP: directory,
		GITHUB_REF: config.nonMain ? "refs/heads/feature" : "refs/heads/main",
		GITHUB_SHA: "fixture-sha",
	};
	// Execute the actual workflow shell in step order, stopping on a failed
	// step exactly as Actions does. Only the unrelated notes validator is stubbed.
	const steps = [step("Require the main branch")];
	const validation = step("Validate the release request");
	steps.push({
		liveOnly: false,
		script: validation.script.slice(
			0,
			validation.script.indexOf("missing_packages=()"),
		),
	});
	steps.push(
		step("Publish ordered artifacts and verify the complete registry graph"),
		step("Tag the release"),
		step("Create the GitHub release"),
	);
	let status: number | null = 0;
	let output = "";
	for (const current of steps) {
		if (current.liveOnly && config.dryRun) continue;
		const shim = `node() {\nif [[ "$1" == scripts/release-packages.mjs && ( "$2" == notes || "$2" == validate ) ]]; then return 0; fi\n"${process.execPath}" --import "${fixture}/clock.mjs" "$@"\n}\n`;
		const result = spawnSync(
			"bash",
			[
				"--noprofile",
				"--norc",
				"-e",
				"-o",
				"pipefail",
				"-c",
				shim + current.script,
			],
			{ cwd: root, env, encoding: "utf8", timeout: 30000 },
		);
		output += result.stdout + result.stderr;
		status = result.status;
		if (status !== 0) break;
	}
	const events: Event[] = readFileSync(join(directory, "events"), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const publishes = events.filter(
		(event) => event.command === "npm" && event.args?.[0] === "publish",
	);
	const tags = events.filter(
		(event) =>
			event.command === "git" &&
			["tag", "push"].includes(event.args?.[0] || ""),
	);
	const releases = events.filter((event) => event.command === "gh");
	return { status, output, events, publishes, tags, releases };
}

describe("release workflow executable registry gate", () => {
	it("uploads all artifacts in dependency order before shared polling, then tags once all are verified", () => {
		const run = runScenario({
			delays: names.map((_, index) => ((index % 3) + 1) * 10000),
		});
		expect(run.status, run.output).toBe(0);
		expect(run.publishes.map((event) => event.name)).toEqual(names);
		expect(run.publishes.every((event) => event.clock === 0)).toBe(true);
		expect(
			run.events
				.filter((event) => event.command === "sleep")
				.map((event) => event.ms),
		).toEqual([10000, 10000, 10000]);
		expect(
			run.events
				.filter((event) => event.command === "curl" && event.clock === 30000)
				.map((event) => event.name)
				.sort(),
		).toEqual([...names].sort());
		expect(run.tags).toHaveLength(2);
		expect(run.releases).toHaveLength(1);
		expect(run.tags.every((event) => event.clock === 30000)).toBe(true);
	});

	it("safely resumes a partial publish with different gzip bytes and rechecks the recovered artifact at the final gate", () => {
		const run = runScenario({
			existing: [0, 9],
			delays: names.map(() => 10000),
		});
		expect(run.status, run.output).toBe(0);
		expect(run.publishes.map((event) => event.name)).toEqual(
			names.filter((_, index) => ![0, 9].includes(index)),
		);
		const firstPublish = run.events.findIndex(
			(event) => event.args?.[0] === "publish",
		);
		expect(
			run.events
				.slice(0, firstPublish)
				.filter((event) => event.command === "curl")
				.map((event) => event.name)
				.sort(),
		).toEqual([names[0], names[9]].sort());
		expect(
			run.events.filter(
				(event) => event.command === "curl" && event.name === names[0],
			).length,
		).toBeGreaterThan(1);
	});

	it.each([
		["wrong fresh contents", { wrongContent: 3 }, "mixed-commit"],
		["wrong registry integrity", { wrongIntegrity: 3 }, "dist.integrity"],
		["wrong fresh tag", { wrongTag: 3, tick: 300000 }, "failed after 600s"],
		["missing package", { missing: 3, tick: 300000 }, "failed after 600s"],
		[
			"recovered tag changes after upload",
			{ existing: [0], tagDrift: 0, tick: 300000 },
			"failed after 600s",
		],
	] as const)("blocks both tagging and GitHub release for %s", (_label, config, error) => {
		const run = runScenario(config);
		expect(run.status, run.output).not.toBe(0);
		expect(run.output).toContain(error);
		expect(run.publishes).toHaveLength(
			names.length - ("existing" in config ? config.existing.length : 0),
		);
		expect(run.tags).toEqual([]);
		expect(run.releases).toEqual([]);
	});

	it.each([
		{ existing: [0], wrongContent: 0 },
		{ existing: [0], wrongTag: 0 },
		{ existingGitTag: true },
		{ nonMain: true },
	])("rejects existing mismatches or non-main before any upload: %j", (config) => {
		const run = runScenario(config);
		expect(run.status, run.output).not.toBe(0);
		expect(run.publishes).toEqual([]);
		expect(run.tags).toEqual([]);
		expect(run.releases).toEqual([]);
	});

	it("retries transient metadata/download errors without treating them as missing versions", () => {
		const run = runScenario({
			existing: [0],
			preflightError: true,
			finalError: true,
			curlError: true,
		});
		expect(run.status, run.output).toBe(0);
		expect(run.publishes.map((event) => event.name)).toEqual(names.slice(1));
		expect(run.tags).toHaveLength(2);
	});

	it("fails closed on a registry outage without publishing", () => {
		const run = runScenario({ permanentError: true, tick: 300000 });
		expect(run.status, run.output).not.toBe(0);
		expect(run.publishes).toEqual([]);
		expect(run.tags).toEqual([]);
	});

	it("verifies ambiguous failed writes instead of retrying immutable publication", () => {
		const run = runScenario({
			publishError: true,
			delays: names.map(() => 10000),
		});
		expect(run.status, run.output).toBe(0);
		expect(run.publishes.map((event) => event.name)).toEqual(names);
		expect(run.tags).toHaveLength(2);
	});

	it("blocks tagging when failed uploads never reach the registry", () => {
		const run = runScenario({ rejectedPublish: true, tick: 300000 });
		expect(run.status, run.output).not.toBe(0);
		expect(run.output).toContain("Final registry gate failed after 600s");
		expect(run.publishes.map((event) => event.name)).toEqual(names);
		expect(run.tags).toEqual([]);
		expect(run.releases).toEqual([]);
	});

	it("dry run validates recovered artifacts and publishes/tags/releases nothing", () => {
		const run = runScenario({ dryRun: true, existing: [0] });
		expect(run.status, run.output).toBe(0);
		expect(run.output.match(/Dry run would publish/g)).toHaveLength(
			names.length - 1,
		);
		expect(run.events.some((event) => event.command === "curl")).toBe(true);
		expect(run.publishes).toEqual([]);
		expect(run.tags).toEqual([]);
		expect(run.releases).toEqual([]);
	});
});
