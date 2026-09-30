import { z } from "zod";

const phaseSchema = z.enum([
	"admission",
	"authorize",
	"execute",
	"mcp",
	"progress",
	"result",
]);
const sectionSchema = z.enum([
	"authority",
	"mcp",
	"sessionDelivery",
	"engineering",
	"response",
]);
export const diagnosticSchema = z
	.object({
		phase: phaseSchema,
		code: z.enum([
			"http_denied",
			"transport_failed",
			"response_invalid",
			"admission_invalid",
			"identity_mismatch",
			"credential_invalid",
			"authority_unavailable",
			"session_mismatch",
			"mcp_initialization",
			"mcp_authorization",
			"mcp_operation",
			"execution_interrupted",
		]),
		httpStatus: z.number().int().min(100).max(599).optional(),
		authorizePhase: z.enum(["admit", "renew"]).optional(),
		sections: z.array(sectionSchema).max(5).optional(),
	})
	.strict();
export const failureSchema = diagnosticSchema
	.extend({ at: z.iso.datetime() })
	.strict();
export const failureHistoryEntrySchema = failureSchema
	.extend({
		attempt: z.number().int().positive().safe(),
		fence: z.number().int().positive().safe(),
	})
	.strict();
export const FAILURE_HISTORY_LIMIT = 16;
export type AutomationDiagnostic = z.infer<typeof diagnosticSchema>;

/** Only enumerated metadata crosses into durable state; never raw error text/cause/body. */
export class AutomationDiagnosticError extends Error {
	readonly diagnostic: AutomationDiagnostic;
	constructor(
		diagnostic: AutomationDiagnostic,
		message: string = diagnostic.code,
	) {
		super(message);
		this.diagnostic = diagnosticSchema.parse(diagnostic);
	}
}
const known: Record<string, AutomationDiagnostic["code"]> = {
	"Admission identity mismatch": "identity_mismatch",
	"Admitted checkpoint scope changed": "identity_mismatch",
	"Receipt checkpoint identity changed": "identity_mismatch",
	"Invalid scoped credential deadline": "credential_invalid",
	"Automation authority unavailable": "authority_unavailable",
	"Automation authority changed": "identity_mismatch",
	"Session delivery admission mismatch": "session_mismatch",
	"Child assignment scope mismatch": "session_mismatch",
	"Child session delivery is required": "session_mismatch",
	"Delegation requires coordinator authority and durable session delivery":
		"session_mismatch",
	"Engineering assignment admission mismatch": "identity_mismatch",
	"Scoped MCP initialization denied": "mcp_initialization",
	"Scoped MCP authority unavailable": "mcp_authorization",
	"Scoped MCP operation interrupted": "mcp_operation",
};
export function safeDiagnostic(
	error: unknown,
	phase: AutomationDiagnostic["phase"],
): AutomationDiagnostic {
	if (error instanceof AutomationDiagnosticError)
		return diagnosticSchema.parse(error.diagnostic);
	if (phase === "admission" && error instanceof z.ZodError) {
		const sections = [
			...new Set(
				error.issues.map((issue) => {
					const section = sectionSchema.safeParse(issue.path[0]);
					return section.success ? section.data : ("response" as const);
				}),
			),
		];
		return { phase, code: "admission_invalid", sections };
	}
	const code =
		error instanceof Error && Object.hasOwn(known, error.message)
			? known[error.message]
			: undefined;
	return {
		phase,
		code:
			code ??
			(phase === "admission" ? "admission_invalid" : "execution_interrupted"),
	};
}
