import { z } from "zod";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const scheduleSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("once"), at: z.iso.datetime() }),
	z.object({ kind: z.literal("daily"), time }),
	z.object({
		kind: z.literal("weekly"),
		time,
		days: z.array(z.number().int().min(0).max(6)).min(1),
	}),
	z.object({ kind: z.literal("cron"), expression: z.string().max(200) }),
]);
export const targetSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("direct_repository") }),
	z.object({
		kind: z.literal("linear_issue"),
		workspaceId: z.string().min(1),
		teamId: z.string().min(1),
		projectId: z.string().min(1).optional(),
	}),
]);
export const automationInputSchema = z.object({
	name: z.string().trim().min(1).max(200),
	instructions: z.string().trim().min(1).max(50000),
	repositoryId: z.string().min(1),
	timezone: z.string().min(1).max(100),
	schedule: scheduleSchema,
	target: targetSchema,
	enabled: z.boolean(),
});
export const definitionSchema = automationInputSchema.extend({
	id: z.string(),
	revision: z.number().int().positive(),
	createdAt: z.number(),
	updatedAt: z.number(),
	archived: z.boolean(),
	nextRunAt: z.number().nullable(),
	scheduleState: z.enum([
		"scheduled",
		"paused",
		"finished",
		"missed",
		"archived",
	]),
});
export const runSchema = z.object({
	id: z.string(),
	automationId: z.string(),
	key: z.string(),
	trigger: z.enum(["scheduled", "manual"]),
	scheduledAt: z.number(),
	createdAt: z.number(),
	updatedAt: z.number(),
	startedAt: z.number().optional(),
	status: z.enum([
		"dispatching",
		"waiting_session",
		"running",
		"awaiting_input",
		"succeeded",
		"failed",
		"skipped",
		"uncertain",
	]),
	snapshot: definitionSchema,
	issueId: z.string().optional(),
	issueUrl: z.string().optional(),
	sessionId: z.string().optional(),
	executionClaimedAt: z.number().optional(),
	prUrls: z.array(z.string()).default([]),
	message: z.string().default(""),
	attempts: z.number().int().default(0),
});
export type AutomationInput = z.infer<typeof automationInputSchema>;
export type AutomationDefinition = z.infer<typeof definitionSchema>;
export type AutomationTarget = z.infer<typeof targetSchema>;
export type AutomationRun = z.infer<typeof runSchema>;
export type RunUpdate = Partial<
	Pick<
		AutomationRun,
		| "status"
		| "message"
		| "issueUrl"
		| "sessionId"
		| "prUrls"
		| "executionClaimedAt"
	>
>;
export interface AutomationAdapter {
	validate(input: AutomationInput): Promise<void>;
	dispatch(run: AutomationRun): Promise<RunUpdate>;
	reconcile(run: AutomationRun): Promise<RunUpdate>;
}
export interface RepositoryTaskRequest {
	id: string;
	title: string;
	instructions: string;
	repositoryId: string;
	source: "automation" | "linear";
	issueContext?: { issueId: string; workspaceId: string };
}
export const activeRun = (run: AutomationRun) =>
	!["succeeded", "failed", "skipped"].includes(run.status);
export class AutomationError extends Error {
	constructor(
		message: string,
		public statusCode = 400,
	) {
		super(message);
	}
}
