/**
 * Message Translator Interface
 *
 * This module defines the interface for translating platform-specific webhook
 * payloads into unified internal messages.
 *
 * @module messages/IMessageTranslator
 */

import type { InternalMessage } from "./types.js";

/**
 * Result of a translation attempt.
 * Translation can fail if the webhook is not relevant or malformed.
 */
export type TranslationResult =
	| { success: true; message: InternalMessage }
	| { success: false; reason: string };

/**
 * Interface for platform-specific message translators.
 *
 * Each platform (Linear, GitHub, Slack) implements this interface to translate
 * their webhook payloads into the unified InternalMessage format.
 *
 * @typeParam TWebhook - The platform-specific webhook payload type
 */
export interface IMessageTranslator<TWebhook> {
	/**
	 * Translate a platform-specific webhook into an internal message.
	 *
	 * @param webhook - The platform-specific webhook payload
	 * @param context - Optional additional context needed for translation
	 * @returns TranslationResult indicating success with the message or failure with reason
	 *
	 * @example
	 * ```typescript
	 * const translator = new LinearMessageTranslator();
	 * const result = translator.translate(webhookPayload);
	 *
	 * if (result.success) {
	 *   handleMessage(result.message);
	 * } else {
	 *   console.log('Skipped webhook:', result.reason);
	 * }
	 * ```
	 */
	translate(webhook: TWebhook, context?: TranslationContext): TranslationResult;

	/**
	 * Check if this translator can handle the given webhook.
	 *
	 * @param webhook - The webhook payload to check
	 * @returns true if this translator can translate the webhook
	 */
	canTranslate(webhook: unknown): webhook is TWebhook;
}

/**
 * Context information that may be needed during translation.
 */
export interface TranslationContext {
	/** Organization ID if not in the webhook */
	organizationId?: string;
	/** Linear API token for Linear webhooks */
	linearApiToken?: string;
	/** GitHub installation token for GitHub webhooks */
	installationToken?: string;
	/** Additional metadata */
	metadata?: Record<string, unknown>;
}
