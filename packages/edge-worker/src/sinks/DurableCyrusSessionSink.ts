import type { AgentActivityContent } from "cyrus-core";
import type {
	ActivityPostOptions,
	ActivityPostResult,
	CyrusSessionDescriptor,
	ICyrusSessionSink,
} from "./IActivitySink.js";
import type { SessionActivityJournal } from "./SessionActivityJournal.js";
import type { SessionDeliveryTransport } from "./SessionDeliveryTransport.js";
import {
	canonicalSessionJson,
	type SessionDeliveryEnvelope,
	type SessionLifecycleUpdate,
	verifySessionDeliveryAck,
} from "./session-delivery.js";

const credentialMaterial =
	/(?:\bBearer\s+\S+|\b(?:cmcp_|cysk_|sk-ant-|xox[baprs]-)[a-zA-Z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:CYRUS_API_KEY|CLOUDFLARE_TOKEN|ANTHROPIC_API_KEY|SUPABASE_SECRET_KEY)\s*=)/i;

/** Replace an affected display field entirely; partial masking can leave credential fragments. */
function redactDisplay(value: unknown, secrets: readonly string[]): unknown {
	if (typeof value === "string")
		return credentialMaterial.test(value) ||
			secrets.some((secret) => secret.length > 0 && value.includes(secret))
			? "[redacted credential material]"
			: value;
	if (Array.isArray(value))
		return value.map((item) => redactDisplay(item, secrets));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				redactDisplay(item, secrets),
			]),
		);
	return value;
}

/**
 * Local durable acceptance is separate from remote delivery. A network error
 * retains immutable redacted items; supervisor reconnect calls flush with current
 * authority. This sink has no scheduler, model launcher or credential persistence.
 */
export class DurableCyrusSessionSink implements ICyrusSessionSink {
	readonly id: string;
	private flushing?: Promise<void>;
	constructor(
		private readonly journal: SessionActivityJournal,
		private readonly transport: SessionDeliveryTransport,
		private readonly authority: (
			sessionId: string,
		) => Promise<Omit<SessionDeliveryEnvelope, "item">>,
		private readonly secrets: () => readonly string[],
		private readonly backgroundSignal?: AbortSignal,
	) {
		this.id = journal.id;
	}
	async createCyrusSession(descriptor: CyrusSessionDescriptor): Promise<void> {
		this.assertPrivateIdentity(descriptor);
		// A child uses its own private journal. The hosted creation receipt, checked
		// under current child authority, establishes its already-admitted parent;
		// never read or import a parent's private checkpoint to establish linkage.
		if (
			descriptor.parentSessionId &&
			!this.journal.isCreated(descriptor.parentSessionId) &&
			!this.journal.isCreated(descriptor.id)
		) {
			const item = {
				sessionId: descriptor.id,
				sequence: 1,
				kind: "session" as const,
				payload: descriptor,
			};
			const authority = await this.authority(descriptor.id);
			const ack = verifySessionDeliveryAck(
				await this.transport.deliver(
					{ ...authority, item },
					AbortSignal.timeout(20_000),
				),
				item,
			);
			this.journal.create(descriptor, true);
			this.journal.acknowledge(item, ack);
			return;
		}
		const item = this.journal.create(descriptor);
		if (this.journal.isCreated(descriptor.id)) {
			// Persisted creation is identity, not current authority on reconnect.
			const authority = await this.authority(descriptor.id);
			verifySessionDeliveryAck(
				await this.transport.deliver(
					{ ...authority, item },
					AbortSignal.timeout(20_000),
				),
				item,
			);
			return;
		}
		await this.flush().catch(() => undefined);
		if (!this.journal.isCreated(descriptor.id))
			throw new Error("Session admission was not acknowledged");
	}
	async postActivity(
		sessionId: string,
		content: AgentActivityContent,
		options?: ActivityPostOptions,
		sourceKey?: string,
	): Promise<ActivityPostResult> {
		const payload = { content, ...(options && { options }) };
		// Validate JSON before walking/redacting; no custom SDK objects or accessors.
		canonicalSessionJson(payload);
		const redacted = redactDisplay(payload, this.secrets()) as {
			content: AgentActivityContent;
			options?: ActivityPostOptions;
		};
		this.journal.append(
			sessionId,
			{ kind: "activity", payload: redacted },
			sourceKey,
		);
		await this.deliverAccepted(); // Durable item remains; no acknowledgement is fabricated.
		return {};
	}
	async updateCyrusSession(
		sessionId: string,
		update: SessionLifecycleUpdate,
		sourceKey?: string,
	): Promise<void> {
		this.assertPrivateIdentity(update);
		this.journal.append(
			sessionId,
			{ kind: "lifecycle", payload: update },
			sourceKey,
		);
		await this.deliverAccepted();
	}
	private async deliverAccepted(): Promise<void> {
		if (!this.backgroundSignal) {
			await this.flush().catch(() => undefined);
			return;
		}
		// Append is already durable. One bounded ordered drain may overlap execution;
		// final flush still requires every exact receipt ACK before /result.
		if (!this.flushing)
			void this.flush(
				AbortSignal.any([this.backgroundSignal, AbortSignal.timeout(20_000)]),
			).catch(() => undefined);
	}
	async settled(): Promise<void> {
		await this.flushing?.catch(() => undefined);
	}
	private assertPrivateIdentity(value: unknown): void {
		const serialized = canonicalSessionJson(value);
		if (
			credentialMaterial.test(serialized) ||
			this.secrets().some(
				(secret) => secret.length > 0 && serialized.includes(secret),
			)
		)
			throw new Error("Session identity contains credential material");
	}
	async flush(
		signal: AbortSignal = AbortSignal.timeout(20_000),
	): Promise<void> {
		// Another caller may append after the current drain's last peek. Waiting
		// only for that promise could falsely acknowledge a terminal flush.
		// A previous background failure retains the same immutable item. This
		// explicit flush makes its own current-authority delivery attempt.
		while (this.flushing) await this.flushing.catch(() => undefined);
		signal.throwIfAborted();
		const work = this.drain(signal);
		this.flushing = work;
		try {
			await work;
		} finally {
			if (this.flushing === work) this.flushing = undefined;
		}
	}
	private async drain(signal: AbortSignal): Promise<void> {
		const failed = new Set<string>();
		// Bounded reconnect work; supervisor explicitly schedules another flush.
		for (let count = 0; count < 1024; count++) {
			signal.throwIfAborted();
			const item = this.journal.peek(failed);
			if (!item) break;
			try {
				const authority = await this.authority(item.sessionId);
				signal.throwIfAborted();
				const ack = await this.transport.deliver(
					{ ...authority, item },
					signal,
				);
				this.journal.acknowledge(item, ack);
			} catch {
				failed.add(item.sessionId);
			}
		}
		if (failed.size)
			throw new Error(
				"Session deliveries were not acknowledged; durable items retained",
			);
	}
}
