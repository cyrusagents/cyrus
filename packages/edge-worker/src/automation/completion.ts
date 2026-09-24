import { z } from "zod";
import type { RunUpdate } from "./types.js";

export const AUTOMATION_COMPLETION_INSTRUCTIONS = `This scheduled development run must include implementation, verification, and a pull request when changes are needed. Do not treat an intermediate step as task completion.
At the end of your final response, include a hidden completion record:
<!-- miko-automation-result {"outcome":"succeeded","reason":"Completed and verified","prUrls":["https://github.com/owner/repo/pull/123"]} -->
Use outcome "no_change" with a specific reason and an empty prUrls array when no changes are necessary; "awaiting_input" when clarification is required; or "failed" when blocked or unsuccessful. Only report "succeeded" after verification and PR creation. Never invent a PR URL.`;

const schema = z.object({
	outcome: z.enum(["succeeded", "no_change", "awaiting_input", "failed"]),
	reason: z.string().trim().min(1).max(10000),
	prUrls: z
		.array(
			z
				.string()
				.url()
				.refine((url) =>
					/^https:\/\/[^\s/]+\/[^\s]*\/(?:pull|merge_requests)\/\d+\/?$/.test(
						url,
					),
				),
		)
		.max(20),
});
export function automationCompletion(body: string): RunUpdate {
	const match = /<!--\s*miko-automation-result\s+(\{[\s\S]*?\})\s*-->/.exec(
		body,
	);
	try {
		const result = schema.parse(JSON.parse(match?.[1] ?? ""));
		if (result.outcome === "succeeded" && result.prUrls.length === 0)
			throw new Error("Missing PR");
		return {
			status: result.outcome === "no_change" ? "succeeded" : result.outcome,
			message: body.replace(match![0], "").trim() || result.reason,
			prUrls: result.prUrls,
		};
	} catch {
		return {
			status: "uncertain",
			message: `The agent ended without a valid final development outcome. Review its activity before clearing this run.\n\n${body}`,
		};
	}
}
