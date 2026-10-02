import { z } from "zod";
import { registrationSchema } from "./contract.js";

/** Supervisor command only. It cannot replace input, scope, model, or checkpoint identity. */
export const recoveryRequestSchema = z
	.object({
		contractVersion: z.literal(1),
		workspaceId: registrationSchema.shape.workspaceId,
		automationId: registrationSchema.shape.id,
		revision: z.number().int().positive(),
		occurrenceId: z.string().regex(/^[a-f0-9]{64}$/),
		commandId: z.string().uuid(),
		expectedFence: z.number().int().positive(),
	})
	.strict();
export const recoveryReceiptSchema = recoveryRequestSchema
	.extend({
		cycle: z.number().int().positive(),
		maxAttempts: z.literal(3),
		status: z.literal("accepted"),
		acceptedAt: z.iso.datetime(),
	})
	.strict();
export type AutomationRecoveryRequest = z.infer<typeof recoveryRequestSchema>;
export type AutomationRecoveryReceipt = z.infer<typeof recoveryReceiptSchema>;
