/**
 * Types for Linear event transport
 */

import type { FastifyInstance } from "fastify";
import type { AgentEvent, InternalMessage } from "miko-core";

/**
 * Verification mode for Linear webhooks
 * - 'direct': Use LINEAR_WEBHOOK_SECRET for Linear signature verification
 * - 'proxy': Use MIKO_API_KEY Bearer token for proxy authentication
 */
export type VerificationMode = "direct" | "proxy";

/**
 * Configuration for LinearEventTransport
 */
export interface LinearEventTransportConfig {
	/** Fastify server instance to mount routes on */
	fastifyServer: FastifyInstance;
	/** Verification mode: 'direct' or 'proxy' */
	verificationMode: VerificationMode;
	/** Secret for verification (LINEAR_WEBHOOK_SECRET or MIKO_API_KEY) */
	secret: string;
	/**
	 * Resolve the signing secret for the claimed organization in direct mode.
	 * The organization is untrusted until its signature is verified. Returning
	 * undefined rejects the request; it never falls back to the global secret.
	 */
	resolveWebhookSecret?: (organizationId: string) => string | undefined;
	/** Optional IP allowlist for webhook source validation (only used in direct mode) */
	ipAllowlist?: readonly string[];
}

/**
 * Events emitted by LinearEventTransport
 */
export interface LinearEventTransportEvents {
	/** Emitted when a webhook is received and verified (legacy) */
	event: (event: AgentEvent) => void;
	/** Emitted when a unified internal message is received */
	message: (message: InternalMessage) => void;
	/** Emitted when an error occurs */
	error: (error: Error) => void;
}
