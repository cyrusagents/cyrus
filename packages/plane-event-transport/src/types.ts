import type { FastifyInstance } from "fastify";

/**
 * Plane (https://plane.so) agent-run types.
 *
 * Plane's agent model mirrors Linear's: an OAuth app with "App Mentions"
 * enabled gets a bot user, mentioning or assigning it on a work item starts an
 * "agent run", and the app answers with run "activities". These types cover
 * the parts of Plane's webhook payloads and REST resources Cyrus reads.
 *
 * @see https://developers.plane.so/dev-tools/agents/building-an-agent
 * @see https://developers.plane.so/dev-tools/agents/signals-content-payload
 */

export type PlaneAgentRunStatus =
	| "created"
	| "in_progress"
	| "awaiting"
	| "completed"
	| "stopping"
	| "stopped"
	| "failed"
	| "stale";

export type PlaneActivitySignal =
	| "auth_request"
	| "continue"
	| "select"
	| "stop";

export type PlaneActivityType =
	| "action"
	| "elicitation"
	| "error"
	| "prompt"
	| "response"
	| "thought";

/** An agent run, as embedded in webhook payloads (ids may be expanded objects). */
export interface PlaneAgentRun {
	id: string;
	agent_user?: string;
	comment?: string | null;
	source_comment?: string | null;
	creator?: string;
	issue?: string | null;
	project?: string | null;
	workspace?: string;
	status?: PlaneAgentRunStatus;
	type?: string;
	/** What started the run: "mention", "assignment", ... */
	trigger_type?: string;
	started_at?: string;
}

export type PlaneActivityContent =
	| { type: "action"; action: string; parameters: Record<string, string> }
	| { type: Exclude<PlaneActivityType, "action">; body: string };

export interface PlaneAgentRunActivity {
	id: string;
	agent_run: string;
	type: PlaneActivityType;
	content: PlaneActivityContent;
	ephemeral?: boolean;
	signal?: PlaneActivitySignal;
	signal_metadata?: Record<string, unknown>;
	comment?: string | null;
	actor?: string | null;
	workspace?: string;
	project?: string | null;
}

/** Common identifier fields Plane adds to every agent webhook. */
interface PlaneAgentWebhookBase {
	agent_user_id?: string;
	app_client_id?: string;
	issue_id?: string | null;
	project_id?: string | null;
	workspace_id?: string;
	comment_id?: string | null;
}

/** `agent_run_create`: a user mentioned or assigned the agent. Carries no prompt text. */
export interface PlaneAgentRunCreatedPayload extends PlaneAgentWebhookBase {
	type: "agent_run";
	action: "created";
	agent_run: PlaneAgentRun;
}

/** `agent_run_user_prompt`: the initial mention or a follow-up, with the text. */
export interface PlaneAgentRunPromptedPayload extends PlaneAgentWebhookBase {
	type: "agent_run_activity";
	action: "prompted";
	agent_run: PlaneAgentRun;
	agent_run_activity: PlaneAgentRunActivity;
}

export type PlaneAgentWebhookPayload =
	| PlaneAgentRunCreatedPayload
	| PlaneAgentRunPromptedPayload;

/** Body for POST /workspaces/{slug}/runs/{runId}/activities/ */
export interface PlaneCreateActivityRequest {
	type: Exclude<PlaneActivityType, "prompt">;
	content: PlaneActivityContent;
	content_metadata?: Record<string, unknown>;
	signal?: PlaneActivitySignal;
	signal_metadata?: Record<string, unknown>;
	project?: string;
}

// ---------------------------------------------------------------------------
// REST resources (only the fields Cyrus uses)
// ---------------------------------------------------------------------------

export type PlaneStateGroup =
	| "backlog"
	| "unstarted"
	| "started"
	| "completed"
	| "cancelled"
	| "triage";

export interface PlaneState {
	id: string;
	name: string;
	group: PlaneStateGroup;
	color?: string;
	sequence?: number;
	description?: string;
}

export interface PlaneLabel {
	id: string;
	name: string;
	color?: string;
	description?: string;
}

export interface PlaneProject {
	id: string;
	name: string;
	identifier: string;
	description?: string;
}

export type PlanePriority = "urgent" | "high" | "medium" | "low" | "none";

export interface PlaneWorkItem {
	id: string;
	name: string;
	description_html?: string | null;
	description_stripped?: string | null;
	sequence_id: number;
	state?: string | null;
	priority?: PlanePriority | null;
	labels?: string[];
	assignees?: string[];
	parent?: string | null;
	project: string;
	created_at: string;
	updated_at: string;
	archived_at?: string | null;
	/** Set on work items imported from another tracker, e.g. "linear" + "ENG-236". */
	external_source?: string | null;
	external_id?: string | null;
}

export interface PlaneComment {
	id: string;
	comment_html?: string | null;
	comment_stripped?: string | null;
	actor?: string | null;
	parent?: string | null;
	created_at: string;
	updated_at: string;
}

/** A link on a work item (e.g. a pull request). */
export interface PlaneLink {
	id: string;
	url: string;
	title?: string | null;
}

/** A file attached to a work item (the paperclip), as the attachments API lists it. */
export interface PlaneAttachment {
	id: string;
	asset?: string;
	attributes?: { name?: string; size?: number; type?: string } | null;
	size?: number | null;
	is_uploaded?: boolean;
}

export interface PlaneMember {
	id: string;
	display_name?: string;
	first_name?: string;
	last_name?: string;
	email?: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Credentials for one Plane workspace. The bot token is obtained with the
 * app's client credentials and the workspace's app installation id.
 */
export interface PlaneCredentials {
	/** Plane origin, e.g. https://plane.example.com (no trailing slash) */
	baseUrl: string;
	workspaceSlug: string;
	clientId: string;
	clientSecret: string;
	/** From the OAuth install redirect (`app_installation_id`) */
	appInstallationId: string;
}

export interface PlaneEventTransportConfig {
	fastifyServer: FastifyInstance;
	/** Secret for `X-Plane-Signature` (HMAC-SHA256 of the raw body, hex). */
	webhookSecret: string;
	/** Called with the query string of the OAuth install redirect. */
	onInstall?: (query: Record<string, string>) => Promise<string> | string;
}

export interface PlaneEventTransportEvents {
	event: (payload: PlaneAgentWebhookPayload) => void;
	error: (error: Error) => void;
}
