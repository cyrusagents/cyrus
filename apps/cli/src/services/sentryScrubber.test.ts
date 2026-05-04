import type { ErrorEvent } from "@sentry/node";
import { describe, expect, it } from "vitest";
import { scrubSentryEvent } from "./sentryScrubber.js";

function ev(partial: Partial<ErrorEvent>): ErrorEvent {
	return partial as ErrorEvent;
}

describe("scrubSentryEvent", () => {
	it("redacts sensitive keys at any depth in extra", () => {
		const out = scrubSentryEvent(
			ev({
				extra: {
					message: "auth failed",
					args: [
						{
							headers: {
								Authorization: "Bearer real-secret-12345",
								"x-trace": "ok",
							},
							body: { linear_token: "lin_api_xxxxxxxxxxxx" },
						},
					],
				},
			}),
		);
		const args = (out!.extra!.args as unknown[])[0] as {
			headers: { Authorization: string; "x-trace": string };
			body: { linear_token: string };
		};
		expect(args.headers.Authorization).toBe("[REDACTED]");
		expect(args.headers["x-trace"]).toBe("ok");
		expect(args.body.linear_token).toBe("[REDACTED]");
	});

	it("redacts token-shaped strings even under innocuous keys", () => {
		const out = scrubSentryEvent(
			ev({
				extra: {
					detail: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
					ok: "short",
				},
			}),
		);
		expect(out!.extra!.detail).toBe("[REDACTED]");
		expect(out!.extra!.ok).toBe("short");
	});

	it("redacts Bearer tokens inside larger strings", () => {
		const out = scrubSentryEvent(
			ev({
				message: "request: Authorization: Bearer real-secret-1234567890",
				exception: {
					values: [
						{
							type: "Error",
							value: "fetch failed: Bearer abc1234567890123456 invalid",
						},
					],
				},
			}),
		);
		expect(out!.message).toContain("Bearer [REDACTED]");
		expect(out!.exception!.values![0]!.value).toContain("Bearer [REDACTED]");
	});

	it("strips ?token= query params", () => {
		const out = scrubSentryEvent(
			ev({ extra: { url: "https://api.x/y?token=hunter2&other=1" } }),
		);
		expect(out!.extra!.url).toBe("https://api.x/y?token=[REDACTED]&other=1");
	});

	it("redacts request headers and cookies", () => {
		const out = scrubSentryEvent(
			ev({
				request: {
					headers: { authorization: "Bearer xyz1234567890123456" },
					cookies: { session: "abc" },
					data: { password: "p" },
				},
			}),
		);
		expect(out!.request!.headers!.authorization).toBe("[REDACTED]");
		expect(out!.request!.cookies as unknown as string).toBe("[REDACTED]");
		expect((out!.request!.data as { password: string }).password).toBe(
			"[REDACTED]",
		);
	});

	it("preserves session identifier attributes (sessionId / claudeSessionId)", () => {
		// Identifier attributes are the whole point of structured log slicing —
		// we surface them in Sentry intentionally. Real session secrets live
		// under compound keys (`session_token`, `session_cookie`) which still
		// trip the more specific patterns.
		const out = scrubSentryEvent(
			ev({
				extra: {
					sessionId: "019dd0f6-464d-7c70-a9bf-f60bb2e772eb",
					claudeSessionId: "c5c1fc00-1234-5678-90ab-cdef01234567",
					session_token: "secret-token-payload-1234567890",
					session_cookie: "cookieval",
				},
			}),
		);
		expect(out!.extra!.sessionId).toBe("019dd0f6-464d-7c70-a9bf-f60bb2e772eb");
		expect(out!.extra!.claudeSessionId).toBe(
			"c5c1fc00-1234-5678-90ab-cdef01234567",
		);
		// Compound keys with a real secret pattern still redact.
		expect(out!.extra!.session_token).toBe("[REDACTED]");
		expect(out!.extra!.session_cookie).toBe("[REDACTED]");
	});

	it("leaves benign fields untouched", () => {
		const out = scrubSentryEvent(
			ev({ extra: { component: "EdgeWorker", count: 3, ok: true } }),
		);
		expect(out!.extra).toEqual({
			component: "EdgeWorker",
			count: 3,
			ok: true,
		});
	});
});
