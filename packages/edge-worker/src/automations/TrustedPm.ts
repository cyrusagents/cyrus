import { z } from "zod";
import type { AutomationAuthority } from "./contract.js";
import type { AutomationModel, AutomationModelContext } from "./Model.js";

const id = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[a-zA-Z0-9_.:-]+$/);
export const trustedPmSchema = z
	.object({
		version: z.literal(1),
		pmId: z.string().uuid(),
		submissionId: z.string().uuid(),
		linearWorkspaceId: id,
		repositoryIds: z
			.array(id)
			.min(1)
			.max(100)
			.refine((ids) => new Set(ids).size === ids.length),
	})
	.strict();
export type TrustedPm = z.infer<typeof trustedPmSchema>;
/** Adapter to the existing normal runner factory, never a customer contained model. */
export interface TrustedPmExecutor {
	available(): boolean;
	check(authority: AutomationAuthority): void;
	open(context: AutomationModelContext): Promise<AutomationModel>;
}
export function assertTrustedPmIdentity(authority: AutomationAuthority): void {
	const pm = authority.trustedPm,
		d = authority.definition;
	if (
		!pm ||
		d.execution !== "trusted-pm-v1" ||
		d.id !== pm.pmId ||
		d.namespace !== `pm:${pm.pmId}` ||
		d.scopeRef !== d.namespace ||
		d.role !== "coordinator" ||
		d.grants.length ||
		d.session ||
		d.schedule ||
		authority.customerPolicy ||
		authority.oneWayEngineering ||
		authority.nativeContext ||
		authority.engineering ||
		authority.customerSources ||
		authority.slackMessages
	)
		throw Error("Trusted PM admission identity mismatch");
}
