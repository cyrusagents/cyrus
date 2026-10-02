import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { AppServerClient } from "./appServerClient.js";
import type {
	ContainedModelRequest,
	ContainedModelResponse,
} from "./ContainedCodexProcess.js";
import { resolveCodexAppServerLaunch } from "./codexBinary.js";

interface Login {
	accessToken: string;
	accountId: string;
}
/** Supervisor-only broker for the existing local Codex ChatGPT login. Never
 * exports auth to container env/files, MCP, checkpoints or log/error payloads. */
export class CodexLoginBroker {
	private accountId?: string;
	private refreshing?: Promise<void>;
	constructor(
		private readonly home: string = process.env.CODEX_HOME ||
			join(homedir(), ".codex"),
	) {
		if (!isAbsolute(home)) throw new Error("Codex auth home must be absolute");
	}
	private async login(): Promise<Login> {
		const file = await open(
			join(this.home, "auth.json"),
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
		try {
			const stat = await file.stat();
			if (
				!stat.isFile() ||
				stat.uid !== process.getuid?.() ||
				stat.mode & 0o077 ||
				stat.size > 131072
			)
				throw Error();
			const auth = JSON.parse(await file.readFile("utf8"));
			if (
				auth.OPENAI_API_KEY ||
				!auth.tokens ||
				typeof auth.tokens.access_token !== "string" ||
				!auth.tokens.access_token ||
				typeof auth.tokens.account_id !== "string" ||
				!auth.tokens.account_id ||
				/[\r\n\0]/.test(auth.tokens.access_token + auth.tokens.account_id)
			)
				throw Error();
			if (this.accountId && this.accountId !== auth.tokens.account_id)
				throw Error();
			this.accountId = auth.tokens.account_id;
			return {
				accessToken: auth.tokens.access_token,
				accountId: auth.tokens.account_id,
			};
		} finally {
			await file.close();
		}
	}
	async readiness(): Promise<string | null> {
		try {
			await this.login();
			return null;
		} catch {
			return "Existing private Codex ChatGPT login is unavailable or changed";
		}
	}
	private async refresh(): Promise<void> {
		if (this.refreshing) return this.refreshing;
		const launch = resolveCodexAppServerLaunch();
		const client = new AppServerClient({
			binaryPath: launch.command,
			args: launch.args,
			env: {
				HOME: homedir(),
				CODEX_HOME: this.home,
				PATH: "/usr/local/bin:/usr/bin:/bin",
			},
			logger: { warn() {}, error() {} },
			requestTimeoutMs: 15000,
			maxOutputBytes: 1000000,
		});
		client.on("error", () => {});
		// This trusted auth-only process never starts a thread/turn, registers tools,
		// or enters agent context. Native Codex owns refresh persistence/locking.
		client.setServerRequestHandler(() => {
			throw new Error("Auth-only request rejected");
		});
		const work = (async () => {
			try {
				client.start();
				await client.request("initialize", {
					clientInfo: { name: "cyrus-codex-auth", version: "1" },
				});
				await client.request("account/read", { refreshToken: true });
				await this.login();
			} finally {
				await client.close();
			}
		})();
		this.refreshing = work;
		try {
			await work;
		} finally {
			this.refreshing = undefined;
		}
	}
	async respond(
		request: ContainedModelRequest,
		context: {
			model: string;
			scopeKey: string;
			toolNames: readonly string[];
			authorize: () => Promise<void>;
			latency?: (
				stage:
					| "provider.headers"
					| "provider.body"
					| "credential.read"
					| "credential.refresh",
			) => (failed?: boolean) => void;
		},
		signal: AbortSignal,
	): Promise<ContainedModelResponse> {
		const measured = async <T>(
			stage:
				| "provider.headers"
				| "provider.body"
				| "credential.read"
				| "credential.refresh",
			work: () => Promise<T>,
		): Promise<T> => {
			const end = context.latency?.(stage);
			try {
				const value = await work();
				end?.();
				return value;
			} catch (error) {
				end?.(true);
				throw error;
			}
		};
		try {
			signal.throwIfAborted();
			// Validate the bounded request synchronously before the single pre-send
			// authority check below. No credentials, provider access or response
			// release occurs here; a second remote check around this pure validation
			// only adds another round trip to every model request.
			if (Buffer.byteLength(request.body) > 2000000) throw Error();
			const body = JSON.parse(request.body);
			const allowed = new Set([
				"model",
				"instructions",
				"input",
				"tools",
				"tool_choice",
				"parallel_tool_calls",
				"reasoning",
				"store",
				"stream",
				"include",
				"prompt_cache_key",
				"text",
				"client_metadata",
			]);
			if (
				!body ||
				typeof body !== "object" ||
				Array.isArray(body) ||
				Object.keys(body).some((k) => !allowed.has(k)) ||
				body.model !== context.model ||
				body.store !== false ||
				body.stream !== true ||
				!Array.isArray(body.input) ||
				!Array.isArray(body.tools)
			)
				throw Error();
			if (
				body.tools.some(
					(tool: any) =>
						!tool ||
						!["function", "custom"].includes(tool.type) ||
						![
							...context.toolNames,
							"apply_patch",
							"view_image",
							"request_user_input",
						].includes(tool.name),
				)
			)
				throw Error();
			// Codex supplies these local built-ins even when shell/network tools are
			// disabled. They are compatibility input, not scoped capabilities: the
			// provider must see only the supervisor-admitted dynamic tool catalog.
			body.tools = body.tools.filter((tool: { name: string }) =>
				context.toolNames.includes(tool.name),
			);
			// No remotely resolved files/images or prior response IDs. Every request
			// supplies its own admitted conversation; provider cache key is scope-bound.
			const visit = (value: unknown, depth = 0): void => {
				if (depth > 32) throw Error();
				if (Array.isArray(value)) {
					for (const item of value) visit(item, depth + 1);
				} else if (value && typeof value === "object") {
					const v = value as Record<string, unknown>;
					if (
						[
							"input_image",
							"input_file",
							"item_reference",
							"input_audio",
							"input_video",
							"file_search",
							"web_search",
							"web_search_preview",
							"computer",
						].includes(String(v.type))
					)
						throw Error();
					for (const item of Object.values(v)) visit(item, depth + 1);
				}
			};
			visit(body.input);
			body.prompt_cache_key = context.scopeKey;
			const send = async () => {
				await context.authorize();
				signal.throwIfAborted();
				const login = await measured("credential.read", () => this.login());
				return measured("provider.headers", () =>
					fetch("https://chatgpt.com/backend-api/codex/responses", {
						method: "POST",
						redirect: "error",
						signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${login.accessToken}`,
							"ChatGPT-Account-ID": login.accountId,
							originator: "codex_cli_rs",
						},
						body: JSON.stringify(body),
					}),
				);
			};
			let response = await send();
			if (response.status === 401) {
				await response.body?.cancel();
				await context.authorize();
				await measured("credential.refresh", () => this.refresh());
				signal.throwIfAborted();
				response = await send();
			}
			if (!response.ok || !response.body) {
				await response.body?.cancel();
				throw Error();
			}
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			await measured("provider.body", async () => {
				try {
					for (;;) {
						const next = await reader.read();
						if (next.done) break;
						size += next.value.byteLength;
						if (size > 4000000) throw Error();
						chunks.push(next.value);
					}
				} finally {
					await reader.cancel().catch(() => {});
					reader.releaseLock();
				}
			});
			await context.authorize();
			signal.throwIfAborted();
			return {
				status: 200,
				contentType: "text/event-stream",
				body: Buffer.concat(chunks).toString("base64"),
			};
		} catch {
			throw new Error("Contained Codex model connection denied or interrupted");
		}
	}
}
