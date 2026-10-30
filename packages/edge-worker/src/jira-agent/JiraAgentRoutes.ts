import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
	JiraAgentError,
	type JiraAgentTaskService,
	MAX_TEXT_BYTES,
} from "./JiraAgentTaskService.js";

/**
 * Bridge v2 routes Cyrus Hosted uses to run Jira remote-agent tasks on this
 * runtime. Authenticated with the same `CYRUS_API_KEY` Bearer token as the
 * other Hosted → runtime routes (read on every request so `.env` reloads
 * apply). An empty key disables the routes rather than opening them.
 */

export const JIRA_AGENT_ROUTE_PREFIX = "/api/jira-agent/v1/tasks";
export const JIRA_AGENT_BODY_LIMIT = 256 * 1024;

const uuid = z.string().uuid();
const boundedText = (maxBytes: number) =>
	z
		.string()
		.refine((v) => Buffer.byteLength(v, "utf8") <= maxBytes, "too large");

const BindingSchema = z
	.object({
		teamId: uuid,
		installationLinkId: uuid,
		accountLinkId: uuid,
	})
	.strict();

const AuthorizedIds = z.array(z.string().min(1).max(200)).max(1000);

/** Bridge version; v1 bound one repository to the whole Jira site. */
export const JIRA_AGENT_BRIDGE_VERSION = 2;

const IssueSchema = z
	.object({
		id: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[0-9]+$/),
		key: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[A-Za-z][A-Za-z0-9_]*-[0-9]+$/),
		summary: boundedText(4 * 1024),
		description: boundedText(MAX_TEXT_BYTES),
		labels: z.array(z.string().min(1).max(255)).max(100),
		projectKey: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[A-Za-z][A-Za-z0-9_]*$/),
	})
	.strict()
	.refine((issue) => issue.key.startsWith(`${issue.projectKey}-`), {
		message: "projectKey must prefix key",
	});

const SendSchema = z
	.object({
		version: z.literal(2),
		kind: z.enum(["create", "followup"]),
		taskId: uuid,
		contextId: uuid,
		messageId: z.string().min(1).max(200),
		binding: BindingSchema,
		issue: IssueSchema,
		// Fresh authority for THIS delivery (Hosted-resolved; not identity).
		authorizedRepositoryIds: AuthorizedIds,
		text: boundedText(MAX_TEXT_BYTES).refine((v) => v.trim().length > 0),
	})
	.strict();

const RefSchema = z
	.object({
		version: z.literal(2),
		taskId: uuid,
		contextId: uuid,
		binding: BindingSchema,
		authorizedRepositoryIds: AuthorizedIds.optional(),
	})
	.strict();
// get must say what is authorized now; cancel may omit it (content-free stop).
const GetSchema = RefSchema.required({ authorizedRepositoryIds: true });

function digest(value: string): Buffer {
	return createHash("sha256").update(value, "utf8").digest();
}

export function isAuthorizedBearer(
	header: string | undefined,
	apiKey: string,
): boolean {
	if (!apiKey || !header) return false;
	return timingSafeEqual(digest(header), digest(`Bearer ${apiKey}`));
}

function fail(
	reply: FastifyReply,
	status: number,
	code: string,
	error: string,
) {
	return reply.status(status).send({ success: false, code, error });
}

export function registerJiraAgentRoutes(
	fastify: FastifyInstance,
	service: JiraAgentTaskService,
	getApiKey: () => string,
): void {
	const route = (
		op: "send" | "get" | "cancel",
		handler: (body: unknown) => Promise<unknown>,
	) => {
		fastify.post(
			`${JIRA_AGENT_ROUTE_PREFIX}/${op}`,
			{ bodyLimit: JIRA_AGENT_BODY_LIMIT },
			async (request: FastifyRequest, reply: FastifyReply) => {
				if (!isAuthorizedBearer(request.headers.authorization, getApiKey())) {
					return fail(reply, 401, "unauthorized", "Unauthorized");
				}
				const body = request.body as { version?: unknown } | null;
				if (!body || typeof body !== "object") {
					return fail(reply, 400, "invalid_request", "JSON body required");
				}
				if (body.version !== JIRA_AGENT_BRIDGE_VERSION) {
					return fail(
						reply,
						400,
						"unsupported_version",
						"Unsupported Jira agent bridge version",
					);
				}
				try {
					const data = await handler(body);
					return reply.status(200).send({ success: true, data });
				} catch (error) {
					if (error instanceof z.ZodError) {
						return fail(reply, 400, "invalid_request", "Invalid request body");
					}
					if (error instanceof JiraAgentError) {
						return fail(reply, error.status, error.code, error.message);
					}
					return fail(reply, 500, "internal", "Internal error");
				}
			},
		);
	};

	route("send", (body) => service.send(SendSchema.parse(body)));
	route("get", (body) => service.get(GetSchema.parse(body)));
	route("cancel", (body) => service.cancel(RefSchema.parse(body)));
}

/**
 * Registered instead of the task routes when the journal cannot be loaded at
 * startup. Answers 503 (authenticated) so Cyrus Hosted treats it as a
 * transient runtime fault and keeps tasks fenced, rather than seeing a 404 and
 * telling the user to upgrade cyrus-ai.
 */
export function registerUnavailableJiraAgentRoutes(
	fastify: FastifyInstance,
	getApiKey: () => string,
): void {
	for (const op of ["send", "get", "cancel"] as const) {
		fastify.post(
			`${JIRA_AGENT_ROUTE_PREFIX}/${op}`,
			{ bodyLimit: JIRA_AGENT_BODY_LIMIT },
			async (request: FastifyRequest, reply: FastifyReply) => {
				if (!isAuthorizedBearer(request.headers.authorization, getApiKey())) {
					return fail(reply, 401, "unauthorized", "Unauthorized");
				}
				return fail(
					reply,
					503,
					"journal_unavailable",
					"Jira task state could not be loaded on this Cyrus runtime",
				);
			},
		);
	}
}
