import { z } from "zod";

export const HarnessKindSchema = z.enum([
	"claude",
	"codex",
	"cursor",
	"gemini",
	"opencode",
]);

export const PermissionModeSchema = z.enum([
	"default",
	"plan",
	"ask",
	"auto",
	"bypass",
]);

export const NetworkEgressModeSchema = z.enum([
	"default",
	"disabled",
	"proxied",
	"unrestricted",
]);

export const RuntimeNetworkEgressConfigSchema = z.object({
	mode: NetworkEgressModeSchema,
	proxyUrl: z.string().optional(),
	allowedHosts: z.array(z.string()).optional(),
	deniedHosts: z.array(z.string()).optional(),
});

export const RuntimeSandboxConfigSchema = z.object({
	provider: z.string().min(1),
	id: z.string().optional(),
	name: z.string().optional(),
	namespace: z.string().optional(),
	workingDirectory: z.string().optional(),
	templateId: z.string().optional(),
	snapshot: z.string().optional(),
	timeoutMs: z.number().int().positive().optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
	volumes: z
		.array(
			z.object({
				name: z.string(),
				mountPath: z.string(),
				source: z.string().optional(),
				kind: z.enum(["bind", "fuse", "provider"]).optional(),
				readOnly: z.boolean().optional(),
				subpath: z.string().optional(),
			}),
		)
		.optional(),
	networkEgress: RuntimeNetworkEgressConfigSchema.optional(),
	destroyWhileInactive: z.boolean().optional(),
});

export const RuntimeHarnessConfigSchema = z.object({
	kind: HarnessKindSchema,
	model: z.string().optional(),
	command: z.string().optional(),
	args: z.array(z.string()).optional(),
});

export const CreateAgentSessionConfigSchema = z.object({
	sessionId: z.string().optional(),
	harness: z.union([HarnessKindSchema, RuntimeHarnessConfigSchema]),
	model: z.string().optional(),
	systemPrompt: z.string().optional(),
	agentSessionsRoot: z.string().optional(),
	env: z.record(z.string(), z.string()).optional(),
	secrets: z
		.record(
			z.string(),
			z.union([
				z.string(),
				z.object({
					value: z.string(),
					redact: z.boolean().optional(),
				}),
			]),
		)
		.optional(),
	packages: z
		.object({
			system: z.array(z.string()).optional(),
			npm: z.array(z.string()).optional(),
			commands: z.array(z.string()).optional(),
		})
		.optional(),
	files: z
		.array(
			z.object({
				path: z.string().min(1),
				content: z.string(),
				sensitive: z.boolean().optional(),
			}),
		)
		.optional(),
	folders: z
		.array(
			z.object({
				source: z.string().min(1),
				mountPath: z.string().min(1),
				access: z.enum(["read", "readwrite"]).optional(),
				exclude: z.array(z.string()).optional(),
			}),
		)
		.optional(),
	repositories: z
		.array(
			z.object({
				source: z.string().min(1),
				mountPath: z.string().min(1),
				branch: z.string().min(1).optional(),
				access: z.enum(["read", "readwrite"]).optional(),
				depth: z.number().int().positive().optional(),
			}),
		)
		.optional(),
	plugins: z
		.array(
			z.union([
				z.object({
					name: z.string().min(1),
					version: z.string().optional(),
					description: z.string().optional(),
					mcpServers: z
						.record(
							z.string(),
							// MCP server entries are forwarded verbatim to the
							// materializer / harness CLI, which interprets the
							// full SDK schema (`type`, `tools`, `alwaysLoad`,
							// etc.). `.passthrough()` keeps the documented
							// fields typed while letting unknown SDK fields
							// flow through without being silently stripped.
							z
								.object({
									type: z.enum(["http", "sse", "stdio"]).optional(),
									command: z.string().optional(),
									args: z.array(z.string()).optional(),
									env: z.record(z.string(), z.string()).optional(),
									url: z.string().optional(),
									httpUrl: z.string().optional(),
									headers: z.record(z.string(), z.string()).optional(),
								})
								.passthrough(),
						)
						.optional(),
					hooks: z
						.array(
							z.object({
								event: z.enum([
									"PreToolUse",
									"PostToolUse",
									"SessionStart",
									"Stop",
									"UserPromptSubmit",
								]),
								command: z.string().min(1),
								matcher: z.string().optional(),
								timeout: z.number().int().positive().optional(),
								failClosed: z.boolean().optional(),
							}),
						)
						.optional(),
					skills: z
						.array(
							z.object({
								name: z.string().min(1),
								description: z.string().min(1),
								content: z.string(),
								disableModelInvocation: z.boolean().optional(),
								assets: z
									.array(
										z.object({
											path: z.string().min(1),
											content: z.string(),
										}),
									)
									.optional(),
							}),
						)
						.optional(),
				}),
				z.object({ rootPath: z.string().min(1) }),
			]),
		)
		.optional(),
	permissions: z
		.object({
			mode: PermissionModeSchema.optional(),
			allowedTools: z.array(z.string()).optional(),
			disallowedTools: z.array(z.string()).optional(),
		})
		.optional(),
	memory: z
		.object({
			enabled: z.boolean().optional(),
			directory: z.string().optional(),
			namespace: z.string().optional(),
		})
		.optional(),
	sandbox: RuntimeSandboxConfigSchema.optional(),
	networkEgress: RuntimeNetworkEgressConfigSchema.optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
	interactiveInput: z.boolean().optional(),
	resumeHarnessSessionId: z.string().min(1).optional(),
});
