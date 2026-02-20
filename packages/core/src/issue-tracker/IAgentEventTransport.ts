/**
 * Platform-agnostic interface for agent event transport.
 *
 * This interface defines how webhook events from issue tracking platforms
 * are received, verified, and delivered to the application. It abstracts
 * away platform-specific details like HTTP endpoints, signature verification,
 * and payload structures.
 *
 * @module issue-tracker/IAgentEventTransport
 */

import type { FastifyInstance } from "fastify";
import type { InternalMessage } from "../messages/index.js";
import type { AgentEvent } from "./AgentEvent.js";

/**
 * Base configuration shared by all event transports.
 */
interface AgentEventTransportConfigBase {
	/**
	 * Fastify server instance to register webhook endpoints with.
	 */
	fastifyServer: FastifyInstance;
}

/**
 * Configuration for Linear event transport in direct mode.
 * Uses Linear's webhook signature verification.
 */
export interface LinearDirectEventTransportConfig
	extends AgentEventTransportConfigBase {
	platform: "linear";
	verificationMode: "direct";
	/**
	 * Linear webhook secret (LINEAR_WEBHOOK_SECRET) for signature verification.
	 */
	secret: string;
}

/**
 * Configuration for Linear event transport in proxy mode.
 * Uses Bearer token authentication.
 */
export interface LinearProxyEventTransportConfig
	extends AgentEventTransportConfigBase {
	platform: "linear";
	verificationMode: "proxy";
	/**
	 * API key (CYRUS_API_KEY) for Bearer token authentication.
	 */
	secret: string;
}

/**
 * Configuration for CLI event transport (in-memory mode).
 */
export interface CLIEventTransportConfig extends AgentEventTransportConfigBase {
	platform: "cli";
}

/**
 * Discriminated union of all event transport configurations.
 * Platform-specific config values are only required when using that platform.
 */
export type AgentEventTransportConfig =
	| LinearDirectEventTransportConfig
	| LinearProxyEventTransportConfig
	| CLIEventTransportConfig;

/**
 * Event handlers for agent event transport.
 */
export interface AgentEventTransportEvents {
	/**
	 * Emitted when a valid agent event is received.
	 * @param event - The verified agent event
	 * @deprecated Use the 'message' event for new code. This event is maintained for backward compatibility.
	 */
	event: (event: AgentEvent) => void;

	/**
	 * Emitted when a valid internal message is received.
	 * This is the new unified message format that all platforms translate to.
	 * @param message - The translated internal message
	 */
	message: (message: InternalMessage) => void;

	/**
	 * Emitted when an error occurs during event processing.
	 * @param error - The error that occurred
	 */
	error: (error: Error) => void;
}

/**
 * Platform-agnostic transport for receiving and delivering agent events.
 *
 * This interface defines the contract for event transport implementations.
 * Each platform (Linear, GitHub, Jira) provides its own implementation that
 * handles platform-specific details like HTTP endpoints, authentication, and
 * payload structures.
 *
 * Events:
 * - 'event': Legacy event emitted with platform-specific payload (deprecated)
 * - 'message': New unified internal message format (preferred)
 * - 'error': Emitted when an error occurs during event processing
 *
 * @example
 * ```typescript
 * // Create transport from issue tracker service
 * const transport = issueTracker.createEventTransport({
 *   fastifyServer: server.getFastifyInstance(),
 *   verificationMode: 'proxy',
 *   secret: process.env.CYRUS_API_KEY
 * });
 *
 * // Register HTTP endpoints
 * transport.register();
 *
 * // Listen for unified messages (preferred)
 * transport.on('message', (message: InternalMessage) => {
 *   console.log('Received message:', message.action);
 * });
 *
 * // Legacy: Listen for events (deprecated)
 * transport.on('event', (event: AgentEvent) => {
 *   console.log('Received event:', event.action);
 * });
 *
 * // Handle errors
 * transport.on('error', (error: Error) => {
 *   console.error('Transport error:', error);
 * });
 * ```
 */
export interface IAgentEventTransport {
	/**
	 * Register HTTP endpoints with the Fastify server.
	 *
	 * This method mounts the necessary routes to receive webhook events
	 * from the issue tracking platform.
	 *
	 * @example
	 * ```typescript
	 * transport.register();
	 * console.log('Webhook endpoints registered');
	 * ```
	 */
	register(): void;

	/**
	 * Register an event listener.
	 *
	 * @param event - Event name to listen for
	 * @param listener - Callback function to handle the event
	 *
	 * @example
	 * ```typescript
	 * transport.on('event', (event: AgentEvent) => {
	 *   if (isAgentSessionCreatedEvent(event)) {
	 *     console.log('Session created:', event.agentSession.id);
	 *   }
	 * });
	 * ```
	 */
	on<K extends keyof AgentEventTransportEvents>(
		event: K,
		listener: AgentEventTransportEvents[K],
	): void;

	/**
	 * Remove all event listeners.
	 *
	 * This is typically called during cleanup when shutting down the transport.
	 *
	 * @example
	 * ```typescript
	 * transport.removeAllListeners();
	 * ```
	 */
	removeAllListeners(): void;
}
