// Explicit test instrumentation only. Not imported by, or packed with, the runtime.
// No credentials, provider output, session IDs or references leave this closure.
export const REVIEWED_RUNTIME_SHA = "134a8a48fd97ffae01fe5328c098ff0d1e719f43";
export const PREVIEW_ORIGIN = "https://cyrus-preview-cyhost-1321.vercel.app";

export function installWithdrawalProbe(ScopedClient, sdk, options) {
	const { target, report = () => {}, origin = PREVIEW_ORIGIN } = options;
	const original = ScopedClient.prototype.call;
	let phase = "idle",
		occurrenceId,
		held,
		old,
		release,
		deadline,
		recoveryDeadline;
	let commands = Promise.resolve();
	const events = [];
	const status = () => ({
		version: 1,
		phase,
		occurrenceId: occurrenceId ?? null,
		expiresInMs: old ? Math.max(0, old.expiresAt - Date.now()) : null,
		events: structuredClone(events),
	});
	const event = (type, data = {}) => {
		events.push({ type, at: new Date().toISOString(), ...data });
		if (events.length > 32) events.shift();
		report(status());
	};
	const matches = (owner) => {
		const a = owner.authority();
		return (
			owner.url.href === `${origin}/mcp` &&
			a.phase === "execute" &&
			a.definition.workspaceId === target.workspaceId &&
			a.definition.id === target.automationId &&
			a.definition.revision === target.revision &&
			a.occurrenceId === occurrenceId &&
			a.definition.role === "coordinator" &&
			!a.engineering &&
			a.definition.grants.length === 1 &&
			a.definition.grants[0].resource.provider === "linear" &&
			a.definition.grants[0].resource.customerId === target.customerId &&
			a.definition.grants[0].permissions.includes("read")
		);
	};
	const capture = (owner) => {
		if (
			!owner.transport?.sessionId ||
			!owner.connectedCredential ||
			!owner.client ||
			typeof owner.transport._protocolVersion !== "string"
		)
			throw Error("Probe requires an initialized admitted session");
		const a = owner.authority(),
			credential = { ...owner.connectedCredential };
		if (
			credential.audience !== "/mcp" ||
			credential.grantId !== a.definition.grants[0].id
		)
			throw Error("Probe grant mismatch");
		return {
			credential,
			sessionId: owner.transport.sessionId,
			protocolVersion: owner.transport._protocolVersion,
			expiresAt: Math.min(
				Date.parse(credential.expiresAt),
				Date.parse(a.leaseUntil),
			),
			identity: JSON.stringify({
				definition: a.definition,
				occurrenceId: a.occurrenceId,
				input: a.input,
			}),
			attemptId: a.attemptId,
			fence: a.fence,
		};
	};
	const unblock = () => {
		clearTimeout(deadline);
		release?.();
		release = undefined;
		held = undefined;
	};
	const dispose = () => {
		unblock();
		clearTimeout(recoveryDeadline);
		old = undefined;
		if (ScopedClient.prototype.call === wrapped)
			ScopedClient.prototype.call = original;
	};
	const inconclusive = (reason) => {
		phase = "inconclusive";
		event("inconclusive", { reason });
		dispose();
	};

	// A reconnect to an ALREADY admitted session: no initialize, new grant or scope.
	// Capability checks are deliberately limited to these two read methods because
	// SDK reconnect does not restore initialize metadata. Request/response framing
	// remains the actual SDK transport; per-call Hosted authentication is unchanged.
	class ReadProbeClient extends sdk.Client {
		assertCapabilityForMethod(method) {
			if (!["tools/list", "tools/call"].includes(method))
				throw Error("Probe method denied");
		}
	}
	async function probe(captured, method, reference, label) {
		const evidence = {
			label,
			method,
			httpObserved: false,
			requestCount: 0,
			httpStatus: null,
			mcpCode: null,
			denied: false,
			requestAt: null,
			responseAt: null,
			unexpiredAtRequest: false,
			unexpiredAtResponse: false,
		};
		if (Date.now() >= captured.expiresAt) {
			event("probe", { ...evidence, outcome: "inconclusive-expired" });
			return false;
		}
		const client = new ReadProbeClient({
			name: "cyrus-f1-withdrawal-read-probe",
			version: "1",
		});
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(),
			Math.min(8000, captured.expiresAt - Date.now()),
		);
		const transport = new sdk.StreamableHTTPClientTransport(
			new URL(`${origin}/mcp`),
			{
				sessionId: captured.sessionId,
				reconnectionOptions: {
					maxRetries: 0,
					initialReconnectionDelay: 1000,
					maxReconnectionDelay: 1000,
					reconnectionDelayGrowFactor: 1,
				},
				fetch: async (url, init) => {
					const body = JSON.parse(String(init?.body));
					const expected =
						method === "tools/list"
							? undefined
							: { name: "get_issue", arguments: { reference } };
					if (
						String(url) !== `${origin}/mcp` ||
						init?.method !== "POST" ||
						body.method !== method ||
						JSON.stringify(body.params) !== JSON.stringify(expected) ||
						evidence.requestCount !== 0
					)
						throw Error("Probe request widening denied");
					if (Date.now() >= captured.expiresAt) throw Error("Probe expired");
					const headers = new Headers(init.headers);
					if (headers.get("mcp-session-id") !== captured.sessionId)
						throw Error("Probe session changed");
					headers.set("authorization", `Bearer ${captured.credential.token}`);
					evidence.requestAt = new Date().toISOString();
					evidence.unexpiredAtRequest = true;
					evidence.requestCount++;
					const response = await fetch(url, {
						...init,
						headers,
						redirect: "error",
						signal: controller.signal,
					});
					evidence.httpObserved = true;
					evidence.httpStatus = response.status;
					evidence.responseAt = new Date().toISOString();
					evidence.unexpiredAtResponse = Date.now() < captured.expiresAt;
					// Do not emit or retain private response bodies, even on unexpected success.
					if (!response.ok) {
						await response.body?.cancel();
						throw Error("Probe HTTP response denied");
					}
					const reader = response.body?.getReader();
					if (
						!reader ||
						response.headers.get("content-type")?.includes("text/event-stream")
					) {
						await reader?.cancel();
						throw Error("Probe requires bounded JSON");
					}
					const chunks = [];
					let size = 0;
					try {
						for (;;) {
							const part = await reader.read();
							if (part.done) break;
							size += part.value.byteLength;
							if (size > 2_000_000) throw Error("Probe response bound");
							chunks.push(part.value);
						}
					} finally {
						await reader.cancel().catch(() => {});
						reader.releaseLock();
					}
					return new Response(Buffer.concat(chunks), {
						status: response.status,
						headers: response.headers,
					});
				},
			},
		);
		transport.setProtocolVersion(captured.protocolVersion);
		try {
			await client.connect(transport);
			if (method === "tools/list")
				await client.listTools(undefined, {
					signal: controller.signal,
					timeout: 8000,
				});
			else
				await client.callTool(
					{ name: "get_issue", arguments: { reference } },
					undefined,
					{ signal: controller.signal, timeout: 8000 },
				);
		} catch (error) {
			if (Number.isSafeInteger(error?.code)) evidence.mcpCode = error.code;
		} finally {
			clearTimeout(timer);
			await client.close().catch(() => {});
		}
		evidence.denied =
			evidence.httpObserved &&
			evidence.unexpiredAtRequest &&
			evidence.unexpiredAtResponse &&
			(evidence.httpStatus === 401 ||
				(label === "new-session-old-reference" && evidence.mcpCode === -32600));
		event("probe", {
			...evidence,
			outcome: evidence.denied ? "denied" : "inconclusive-or-unexpected",
		});
		return evidence.denied;
	}

	async function wrapped(call, ...args) {
		const output = await original.call(this, call, ...args);
		if (!occurrenceId || !matches(this)) return output;
		// The successful read finishes first. Then hold the SAME production queue;
		// renew/close/other normal tool work cannot overlap the retained probe session.
		await this.exclusive(async () => {
			if (
				phase === "armed" &&
				call.name === "get_issue" &&
				this.references.has(call.arguments.reference) &&
				this.names.has("get_issue")
			) {
				old = { ...capture(this), reference: call.arguments.reference };
				if (old.expiresAt - Date.now() < 20000)
					return inconclusive("insufficient-lease-window");
				held = this;
				phase = "ready";
				const wait = new Promise((resolve) => {
					release = resolve;
				});
				deadline = setTimeout(
					() => inconclusive("barrier-timeout"),
					Math.min(45000, old.expiresAt - Date.now() - 1000),
				);
				event("ready", {
					attemptId: old.attemptId,
					fence: old.fence,
					remainingMs: old.expiresAt - Date.now(),
				});
				await wait;
				if (phase === "awaiting-recovery")
					throw Error(
						"F1 withdrawal barrier released; normal recovery required",
					);
			} else if (
				phase === "awaiting-recovery" &&
				old &&
				call.name === "list_issues"
			) {
				const current = capture(this);
				if (current.identity !== old.identity)
					return inconclusive("recovery-scope-changed");
				if (
					current.attemptId === old.attemptId ||
					current.fence <= old.fence ||
					current.sessionId === old.sessionId
				)
					return; // no resurrection or invented replacement admission
				event("new-session", {
					attemptChanged: true,
					fenceIncreased: true,
					sessionChanged: true,
				});
				if (
					!(await probe(
						current,
						"tools/call",
						old.reference,
						"new-session-old-reference",
					))
				)
					return inconclusive("stale-reference-not-proven");
				phase = "awaiting-current-read";
				event("stale-reference-denied");
			} else if (
				phase === "awaiting-current-read" &&
				call.name === "get_issue" &&
				this.references.has(call.arguments.reference) &&
				call.arguments.reference !== old?.reference
			) {
				phase = "complete";
				event("current-read-succeeded");
				dispose();
			}
		});
		return output;
	}
	ScopedClient.prototype.call = wrapped;

	async function control(command) {
		if (!command || typeof command !== "object" || Array.isArray(command))
			throw Error("Invalid probe command");
		const keys = Object.keys(command).sort().join(",");
		if (command.op === "status" && keys === "op") return status();
		if (command.op === "cancel" && keys === "op") {
			phase = "cancelled";
			event("cancelled");
			dispose();
			return status();
		}
		if (
			command.op === "arm" &&
			keys === "occurrenceId,op" &&
			phase === "idle" &&
			typeof command.occurrenceId === "string" &&
			/^[a-zA-Z0-9_-]{1,200}$/.test(command.occurrenceId)
		) {
			occurrenceId = command.occurrenceId;
			phase = "armed";
			event("armed");
			recoveryDeadline = setTimeout(
				() => inconclusive("probe-lifetime-timeout"),
				10 * 60_000,
			);
			recoveryDeadline.unref();
			return status();
		}
		if (
			keys !== "confirmedAt,op" ||
			!held ||
			!old ||
			!["probe-paused", "probe-resumed"].includes(command.op) ||
			!Number.isFinite(Date.parse(command.confirmedAt)) ||
			Date.parse(command.confirmedAt) > Date.now() ||
			Date.parse(command.confirmedAt) <
				Date.parse(events.find((e) => e.type === "ready").at)
		)
			throw Error("Invalid probe state or confirmation");
		if (command.op === "probe-paused" && phase === "ready") {
			const list = await probe(old, "tools/list", undefined, "paused-list");
			const read = await probe(old, "tools/call", old.reference, "paused-read");
			if (!list || !read) {
				inconclusive("post-pause-denial-not-proven");
				return status();
			}
			phase = "paused-proven";
			event("paused-proven", { confirmedAt: command.confirmedAt });
			return status();
		}
		if (command.op === "probe-resumed" && phase === "paused-proven") {
			if (
				!(await probe(
					old,
					"tools/call",
					old.reference,
					"resumed-old-credential",
				))
			) {
				inconclusive("post-resume-denial-not-proven");
				return status();
			}
			phase = "awaiting-recovery";
			event("released", { confirmedAt: command.confirmedAt });
			unblock();
			return status();
		}
		throw Error("Invalid probe phase");
	}
	return {
		status,
		dispose,
		command(command) {
			const next = commands.then(() => control(command));
			commands = next.catch(() => {});
			return next;
		},
	};
}
