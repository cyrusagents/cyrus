import { createHash } from "node:crypto";
import { z } from "zod";
import {
	cyrusSessionDescriptorSchema,
	SESSION_DELIVERY_PATH,
} from "../sinks/session-delivery.js";
import {
	type EngineeringEnvelope,
	engineeringEnvelopeSchema,
} from "./Engineering.js";

export const AUTOMATION_VERSION = 1 as const;
const id = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[a-zA-Z0-9_.:-]+$/);
const instant = z.iso.datetime();
export const resourceSchema = z.union([
	z
		.object({ provider: z.literal("slack"), channelId: id, threadTs: id })
		.strict(),
	z.object({ provider: z.literal("linear"), teamId: id, issueId: id }).strict(),
	z
		.object({ provider: z.literal("linear"), customerId: z.string().uuid() })
		.strict(),
]);
export const grantSchema = z
	.object({
		id,
		connectionId: id,
		accountId: id,
		resource: resourceSchema,
		permissions: z
			.array(z.enum(["read", "write", "delegate"]))
			.min(1)
			.max(3),
	})
	.strict();
export const scheduleSchema = z
	.object({
		intervalSeconds: z.number().int().min(60).max(31_536_000),
		anchorAt: instant,
		timezone: z
			.string()
			.max(100)
			.refine((zone) => {
				try {
					new Intl.DateTimeFormat("en", { timeZone: zone });
					return true;
				} catch {
					return false;
				}
			}),
	})
	.strict();
export const definitionSchema = z
	.object({
		id,
		workspaceId: id,
		ownerId: id,
		namespace: id,
		scopeRef: id,
		revision: z.number().int().positive(),
		state: z.enum(["enabled", "paused", "deleted"]),
		role: z.enum(["coordinator", "investigator", "engineering"]),
		instruction: z.string().min(1).max(100_000),
		schedule: scheduleSchema.nullable(),
		target: z
			.object({
				harness: z.string().min(1).max(100),
				model: z.string().min(1).max(200),
			})
			.strict(),
		grants: z.array(grantSchema).max(1),
		session: cyrusSessionDescriptorSchema.optional(),
	})
	.strict();
export type AutomationDefinition = z.infer<typeof definitionSchema>;
export const registrationSchema = definitionSchema.omit({ grants: true });
export type AutomationRegistration = z.infer<typeof registrationSchema>;
export type ResourceGrant = z.infer<typeof grantSchema>;

export const authoritySchema = z
	.object({
		contractVersion: z.literal(AUTOMATION_VERSION),
		definition: definitionSchema,
		occurrenceId: id,
		attemptId: id,
		fence: z.number().int().positive(),
		leaseUntil: instant,
		phase: z.enum(["execute", "reconcile"]),
		input: z.string().max(100_000),
	})
	.strict();
// Internal execution view; the wire puts engineering beside authority, never inside it.
export type AutomationAuthority = z.infer<typeof authoritySchema> & {
	engineering?: EngineeringEnvelope;
};
export const mcpCredentialSchema = z
	.object({
		token: z.string().min(32).max(8192),
		audience: z.literal("/mcp"),
		expiresAt: instant,
		grantId: id,
		sessionRenewal: z.literal(true).optional(),
		sessionId: z.string().uuid().optional(),
	})
	.strict()
	.refine(
		(value) => !value.sessionId || value.sessionRenewal === true,
		"Session continuation requires negotiation",
	);
export const admissionSchema = z
	.object({
		authority: authoritySchema,
		ownerInterruption: z.literal(true).optional(),
		sessionExecutionTiming: z.literal(true).optional(),
		engineering: engineeringEnvelopeSchema.optional(),
		mcp: mcpCredentialSchema,
		sessionDelivery: z
			.object({
				contractVersion: z.literal(1),
				path: z.literal(SESSION_DELIVERY_PATH),
				session: cyrusSessionDescriptorSchema,
			})
			.strict()
			.optional(),
	})
	.strict();
export type AutomationAdmission = z.infer<typeof admissionSchema>;
export function executionAuthority(
	admission: AutomationAdmission,
): AutomationAuthority {
	return {
		...admission.authority,
		...(admission.engineering && { engineering: admission.engineering }),
	};
}
export type McpCredential = z.infer<typeof mcpCredentialSchema>;
export const toolCallSchema = z.discriminatedUnion("name", [
	z
		.object({
			name: z.literal("list_issues"),
			arguments: z.object({}).strict(),
		})
		.strict(),
	z
		.object({
			name: z.literal("execute"),
			arguments: z.object({ command: z.string().min(1).max(20_000) }).strict(),
		})
		.strict(),
	z
		.object({
			name: z.literal("publish_artifact"),
			arguments: z
				.object({
					title: z.string().min(1).max(200),
					summary: z.string().min(1).max(100_000),
				})
				.strict(),
		})
		.strict(),
	z
		.object({
			name: z.literal("delegate_investigation"),
			arguments: z
				.object({
					instruction: z.string().min(1).max(10_000),
					tracking: z.enum(["direct", "assigned_ticket"]),
					reference: z.string().uuid().optional(),
				})
				.strict(),
		})
		.strict(),
	z
		.object({
			name: z.literal("read_messages"),
			arguments: z
				.object({
					limit: z.number().int().min(1).max(100).optional(),
					cursor: z.string().min(1).max(2000).optional(),
				})
				.strict(),
		})
		.strict(),
	z
		.object({
			name: z.literal("reply"),
			arguments: z.object({ text: z.string().min(1).max(10_000) }).strict(),
		})
		.strict(),
	z
		.object({
			name: z.literal("get_issue"),
			arguments: z.union([
				z.object({}).strict(),
				z.object({ reference: z.string().uuid() }).strict(),
			]),
		})
		.strict(),
	z
		.object({
			name: z.literal("add_comment"),
			arguments: z.object({ text: z.string().min(1).max(10_000) }).strict(),
		})
		.strict(),
]);
export type AutomationToolCall = z.infer<typeof toolCallSchema>;
export const modelStepSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("tool"), call: toolCallSchema }).strict(),
	z
		.object({ type: z.literal("result"), text: z.string().min(1).max(100_000) })
		.strict(),
]);
export type AutomationStep = z.infer<typeof modelStepSchema>;
export const toolResultSchema = z
	.object({
		items: z
			.array(
				z
					.object({
						grantId: id,
						connectionId: id,
						accountId: id,
						resource: resourceSchema,
						text: z.string().max(100_000),
					})
					.strict(),
			)
			.max(100),
		nextCursor: z.string().max(2000).nullable(),
		receiptId: id.optional(),
	})
	.strict();

/** Canonical hashes bind immutable payloads, never object insertion order. */
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
export function digest(value: unknown): string {
	return createHash("sha256").update(canonical(value)).digest("hex");
}
export function checkpointKey(authority: AutomationAuthority): string {
	return digest({
		definition: authority.definition,
		occurrenceId: authority.occurrenceId,
		input: authority.input,
		...(authority.engineering && { engineering: authority.engineering }),
	});
}
export function identity(authority: AutomationAuthority) {
	return {
		automationId: authority.definition.id,
		revision: authority.definition.revision,
		occurrenceId: authority.occurrenceId,
		attemptId: authority.attemptId,
		fence: authority.fence,
	};
}

export function isCustomerReadSet(authority: AutomationAuthority): boolean {
	const resource = authority.definition.grants[0]?.resource;
	return resource?.provider === "linear" && "customerId" in resource;
}

export function permittedToolNames(authority: AutomationAuthority): string[] {
	if (authority.definition.role === "engineering")
		return authority.engineering && authority.definition.grants.length === 0
			? ["execute", "publish_artifact"]
			: [];
	const grant = authority.definition.grants[0];
	if (!grant) return [];
	const names: string[] = [];
	if (isCustomerReadSet(authority) && grant.permissions.includes("read"))
		names.push("list_issues");
	if (grant.permissions.includes("read"))
		names.push(
			grant.resource.provider === "slack" ? "read_messages" : "get_issue",
		);
	if (
		!isCustomerReadSet(authority) &&
		grant.permissions.includes("write") &&
		authority.definition.role === "coordinator"
	)
		names.push(grant.resource.provider === "slack" ? "reply" : "add_comment");
	if (
		authority.definition.role === "coordinator" &&
		grant.permissions.includes("read") &&
		grant.permissions.includes("delegate")
	)
		names.push("delegate_investigation");
	return names;
}
/** Model schemas select only opaque references within an authenticated read set. */
export function scopedToolSchemas(authority: AutomationAuthority) {
	const names = permittedToolNames(authority);
	const readSet = isCustomerReadSet(authority);
	return toolCallSchema.options
		.filter((schema) => names.includes(schema.shape.name.value))
		.map((schema) => {
			if (schema.shape.name.value === "get_issue")
				return z
					.object({
						name: z.literal("get_issue"),
						arguments: readSet
							? z.object({ reference: z.string().uuid() }).strict()
							: z.object({}).strict(),
					})
					.strict();
			if (schema.shape.name.value === "delegate_investigation") {
				const args = z
					.object({
						instruction: z.string().min(1).max(10_000),
						tracking: z.enum(["direct", "assigned_ticket"]),
					})
					.strict();
				return z
					.object({
						name: z.literal("delegate_investigation"),
						arguments: readSet
							? args.extend({ reference: z.string().uuid() }).strict()
							: args,
					})
					.strict();
			}
			return schema;
		});
}
/** Arguments carry no authority IDs; read-set references only narrow server-issued scope. */
export function authorizeTool(
	authority: AutomationAuthority,
	raw: unknown,
): ResourceGrant | undefined {
	const call = toolCallSchema.parse(raw);
	const schema = scopedToolSchemas(authority).find(
		(s) => s.shape.name.value === call.name,
	);
	if (!schema) throw new Error("Automation tool denied");
	schema.parse(call);
	if (
		authority.definition.role === "engineering" &&
		permittedToolNames(authority).includes(call.name)
	)
		return undefined;
	const grant = authority.definition.grants[0];
	if (!grant || !permittedToolNames(authority).includes(call.name)) {
		throw new Error("Automation tool denied");
	}
	return grant;
}
export function scopedToolResult(
	authority: AutomationAuthority,
	call: AutomationToolCall,
	raw: unknown,
) {
	const grant = authorizeTool(authority, call);
	if (!grant) throw new Error("Customer tool result requires a resource grant");
	const result = toolResultSchema.parse(raw);
	if (
		result.items.some(
			(item) =>
				item.grantId !== grant.id ||
				item.connectionId !== grant.connectionId ||
				item.accountId !== grant.accountId ||
				canonical(item.resource) !== canonical(grant.resource),
		)
	) {
		throw new Error("Unscoped automation tool result");
	}
	return {
		items: result.items.map((item) => ({ text: item.text })),
		nextCursor: result.nextCursor,
	};
}
