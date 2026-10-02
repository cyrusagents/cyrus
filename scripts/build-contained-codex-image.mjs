// Local-only image assembly. Caller first obtains the exact upstream platform
// archive and reviews its SHA256. No pull, network installation, volume or secret.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [docker, socket, base, archive, expected, arch] = process.argv.slice(2);
if (
	!docker?.startsWith("/") ||
	!socket?.startsWith("unix:///") ||
	!/^sha256:[a-f0-9]{64}$/.test(base ?? "") ||
	!/^[a-f0-9]{64}$/.test(expected ?? "") ||
	!["arm64", "amd64"].includes(arch)
)
	throw Error(
		"Usage: absolute-docker unix-socket immutable-base-id archive expected-sha256 arm64|amd64",
	);
if (
	createHash("sha256").update(readFileSync(archive)).digest("hex") !== expected
)
	throw Error("Archive checksum mismatch");
const metadata = JSON.parse(
	execFileSync("tar", ["-xOf", archive, "package/package.json"], {
		encoding: "utf8",
	}),
);
const expectedVersion = `0.153.3-linux-${arch === "arm64" ? "arm64" : "x64"}`;
if (metadata.name !== "@openai/codex" || metadata.version !== expectedVersion)
	throw Error("Unexpected Codex archive package/version");
const run = (args, options = {}) =>
	execFileSync(docker, ["--host", socket, ...args], {
		encoding: "utf8",
		...options,
	});
const [image] = JSON.parse(run(["image", "inspect", base]));
if (
	image.Architecture !== arch ||
	Object.keys(image.Config.Volumes ?? {}).length
)
	throw Error("Base architecture/volumes rejected");
const work = mkdtempSync(join(tmpdir(), "cyrus-codex-image-"));
try {
	const platform = arch === "arm64" ? "aarch64" : "x86_64";
	const binary = execFileSync(
		"tar",
		[
			"-xOf",
			archive,
			`package/vendor/${platform}-unknown-linux-musl/bin/codex`,
		],
		{ maxBuffer: 300_000_000 },
	);
	writeFileSync(join(work, "codex"), binary, { mode: 0o755 });
	// Create/copy/commit uses the already inspected local image ID. Unlike FROM
	// resolution it cannot consult a registry or replace an existing tag.
	const container = run([
		"create",
		"--pull=never",
		"--network=none",
		"--entrypoint=/bin/true",
		base,
	]).trim();
	let id;
	try {
		run(["cp", join(work, "codex"), `${container}:/usr/local/bin/codex`]);
		id = run([
			"commit",
			"--change",
			`LABEL cyrus.contained-codex.version=0.153.3 cyrus.contained-codex.archive-sha256=${expected}`,
			container,
		]).trim();
	} finally {
		run(["rm", "--force", container]);
	}

	console.log(
		JSON.stringify({
			image: id,
			base,
			archiveSha256: expected,
			architecture: arch,
			codexVersion: "0.153.3",
			publication: false,
		}),
	);
} finally {
	rmSync(work, { recursive: true, force: true });
}
