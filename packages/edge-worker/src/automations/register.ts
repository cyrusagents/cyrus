import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { getCyrusAppUrl } from "cyrus-cloudflare-tunnel-client";
import { CodexLoginBroker, ContainedCodexProcess } from "cyrus-codex-runner";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpSessionDeliveryTransport } from "../sinks/SessionDeliveryTransport.js";
import { AutomationRuntime } from "./AutomationRuntime.js";
import { AutomationCheckpointStore } from "./CheckpointStore.js";
import { ContainedCodexAutomationModel } from "./ContainedCodexModel.js";
import {
	checkpointKey,
	permittedToolNames,
	registrationSchema,
} from "./contract.js";
import { DockerSandbox } from "./DockerSandbox.js";
import { type AutomationGateway, AutomationHttpGateway } from "./Gateway.js";
import { beginLatency } from "./Latency.js";
import { AutomationLedger } from "./Ledger.js";
import {
	ConfiguredAutomationMessagesModel,
	type ConfiguredAutomationModel,
	modelReadiness,
} from "./Model.js";
import { recoveryRequestSchema } from "./Recovery.js";
import { ScopedAutomationMcpClient } from "./ScopedMcpClient.js";

export function registerAutomationRoutes(
	app: FastifyInstance,
	runtime: AutomationRuntime,
	getApiKey: () => string,
): void {
	const authenticated = (header: string | undefined) => {
		const key = getApiKey();
		if (!key || !header) return false;
		const expected = Buffer.from(`Bearer ${key}`);
		const supplied = Buffer.from(header);
		return (
			expected.length === supplied.length && timingSafeEqual(expected, supplied)
		);
	};
	app.get("/api/automations/v1/capabilities", async (request, reply) => {
		if (!authenticated(request.headers.authorization))
			return reply.code(401).send({ error: "Unauthorized" });
		return reply
			.header("Cache-Control", "no-store")
			.send(runtime.capabilities());
	});
	app.post(
		"/api/automations/v1/wake",
		{ bodyLimit: 1024 },
		async (request, reply) => {
			if (!authenticated(request.headers.authorization))
				return reply.code(401).send({ error: "Unauthorized" });
			if (
				!z
					.object({ contractVersion: z.literal(1) })
					.strict()
					.safeParse(request.body).success
			)
				return reply
					.code(400)
					.send({ error: "Unsupported automation request" });
			if (!runtime.canDrain())
				return reply.code(409).send(runtime.capabilities());
			void runtime.wake().catch(() => {});
			return reply
				.code(202)
				.header("Cache-Control", "no-store")
				.send({ contractVersion: 1, status: "accepted" });
		},
	);
	app.post(
		"/api/automations/v1/definitions",
		{ bodyLimit: 120_000 },
		async (request, reply) => {
			if (!authenticated(request.headers.authorization))
				return reply.code(401).send({ error: "Unauthorized" });
			try {
				const body = z
					.object({
						contractVersion: z.literal(1),
						definition: registrationSchema,
					})
					.strict()
					.parse(request.body);
				const definition = runtime.upsert(body.definition);
				return {
					contractVersion: 1,
					automationId: definition.id,
					revision: definition.revision,
					state: definition.state,
				};
			} catch {
				return reply
					.code(409)
					.send({ error: "Automation definition rejected" });
			}
		},
	);
	app.post(
		"/api/automations/v1/occurrences",
		{ bodyLimit: 120_000 },
		async (request, reply) => {
			if (!authenticated(request.headers.authorization))
				return reply.code(401).send({ error: "Unauthorized" });
			const receivedAt = performance.now();
			try {
				const body = z
					.object({
						contractVersion: z.literal(1),
						automationId: z.string().min(1).max(200),
						revision: z.number().int().positive(),
						eventId: z.string().min(1).max(200),
						input: z.string().max(100_000),
						trigger: z.enum(["instruction", "event"]).default("instruction"),
					})
					.strict()
					.parse(request.body);
				const occurrence = runtime.enqueue(
					body.automationId,
					body.revision,
					body.eventId,
					body.input,
					body.trigger,
					receivedAt,
				);
				void runtime.wake().catch(() => {});
				return {
					contractVersion: 1,
					occurrenceId: occurrence.id,
					status: occurrence.status,
				};
			} catch {
				return reply
					.code(409)
					.send({ error: "Automation occurrence rejected" });
			}
		},
	);
	app.post(
		"/api/automations/v1/retry",
		{ bodyLimit: 2048 },
		async (request, reply) => {
			if (!authenticated(request.headers.authorization))
				return reply.code(401).send({ error: "Unauthorized" });
			const parsed = recoveryRequestSchema.safeParse(request.body);
			if (!parsed.success)
				return reply.code(400).send({ error: "Invalid recovery command" });
			try {
				const receipt = runtime.recover(parsed.data);
				void runtime.wake().catch(() => {});
				return reply
					.code(202)
					.header("Cache-Control", "no-store")
					.send(receipt);
			} catch {
				return reply.code(409).send({ error: "Automation recovery rejected" });
			}
		},
	);
	app.get<{ Params: { automationId: string } }>(
		"/api/automations/v1/status/:automationId",
		async (request, reply) => {
			if (!authenticated(request.headers.authorization))
				return reply.code(401).send({ error: "Unauthorized" });
			try {
				return reply.header("Cache-Control", "no-store").send({
					contractVersion: 1,
					...runtime.status(
						request.params.automationId,
						request.headers["x-cyrus-latency-diagnostics"] === "1",
					),
				});
			} catch {
				return reply.code(409).send({ error: "Automation state unavailable" });
			}
		},
	);
	app.addHook("onReady", async () => runtime.start());
	app.addHook("onClose", async () => runtime.stop());
}

/** Registered in active AND repository-less runtimes; no extra listener/config/key. */
export function registerConfiguredAutomations(
	app: FastifyInstance,
	cyrusHome: string,
	getConfig: () => {
		defaultRunner?: string;
		claudeDefaultModel?: string;
		codexDefaultModel?: string;
		geminiDefaultModel?: string;
		cursorDefaultModel?: string;
		opencodeDefaultModel?: string;
		defaultModel?: string;
	},
): AutomationRuntime {
	const pairedWorkspace = process.env.CYRUS_TEAM_ID || "";
	const origin = getCyrusAppUrl();
	const configuration = (): ConfiguredAutomationModel => {
		const config = getConfig();
		const harness =
			process.env.CYRUS_DEFAULT_RUNNER || config.defaultRunner || "claude";
		const selectedModel =
			harness === "codex"
				? process.env.CYRUS_CODEX_DEFAULT_MODEL || config.codexDefaultModel
				: harness === "gemini"
					? process.env.CYRUS_GEMINI_DEFAULT_MODEL || config.geminiDefaultModel
					: harness === "cursor"
						? process.env.CYRUS_CURSOR_DEFAULT_MODEL ||
							config.cursorDefaultModel
						: harness === "opencode"
							? process.env.CYRUS_OPENCODE_DEFAULT_MODEL ||
								config.opencodeDefaultModel
							: harness === "claude"
								? process.env.CYRUS_CLAUDE_DEFAULT_MODEL ||
									config.claudeDefaultModel
								: undefined;
		return {
			harness,
			model:
				selectedModel ||
				process.env.CYRUS_DEFAULT_MODEL ||
				config.defaultModel ||
				"",
			apiKey: process.env.ANTHROPIC_API_KEY,
			oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
		};
	};
	let gateway: AutomationGateway;
	let gatewayError: string | null = null;
	try {
		gateway = new AutomationHttpGateway(
			origin,
			() => ({
				apiKey: process.env.CYRUS_API_KEY || "",
				workspaceId: pairedWorkspace,
			}),
			true,
			// Protocol support also permits receipt-only recovery with an unavailable image.
			() => true,
		);
	} catch {
		gatewayError =
			"Configured control plane requires HTTPS for contained automations";
		gateway = {
			async call() {
				throw new Error("Automation gateway unavailable");
			},
		};
	}
	let ledger: AutomationLedger | undefined;
	if (process.env.CYRUS_TEAM_ID && process.env.CYRUS_API_KEY) {
		try {
			ledger = new AutomationLedger(
				join(cyrusHome, "automation-ledger-v1"),
				process.env.CYRUS_TEAM_ID,
			);
		} catch {
			gatewayError = "Private durable automation storage is unavailable";
		}
	}
	const codexConfig = {
		image: process.env.CYRUS_CONTAINED_CODEX_IMAGE || "",
		dockerPath:
			process.env.CYRUS_CONTAINED_DOCKER_PATH ||
			(process.platform === "darwin"
				? "/usr/local/bin/docker"
				: "/usr/bin/docker"),
		dockerHost:
			process.env.CYRUS_CONTAINED_DOCKER_HOST || "unix:///var/run/docker.sock",
	};
	let codexReason: string | null =
		"Contained Codex image has not been configured and verified";
	let engineeringReady = false;
	let broker: CodexLoginBroker | undefined;
	try {
		broker = new CodexLoginBroker();
	} catch {
		codexReason = "Codex login home must be an absolute private path";
	}
	const codexModel = new ContainedCodexAutomationModel(
		codexConfig,
		(request, context) => {
			if (!broker) throw new Error("Codex login broker unavailable");
			return broker.respond(
				request,
				{
					model: context.authority().definition.target.model,
					scopeKey: checkpointKey(context.authority()),
					toolNames: permittedToolNames(context.authority()),
					authorize: context.authorize,
					latency: beginLatency,
				},
				context.signal,
			);
		},
	);
	const messagesModel = new ConfiguredAutomationMessagesModel(configuration);
	app.addHook("onReady", async () => {
		if (configuration().harness !== "codex" || !codexConfig.image || !broker)
			return;
		let probe: ContainedCodexProcess | undefined;
		try {
			codexReason = await broker.readiness();
			if (codexReason) return;
			probe = new ContainedCodexProcess(codexConfig);
			await probe.start({
				signal: AbortSignal.timeout(15000),
				notification() {},
				async model() {
					throw new Error("Readiness cannot call a model");
				},
				async request() {
					throw new Error("Readiness cannot call tools");
				},
			});
			codexReason = null;
		} catch {
			codexReason = "Contained Codex image or isolation runtime is unavailable";
		} finally {
			await probe?.close();
		}
		if (!codexReason) {
			const sandbox = new DockerSandbox({
				...codexConfig,
			});
			try {
				const signal = AbortSignal.timeout(15_000);
				await sandbox.start({}, signal);
				const result = await sandbox.execute(":", signal);
				engineeringReady = result.exitCode === 0;
			} catch {
				engineeringReady = false;
			} finally {
				await sandbox.stop();
			}
		}
	});
	const runtime = new AutomationRuntime({
		latencyDiagnostics:
			process.env.CYRUS_AUTOMATION_LATENCY_DIAGNOSTICS === "1",
		...(pairedWorkspace &&
			process.env.CYRUS_AUTOMATION_LATENCY_RETENTION === "1" && {
				latencyRetention: {
					directory: join(cyrusHome, "automation-latency-v1"),
					workspaceId: pairedWorkspace,
				},
			}),
		engineering: {
			available: () => configuration().harness === "codex" && engineeringReady,
			sandbox: () => new DockerSandbox(codexConfig),
		},
		workspaceId: () => pairedWorkspace,
		gateway,
		ledger,
		...(pairedWorkspace &&
			!gatewayError && {
				sessions: {
					directory: join(cyrusHome, "automation-session-journal-v1"),
					transport: new HttpSessionDeliveryTransport(origin, () => ({
						workspaceId: process.env.CYRUS_TEAM_ID || "",
						apiKey: process.env.CYRUS_API_KEY || "",
					})),
					secrets: () =>
						[
							process.env.CYRUS_API_KEY,
							process.env.CLOUDFLARE_TOKEN,
							process.env.ANTHROPIC_API_KEY,
							process.env.CLAUDE_CODE_OAUTH_TOKEN,
							process.env.OPENAI_API_KEY,
							process.env.CODEX_API_KEY,
						].filter((v): v is string => !!v),
				},
			}),
		tools: (authority, credential, signal) =>
			new ScopedAutomationMcpClient(origin, authority, credential, signal),
		model: {
			nextAuthorization: "in-flight-v1",
			async next() {
				throw new Error("Configured model requires an admitted session");
			},
			async open(context) {
				if (configuration().harness === "codex") {
					// Opening must stay pure so preparation can join the still-running
					// authority check. Startup verifies login readiness; respond() reads
					// and validates current credentials after authorization on every request.
					if (codexReason || !broker)
						throw new Error("Contained Codex unavailable");
					return codexModel.open(context);
				}
				return {
					nextAuthorization: "in-flight-v1",
					async next(messages, authority, signal) {
						await context.authorize();
						signal.throwIfAborted();
						return messagesModel.next(messages, authority, signal);
					},
				};
			},
		},
		store: new AutomationCheckpointStore(
			join(cyrusHome, "automation-checkpoints-v1"),
		),
		readiness: () => {
			const config = configuration();
			const controlReason =
				(process.env.CYRUS_TEAM_ID !== pairedWorkspace
					? "Workspace pairing changed; restart required"
					: null) ||
				gatewayError ||
				(!process.env.CYRUS_API_KEY ? "Runtime is not paired" : null);
			return {
				harness: config.harness,
				model: config.model,
				controlReason,
				adapter:
					config.harness === "codex" && !codexReason
						? ("codex-app-server-contained-v1" as const)
						: config.harness === "claude"
							? ("anthropic-messages-contained-v1" as const)
							: null,
				reason:
					controlReason ||
					(config.harness === "codex"
						? codexReason ||
							(!/^gpt-[a-zA-Z0-9._-]+$/.test(config.model)
								? "Configure an explicit Codex model ID"
								: null)
						: modelReadiness(config)),
			};
		},
	});
	registerAutomationRoutes(app, runtime, () =>
		process.env.CYRUS_TEAM_ID === pairedWorkspace
			? process.env.CYRUS_API_KEY || ""
			: "",
	);
	app.addHook("onClose", async () => {
		await runtime.stop();
		ledger?.close();
	});
	return runtime;
}
