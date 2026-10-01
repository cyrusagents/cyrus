import { z } from "zod";
import { readBoundedJson } from "../customer-runtime/Gateway.js";
import type {
	AutomationCheckpoint,
	AutomationMessage,
} from "./CheckpointStore.js";
import {
	type AutomationAuthority,
	type AutomationStep,
	modelStepSchema,
	permittedToolNames,
	scopedToolDescription,
	scopedToolSchemas,
} from "./contract.js";

export interface AutomationModelContext {
	state: AutomationCheckpoint;
	authority: () => AutomationAuthority;
	authorize: () => Promise<void>;
	save: () => Promise<void>;
	nativeIdentity: (id: string) => Promise<void>;
	signal: AbortSignal;
}
export interface AutomationModel {
	/** Pure open; next awaits context.authorize before effects or replay output.
	 * Allows the loop and adapter to join only an in-flight authority check.
	 * No completed check/permission result is reusable through this contract.
	 */
	readonly nextAuthorization?: "in-flight-v1";
	open?(context: AutomationModelContext): Promise<AutomationModel>;
	close?(): Promise<void>;
	next(
		messages: AutomationMessage[],
		authority: AutomationAuthority,
		signal: AbortSignal,
	): Promise<AutomationStep>;
}
export interface ConfiguredAutomationModel {
	harness: string;
	model: string;
	apiKey?: string;
	oauthToken?: string;
}
export function modelReadiness(
	config: ConfiguredAutomationModel,
): string | null {
	if (config.harness !== "claude")
		return "Configured harness has no contained automation adapter";
	if (config.oauthToken)
		return "Claude Code OAuth is not supported by the contained Messages adapter";
	if (!config.apiKey)
		return "Configured runtime has no Anthropic API connection";
	if (!/^claude-[a-zA-Z0-9._-]+$/.test(config.model))
		return "Configure an explicit Anthropic model ID; CLI aliases are unsupported";
	return null;
}

/** Reuses only the configured runtime API connection, without native tools or CLI state. */
export class ConfiguredAutomationMessagesModel implements AutomationModel {
	constructor(
		private readonly configuration: () => ConfiguredAutomationModel,
	) {}
	async next(
		messages: AutomationMessage[],
		authority: AutomationAuthority,
		signal: AbortSignal,
	): Promise<AutomationStep> {
		const config = this.configuration();
		if (
			modelReadiness(config) ||
			authority.definition.target.harness !== config.harness ||
			authority.definition.target.model !== config.model
		) {
			throw new Error(
				"Configured model is incompatible with automation authority",
			);
		}
		const permitted = permittedToolNames(authority);
		const schemas = scopedToolSchemas(authority).map((schema) =>
			z.toJSONSchema(schema),
		);
		const response = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			redirect: "error",
			signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
			headers: {
				"Content-Type": "application/json",
				"x-api-key": config.apiKey!,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: config.model,
				max_tokens: 4096,
				messages,
				system: `Execute the assigned automation. Return only JSON: {"type":"result","text":"findings"} or {"type":"tool","call":...}. Tools follow the scoped MCP call schema ${JSON.stringify(schemas.length ? { oneOf: schemas } : false)}. Available names: ${JSON.stringify(permitted)}. Tool descriptions: ${JSON.stringify(Object.fromEntries(permitted.map((name) => [name, scopedToolDescription(authority, name)])))}. Only these admitted sources and tools are available. If access is unavailable, report that limitation; never suggest credential, filesystem or alternate connector access. The connection is bound to authenticated resources. If list_issues is available, obtain session references with it before get_issue; only references issued by that connection may be used. Re-list after reconnect or reference expiry. Role: ${authority.definition.role}. The server enforces write approval and exact payload. Delegation tracking only links a server-admitted child to the already-bound ticket or creates a direct child; it does not create or assign a provider ticket. Report limitations honestly.`,
			}),
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`Automation model failed (${response.status})`);
		}
		const body = z
			.object({
				content: z.array(
					z.object({ type: z.string(), text: z.string().optional() }),
				),
			})
			.parse(await readBoundedJson(response, 1_000_000));
		return modelStepSchema.parse(
			JSON.parse(
				body.content
					.filter((c) => c.type === "text")
					.map((c) => c.text ?? "")
					.join(""),
			),
		);
	}
}
