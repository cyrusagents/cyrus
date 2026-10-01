import { z } from "zod";

const id = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[a-zA-Z0-9_.:-]+$/);
export const nativeContextSchema = z
	.object({
		contractVersion: z.literal(1),
		bindingId: id,
		scopeRef: id,
		permissions: z
			.array(z.enum(["read", "remember", "apply_approved", "work"]))
			.min(1)
			.max(4)
			.refine((p) => p.includes("read") && new Set(p).size === p.length),
	})
	.strict();
export type NativeContext = z.infer<typeof nativeContextSchema>;
export const contextKindSchema = z.enum([
	"confirmed",
	"source",
	"conclusion",
	"hypothesis",
]);
export const workStatusSchema = z.enum([
	"active",
	"waiting",
	"verified",
	"confirmed",
	"closed",
]);
const describedReferences = z
	.array(
		z
			.object({
				reference: z.string().uuid(),
				description: z.string().max(1000),
			})
			.strict(),
	)
	.max(25);
// Includes the retired call shape solely so old checkpoints remain readable.
// permittedToolNames/authorizeTool never expose or execute it.
export const nativeContextCalls = [
	z
		.object({
			name: z.literal("read_context"),
			arguments: z.object({ cursor: z.string().uuid().optional() }).strict(),
		})
		.strict(),
	z
		.object({
			name: z.literal("remember_context"),
			arguments: z
				.object({
					kind: contextKindSchema,
					body: z.string().min(1).max(4000),
					evidence_reference: z
						.string()
						.uuid()
						.optional()
						.describe(
							"Optional current read_context.inputEvidence reference for the operator instruction. Omit for source observations. Never use issue/thread/work references or provider IDs.",
						),
				})
				.strict(),
		})
		.strict(),
	z
		.object({
			name: z.literal("apply_approved_action"),
			arguments: z.object({ reference: z.string().uuid() }).strict(),
		})
		.strict(),
	z
		.object({
			name: z.literal("track_work"),
			arguments: z.union([
				z.object({ objective: z.string().min(1).max(500) }).strict(),
				z
					.object({
						reference: z.string().uuid(),
						objective: z.string().min(1).max(500).optional(),
						status: workStatusSchema.optional(),
						outcome_reference: z.string().uuid().optional(),
					})
					.strict()
					.refine(
						(v) =>
							v.objective !== undefined ||
							v.status !== undefined ||
							v.outcome_reference !== undefined,
					),
			]),
		})
		.strict(),
] as const;
export const nativeContextPageSchema = z
	.object({
		bindingId: id,
		scopeRef: id,
		snapshotRevision: id,
		entries: z
			.array(
				z
					.object({
						kind: contextKindSchema,
						body: z.string().max(4000),
						provenance: z.string().max(1000),
						evidence_reference: z.string().uuid().optional(),
					})
					.strict(),
			)
			.max(25),
		inputEvidence: describedReferences.optional(),
		work: z
			.array(
				z
					.object({
						reference: z.string().uuid(),
						objective: z.string().min(1).max(500),
						status: workStatusSchema,
					})
					.strict(),
			)
			.max(25)
			.optional(),
		outcomes: describedReferences.optional(),
		nextCursor: z.string().uuid().nullable(),
		approvedActions: z
			.array(
				z
					.object({
						reference: z.string().uuid(),
						description: z.string().max(1000),
					})
					.strict(),
			)
			.max(25)
			.optional(),
	})
	.strict();
export const nativeContextReceiptSchema = z
	.object({
		bindingId: id,
		scopeRef: id,
		status: z.enum(["applied", "pending", "denied"]),
		receiptId: id,
	})
	.strict();
export function isNativeContextTool(name: string): boolean {
	return nativeContextCalls.some((schema) => schema.shape.name.value === name);
}
/** Provider identities are deliberately not part of this native capability. */
export function nativeContextTools(
	context: NativeContext | undefined,
): string[] {
	if (!context) return [];
	const names = ["read_context"];
	if (context.permissions.includes("remember")) names.push("remember_context");
	// Legacy approval metadata is parsed only for checkpoint/receipt compatibility.
	// No model or recovered executable step receives the retired tool.
	if (context.permissions.includes("work")) names.push("track_work");
	return names;
}
export function nativeContextResult(
	context: NativeContext,
	name: string,
	raw: unknown,
) {
	if (Buffer.byteLength(JSON.stringify(raw)) > 150_000)
		throw new Error("Native context response exceeds bound");
	const parsed =
		name === "read_context"
			? nativeContextPageSchema.parse(raw)
			: nativeContextReceiptSchema.parse(raw);
	if (
		parsed.bindingId !== context.bindingId ||
		parsed.scopeRef !== context.scopeRef
	)
		throw new Error("Foreign native context response");
	if ("entries" in parsed)
		return {
			items: [
				{
					text: JSON.stringify({
						snapshotRevision: parsed.snapshotRevision,
						...(parsed.inputEvidence
							? { inputEvidence: parsed.inputEvidence }
							: {}),
						...(parsed.work ? { work: parsed.work } : {}),
						...(parsed.outcomes ? { outcomes: parsed.outcomes } : {}),
					}),
				},
				...parsed.entries.map((entry) => ({ text: JSON.stringify(entry) })),
			],
			nextCursor: parsed.nextCursor,
		};
	return {
		items: [{ text: JSON.stringify({ status: parsed.status }) }],
		nextCursor: null,
	};
}

export const nativeContextReceiptHintSchema = z
	.object({
		name: z.enum(["remember_context", "apply_approved_action", "track_work"]),
		status: z.enum(["applied", "pending", "denied"]),
	})
	.strict();

/** Only a positive, operation-bound no-effect receipt can resolve a rejected write. */
export function nativeContextRejection(
	name: string,
	key: string,
	raw: unknown,
) {
	if (name !== "remember_context" && name !== "track_work")
		throw new Error("Unsupported tool rejection");
	if (raw === undefined || Buffer.byteLength(JSON.stringify(raw)) > 1024)
		throw new Error("Invalid tool rejection");
	const rejection = z
		.object({
			contractVersion: z.literal(1),
			kind: z.literal("tool_rejection"),
			code: z.enum([
				"invalid_reference",
				"invalid_arguments",
				"proof_required",
			]),
			effect: z.literal("none"),
			operationKey: z.string().min(1).max(256),
		})
		.strict()
		.parse(raw);
	if (rejection.operationKey !== key) throw new Error("Foreign tool rejection");
	const guidance = {
		invalid_reference:
			"No change was made. Read current context and use the reference type required by this tool. For source memory omit evidence_reference; issue/thread references are not input evidence. Correct the arguments before trying again.",
		invalid_arguments:
			"No change was made. Correct the arguments to match the declared tool schema before trying again.",
		proof_required:
			"No change was made. A terminal work status needs a current matching outcome reference; otherwise retain a nonterminal status.",
	};
	return {
		items: [
			{
				text: JSON.stringify({
					status: "denied",
					code: rejection.code,
					message: guidance[rejection.code],
				}),
			},
		],
		nextCursor: null,
	};
}
