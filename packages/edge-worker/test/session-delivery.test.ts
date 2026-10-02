import { describe, expect, it } from "vitest";
import {
	canonicalSessionJson,
	parseSessionDeliveryEnvelope,
	parseSessionDeliveryItem,
	sessionDeliveryDigest,
	verifySessionDeliveryAck,
} from "../src/sinks/session-delivery.js";

const session = {
	sessionId: "child",
	sequence: 1,
	kind: "session" as const,
	payload: {
		id: "child",
		parentSessionId: "parent",
		scopeRef: "admitted-scope",
		role: "investigator" as const,
	},
};
const authority = {
	contractVersion: 1,
	instanceId: "instance",
	automationId: "automation",
	revision: 1,
	occurrenceId: "occurrence",
	attemptId: "attempt",
	fence: 1,
};

describe("shared session delivery contract", () => {
	it("canonicalizes nested objects, preserves array order and isolates digest from attempt rotation", () => {
		expect(canonicalSessionJson({ z: [2, 1], a: { b: true, a: null } })).toBe(
			'{"a":{"a":null,"b":true},"z":[2,1]}',
		);
		const reordered = {
			payload: {
				role: "investigator" as const,
				scopeRef: "admitted-scope",
				parentSessionId: "parent",
				id: "child",
			},
			kind: "session" as const,
			sequence: 1,
			sessionId: "child",
		};
		expect(sessionDeliveryDigest(reordered)).toBe(
			sessionDeliveryDigest(session),
		);
		const first = parseSessionDeliveryEnvelope({ ...authority, item: session });
		const next = parseSessionDeliveryEnvelope({
			...authority,
			attemptId: "takeover",
			fence: 2,
			item: reordered,
		});
		expect(sessionDeliveryDigest(first.item)).toBe(
			sessionDeliveryDigest(next.item),
		);
		const ack = {
			contractVersion: 1,
			sessionId: "child",
			sequence: 1,
			digest: sessionDeliveryDigest(session),
		};
		expect(verifySessionDeliveryAck(ack, session)).toEqual(ack);
		expect(() =>
			verifySessionDeliveryAck({ ...ack, sequence: 2 }, session),
		).toThrow("acknowledgement mismatch");
		expect(() =>
			verifySessionDeliveryAck(ack, {
				...session,
				payload: { ...session.payload, role: "engineering" },
			}),
		).toThrow("acknowledgement mismatch");
	});

	it.each([
		undefined,
		Number.NaN,
		Infinity,
		1n,
		new Date(),
		{ a: undefined },
		[undefined],
		Array(1),
	])("rejects non-JSON input %#", (value) => {
		expect(() => canonicalSessionJson(value)).toThrow();
	});

	it("rejects cycles, mismatched creation identity and undeclared authority fields", () => {
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		expect(() => canonicalSessionJson(cycle)).toThrow();
		expect(() =>
			parseSessionDeliveryItem({ ...session, sessionId: "another-child" }),
		).toThrow();
		expect(() =>
			parseSessionDeliveryItem({ ...session, sequence: 2 }),
		).toThrow();
		expect(() =>
			parseSessionDeliveryEnvelope({
				...authority,
				customerId: "forged",
				item: session,
			}),
		).toThrow();
		expect(() =>
			parseSessionDeliveryItem({
				...session,
				payload: { ...session.payload, token: "forged" },
			}),
		).toThrow();
	});

	it("keeps normalized activity/signal options but denies arbitrary metadata and auth URLs", () => {
		const item = {
			sessionId: "child",
			sequence: 2,
			kind: "activity",
			payload: {
				content: { type: "elicitation", body: "Choose" },
				options: {
					ephemeral: true,
					signal: "select",
					signalMetadata: { options: [{ value: "One" }] },
				},
			},
		};
		expect(parseSessionDeliveryItem(item)).toEqual(item);
		expect(() =>
			parseSessionDeliveryItem({
				...item,
				payload: {
					...item.payload,
					options: {
						signal: "auth",
						signalMetadata: { url: "https://example.invalid/private-code" },
					},
				},
			}),
		).toThrow();
		expect(() =>
			parseSessionDeliveryItem({
				...item,
				payload: {
					...item.payload,
					options: { ...item.payload.options, signal: "stop" },
				},
			}),
		).toThrow();
		expect(() =>
			parseSessionDeliveryItem({
				...item,
				payload: {
					content: { type: "response", body: "ok", credentials: "no" },
				},
			}),
		).toThrow();
	});

	it("bounds display data and keeps native identity separate from the Cyrus session", () => {
		const lifecycle = {
			sessionId: "child",
			sequence: 3,
			kind: "lifecycle",
			payload: {
				status: "complete",
				harness: { type: "codex", sessionId: "native-thread" },
			},
		};
		expect(parseSessionDeliveryItem(lifecycle)).toEqual(lifecycle);
		expect(() =>
			parseSessionDeliveryItem({
				sessionId: "child",
				sequence: 2,
				kind: "activity",
				payload: { content: { type: "response", body: "a".repeat(32_769) } },
			}),
		).toThrow();
		expect(() =>
			parseSessionDeliveryItem({
				...lifecycle,
				payload: { ...lifecycle.payload, environment: {} },
			}),
		).toThrow();
	});
});
