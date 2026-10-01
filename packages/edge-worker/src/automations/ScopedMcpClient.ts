import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import {
	type AutomationAuthority,
	type AutomationToolCall,
	authorizeTool,
	isCustomerReadSet,
	isSlackChannel,
	type McpCredential,
	permittedToolNames,
	scopedToolResult,
	slackChannelHistorySchema,
	slackMessageResult,
} from "./contract.js";
import { AutomationDiagnosticError } from "./Diagnostics.js";
import {
	engineeringPublicationResult,
	publicationMetadata,
} from "./Engineering.js";
import type { SupervisorTiming } from "./HostedTiming.js";
import { beginLatency, measureLatency } from "./Latency.js";
import {
	isNativeContextTool,
	nativeContextPageSchema,
	nativeContextRejection,
	nativeContextResult,
} from "./NativeContext.js";

export interface ScopedAutomationTools {
	call(
		call: AutomationToolCall,
		idempotencyKey: string,
		signal: AbortSignal,
		engineeringFiles?: Record<string, string>,
	): Promise<unknown>;
	/** Serialize server-side credential rotation with complete MCP operations. */
	renew(operation: (sessionId?: string) => Promise<void>): Promise<void>;
	/** Current authority check on the admitted SDK session; never extends its lease. */
	revalidate?(): Promise<void>;
	close(): Promise<void>;
}

/** One client per admitted attempt. Never reads global MCP config or supervisor credentials. */
export class ScopedAutomationMcpClient implements ScopedAutomationTools {
	private client?: Client;
	private transport?: StreamableHTTPClientTransport;
	private names = new Set<string>();
	private connectedCredential?: McpCredential;
	private readonly issueReferences = new Set<string>();
	private readonly threadReferences = new Set<string>();
	private readonly cursors = new Set<string>();
	private readonly contextCursors = new Set<string>();
	private queue: Promise<unknown> = Promise.resolve();
	private exclusive<T>(operation: () => Promise<T>): Promise<T> {
		const queued = beginLatency("mcp.queue");
		const next = this.queue.then(() => {
			queued();
			return operation();
		});
		this.queue = next.catch(() => {});
		return next;
	}
	renew(operation: (sessionId?: string) => Promise<void>): Promise<void> {
		return this.exclusive(async () => {
			const admitted = this.connectedCredential;
			const sessionId = admitted?.sessionRenewal
				? this.transport?.sessionId
				: undefined;
			const authorityIdentity = () => {
				const { leaseUntil: _lease, ...identity } = this.authority();
				return JSON.stringify(identity);
			};
			const identity = authorityIdentity();
			try {
				if (sessionId && Date.parse(admitted!.expiresAt) <= Date.now())
					throw new Error("Expired MCP session cannot renew");
				await operation(sessionId);
				this.signal.throwIfAborted();
				const next = this.credential();
				if (sessionId) {
					if (
						!next.sessionRenewal ||
						next.sessionId !== sessionId ||
						next.grantId !== admitted!.grantId ||
						next.audience !== "/mcp" ||
						Date.parse(next.expiresAt) <= Date.now() ||
						identity !== authorityIdentity()
					)
						throw new Error("MCP session continuation not authorized");
					// The SDK operation queue is idle. Preserve this exact transport and
					// its references only after the server atomically admits continuation.
					Object.assign(admitted!, next);
				} else if (next.sessionId) {
					throw new Error("Unrequested MCP session continuation");
				}
			} catch (error) {
				await this.disconnect();
				throw error;
			}
		});
	}
	private readonly url: URL;
	private requestTiming?: SupervisorTiming;
	constructor(
		origin: string,
		private readonly authority: () => AutomationAuthority,
		private readonly credential: () => McpCredential,
		private readonly signal: AbortSignal,
	) {
		const url = new URL(origin);
		if (
			url.protocol !== "https:" ||
			url.pathname !== "/" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		)
			throw new Error("Invalid scoped MCP origin");
		this.url = new URL("/mcp", url);
	}
	private async connect(
		credential: McpCredential,
		refreshCatalog = false,
	): Promise<Client> {
		if (this.closeFailed) throw new Error("Scoped MCP cleanup unconfirmed");
		if (
			this.client &&
			(this.connectedCredential?.token !== credential.token ||
				this.connectedCredential?.grantId !== credential.grantId)
		)
			await this.disconnect();
		if (this.client) {
			if (refreshCatalog) await this.readCatalog(this.client);
			return this.client;
		}
		const client = new Client({
			name: "cyrus-contained-automation",
			version: "1",
		});
		const transport = new StreamableHTTPClientTransport(this.url, {
			reconnectionOptions: {
				maxRetries: 0,
				initialReconnectionDelay: 1000,
				maxReconnectionDelay: 1000,
				reconnectionDelayGrowFactor: 1,
			},
			fetch: async (url, init) => {
				if (String(url) !== this.url.href)
					throw new Error("MCP transport origin changed");
				const admitted = { ...credential };
				if (
					admitted.audience !== "/mcp" ||
					Date.parse(admitted.expiresAt) <= Date.now()
				)
					throw new Error("Scoped MCP credential expired");
				this.signal.throwIfAborted();
				const timing = init?.method === "POST" ? this.requestTiming : undefined;
				const headers = new Headers(init?.headers);
				if (timing)
					for (const [key, value] of Object.entries(timing.headers))
						headers.set(key, value);
				headers.set("Authorization", `Bearer ${admitted.token}`);
				const response = await fetch(this.url, {
					...init,
					redirect: "error",
					headers,
					signal: AbortSignal.any([
						this.signal,
						...(init?.signal ? [init.signal] : []),
						AbortSignal.timeout(20_000),
					]),
				});
				timing?.read(response);
				if (
					!response.ok &&
					!(response.status === 405 && init?.method === "GET")
				) {
					await response.body?.cancel();
					throw new AutomationDiagnosticError({
						phase: "mcp",
						code: "http_denied",
						httpStatus: response.status,
					});
				}
				if (!response.body) return response;
				// This contract uses JSON responses, not a background SSE stream. Buffer
				// bounded bytes before handing the response to the SDK: cancelling a
				// transformed undici stream can otherwise reject outside the SDK request.
				const reader = response.body.getReader();
				const chunks: Uint8Array[] = [];
				let bytes = 0;
				try {
					if (
						response.headers.get("content-type")?.includes("text/event-stream")
					)
						throw new Error("Scoped MCP requires JSON responses");
					for (;;) {
						const part = await reader.read();
						if (part.done) break;
						bytes += part.value.byteLength;
						if (bytes > 2_000_000)
							throw new Error("Scoped MCP response limit exceeded");
						chunks.push(part.value);
					}
				} catch (error) {
					await reader.cancel(error).catch(() => {});
					throw error;
				} finally {
					reader.releaseLock();
				}
				const body = Buffer.concat(chunks);
				return new Response(body, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				});
			},
		});
		try {
			await measureLatency("mcp.initialize", () =>
				client.connect(transport, { signal: this.signal, timeout: 20_000 }),
			);
			await this.readCatalog(client);
			this.client = client;
			this.transport = transport;
			this.connectedCredential = credential;
			return client;
		} catch (error) {
			const cleanup = await Promise.allSettled([
				client.close(),
				transport.close(),
			]);
			if (cleanup.some((result) => result.status === "rejected"))
				this.closeFailed = true;
			if (error instanceof AutomationDiagnosticError) throw error;
			throw new AutomationDiagnosticError(
				{ phase: "mcp", code: "mcp_initialization" },
				"Scoped MCP initialization denied",
			);
		}
	}

	private measuredRequest<T>(
		stage: "mcp.catalog" | "mcp.call",
		work: () => Promise<T>,
	): Promise<T> {
		return measureLatency(stage, async (timing) => {
			// Only inside the serialized SDK request, never initialization/GET or
			// model context. One response belongs to this one numeric span.
			this.requestTiming = timing;
			try {
				return await work();
			} finally {
				this.requestTiming = undefined;
			}
		});
	}

	private async readCatalog(client: Client): Promise<void> {
		await this.measuredRequest("mcp.catalog", async () => {
			this.admitCatalog(
				await client.listTools(undefined, {
					signal: this.signal,
					timeout: 20_000,
				}),
			);
		});
	}

	private admitCatalog(list: {
		nextCursor?: string;
		tools: { name: string }[];
	}) {
		if (
			list.nextCursor ||
			list.tools.length >
				permittedToolNames(this.authority()).filter(
					(name) => name !== "execute",
				).length ||
			list.tools.some(
				(tool) =>
					tool.name === "execute" ||
					!permittedToolNames(this.authority()).includes(tool.name),
			)
		)
			throw new Error("Unscoped MCP tool catalog");
		this.names = new Set(list.tools.map((tool) => tool.name));
	}
	revalidate(): Promise<void> {
		return this.exclusive(async () => {
			try {
				// A new connection already checks a fresh catalog in this same
				// serialized operation. Existing sessions must fetch it again:
				// this is never a cached authority check or a lease extension.
				await this.connect({ ...this.credential() }, true);
			} catch (error) {
				await this.disconnect();
				throw new AutomationDiagnosticError(
					error instanceof AutomationDiagnosticError
						? error.diagnostic
						: { phase: "mcp", code: "mcp_authorization" },
					"Scoped MCP authority unavailable",
				);
			}
		});
	}

	async call(
		call: AutomationToolCall,
		idempotencyKey: string,
		signal: AbortSignal,
		engineeringFiles?: Record<string, string>,
	): Promise<unknown> {
		return this.exclusive(async () => {
			const authority = this.authority();
			const credential = { ...this.credential() };
			authorizeTool(authority, call);
			if (
				!authority.engineering &&
				(authority.definition.grants[0]?.id ??
					authority.nativeContext?.bindingId) !== credential.grantId
			)
				throw new Error("MCP grant identity mismatch");
			if (call.name === "execute")
				throw new Error(
					"Engineering commands require the local isolated executor",
				);
			if (engineeringFiles && call.name !== "publish_artifact")
				throw new Error("Engineering metadata on a non-publication tool");
			const metadata =
				call.name === "publish_artifact"
					? publicationMetadata(
							authority.engineering!,
							idempotencyKey,
							engineeringFiles,
						)
					: { idempotencyKey };
			try {
				const client = await this.connect(credential);
				if (!this.names.has(call.name))
					throw new Error("MCP tool absent from scoped catalog");
				if (
					isSlackChannel(authority) &&
					((call.name === "read_thread" &&
						!this.threadReferences.has(call.arguments.reference)) ||
						(call.name === "read_messages" &&
							call.arguments.cursor !== undefined &&
							!this.cursors.has(call.arguments.cursor)))
				)
					return {
						items: [
							{
								text: "This reference or cursor was not issued by the current MCP session. Call read_messages without a cursor and use its newly returned references.",
							},
						],
						nextCursor: null,
					};
				// Pure reads can safely return a re-list instruction after reconnect.
				// Uncertain delegation is never rewritten or assigned another operation key.
				if (
					isCustomerReadSet(authority) &&
					call.name === "get_issue" &&
					!(
						"reference" in call.arguments &&
						this.issueReferences.has(call.arguments.reference)
					)
				)
					return {
						items: [
							{
								text: "This reference was not issued by the current MCP session. Call list_issues and use a newly returned reference before reading.",
							},
						],
						nextCursor: null,
					};
				if (
					call.name === "read_context" &&
					call.arguments.cursor &&
					!this.contextCursors.has(call.arguments.cursor)
				)
					return {
						items: [
							{
								text: "This context cursor was not issued by the current MCP session. Call read_context without a cursor to obtain a fresh page.",
							},
						],
						nextCursor: null,
					};
				const result = await this.measuredRequest("mcp.call", () =>
					client.callTool({ ...call, _meta: metadata }, undefined, {
						signal,
						timeout: 20_000,
					}),
				);
				if (result.isError)
					return nativeContextRejection(
						call.name,
						idempotencyKey,
						result.structuredContent,
					);
				if (!result.structuredContent)
					throw new Error("Scoped MCP tool denied");
				if (call.name === "publish_artifact")
					return engineeringPublicationResult(
						authority.engineering!,
						result.structuredContent,
					);
				if (isNativeContextTool(call.name)) {
					const output = nativeContextResult(
						authority.nativeContext!,
						call.name,
						result.structuredContent,
					);
					if (call.name === "read_context") {
						const page = nativeContextPageSchema.parse(
							result.structuredContent,
						);
						if (page.nextCursor) this.contextCursors.add(page.nextCursor);
					}
					return output;
				}
				if (call.name === "reply" && authority.slackMessages)
					return slackMessageResult(
						authority,
						call,
						idempotencyKey,
						result.structuredContent,
					);
				const output = scopedToolResult(
					authority,
					call,
					result.structuredContent,
				);
				if (isCustomerReadSet(authority) && call.name === "list_issues") {
					const listed = z
						.object({
							issues: z
								.array(
									z
										.object({
											reference: z.string().uuid(),
											identifier: z.string().max(300),
										})
										.strict(),
								)
								.max(100),
							held: z.number().int().nonnegative(),
						})
						.strict();
					for (const item of output.items)
						for (const issue of listed.parse(JSON.parse(item.text)).issues)
							this.issueReferences.add(issue.reference);
				}
				if (isSlackChannel(authority) && call.name === "read_messages") {
					const pages = output.items.map((item) =>
						slackChannelHistorySchema.parse(JSON.parse(item.text)),
					);
					const cursor =
						output.nextCursor === null
							? null
							: z.string().uuid().parse(output.nextCursor);
					for (const page of pages)
						for (const message of page.messages)
							this.threadReferences.add(message.reference);
					if (cursor) this.cursors.add(cursor);
				}
				return output;
			} catch (error) {
				// Uncertain operations remain checkpointed. Next admitted attempt reconnects
				// with the same operation key; it never retries a send under broader authority.
				await this.disconnect();
				throw new AutomationDiagnosticError(
					error instanceof AutomationDiagnosticError
						? error.diagnostic
						: { phase: "mcp", code: "mcp_operation" },
					"Scoped MCP operation interrupted",
				);
			}
		});
	}
	async close(): Promise<void> {
		return this.exclusive(async () => {
			await this.disconnect();
			if (this.closeFailed) throw new Error("Scoped MCP cleanup unconfirmed");
		});
	}
	private closeFailed = false;
	private async disconnect(): Promise<void> {
		this.issueReferences.clear();
		this.threadReferences.clear();
		this.cursors.clear();
		this.contextCursors.clear();
		const transport = this.transport;
		this.transport = undefined;
		this.connectedCredential = undefined;
		const client = this.client;
		this.client = undefined;
		// Local close only. Completion/revocation may already prohibit protocol DELETE.
		const results = await Promise.allSettled([
			client?.close(),
			transport?.close(),
		]);
		if (results.some((result) => result.status === "rejected")) {
			this.closeFailed = true;
			throw new Error("Scoped MCP cleanup unconfirmed");
		}
	}
}
