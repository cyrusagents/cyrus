import { z } from "zod";

/** Server-authenticated policy; never inferred from customer text or a provider ID. */
export const customerPolicySchema = z
	.object({
		version: z.literal(1),
		epoch: z.string().uuid(),
		linearDisclosure: z.literal("email-origin-v1"),
	})
	.strict();
export type CustomerPolicy = z.infer<typeof customerPolicySchema>;
const summarySchema = z
	.object({
		identifier: z.string().min(1).max(300),
		status: z.string().min(1).max(300),
	})
	.strict();
export const customerIssueListSchema = z
	.object({
		issues: z
			.array(summarySchema.extend({ reference: z.string().uuid() }).strict())
			.max(100),
	})
	.strict();
export const customerIssueSchema = z.discriminatedUnion("disclosure", [
	z
		.object({
			disclosure: z.literal("identifier_status"),
			issue: summarySchema,
		})
		.strict(),
	z
		.object({
			disclosure: z.literal("verified_customer_email"),
			issue: summarySchema
				.extend({
					title: z.string().max(100_000),
					description: z.string().max(100_000).nullable(),
				})
				.strict(),
		})
		.strict(),
]);
export const engineeringSubmissionCallSchema = z
	.object({
		name: z.literal("submit_engineering_request"),
		arguments: z
			.object({
				request: z.string().min(1).max(10_000),
				reference: z.string().uuid().optional(),
			})
			.strict(),
	})
	.strict();
export const engineeringSubmissionReceiptSchema = z
	.object({
		submissionId: z.string().uuid(),
		status: z.literal("accepted"),
	})
	.strict();

/** No titles/content/association counts can slip through a restricted projection. */
export function customerLinearResult(
	name: "list_issues" | "get_issue",
	text: string,
) {
	const raw: unknown = JSON.parse(text);
	return name === "list_issues"
		? customerIssueListSchema.parse(raw)
		: customerIssueSchema.parse(raw);
}

/** Do not rewrite or resume an older disclosure transcript, even without pending tools. */
export function assertCustomerPolicyRecovery(
	previous: CustomerPolicy | undefined,
	current: CustomerPolicy | undefined,
	terminal: boolean,
): void {
	if (terminal) return; // Immutable private receipt recovery never opens a model.
	if (
		previous?.epoch !== current?.epoch ||
		previous?.linearDisclosure !== current?.linearDisclosure
	)
		throw new Error(
			"Customer disclosure changed; a fresh admitted occurrence is required",
		);
}
