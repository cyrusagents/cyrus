import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AppServerClient } from "./appServerClient.js";

export interface ContainedCodexConfig {
	dockerPath: string;
	dockerHost: string;
	/** Preloaded, reviewed image containing node and /usr/local/bin/codex. */
	image: string;
}
export interface ContainedModelRequest {
	body: string;
}
export interface ContainedModelResponse {
	status: number;
	contentType: string;
	body: string;
}

// Runs inside the isolated container. The only bridge is framed stdio; its HTTP
// server is in the container's network-none namespace, never a host listener.
const relay = String.raw`
const http = require('node:http'), cp = require('node:child_process'), readline = require('node:readline'), fs = require('node:fs');
fs.mkdirSync('/work/home/.codex', {recursive:true,mode:448});
const pending = new Map(); let sequence=0, child;
function emit(value) { process.stdout.write(JSON.stringify(value)+'\n'); }
const server = http.createServer(async (req,res) => {
 if(req.method!=='POST'||req.url!=='/responses'||pending.size>=2){res.writeHead(403);res.end();return;}
 const chunks=[];let size=0;
 try { for await(const part of req){size+=part.length;if(size>2000000)throw Error();chunks.push(part);} }
 catch {res.writeHead(413);res.end();return;}
 const id='cyrus-model-'+(++sequence);
 const timer=setTimeout(()=>{pending.delete(id);res.writeHead(504);res.end();},60000);
 pending.set(id,{res,timer});
 emit({id,method:'cyrus/model',params:{body:Buffer.concat(chunks).toString('utf8')}});
});
server.listen(0,'127.0.0.1',()=>{
 const base='http://127.0.0.1:'+server.address().port;
 const config={model_provider:'cyrus_contained',model_providers:{cyrus_contained:{name:'Cyrus scoped model broker',base_url:base,wire_api:'responses',requires_openai_auth:false,supports_websockets:false,request_max_retries:0,stream_max_retries:0}},web_search:'disabled',mcp_servers:{},analytics:{enabled:false},features:{shell_tool:false,unified_exec:false,multi_agent:false,goals:false,apps:false,plugins:false,hooks:false,remote_plugin:false,skill_search:false,skill_mcp_dependency_install:false,memories:false,external_agent_memory_import:false,browser_use:false,browser_use_external:false,computer_use:false,image_generation:false,code_mode_host:false,workspace_dependencies:false,sleep_tool:false},cli_auth_credentials_store:'ephemeral'};
 const args=['app-server','--listen','stdio://'];
 // TOML overrides for fixed supervisor settings only. Never merge user config.
 for(const [k,v] of Object.entries(config)) {
  if(k==='model_providers') {
   for(const [field,value] of Object.entries(v.cyrus_contained))args.push('-c','model_providers.cyrus_contained.'+field+'='+JSON.stringify(value));
  } else if(typeof v==='object') {
   for(const [field,value] of Object.entries(v))args.push('-c',k+'.'+field+'='+JSON.stringify(value));
  } else args.push('-c',k+'='+JSON.stringify(v));
 }
 child=cp.spawn('/usr/local/bin/codex',args,{cwd:'/work',env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/work/home',CODEX_HOME:'/work/home/.codex'},stdio:['pipe','pipe','pipe']});
 child.stdout.pipe(process.stdout); child.stderr.resume();
 child.on('error',()=>process.exit(70));child.on('exit',()=>process.exit(0));
 const input=readline.createInterface({input:process.stdin});let bytes=0;
 input.on('line',line=>{
  bytes+=Buffer.byteLength(line);if(line.length>8000000||bytes>64000000)process.exit(71);
  let message;try{message=JSON.parse(line);}catch{process.exit(72);}
  if(typeof message.id==='string'&&message.id.startsWith('cyrus-model-')) {
   const p=pending.get(message.id);if(!p)return;pending.delete(message.id);clearTimeout(p.timer);
   const r=message.result;
   if(!r||typeof r.body!=='string'||r.body.length>8000000||!Number.isInteger(r.status)){p.res.writeHead(502);p.res.end();return;}
   p.res.writeHead(r.status,{'content-type':r.contentType==='text/event-stream'?'text/event-stream':'application/json'});p.res.end(Buffer.from(r.body,'base64'));
  } else child.stdin.write(line+'\n');
 });
 input.on('close',()=>process.exit(0));
});
`;

/** Dedicated process, empty home, no mounts/network/credentials; never uses the
 * ordinary shared app-server pool. Container data is untrusted at the bridge. */
export class ContainedCodexProcess {
	private readonly name = `cyrus-codex-${randomUUID()}`;
	private client?: AppServerClient;
	private stopped = false;
	private started = false;
	private initialized = false;
	private closing?: Promise<void>;
	private readonly requests = new Set<Promise<unknown>>();
	constructor(private readonly config: ContainedCodexConfig) {
		if (
			!/^sha256:[a-f0-9]{64}$/.test(config.image) ||
			!config.dockerPath.startsWith("/") ||
			!config.dockerHost.startsWith("unix:///")
		)
			throw new Error(
				"Contained Codex requires a local immutable image and Docker socket",
			);
	}
	private command(args: string[], signal?: AbortSignal): Promise<string> {
		return new Promise((resolve, reject) => {
			const child = spawn(
				this.config.dockerPath,
				["--host", this.config.dockerHost, ...args],
				{
					env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
					stdio: ["ignore", "pipe", "pipe"],
					signal,
				},
			);
			let output = "",
				size = 0;
			const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
			child.stdout.on("data", (part: Buffer) => {
				size += part.length;
				if (size > 1000000) child.kill("SIGKILL");
				else output += part.toString();
			});
			child.stderr.resume();
			child.on("error", () => {
				clearTimeout(timer);
				reject(new Error("Contained Codex Docker operation failed"));
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				if (code === 0 && size <= 1000000) resolve(output);
				else reject(new Error("Contained Codex Docker operation failed"));
			});
		});
	}
	async start(options: {
		signal: AbortSignal;
		model: (
			request: ContainedModelRequest,
			signal: AbortSignal,
		) => Promise<ContainedModelResponse>;
		notification: (method: string, params: unknown) => void;
		request: (method: string, params: unknown) => Promise<unknown>;
		exit?: () => void;
	}): Promise<void> {
		if (this.started || this.stopped)
			throw new Error("Contained Codex process cannot be reused");
		this.started = true;
		const info = JSON.parse(
			await this.command(
				["image", "inspect", this.config.image],
				options.signal,
			),
		);
		if (info.length !== 1 || Object.keys(info[0]?.Config?.Volumes ?? {}).length)
			throw new Error("Contained image may not declare volumes");
		if (this.stopped) throw new Error("Contained process is closing");
		const args = [
			"--host",
			this.config.dockerHost,
			"run",
			"--rm",
			"--pull=never",
			"--interactive",
			"--name",
			this.name,
			"--network=none",
			"--read-only",
			"--no-healthcheck",
			"--cap-drop=ALL",
			"--security-opt=no-new-privileges",
			"--pids-limit=128",
			"--memory=768m",
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
			"/usr/local/bin/node",
			"-e",
			relay,
		];
		const client = new AppServerClient({
			binaryPath: this.config.dockerPath,
			args,
			env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
			logger: { warn() {}, error() {} },
			requestTimeoutMs: 20000,
			maxOutputBytes: 32_000_000,
		});
		this.client = client;
		let modelRequests = 0;
		client.setNotificationHandler(options.notification);
		client.setServerRequestHandler((method, params) => {
			if (this.stopped) throw new Error("Contained process is closing");
			const work = (async () => {
				options.signal.throwIfAborted();
				if (method !== "cyrus/model") return options.request(method, params);
				if (
					++modelRequests > 24 ||
					!params ||
					typeof params !== "object" ||
					Object.keys(params).join() !== "body" ||
					typeof (params as ContainedModelRequest).body !== "string" ||
					Buffer.byteLength((params as ContainedModelRequest).body) > 2000000
				)
					throw new Error("Contained model request rejected");
				return options.model(params as ContainedModelRequest, options.signal);
			})();
			this.requests.add(work);
			const settled = () => this.requests.delete(work);
			void work.then(settled, settled);
			return work;
		});
		client.on("error", () => {
			void this.close().catch(() => {});
		});
		const abort = () => {
			void this.close().catch(() => {});
		};
		options.signal.addEventListener("abort", abort, { once: true });
		client.on("exit", () => {
			options.signal.removeEventListener("abort", abort);
			options.exit?.();
		});
		try {
			options.signal.throwIfAborted();
			client.start();
			const initialized = await client.request<{
				codexHome: string;
				userAgent: string;
			}>("initialize", {
				clientInfo: { name: "cyrus-contained-codex", version: "1" },
				capabilities: { experimentalApi: true },
			});
			if (
				initialized.codexHome !== "/work/home/.codex" ||
				!initialized.userAgent.includes("/0.153.3 ")
			)
				throw new Error("Unsupported contained Codex protocol");
			this.initialized = true;
		} catch {
			await this.close();
			throw new Error("Contained Codex initialization failed");
		}
	}
	request<T = unknown>(method: string, params: unknown): Promise<T> {
		if (this.stopped || !this.client)
			throw new Error("Contained Codex is unavailable");
		return this.client.request<T>(method, params);
	}
	/** Native rollout only; no auth/config/database files or host filesystem access. */
	async snapshot(
		threadId: string,
	): Promise<{ threadId: string; rollout: string }> {
		if (!/^[a-f0-9-]{36}$/.test(threadId))
			throw new Error("Invalid native session ID");
		const { thread } = await this.request<{
			thread: { id: string; path: string };
		}>("thread/read", { threadId, includeTurns: false });
		if (
			thread.id !== threadId ||
			typeof thread.path !== "string" ||
			!thread.path.startsWith("/work/home/.codex/sessions/")
		)
			throw new Error("Foreign native checkpoint");
		const result = await this.request<{ exitCode: number; stdout: string }>(
			"command/exec",
			{
				command: [
					"/usr/local/bin/node",
					"-e",
					`const fs=require('node:fs');const p=process.argv[1];if(!fs.realpathSync(p).startsWith('/work/home/.codex/sessions/'))process.exit(1);const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const s=fs.fstatSync(fd);if(!s.isFile()||s.size>2000000)process.exit(2);process.stdout.write(fs.readFileSync(fd).toString('base64'));`,
					thread.path,
				],
				cwd: "/work",
				sandboxPolicy: { type: "dangerFullAccess" },
				timeoutMs: 5000,
				outputBytesCap: 2700000,
			},
		);
		if (result.exitCode !== 0)
			throw new Error("Native checkpoint capture failed");
		const snapshot = { threadId, rollout: result.stdout };
		this.validateSnapshot(snapshot);
		return snapshot;
	}
	private validateSnapshot(snapshot: {
		threadId: string;
		rollout: string;
	}): void {
		if (
			!/^[a-f0-9-]{36}$/.test(snapshot.threadId) ||
			snapshot.rollout.length > 2700000 ||
			!/^[A-Za-z0-9+/]+={0,2}$/.test(snapshot.rollout)
		)
			throw new Error("Invalid native checkpoint");
		const bytes = Buffer.from(snapshot.rollout, "base64");
		if (bytes.length > 2000000 || bytes.toString("base64") !== snapshot.rollout)
			throw new Error("Invalid native checkpoint encoding");
		const first = JSON.parse(bytes.toString("utf8").split("\n")[0]!);
		if (
			first.type !== "session_meta" ||
			first.payload?.id !== snapshot.threadId ||
			first.payload?.cwd !== "/work"
		)
			throw new Error("Native checkpoint identity mismatch");
	}
	async restore(snapshot: {
		threadId: string;
		rollout: string;
	}): Promise<string> {
		this.validateSnapshot(snapshot);
		const path = `/work/home/.codex/sessions/cyrus-${snapshot.threadId}.jsonl`;
		const result = await this.request<{ exitCode: number }>("command/exec", {
			command: [
				"/usr/local/bin/node",
				"-e",
				`const fs=require('node:fs');fs.mkdirSync('/work/home/.codex/sessions',{recursive:true,mode:448});fs.writeFileSync(process.argv[1],Buffer.from(process.argv[2],'base64'),{flag:'wx',mode:384});`,
				path,
				snapshot.rollout,
			],
			cwd: "/work",
			sandboxPolicy: { type: "dangerFullAccess" },
			timeoutMs: 5000,
		});
		if (result.exitCode !== 0)
			throw new Error("Native checkpoint restore failed");
		return path;
	}
	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.stopped = true;
		this.closing = (async () => {
			const clientClosed = await Promise.allSettled([this.client?.close()]);
			const containerClosed = await Promise.allSettled([
				(async () => {
					if (this.started) {
						// --rm may already have removed it. A successful empty listing,
						// not a swallowed removal/daemon failure, proves absence.
						await this.command(["rm", "--force", this.name]).catch(() => {});
						const remaining = await this.command([
							"ps",
							"--all",
							"--quiet",
							"--no-trunc",
							"--filter",
							`name=^/${this.name}$`,
						]);
						if (remaining.trim())
							throw new Error("Contained container cleanup unconfirmed");
					}
				})(),
			]);
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					Promise.allSettled([...this.requests]),
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(new Error("Contained request cleanup unconfirmed")),
							15000,
						);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
			if (
				(this.started && !this.initialized) ||
				[...clientClosed, ...containerClosed].some(
					(result) => result.status === "rejected",
				)
			)
				throw new Error("Contained process cleanup unconfirmed");
		})();
		return this.closing;
	}
}
