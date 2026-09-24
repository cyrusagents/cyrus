import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AutomationAdapters } from "./AutomationAdapters.js";
import { previewSchedule } from "./AutomationScheduler.js";
import type { AutomationService } from "./AutomationService.js";
import { AutomationError, scheduleSchema } from "./types.js";

/** Registered inside the board's local-only scope. */
export function registerAutomationRoutes(
	app: FastifyInstance,
	service: AutomationService,
	adapters: AutomationAdapters,
) {
	app.register(async (scoped) => {
		scoped.setErrorHandler((error, _request, reply) => {
			const status =
				error instanceof AutomationError
					? error.statusCode
					: error instanceof z.ZodError
						? 400
						: 503;
			return reply.code(status).send({
				error:
					error instanceof AutomationError
						? error.message
						: error instanceof z.ZodError
							? "Invalid automation input"
							: "Automation operation failed; check connection and worker logs",
			});
		});
		scoped.addHook("onRequest", async (request, reply) => {
			if (["POST", "PATCH", "DELETE"].includes(request.method)) {
				const origin = `http://${request.headers.host}`;
				if (
					request.headers.origin !== origin ||
					!request.headers["content-type"]?.startsWith("application/json")
				)
					return reply
						.code(403)
						.send({ error: "Same-origin JSON requests required" });
			}
		});
		const root = "/board/api/automations";
		scoped.get(root, async () => service.list());
		scoped.get(`${root}/options`, async () => adapters.options());
		scoped.get(`${root}/linear-options`, async (request) => {
			const query = z
				.object({
					workspaceId: z.string().min(1),
					teamId: z.string().optional(),
				})
				.parse(request.query);
			return adapters.linearOptions(query.workspaceId, query.teamId);
		});
		scoped.post(`${root}/preview`, async (request) => {
			const input = z
				.object({ schedule: scheduleSchema, timezone: z.string() })
				.parse(request.body);
			return { times: previewSchedule(input) };
		});
		scoped.post(root, async (request, reply) =>
			reply.code(201).send(await service.save(request.body)),
		);
		const params = (value: unknown) =>
			z.object({ id: z.string() }).parse(value).id;
		scoped.get(`${root}/:id`, async (request) =>
			service.get(params(request.params)),
		);
		scoped.patch(`${root}/:id`, async (request) => {
			const body = z
				.object({
					revision: z.number().int(),
					enabled: z.boolean().optional(),
					input: z.unknown().optional(),
				})
				.parse(request.body);
			return body.input !== undefined
				? service.save(body.input, params(request.params), body.revision)
				: service.setEnabled(
						params(request.params),
						body.revision,
						z.boolean().parse(body.enabled),
					);
		});
		scoped.delete(`${root}/:id`, async (request) =>
			service.setEnabled(
				params(request.params),
				z.object({ revision: z.number().int() }).parse(request.body).revision,
				false,
				true,
			),
		);
		scoped.post(`${root}/:id/run`, async (request, reply) =>
			reply
				.code(202)
				.send(
					await service.runNow(
						params(request.params),
						z
							.object({ requestId: z.string().min(1).max(128) })
							.parse(request.body).requestId,
					),
				),
		);
		scoped.get(`${root}/:id/runs`, async (request) =>
			service.runs(params(request.params)),
		);
		scoped.post(`${root}/:id/runs/:runId/confirm-ended`, async (request) => {
			const p = z
				.object({ id: z.string(), runId: z.string() })
				.parse(request.params);
			z.object({ confirmedEnded: z.literal(true) }).parse(request.body);
			if (!service.runs(p.id).some((r) => r.id === p.runId))
				throw new AutomationError("Run not found", 404);
			await service.confirmEnded(p.runId);
			return { success: true };
		});
		scoped.post(`${root}/:id/runs/:runId/reconcile`, async (request) => {
			const p = z
				.object({ id: z.string(), runId: z.string() })
				.parse(request.params);
			if (!service.runs(p.id).some((r) => r.id === p.runId))
				throw new AutomationError("Run not found", 404);
			return service.reconcile(p.runId);
		});
	});
}
