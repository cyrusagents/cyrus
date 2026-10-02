import { z } from "zod";

/** Matches the reviewed Hosted handoff; no customer provenance crosses this wire. */
export const engineeringPathSchema = z
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
				.every(
					(part) =>
						part !== ".." &&
						part !== "." &&
						part !== "" &&
						!part.startsWith(".env") &&
						![".git", ".ssh", ".aws", ".npmrc", ".netrc"].includes(part),
				),
		"Unsafe or credential-bearing repository path",
	);
export const engineeringFilesSchema = z
	.record(engineeringPathSchema, z.string().max(800_000))
	.refine(
		(files) =>
			Object.keys(files).length <= 1000 &&
			Buffer.byteLength(JSON.stringify(files), "utf8") <= 800_000,
		"Engineering artifact exceeds 800KB",
	);
export const engineeringEnvelopeSchema = z
	.object({
		assignmentId: z.string().uuid(),
		repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
		baseSha: z.string().regex(/^[a-f0-9]{40}$/),
		headBranch: z.string().min(1).max(200),
		reviewId: z.string().uuid(),
		generation: z.number().int().positive().safe(),
		revision: z.number().int().positive().safe(),
		operations: z.tuple([z.literal("execute"), z.literal("publish")]),
		environment: z.literal("isolated"),
		deployment: z.literal("deny"),
		technicalBrief: z.string().min(1).max(20_000),
		syntheticReproduction: z.string().min(1).max(20_000),
		allowedPaths: z.array(engineeringPathSchema).min(1).max(500),
		files: engineeringFilesSchema,
	})
	.strict()
	.refine(
		(value) =>
			new Set(value.allowedPaths).size === value.allowedPaths.length &&
			Object.keys(value.files).every((path) =>
				value.allowedPaths.includes(path),
			),
		"Handoff files must belong to the reviewed path allowlist",
	);
export type EngineeringEnvelope = z.infer<typeof engineeringEnvelopeSchema>;

/** Hosted publication action receipt, frozen in owner ACK 2d7841a9. */
export const engineeringPublicationResultSchema = z.discriminatedUnion(
	"status",
	[
		z
			.object({
				assignmentId: z.string().uuid(),
				status: z.literal("published"),
				receiptId: z.string().uuid(),
				publication: z
					.object({
						repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
						number: z.number().int().positive().safe(),
						url: z.string().max(2000),
						headSha: z.string().regex(/^[a-f0-9]{40}$/),
					})
					.strict(),
			})
			.strict(),
		z
			.object({
				assignmentId: z.string().uuid(),
				status: z.literal("uncertain"),
				receiptId: z.string().uuid(),
			})
			.strict(),
	],
);

export function engineeringPublicationResult(
	engineering: EngineeringEnvelope,
	raw: unknown,
) {
	const result = engineeringPublicationResultSchema.parse(raw);
	if (result.assignmentId !== engineering.assignmentId)
		throw new Error("Foreign engineering publication receipt");
	if (result.status === "uncertain")
		throw new Error("Engineering publication requires reconciliation");
	const publication = result.publication;
	if (
		publication.repository !== engineering.repository ||
		publication.url !==
			`https://github.com/${engineering.repository}/pull/${publication.number}`
	)
		throw new Error("Engineering publication repository mismatch");
	return {
		items: [
			{
				text: JSON.stringify({
					status: result.status,
					receiptId: result.receiptId,
					publication,
				}),
			},
		],
		nextCursor: null,
	};
}

/** Account for JSON escaping as well as raw output size before checkpointing. */
export function engineeringDiagnostics(result: {
	exitCode: number;
	stdout: string;
	stderr: string;
}) {
	const bounded = {
		...result,
		stdout: result.stdout.slice(0, 40_000),
		stderr: result.stderr.slice(0, 40_000),
		truncated: result.stdout.length > 40_000 || result.stderr.length > 40_000,
	};
	let text = JSON.stringify(bounded);
	while (text.length > 90_000) {
		bounded.stdout = bounded.stdout.slice(
			0,
			Math.floor(bounded.stdout.length / 2),
		);
		bounded.stderr = bounded.stderr.slice(
			0,
			Math.floor(bounded.stderr.length / 2),
		);
		bounded.truncated = true;
		text = JSON.stringify(bounded);
	}
	return { items: [{ text }], nextCursor: null };
}

export function publicationFiles(
	engineering: EngineeringEnvelope,
	files: unknown,
) {
	const parsed = engineeringFilesSchema.parse(files);
	if (
		Object.keys(parsed).some((path) => !engineering.allowedPaths.includes(path))
	)
		throw new Error("Engineering publication exceeds reviewed paths");
	return parsed;
}

/** Supervisor-only metadata; neither field is part of model-visible arguments. */
export function publicationMetadata(
	engineering: EngineeringEnvelope,
	idempotencyKey: string,
	files: unknown,
) {
	return {
		idempotencyKey: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.parse(idempotencyKey),
		engineeringFiles: publicationFiles(engineering, files),
	};
}
