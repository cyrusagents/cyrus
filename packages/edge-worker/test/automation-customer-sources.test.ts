import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
	type AutomationAuthority,
	admissionSchema,
	authoritySchema,
	authorizeTool,
	checkpointKey,
	definitionSchema,
	executionAuthority,
	permittedToolNames,
	scopedToolResult,
} from "../src/automations/contract.js";

function authority(): AutomationAuthority {
	return {
		contractVersion: 1,
		customerSources: true,
		definition: {
			id: "both",
			workspaceId: "workspace",
			ownerId: "owner",
			namespace: "customer",
			scopeRef: "customer",
			revision: 1,
			state: "enabled",
			role: "coordinator",
			instruction: "Use admitted sources",
			schedule: null,
			target: { harness: "codex", model: "fixture" },
			grants: [
				{
					id: "linear-binding",
					connectionId: "linear-connection",
					accountId: "linear-account",
					resource: { provider: "linear", customerId: randomUUID() },
					permissions: ["read", "delegate"],
				},
				{
					id: "slack-binding",
					connectionId: "slack-connection",
					accountId: "slack-account",
					resource: {
						provider: "slack",
						channelId: "channel",
						scope: "channel",
					},
					permissions: ["read"],
				},
			],
		},
		occurrenceId: "occurrence",
		attemptId: "attempt",
		fence: 1,
		phase: "execute",
		leaseUntil: new Date(Date.now() + 60000).toISOString(),
		input: "Read both",
	};
}
it("requires an explicit negotiated ordered read pair and rejects widening at definition parsing", () => {
	const a = authority();
	const { customerSources: _, ...wire } = a;
	const admission = {
		authority: wire,
		customerSources: true,
		mcp: {
			token: "synthetic-credential-with-thirty-two-characters",
			audience: "/mcp",
			grantId: a.definition.grants[0]!.id,
			expiresAt: a.leaseUntil,
		},
	};
	expect(admissionSchema.safeParse(admission).success).toBe(true);
	expect(executionAuthority(admissionSchema.parse(admission))).toEqual(a);
	for (const flag of [undefined, false, "true", 2])
		expect(
			admissionSchema.safeParse({ ...admission, customerSources: flag })
				.success,
		).toBe(false);
	for (const mutation of [
		(d: typeof a.definition) => {
			d.grants.reverse();
		},
		(d: typeof a.definition) => {
			d.grants[1] = d.grants[0]!;
		},
		(d: typeof a.definition) => {
			d.grants[1]!.id = d.grants[0]!.id;
		},
		(d: typeof a.definition) => {
			d.grants[1]!.connectionId = d.grants[0]!.connectionId;
		},
		(d: typeof a.definition) => {
			d.grants[1]!.permissions = ["read", "delegate"];
		},
		(d: typeof a.definition) => {
			d.grants[0]!.permissions = ["read", "write"];
		},
		(d: typeof a.definition) => {
			d.grants[0]!.permissions = ["read", "read"];
		},
		(d: typeof a.definition) => {
			d.grants[0]!.resource = {
				provider: "linear",
				teamId: "team",
				issueId: "issue",
			};
		},
		(d: typeof a.definition) => {
			d.grants[1]!.resource = {
				provider: "slack",
				channelId: "channel",
				threadTs: "123",
			};
		},
		(d: typeof a.definition) => {
			d.role = "investigator";
		},
		(d: typeof a.definition) => {
			d.role = "engineering";
		},
		(d: typeof a.definition) => {
			d.grants.push(d.grants[0]!);
		},
	]) {
		const d = structuredClone(a.definition);
		mutation(d);
		expect(definitionSchema.safeParse(d).success).toBe(false);
		expect(authoritySchema.safeParse({ ...wire, definition: d }).success).toBe(
			false,
		);
		expect(permittedToolNames({ ...a, definition: d })).toEqual([]);
	}
	const single = {
		...wire,
		definition: { ...wire.definition, grants: [wire.definition.grants[0]!] },
	};
	expect(
		admissionSchema.safeParse({ ...admission, authority: single }).success,
	).toBe(false);
	expect(permittedToolNames({ ...wire })).toEqual([]);
});
it("routes fixed tools/results to their provider and narrows delegation to an issued Linear reference", () => {
	const a = authority();
	expect(permittedToolNames(a)).toEqual([
		"list_issues",
		"get_issue",
		"delegate_investigation",
		"read_messages",
		"read_thread",
	]);
	for (const [name, args, index] of [
		["list_issues", {}, 0],
		["get_issue", { reference: randomUUID() }, 0],
		["read_messages", {}, 1],
		["read_thread", { reference: randomUUID() }, 1],
		[
			"delegate_investigation",
			{
				instruction: "Investigate only this issue",
				tracking: "assigned_ticket",
				reference: randomUUID(),
			},
			0,
		],
	] as const) {
		const call = { name, arguments: args };
		const g = a.definition.grants[index]!;
		expect(authorizeTool(a, call)).toEqual(g);
		for (const field of [
			"grantId",
			"connectionId",
			"provider",
			"workspaceId",
			"customerId",
			"channelId",
			"issueId",
			"role",
			"runId",
		])
			expect(() =>
				authorizeTool(a, {
					...call,
					arguments: { ...args, [field]: "forged" },
				}),
			).toThrow();
		const item = {
			grantId: g.id,
			connectionId: g.connectionId,
			accountId: g.accountId,
			resource: g.resource,
			text: "bounded content",
		};
		expect(
			scopedToolResult(a, call, { items: [item], nextCursor: null }),
		).toEqual({ items: [{ text: "bounded content" }], nextCursor: null });
		const foreign = a.definition.grants[1 - index]!;
		expect(() =>
			scopedToolResult(a, call, {
				items: [
					{
						...item,
						grantId: foreign.id,
						connectionId: foreign.connectionId,
						accountId: foreign.accountId,
						resource: foreign.resource,
					},
				],
				nextCursor: null,
			}),
		).toThrow();
	}
	for (const name of [
		"reply",
		"add_comment",
		"execute",
		"apply_approved_action",
	])
		expect(() => authorizeTool(a, { name, arguments: {} })).toThrow();
	expect(() =>
		authorizeTool(a, {
			name: "delegate_investigation",
			arguments: { instruction: "Read", tracking: "direct" },
		}),
	).toThrow();
});
it("pins both full source bindings in checkpoints while allowing attempt/lease continuation", () => {
	const a = authority(),
		key = checkpointKey(a);
	expect(
		checkpointKey({
			...a,
			attemptId: "retry",
			fence: 2,
			leaseUntil: new Date(Date.now() + 90000).toISOString(),
		}),
	).toBe(key);
	for (const index of [0, 1])
		for (const field of ["id", "connectionId", "accountId", "resource"]) {
			const b = structuredClone(a);
			Object.assign(b.definition.grants[index]!, {
				[field]:
					field === "resource"
						? { provider: "slack", channelId: "foreign", scope: "channel" }
						: "foreign",
			});
			expect(checkpointKey(b)).not.toBe(key);
		}
	const survivor = structuredClone(a);
	survivor.definition.grants.pop();
	delete survivor.customerSources;
	survivor.definition.revision++;
	expect(checkpointKey(survivor)).not.toBe(key);
});
