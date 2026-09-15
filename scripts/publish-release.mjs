import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { releasePackages } from "./release-packages.mjs";

const exec = promisify(execFile);
const registry = "https://registry.npmjs.org";
const version = process.env.REQUESTED_VERSION;
const tag = process.env.DIST_TAG;
const dryRun = process.env.DRY_RUN;
const artifactsPath = process.env.RELEASE_ARTIFACTS;
// One deadline for the entire graph, including registry subprocess time.
const verificationTimeout = 600_000;
const pollInterval = 10_000;

class Mismatch extends Error {}

function digest(bytes) {
	return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function contentsIntegrity(bytes) {
	// Preserve #1483: compare the complete tar stream, including metadata and
	// ordering, while allowing gzip implementations/headers to differ.
	return digest(gunzipSync(bytes));
}

async function command(program, args, deadline, encoding = "utf8") {
	const remaining = deadline - performance.now();
	if (remaining <= 0)
		throw new Error("Registry verification deadline expired.");
	return exec(program, args, {
		encoding,
		timeout: Math.max(1, Math.min(30_000, remaining)),
		killSignal: "SIGKILL",
		maxBuffer: 64 * 1024 * 1024,
	});
}

async function metadata(artifact, deadline) {
	let stdout;
	try {
		({ stdout } = await command(
			"npm",
			[
				"view",
				artifact.spec,
				"--json",
				"--prefer-online",
				`--registry=${registry}`,
				"--fetch-retries=0",
				"--fetch-timeout=10000",
			],
			deadline,
		));
	} catch (error) {
		// Only an explicit npm E404 permits an upload. Timeouts, auth errors,
		// invalid JSON and registry outages must never masquerade as absence.
		if (error.code === 1 && !error.killed) {
			try {
				if (JSON.parse(error.stdout).error?.code === "E404") return null;
			} catch {}
		}
		throw new Error(`Cannot read ${artifact.spec}: ${error.message}`);
	}
	const result = JSON.parse(stdout);
	if (result.name !== artifact.name || result.version !== version) {
		throw new Mismatch(`Unexpected registry identity for ${artifact.spec}.`);
	}
	return result;
}

async function verifyArtifact(artifact, deadline, recovery = false) {
	const info = await metadata(artifact, deadline);
	if (!info) return "version missing";
	if (info["dist-tags"]?.[tag] !== version) {
		if (recovery) {
			throw new Mismatch(
				`${artifact.spec} already exists without npm tag ${tag}.`,
			);
		}
		return `npm tag ${tag} does not point to ${version}`;
	}
	if (!info.dist?.tarball || !info.dist?.integrity) {
		return "registry tarball/integrity missing";
	}
	const url = new URL(info.dist.tarball);
	if (url.origin !== registry) {
		throw new Mismatch(`Unexpected registry tarball URL for ${artifact.spec}.`);
	}
	const { stdout: bytes } = await command(
		"curl",
		[
			"--fail",
			"--location",
			"--silent",
			"--show-error",
			"--max-time",
			"20",
			url.href,
		],
		deadline,
		"buffer",
	);
	if (digest(bytes) !== info.dist.integrity) {
		throw new Mismatch(
			`${artifact.spec} tarball does not match registry dist.integrity.`,
		);
	}
	if (contentsIntegrity(bytes) !== artifact.integrity) {
		throw new Mismatch(
			`${artifact.spec} does not contain the inspected artifact; refusing a mixed-commit release.`,
		);
	}
	return null;
}

async function pollAll(artifacts, label, inspect) {
	if (artifacts.length === 0) return;
	const start = performance.now();
	const deadline = start + verificationTimeout;
	let attempt = 0;
	while (true) {
		attempt++;
		const results = await Promise.allSettled(
			artifacts.map((artifact) => inspect(artifact, deadline)),
		);
		const pending = [];
		for (const [index, result] of results.entries()) {
			if (result.status === "rejected" && result.reason instanceof Mismatch) {
				throw result.reason;
			}
			const reason =
				result.status === "rejected" ? result.reason.message : result.value;
			if (reason) pending.push(`${artifacts[index].spec}: ${reason}`);
		}
		// Recheck every package on every pass, including previously successful
		// and recovered packages, so a changed tag cannot bypass the final gate.
		if (pending.length === 0 && performance.now() < deadline) {
			console.log(
				`${label} verified ${artifacts.length} artifacts in ${((performance.now() - start) / 1000).toFixed(1)}s (${attempt} passes).`,
			);
			return;
		}
		if (performance.now() >= deadline) {
			throw new Error(
				`${label} failed after 600s; refusing to tag/release. ${pending.join("; ")}`,
			);
		}
		console.log(`${label}, pass ${attempt}: waiting for ${pending.join("; ")}`);
		await new Promise((resolve) =>
			setTimeout(resolve, Math.min(pollInterval, deadline - performance.now())),
		);
	}
}

async function run() {
	if (
		!version ||
		!tag ||
		!artifactsPath ||
		!["true", "false"].includes(dryRun)
	) {
		throw new Error(
			"REQUESTED_VERSION, DIST_TAG, RELEASE_ARTIFACTS and explicit DRY_RUN are required.",
		);
	}
	if (process.env.GITHUB_REF !== "refs/heads/main") {
		throw new Error("Cyrus releases must run from main.");
	}
	const artifacts = releasePackages.map(({ name }) => {
		const path = join(artifactsPath, `${name}-${version}.tgz`);
		return {
			name,
			path,
			spec: `${name}@${version}`,
			integrity: contentsIntegrity(readFileSync(path)),
		};
	});
	const existing = new Set();
	await pollAll(artifacts, "Registry preflight", async (artifact, deadline) => {
		if (await metadata(artifact, deadline)) existing.add(artifact);
		return null;
	});
	// Validate recovered versions before adding to a partial release. Never
	// republish a known existing version, even if a later read returns E404.
	await pollAll([...existing], "Recovery", (artifact, deadline) =>
		verifyArtifact(artifact, deadline, true),
	);

	const start = performance.now();
	for (const artifact of artifacts) {
		if (existing.has(artifact)) {
			console.log(
				`Skipping immutable ${artifact.spec}; verified npm tag ${tag} and contents.`,
			);
			continue;
		}
		if (dryRun === "true") {
			console.log(
				`Dry run would publish ${artifact.spec} with npm tag ${tag}.`,
			);
			continue;
		}
		console.log(`Publishing ${artifact.spec}.`);
		try {
			const result = await exec(
				"npm",
				[
					"publish",
					artifact.path,
					"--access",
					"public",
					"--tag",
					tag,
					`--registry=${registry}`,
				],
				{
					timeout: 120_000,
					killSignal: "SIGKILL",
					maxBuffer: 4 * 1024 * 1024,
				},
			);
			process.stdout.write(result.stdout);
			process.stderr.write(result.stderr);
		} catch (error) {
			// The server may have accepted an upload before the connection failed,
			// or an immutable version may have been hidden by registry propagation.
			// Never retry the write; require the same full verification below.
			console.error(
				`Publish returned an error for ${artifact.spec}; deferring to final verification without retry: ${error.message}`,
			);
		}
	}
	console.log(
		`Ordered uploads completed in ${((performance.now() - start) / 1000).toFixed(1)}s.`,
	);
	if (dryRun === "true") return;
	await pollAll(artifacts, "Final registry gate", verifyArtifact);
}

run().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});
