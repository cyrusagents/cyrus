import { createHash } from "node:crypto";
import { type AgentActivityContent, AgentSessionStatus } from "cyrus-core";
import { z } from "zod";
import type {
	ActivityPostOptions,
	CyrusSessionDescriptor,
} from "./IActivitySink.js";

export const SESSION_DELIVERY_PATH = "/api/agent-sessions/v1/deliver";
export const SESSION_DELIVERY_LIMITS = {
	itemBytes: 131_072,
	textCharacters: 32_768,
} as const;

export interface SessionLifecycleUpdate {
	status: AgentSessionStatus;
	executionDurationMs?: number;
	executionDurationComplete?: boolean;
	harness?: {
		type: "claude" | "codex" | "gemini" | "cursor" | "opencode";
		sessionId: string;
	};
}

export type SessionDeliveryItem = { sessionId: string; sequence: number } & (
	| { kind: "session"; payload: CyrusSessionDescriptor }
	| {
			kind: "activity";
			payload: { content: AgentActivityContent; options?: ActivityPostOptions };
	  }
	| { kind: "lifecycle"; payload: SessionLifecycleUpdate }
);

/** Refreshed supervisor authority, deliberately outside immutable item identity. */
export interface SessionDeliveryEnvelope {
	contractVersion: 1;
	instanceId: string;
	automationId: string;
	revision: number;
	occurrenceId: string;
	attemptId: string;
	fence: number;
	item: SessionDeliveryItem;
}

export interface SessionDeliveryAck {
	contractVersion: 1;
	sessionId: string;
	sequence: number;
	digest: string;
}

const id = z
	.string()
	.min(1)
	.max(300)
	.regex(/^[A-Za-z0-9_.:-]+$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(SESSION_DELIVERY_LIMITS.textCharacters);
export const cyrusSessionDescriptorSchema = z
	.object({
		id,
		parentSessionId: id.optional(),
		scopeRef: id,
		role: z.enum(["coordinator", "investigator", "engineering"]),
		issueContext: z
			.object({
				trackerId: id,
				issueId: id,
				issueIdentifier: z.string().min(1).max(300),
			})
			.strict()
			.optional(),
		externalSessionId: id.optional(),
	})
	.strict()
	.refine(
		(value) => value.parentSessionId !== value.id,
		"A session cannot parent itself",
	);

// Reuse the existing activity ontology. Reject arbitrary metadata/SDK objects;
// credential-bearing auth controls remain hosted-owned rather than URL payloads.
const contentSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("action"),
			action: z.string().min(1).max(300),
			parameter: text,
			result: text.nullable().optional(),
		})
		.strict(),
	z.object({ type: z.literal("thought"), body: text }).strict(),
	z.object({ type: z.literal("response"), body: text }).strict(),
	z.object({ type: z.literal("error"), body: text }).strict(),
	z.object({ type: z.literal("elicitation"), body: text }).strict(),
	z.object({ type: z.literal("prompt"), body: text }).strict(),
]);
const optionsSchema = z
	.object({
		ephemeral: z.boolean().optional(),
		signal: z.enum(["auth", "select", "stop", "continue"]).optional(),
		signalMetadata: z
			.object({
				options: z
					.array(z.object({ value: z.string().min(1).max(1000) }).strict())
					.min(1)
					.max(20),
			})
			.strict()
			.optional(),
	})
	.strict()
	.refine(
		(value) => !value.signalMetadata || value.signal === "select",
		"Only select signals accept metadata",
	);

const itemSchema = z
	.discriminatedUnion("kind", [
		z
			.object({
				sessionId: id,
				sequence: positive,
				kind: z.literal("session"),
				payload: cyrusSessionDescriptorSchema,
			})
			.strict(),
		z
			.object({
				sessionId: id,
				sequence: positive,
				kind: z.literal("activity"),
				payload: z
					.object({ content: contentSchema, options: optionsSchema.optional() })
					.strict(),
			})
			.strict(),
		z
			.object({
				sessionId: id,
				sequence: positive,
				kind: z.literal("lifecycle"),
				payload: z
					.object({
						status: z.enum(AgentSessionStatus),
						executionDurationMs: z
							.number()
							.int()
							.nonnegative()
							.safe()
							.optional(),
						executionDurationComplete: z.boolean().optional(),
						harness: z
							.object({
								type: z.enum([
									"claude",
									"codex",
									"gemini",
									"cursor",
									"opencode",
								]),
								sessionId: id,
							})
							.strict()
							.optional(),
					})
					.strict()
					.refine(
						(value) =>
							(value.executionDurationMs === undefined) ===
							(value.executionDurationComplete === undefined),
						"Execution duration requires completeness",
					),
			})
			.strict(),
	])
	.refine(
		(value) =>
			value.kind !== "session" ||
			(value.sequence === 1 && value.payload.id === value.sessionId),
		"Creation requires matching identity at sequence one",
	);

/** JSON-only canonicalization: no undefined, nonfinite numbers, custom objects or sparse arrays. */
export function canonicalSessionJson(value: unknown): string {
	const seen = new Set<object>();
	function encode(input: unknown, depth: number): string {
		if (depth > 32) throw new Error("Session delivery nesting limit exceeded");
		if (
			input === null ||
			typeof input === "boolean" ||
			typeof input === "string"
		)
			return JSON.stringify(input);
		if (typeof input === "number" && Number.isFinite(input))
			return JSON.stringify(input);
		if (typeof input !== "object" || input === null || seen.has(input))
			throw new Error("Session delivery requires acyclic JSON values");
		seen.add(input);
		try {
			if (Array.isArray(input)) {
				if (Object.keys(input).length !== input.length)
					throw new Error("Session delivery requires dense JSON arrays");
				return `[${Array.from(input, (item) => encode(item, depth + 1)).join(",")}]`;
			}
			if (
				Object.getPrototypeOf(input) !== Object.prototype &&
				Object.getPrototypeOf(input) !== null
			)
				throw new Error("Session delivery requires plain JSON objects");
			if (Object.getOwnPropertySymbols(input).length)
				throw new Error("Session delivery rejects symbol keys");
			return `{${Object.keys(input)
				.sort()
				.map((key) => {
					const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
					if (!("value" in descriptor))
						throw new Error("Session delivery rejects accessors");
					return `${JSON.stringify(key)}:${encode(descriptor.value, depth + 1)}`;
				})
				.join(",")}}`;
		} finally {
			seen.delete(input);
		}
	}
	return encode(value, 0);
}

export function parseSessionDeliveryItem(input: unknown): SessionDeliveryItem {
	const encoded = canonicalSessionJson(input);
	if (Buffer.byteLength(encoded) > SESSION_DELIVERY_LIMITS.itemBytes)
		throw new Error("Session delivery item exceeds byte limit");
	return itemSchema.parse(input) as SessionDeliveryItem;
}

export function sessionDeliveryDigest(item: SessionDeliveryItem): string {
	parseSessionDeliveryItem(item);
	return createHash("sha256").update(canonicalSessionJson(item)).digest("hex");
}

export function parseSessionDeliveryEnvelope(
	input: unknown,
): SessionDeliveryEnvelope {
	canonicalSessionJson(input);
	const envelope = z
		.object({
			contractVersion: z.literal(1),
			instanceId: id,
			automationId: id,
			revision: positive,
			occurrenceId: id,
			attemptId: id,
			fence: positive,
			item: z.unknown(),
		})
		.strict()
		.parse(input);
	return { ...envelope, item: parseSessionDeliveryItem(envelope.item) };
}

export function verifySessionDeliveryAck(
	input: unknown,
	item: SessionDeliveryItem,
): SessionDeliveryAck {
	const ack = z
		.object({
			contractVersion: z.literal(1),
			sessionId: id,
			sequence: positive,
			digest: z.string().regex(/^[a-f0-9]{64}$/),
		})
		.strict()
		.parse(input);
	if (
		ack.sessionId !== item.sessionId ||
		ack.sequence !== item.sequence ||
		ack.digest !== sessionDeliveryDigest(item)
	)
		throw new Error("Session delivery acknowledgement mismatch");
	return ack;
}
