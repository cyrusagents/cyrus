import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
// Filesystem boundary independent of Hosted admission; active engineering
// adds its stricter reviewed-path and artifact checks before publication.
export const filesSchema = z
	.record(
		z
			.string()
			.min(1)
			.max(300)
			.refine(
				(path) =>
					!path.startsWith("/") &&
					!path.includes("\\") &&
					!path.includes("\0") &&
					path
						.split("/")
						.every((part) => part !== ".." && part !== "." && part !== ""),
				"Unsafe repository path",
			),
		z.string().max(1_000_000),
	)
	.refine(
		(files) =>
			Object.keys(files).length <= 1000 &&
			JSON.stringify(files).length <= 8_000_000,
		"Snapshot exceeds limit",
	);

const commandResultSchema = z
	.object({
		exitCode: z.number().int().min(0).max(255),
		stdout: z.string(),
		stderr: z.string(),
	})
	.strict();
export type EngineeringCommandResult = z.infer<typeof commandResultSchema>;

/** Trusted, operator-selected immutable image; never supplied by a run/model. */
export interface DockerSandboxConfig {
	dockerPath: string;
	dockerHost: string;
	image: string;
}

export interface EngineeringSandbox {
	start(files: Record<string, string>, signal: AbortSignal): Promise<void>;
	execute(
		command: string,
		signal: AbortSignal,
	): Promise<EngineeringCommandResult>;
	snapshot(signal: AbortSignal): Promise<Record<string, string>>;
	stop(): Promise<void>;
}

/**
 * Disposable engineering computer. No host mounts, credentials, network, plugins,
 * git credentials or host repository checkout ever enter this container.
 * The trusted image must provide /usr/bin/env, /bin/sh and /usr/local/bin/node
 * (the reviewed native Codex image used by registered engineering).
 */
export class DockerSandbox implements EngineeringSandbox {
	private readonly name = `cyrus-scoped-${randomUUID()}`;
	private created = false;

	private readonly binary = "/usr/local/bin/node";

	constructor(private readonly config: DockerSandboxConfig) {
		if (!/^sha256:[a-f0-9]{64}$/.test(config.image)) {
			throw new Error("Scoped engineering requires a local immutable image ID");
		}
		if (
			!config.dockerPath.startsWith("/") ||
			!config.dockerHost.startsWith("unix:///")
		) {
			throw new Error(
				"Scoped engineering requires an absolute Docker binary and local Unix socket",
			);
		}
	}

	private command(
		args: string[],
		signal?: AbortSignal,
		input?: string,
	): Promise<string> {
		return new Promise((resolve, reject) => {
			const child = spawn(
				this.config.dockerPath,
				["--host", this.config.dockerHost, ...args],
				{
					env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
					stdio: ["pipe", "pipe", "pipe"],
					signal,
				},
			);
			const stdout: Buffer[] = [],
				stderr: Buffer[] = [];
			let size = 0;
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, 30_000);
			const consume = (target: Buffer[], chunk: Buffer) => {
				size += chunk.length;
				if (size > 1_048_576) child.kill("SIGKILL");
				else target.push(chunk);
			};
			child.stdout.on("data", (chunk: Buffer) => consume(stdout, chunk));
			child.stderr.on("data", (chunk: Buffer) => consume(stderr, chunk));
			child.on("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				if (code === 0 && size <= 1_048_576 && !timedOut && !signal?.aborted)
					resolve(
						Buffer.concat(stdout).toString("utf8") +
							Buffer.concat(stderr).toString("utf8"),
					);
				else
					reject(
						new Error(
							"Isolated engineering command failed or exceeded its limit",
						),
					);
			});
			child.stdin.on("error", () => {});
			child.stdin.end(input);
		});
	}

	async start(
		files: Record<string, string>,
		signal: AbortSignal,
	): Promise<void> {
		const info = JSON.parse(
			await this.command(["image", "inspect", this.config.image], signal),
		);
		if (Object.keys(info[0]?.Config?.Volumes ?? {}).length) {
			throw new Error("Scoped engineering images cannot declare volumes");
		}
		// Mark before launch so interruption/timeout still removes a created container.
		this.created = true;
		try {
			await this.command(
				[
					"run",
					"--detach",
					"--rm",
					"--pull=never",
					"--name",
					this.name,
					"--network=none",
					"--read-only",
					"--no-healthcheck",
					"--cap-drop=ALL",
					"--security-opt=no-new-privileges",
					"--pids-limit=64",
					"--memory=512m",
					"--cpus=1",
					"--user=1000:1000",
					"--workdir=/work",
					"--tmpfs=/work:rw,nosuid,nodev,size=128m,uid=1000,gid=1000,mode=0700",
					"--tmpfs=/tmp:rw,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700",
					"--entrypoint=/usr/bin/env",
					this.config.image,
					"-i",
					"PATH=/usr/local/bin:/usr/bin:/bin",
					"HOME=/work/home",
					this.binary,
					"-e",
					"setInterval(()=>{}, 1000000)",
				],
				signal,
			);
			await this.command(
				[
					"exec",
					"-i",
					this.name,
					"/usr/bin/env",
					"-i",
					"PATH=/usr/local/bin:/usr/bin:/bin",
					"HOME=/work/home",
					this.binary,
					"-e",
					`const fs = require('node:fs'); const path = require('node:path');
(async () => {
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
const files = JSON.parse(Buffer.concat(chunks).toString('utf8'));
for (const [name, content] of Object.entries(files)) {
 if (!name || name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..') || name.includes('\\\\') || name.includes('\\0')) throw Error('Invalid path');
 const target = path.join('/work', name); fs.mkdirSync(path.dirname(target), {recursive:true}); fs.writeFileSync(target, content, {flag:'wx'});
}
})().catch(() => {process.stderr.write('Invalid engineering handoff');process.exitCode=1;});`,
				],
				signal,
				JSON.stringify(files),
			);
		} catch (error) {
			await this.stop();
			throw error;
		}
	}

	async execute(
		command: string,
		signal: AbortSignal,
	): Promise<EngineeringCommandResult> {
		if (!this.created) throw new Error("Engineering sandbox is not running");
		try {
			const output = await this.command(
				[
					"exec",
					this.name,
					"/usr/bin/env",
					"-i",
					"PATH=/usr/local/bin:/usr/bin:/bin",
					"HOME=/work/home",
					this.binary,
					"-e",
					// Docker/transport failures still reject. Only a completed shell
					// command produces this envelope, including ordinary test failures.
					`const {spawnSync} = require('node:child_process');
const result = spawnSync('/bin/sh', ['-c', process.argv[1]], {
 encoding: 'utf8', maxBuffer: 256000, timeout: 29000,
});
if (result.error || result.signal || result.status === null) throw Error('Isolated command interrupted or exceeded its limit');
console.log(JSON.stringify({exitCode: result.status, stdout: result.stdout, stderr: result.stderr}));`,
					"--",
					command,
				],
				signal,
			);
			return commandResultSchema.parse(JSON.parse(output));
		} catch (error) {
			// Killing only the docker client would leave an exec process alive.
			await this.stop();
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (this.created) {
			await this.command(["rm", "--force", this.name]);
			this.created = false;
		}
	}

	async snapshot(signal: AbortSignal): Promise<Record<string, string>> {
		const result = await this.command(
			[
				"exec",
				this.name,
				"/usr/bin/env",
				"-i",
				"PATH=/usr/local/bin:/usr/bin:/bin",
				"HOME=/work/home",
				this.binary,
				"-e",
				`
const fs = require("node:fs"), path = require("node:path");
const files = Object.create(null); let bytes = 0;
function visit(dir) {
 for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
  const name = path.join(dir, entry.name);
  if (entry.isSymbolicLink()) throw Error("Symlinks cannot be published");
  if (entry.isDirectory()) visit(name);
  else if (entry.isFile()) {
   const stat = fs.statSync(name);
   bytes += stat.size;
   if(bytes > 800000 || Object.keys(files).length >= 1000) throw Error("Artifact limit");
   const data = fs.readFileSync(name);
   const text = new TextDecoder("utf-8", {fatal:true}).decode(data);
   files[path.relative("/work", name)] = text;
  } else throw Error("Non-regular artifact");
 }
}
visit("/work"); console.log(JSON.stringify(files));`,
			],
			signal,
		);
		return filesSchema.parse(JSON.parse(result));
	}
}
