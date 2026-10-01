// Copied fixture setup from Hosted24a4b7e0; production handlers/migrations stay frozen.
import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { createSessionDeliveryHandler } from "../agent-sessions/delivery-handler";
import { occurrenceDigest } from "./automation-contract";
import { createAutomationCallback } from "./automation-handler";
import { readCustomerIssues } from "./customer-issue-reader";
import { mcpAuthoritySchema } from "./mcp-contract";
import { createCustomerMcpHandler } from "./mcp-server";
import { nativeAuthoritySchema } from "./native-context-contract";
import { validateNativeSources } from "./native-context-sources";
import { readSlackChannel } from "./slack-history-reader";

test("installed contained runtime joins published native SQL/HTTP/MCP", async () => {
	const sql = new SQL(process.env.CUSTOMER_AGENTS_TEST_DATABASE_URL, {
		max: 4,
	});
	const directory = await mkdtemp(join(tmpdir(), "cyrus-native-join-"));
	console.error(JSON.stringify({ privateFixtureDirectory: directory }));
	const supervisor = randomBytes(32).toString("hex");
	const evidence = {
		hostedSha: process.env.CYRUS_NATIVE_JOIN_HOSTED_SHA,
		runtimeSha: process.env.CYRUS_NATIVE_JOIN_RUNTIME_SHA,
		admissions: 0,
		renewals: 0,
		reconciliations: 0,
		deliveries: 0,
		results: 0,
		interruptions: 0,
		mcpPreflights: 0,
		mcpAuthorizations: 0,
		mcpPhases: {},
		tools: {},
		denials: 0,
	};
	// Fixed phase names and aggregate numeric measurements only. The SDK opens
	// its optional GET concurrently, so global before/after counters misattribute
	// that request's authority work to tools/list. Keep request-local accounting.
	const mcpMeasurement = new AsyncLocalStorage();
	async function measuredAuthority(kind, operation) {
		const measurement = mcpMeasurement.getStore();
		const start = performance.now();
		try {
			return await operation();
		} finally {
			if (measurement) {
				measurement[kind]++;
				measurement[`${kind}Ms`] += performance.now() - start;
			}
		}
	}
	const combined = process.env.CYRUS_NATIVE_JOIN_COMBINED === "1";
	const toolRejection = process.env.CYRUS_NATIVE_JOIN_TOOL_REJECTION === "1";
	const workRejection = process.env.CYRUS_NATIVE_JOIN_WORK_REJECTION === "1";
	const requireLifecycleAuthority =
		process.env.CYRUS_NATIVE_JOIN_LIFECYCLE_AUTHORITY === "1";
	const lifecycleDenials = [];
	let pauseBoundary;
	async function nativeResult(value, key) {
		if (!toolRejection && !workRejection) return value;
		const { checkNativeResult } = await import("./native-tool-rejection");
		return checkNativeResult(value, key);
	}
	const associations = new Map();
	const originalNative = new Map(),
		terminalInputs = new Map(),
		originalSources = new Map();
	let resultLossArmed = false,
		lostResult = false,
		resultLossFixture;
	async function fixture(
		provider = "linear",
		scheduleEnabled = true,
		instruction = "Investigate the synthetic issue",
		customerBound = false,
		scheduleInterval = 60,
		workspace = undefined,
	) {
		const w = workspace ?? crypto.randomUUID();
		const customer = crypto.randomUUID();

		const connection = provider === "conversation" ? null : crypto.randomUUID();
		const user = crypto.randomUUID();
		const id = crypto.randomUUID();
		const issue = crypto.randomUUID();
		const event = crypto.randomUUID();
		const objectType =
			provider === "conversation"
				? "conversation"
				: provider === "linear"
					? customerBound
						? "customer"
						: "issue"
					: customerBound
						? "channel"
						: "thread";
		const externalCustomer = crypto.randomUUID();
		const externalId =
			provider === "linear"
				? customerBound
					? externalCustomer
					: issue
				: customerBound
					? "C123"
					: "C123:1790703000.001";
		const resource =
			provider === "conversation"
				? {}
				: provider === "linear"
					? customerBound
						? { provider, customerId: externalCustomer }
						: { provider, issueId: issue, teamId: "test-team" }
					: customerBound
						? { provider, channelId: "C123", scope: "channel" }
						: { provider, channelId: "C123", threadTs: "1790703000.001" };
		await sql`insert into teams(id) values(${w}) on conflict do nothing`;
		await sql`insert into auth.users(id) values(${user})`;
		await sql`insert into customer_agents(id,workspace_id,name) values(${customer},${w},'Automation fixture')`;
		if (connection) {
			await sql`insert into customer_connections(id,workspace_id,provider,account_id,label,secret_encrypted,config,verified_at) values(${connection},${w},${provider},${connection},'test','','{"credential_source":"workspace"}',now())`;
			await sql`insert into customer_mappings(workspace_id,customer_id,connection_id,object_type,external_id,display_name,verified_by) values(${w},${customer},${connection},${objectType},${externalId},'test',${user})`;
		}
		const definition = {
			id,
			workspaceId: w,
			ownerId: w,
			namespace: customer,
			scopeRef: customer,
			revision: 1,
			state: "enabled",
			role: "coordinator",
			instruction,
			schedule: scheduleEnabled
				? {
						intervalSeconds: scheduleInterval,
						anchorAt: new Date(
							Date.now() - (scheduleInterval + 1) * 1000,
						).toISOString(),
						timezone: "UTC",
					}
				: null,
			target: { harness: "codex", model: "gpt-5.5" },
		};
		await sql`insert into customer_automation_bindings(id,workspace_id,customer_id,revision,customer_revision,definition,connection_id,object_type,external_id,resource) values(${id},${w},${customer},1,1,${definition}::jsonb,${connection},${objectType},${externalId},${resource}::jsonb)`;
		const occurrenceId = occurrenceDigest([w, id, 1, "instruction", event]);
		await sql`insert into customer_events(id,workspace_id,customer_id,provider_event_id,topic,object_type,external_id,occurred_at,payload,routing) values(${event},${w},${customer},${event},'operator.message','customer',${customer},now(),'{}','matched')`;
		const request = {
			contractVersion: 1,
			instanceId: crypto.randomUUID(),
			automationId: id,
			revision: 1,
			occurrenceId,
			attemptId: crypto.randomUUID(),
			fence: 1,
			definition,
			occurrence: {
				id: occurrenceId,
				trigger: "instruction",
				scheduledAt: new Date().toISOString(),
				input: "Investigate",
			},
			phase: "admit",
		};
		await sql`insert into customer_automation_outbox(binding_id,revision,event_id,occurrence_id,input) values(${id},1,${event},${occurrenceId},'Investigate')`;
		return {
			w,
			customer,
			connection,
			id,
			event,
			request,
			resource,
			user,
			issue,
		};
	}
	const main = await fixture(
		"conversation",
		false,
		"Help with the current operator instruction.",
	);
	const source = await fixture(
		"slack",
		false,
		"Read only current allowed context.",
		true,
		60,
		main.w,
	);
	const both = combined
		? await fixture(
				"linear",
				false,
				"Read both admitted sources",
				true,
				60,
				main.w,
			)
		: undefined;
	const lifecycleFixtures = new Map();
	if (requireLifecycleAuthority)
		for (const operation of ["progress", "result"])
			lifecycleFixtures.set(
				`denied-${operation}`,
				await fixture(
					"conversation",
					false,
					"Reply briefly.",
					false,
					60,
					main.w,
				),
			);
	if (both) {
		both.slack = crypto.randomUUID();
		both.channel = "C123";
		await sql`insert into customer_connections(id,workspace_id,provider,account_id,label,secret_encrypted,config,verified_at) values(${both.slack},${both.w},'slack','SLACK-ACCOUNT','Slack','','{"credential_source":"workspace"}',now())`;
		await sql`insert into customer_mappings(workspace_id,customer_id,connection_id,object_type,external_id,display_name,verified_by) values(${both.w},${both.customer},${both.slack},'channel',${both.channel},'Connected channel',${both.user})`;
		both.additional = [
			{
				connectionId: both.slack,
				objectType: "channel",
				externalId: both.channel,
				resource: {
					provider: "slack",
					channelId: both.channel,
					scope: "channel",
				},
			},
		];
		both.request.definition = { ...both.request.definition, revision: 2 };
		await sql`update customer_automation_bindings set additional_sources=${both.additional}::jsonb,revision=2,definition=${both.request.definition}::jsonb where id=${both.id}`;
		associations.set(both.resource.customerId, {
			need: crypto.randomUUID(),
			currentCustomer: both.resource.customerId,
			issue: both.issue,
		});
	}
	for (const f of [
		main,
		source,
		...(both ? [both] : []),
		...lifecycleFixtures.values(),
	]) {
		await sql`insert into team_members values(${f.w},${f.user},'admin')`;
		await sql`delete from customer_automation_outbox where binding_id=${f.id}`;
		await sql`update customer_events set processed_at=now() where id=${f.event}`;
	}
	await sql`update customer_agents set policy='{"memory":"automatic","thread":"automatic"}' where id in(${main.customer},${source.customer})`;
	const fixtures = new Map([
		["main", main],
		["source", source],
		...(both ? [["both", both]] : []),
		...lifecycleFixtures,
	]);
	const authenticate = async (req) =>
		req.headers.get("authorization") === `Bearer ${supervisor}` &&
		req.headers.get("x-cyrus-team-id") === main.w
			? { teamId: main.w }
			: { error: "Denied", status: 401 };
	const callback = createAutomationCallback({
		...(process.env.CYRUS_NATIVE_JOIN_CONTEXT_READ_AUTHORITY === "1" && {
			contextReadAuthority: "current-call-v1",
		}),
		...(requireLifecycleAuthority && {
			lifecycleAuthority: "current-action-v1",
		}),
		authenticate,
		event: async (w, b, o) => {
			const [row] =
				await sql`select event_id,input,revision,trigger from customer_automation_outbox where binding_id=${b} and occurrence_id=${o} and exists(select 1 from customer_automation_bindings where id=${b} and workspace_id=${w})`;
			return { ...row, revision: Number(row.revision) };
		},
		admit: async (p) => {
			const [binding] =
				await sql`select * from customer_automation_bindings where id=${p.p_request.automationId}`;
			const base = binding.connection_id
				? p.p_request
				: { ...p.p_request, mcpSessionId: undefined };
			const [{ v: admission }] = await (combined
				? sql`select customer_sources_admit(${p.p_workspace}::uuid,${p.p_instance}::uuid,${p.p_credential_hash},${base}::jsonb,${p.p_token_hash},${p.p_verified_input},${`{${p.p_event_ids.join(",")}}`}::uuid[],false,${p.p_customer_sources ?? false}) v`
				: sql`select customer_automation_admit(${p.p_workspace}::uuid,${p.p_instance}::uuid,${p.p_credential_hash},${base}::jsonb,${p.p_token_hash},${p.p_verified_input},${`{${p.p_event_ids.join(",")}}`}::uuid[],false) v`);
			assert.equal(p.p_native_context, true);
			const [{ v: native }] =
				await sql`select customer_native_admit(${p.p_workspace}::uuid,${p.p_instance}::uuid,${p.p_credential_hash},${p.p_request}::jsonb,${p.p_token_hash}) v`;
			const key = p.p_request.occurrenceId;
			if (originalSources.has(key))
				assert.deepEqual(
					admission.authority.definition.grants,
					originalSources.get(key),
				);
			else originalSources.set(key, admission.authority.definition.grants);
			if (admission.authority.definition.grants.length === 2) {
				assert.equal(admission.customerSources, true);
				evidence.combinedAdmissions = (evidence.combinedAdmissions ?? 0) + 1;
				if (admission.authority.phase === "reconcile")
					evidence.combinedReconciliations =
						(evidence.combinedReconciliations ?? 0) + 1;
			}
			if (originalNative.has(key))
				assert.deepEqual(native.nativeContext, originalNative.get(key));
			else originalNative.set(key, native.nativeContext);
			evidence.admissions++;
			if (p.p_request.phase === "renew") evidence.renewals++;
			if (admission.authority.phase === "reconcile") {
				evidence.reconciliations++;
				assert.equal(
					(
						await sql`select customer_native_mcp_authorize(${p.p_token_hash},null) v`
					)[0].v,
					null,
				);
			}
			return {
				...admission,
				...native,
				sessionId: native?.sessionId ?? undefined,
			};
		},
		interrupt: async (p) => {
			evidence.interruptions++;
			return (
				await sql`select automation_owner_interrupt(${p.p_workspace}::uuid,${p.p_credential_hash},${p.p_request}::jsonb) v`
			)[0].v;
		},
		callback: async (p) => {
			if (p.p_operation === "result") {
				const sid = `automation:${p.p_request.automationId}:${p.p_request.occurrenceId}`;
				const [s] =
					await sql`select status,last_sequence from cyrus_agent_sessions where workspace_id=${main.w} and id=${sid}`;
				assert.equal(s.status, "complete");
				assert.ok(Number(s.last_sequence) > 0);
				const old = terminalInputs.get(p.p_request.occurrenceId);
				const identity = {
					key: p.p_request.idempotencyKey,
					text: p.p_request.text,
				};
				if (old) assert.deepEqual(identity, old);
				else terminalInputs.set(p.p_request.occurrenceId, identity);
				evidence.results++;
			}
			return (
				await (requireLifecycleAuthority
					? sql`select customer_automation_current_callback(${p.p_workspace}::uuid,${p.p_instance}::uuid,${p.p_credential_hash},${p.p_request}::jsonb,${p.p_operation}) v`
					: sql`select customer_automation_callback(${p.p_workspace}::uuid,${p.p_instance}::uuid,${p.p_request}::jsonb,${p.p_operation}) v`)
			)[0].v;
		},
	});
	const sessions = createSessionDeliveryHandler({
		authenticate,
		deliver: async (p) => {
			evidence.deliveries++;
			try {
				return (
					await sql`select customer_session_deliver(${p.p_workspace}::uuid,${p.p_credential_hash},${p.p_request}::jsonb,${p.p_digest}) v`
				)[0].v;
			} catch (e) {
				console.error(
					JSON.stringify({
						boundary: "session-delivery",
						kind: p.p_request.item.kind,
						sequence: p.p_request.item.sequence,
						error: e.message.slice(0, 160),
					}),
				);
				throw e;
			}
		},
	});
	// This fixture's existing authorizer is database-only; provider membership is
	// synthetic. Enable Hosted's POST preflight path explicitly without bypassing
	// its separate post-body SDK authorize calls or any SQL scope checks.
	const databaseAuthority = async (token, session, tool) => {
		const isNative = [
			"read_context",
			"remember_context",
			"track_work",
		].includes(tool);
		const [{ v }] =
			await sql`select customer_native_mcp_authorize(${token},${session}::uuid,${isNative ? tool : null}) v`;
		if (!v) throw Error("Denied");
		const native = nativeAuthoritySchema.parse(v);
		if (native.providerGrantId) {
			const [{ p }] =
				await sql`select customer_mcp_authorize(${token},${session}::uuid,${isNative ? null : (tool ?? null)}) p`;
			return {
				...mcpAuthoritySchema.parse(p),
				nativeContext: native.nativeContext,
			};
		}
		return { ...native, kind: "native" };
	};
	const mcp = createCustomerMcpHandler({
		preflight: async (token, session) => {
			evidence.mcpPreflights++;
			return measuredAuthority("preflight", () =>
				databaseAuthority(token, session),
			);
		},
		authorize: async (token, session, tool, timing) => {
			evidence.mcpAuthorizations++;
			return measuredAuthority("authorize", () =>
				timing
					? timing.measure("mcp_sql", () =>
							databaseAuthority(token, session, tool),
						)
					: databaseAuthority(token, session, tool),
			);
		},
		open: async (token, protocol) => {
			const [{ n }] =
				await sql`select customer_native_mcp_authorize(${token},null,null) n`;
			return (
				await (n.providerGrantId
					? sql`select customer_mcp_session(${token},'open',null,${protocol}) v`
					: sql`select customer_native_mcp_session(${token},'open',null,${protocol}) v`)
			)[0].v;
		},
		close: async (token, session) => {
			const [{ n }] =
				await sql`select customer_native_mcp_authorize(${token},null,null) n`;
			await (n?.providerGrantId
				? sql`select customer_mcp_session(${token},'close',${session}::uuid)`
				: sql`select customer_native_mcp_session(${token},'close',${session}::uuid)`);
		},
		invoke: async (a, tool, args, key, ctx) => {
			evidence.tools[tool] = (evidence.tools[tool] ?? 0) + 1;
			if (!["read_context", "remember_context", "track_work"].includes(tool)) {
				if (a.resource.scope === "channel")
					return readSlackChannel(
						a,
						tool,
						args,
						async (path) => {
							evidence.slackReads = (evidence.slackReads ?? 0) + 1;

							const u = new URL(path, "https://fixture.invalid");
							expect(u.searchParams.get("channel")).toBe(a.resource.channelId);
							return {
								ok: true,
								messages: [
									{ ts: "1790703000.001", text: "Only mapped Slack channel" },
								],
								response_metadata: { next_cursor: "" },
							};
						},
						{
							current: async () => {
								await sql`select customer_mcp_authorize(${ctx.tokenHash},${ctx.sessionId}::uuid,'read_messages')`;
							},
							issue: async (kind, value) =>
								(
									await sql`select customer_mcp_slack_reference(${ctx.tokenHash},${ctx.sessionId}::uuid,${kind},${value},null) v`
								)[0].v,
							resolve: async (kind, ref) =>
								(
									await sql`select customer_mcp_slack_reference(${ctx.tokenHash},${ctx.sessionId}::uuid,${kind},null,${ref}::uuid) v`
								)[0].v,
						},
					);
				if ("customerId" in a.resource) {
					const state = associations.get(a.resource.customerId);
					return readCustomerIssues(
						a,
						tool,
						args,
						async (_path, options) => {
							evidence.linearReads = (evidence.linearReads ?? 0) + 1;
							const query = options.body.query;
							const page = (nodes) => ({
								nodes,
								pageInfo: { hasNextPage: false, endCursor: null },
							});
							const need = {
								id: state.need,
								customer: { id: state.currentCustomer },
								issue: { id: state.issue },
								originalIssue: null,
								archivedAt: null,
								updatedAt: "2026-09-30T00:00:00Z",
							};
							if (query.includes("customer(id:"))
								return {
									data: {
										customer: {
											id: a.resource.customerId,
											name: "Synthetic customer",
											archivedAt: null,
										},
									},
								};
							if (query.includes("customerNeeds("))
								return { data: { customerNeeds: page([need]) } };
							if (query.includes("needs("))
								return {
									data: { issue: { id: state.issue, needs: page([need]) } },
								};
							return {
								data: {
									issue: {
										id: state.issue,
										identifier: "TEST-READSET",
										title: "Customer-only issue",
										description: "Scoped private body",
										team: { id: "fixed-team" },
										state: { name: "Todo" },
									},
								},
							};
						},
						{
							list: async (issues) =>
								(
									await sql`select customer_mcp_list_issue_references(${ctx.tokenHash},${ctx.sessionId}::uuid,${issues}::jsonb) as value`
								)[0].value,
							resolve: async (ref) =>
								(
									await sql`select customer_mcp_resolve_issue_reference(${ctx.tokenHash},${ctx.sessionId}::uuid,${ref}::uuid) as value`
								)[0].value,
						},
					);
				}

				throw Error("Unexpected provider tool");
			}
			const [{ plan }] =
				await sql`select customer_native_source_plan(${ctx.tokenHash},${ctx.sessionId}::uuid,${tool},${args}::jsonb,${key ?? null}) plan`;
			const visible = await validateNativeSources(
				a,
				await nativeResult(plan, key),
				tool !== "read_context",
				async () => {},
			);
			return nativeResult(
				(
					await sql`select customer_native_invoke(${ctx.tokenHash},${ctx.sessionId}::uuid,${tool},${args}::jsonb,${key ?? null},${`{${visible.join(",")}}`}::uuid[]) v`
				)[0].v,
				key,
			);
		},
	});
	async function event(f, input, eventId = crypto.randomUUID()) {
		const revision = f.request.definition.revision;
		await sql`insert into customer_events(id,workspace_id,customer_id,provider_event_id,topic,object_type,external_id,occurred_at,payload,routing) values(${eventId},${f.w},${f.customer},${eventId},'operator.message','customer',${f.customer},now(),'{}','matched') on conflict do nothing`;
		const occurrenceId = occurrenceDigest([
			f.w,
			f.id,
			revision,
			"instruction",
			eventId,
		]);
		await sql`insert into customer_automation_outbox(binding_id,revision,event_id,occurrence_id,input) values(${f.id},${revision},${eventId},${occurrenceId},${input}) on conflict do nothing`;
		return { definition: f.request.definition, eventId, input, occurrenceId };
	}
	async function control(body) {
		const f = fixtures.get(body.fixture ?? "main");
		assert.ok(f);
		if (body.op === "event") return event(f, body.input);
		if (body.op === "arm-lifecycle-pause") {
			assert.ok(requireLifecycleAuthority);
			assert.equal(lifecycleFixtures.get(`denied-${body.operation}`), f);
			pauseBoundary = { operation: body.operation, fixture: f };
			return {};
		}
		if (body.op === "proof") {
			const [thread] =
				await sql`select * from customer_threads where customer_id=${f.customer}`;
			assert.ok(thread);
			await sql`insert into customer_outcome_proofs(id,workspace_id,customer_id,thread_id,kind,evidence,scope_revision,expires_at) values(${crypto.randomUUID()},${f.w},${f.customer},${thread.id},'source_validation','{}',(select revision from customer_agents where id=${f.customer}),now()+interval '5 minutes')`;
			return {};
		}
		if (body.op === "arm-result-loss") {
			resultLossArmed = true;
			lostResult = false;
			resultLossFixture = f;
			return {};
		}
		if (body.op === "facts")
			return {
				facts: (
					await sql`select body from customer_facts where customer_id=${f.customer}`
				).map((x) => x.body),
				work: await sql`select objective,status from customer_threads where customer_id=${f.customer}`,
			};
		if (body.op === "withdraw-secondary") {
			assert.equal(f, both);
			const [mapping] =
				await sql`select verified_at::text verified_at from customer_mappings where customer_id=${f.customer} and connection_id=${f.slack}`;
			await sql`select customer_remove_source(${f.w}::uuid,${f.user}::uuid,${f.customer}::uuid,${f.slack}::uuid,'channel',${f.channel},${mapping.verified_at}::timestamptz)`;
			const [b] =
				await sql`select * from customer_automation_bindings where id=${f.id}`;
			assert.deepEqual(b.additional_sources, []);
			f.request.definition = {
				...b.definition,
				revision: Number(b.revision) + 1,
			};
			await sql`update customer_automation_bindings set revision=${f.request.definition.revision},definition=${f.request.definition}::jsonb,customer_revision=(select revision from customer_agents where id=${f.customer}),connection_id=${f.connection},object_type='customer',external_id=${f.resource.customerId},resource=${f.resource}::jsonb where id=${f.id}`;
			return { definition: f.request.definition };
		}
		if (body.op === "withdraw") {
			await sql`delete from customer_mappings where customer_id=${f.customer}`;
			f.request.definition = { ...f.request.definition, revision: 2 };
			f.connection = null;
			await sql`update customer_automation_bindings set revision=2,definition=${f.request.definition}::jsonb,connection_id=null,object_type='conversation',external_id=${f.customer},resource='{}' where id=${f.id}`;
			return { definition: f.request.definition };
		}
		if (body.op === "evidence") {
			for (const f of lifecycleFixtures.values()) {
				const [admission] =
					await sql`select completed_at from customer_automation_admissions where binding_id=${f.id}`;
				assert.equal(
					admission.completed_at,
					null,
					"paused callback cannot commit completion",
				);
				const [messages] =
					await sql`select count(*)::int n from customer_messages where customer_id=${f.customer} and author='coordinator'`;
				assert.equal(
					messages.n,
					0,
					"paused callback cannot publish a customer reply",
				);
			}
			assert.ok(
				evidence.mcpPreflights > 0,
				"Hosted POST preflight must be exercised",
			);
			assert.ok(
				evidence.mcpAuthorizations > 0,
				"Full SDK authorization remains required",
			);
			let rejectionReceipts = 0;
			if (toolRejection) {
				const [rejected] =
					await sql`select count(*)::int n from customer_native_rejections r join customer_native_grants g on g.id=r.grant_id where g.binding_id in (${source.id}::uuid,${both.id}::uuid) and r.tool='remember_context'`;
				rejectionReceipts = rejected.n;
				assert.equal(
					rejectionReceipts,
					2,
					"one immutable negative receipt per invalid operation despite lost ACK",
				);
				for (const [customer, marker] of [
					[source.customer, "WITHDRAWN_SOURCE_MARKER"],
					[both.customer, "COMBINED_SOURCE_MARKER"],
				]) {
					const [effects] =
						await sql`select count(*)::int n from customer_facts where customer_id=${customer}::uuid and body=${marker}`;
					assert.equal(effects.n, 1, "one corrected memory effect");
				}
			}
			let workRejectionReceipts = 0;
			if (workRejection) {
				const [rejected] =
					await sql`select count(*)::int n from customer_native_rejections r join customer_native_grants g on g.id=r.grant_id where g.binding_id=${main.id}::uuid and r.tool='track_work' and r.code='proof_required'`;
				workRejectionReceipts = rejected.n;
				const [replies] =
					await sql`select count(*)::int n from customer_messages where customer_id=${main.customer} and author='coordinator' and body='No matching outcome proof is available. I kept the work waiting.'`;
				assert.equal(
					replies.n,
					2,
					"both corrected source-free turns publish an honest waiting reply",
				);
				const [operations] =
					await sql`select count(*)::int n from customer_native_operations o join customer_native_grants g on g.id=o.grant_id where g.binding_id=${main.id}::uuid and o.tool='track_work'`;
				assert.equal(
					operations.n,
					4,
					"only create, two corrected waiting updates, and proof-backed verify commit",
				);
				assert.equal(
					workRejectionReceipts,
					2,
					"one immutable receipt per rejected work update despite ACK loss",
				);
			}
			if (workRejection && both) {
				const [rejected] =
					await sql`select count(*)::int n from customer_native_rejections r join customer_native_grants g on g.id=r.grant_id where g.binding_id=${both.id}::uuid and r.tool='track_work' and r.code='proof_required'`;
				const [replies] =
					await sql`select count(*)::int n from customer_messages where customer_id=${both.customer} and author='coordinator' and body='No matching outcome proof is available. I kept the work waiting.'`;
				assert.equal(
					replies.n,
					1,
					"provider-bound correction publishes one honest waiting reply",
				);
				assert.equal(
					rejected.n,
					1,
					"provider-bound coordinator receives the same no-effect work receipt",
				);
				const [operations] =
					await sql`select count(*)::int n from customer_native_operations o join customer_native_grants g on g.id=o.grant_id where g.binding_id=${both.id}::uuid and o.tool='track_work'`;
				assert.equal(
					operations.n,
					2,
					"provider-bound create and corrected waiting update only",
				);
			}
			const [facts] =
				await sql`select count(*)::int n from customer_facts where customer_id=${main.customer} and body='JOIN_REMEMBERED_DETAIL'`;
			assert.equal(facts.n, 1);
			const [thread] =
				await sql`select * from customer_threads where customer_id=${main.customer}`;
			assert.equal(thread.status, "verified");
			const [linked] =
				await sql`select count(*)::int n from customer_messages where customer_id=${main.customer} and author='coordinator' and thread_id=${thread.id}`;
			assert.ok(linked.n > 0);
			const [sessions] =
				await sql`select count(*)::int n from cyrus_agent_sessions where workspace_id=${main.w} and status='complete'`;
			const [activities] =
				await sql`select count(*)::int n from cyrus_agent_session_activities where workspace_id=${main.w}`;
			const [actions] =
				await sql`select count(*)::int n from customer_actions where customer_id=${main.customer} and status='succeeded'`;
			return {
				...evidence,
				lifecycleDenials,
				passed: true,
				memoryEffects: facts.n,
				rejectionReceipts,
				workRejectionReceipts,
				workStatus: thread.status,
				linkedMessages: linked.n,
				sessions: sessions.n,
				activities: activities.n,
				committedActions: actions.n,
				lostResult,
			};
		}
		throw Error("Unknown controlled operation");
	}
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 60,
		fetch: async (req) => {
			const path = new URL(req.url).pathname;
			try {
				if (path === "/mcp") {
					const method =
						req.method === "POST"
							? (
									await req
										.clone()
										.json()
										.catch(() => ({}))
								).method
							: req.method;
					const phase = [
						"initialize",
						"notifications/initialized",
						"tools/list",
						"tools/call",
						"GET",
						"DELETE",
					].includes(method)
						? method
						: "other";
					const measurement = {
						requests: 1,
						denied: 0,
						durationMs: 0,
						preflight: 0,
						preflightMs: 0,
						authorize: 0,
						authorizeMs: 0,
					};
					const start = performance.now();
					try {
						return await mcpMeasurement.run(measurement, async () => {
							const response = await mcp(req);
							if (!response.ok) {
								evidence.denials++;
								measurement.denied++;
							}
							return response;
						});
					} finally {
						measurement.durationMs = performance.now() - start;
						evidence.mcpPhases[phase] ??= Object.fromEntries(
							Object.keys(measurement).map((key) => [key, 0]),
						);
						const aggregate = evidence.mcpPhases[phase];
						for (const key of Object.keys(measurement))
							aggregate[key] += measurement[key];
					}
				}
				if (path === "/api/agent-sessions/v1/deliver") return sessions(req);
				if (path.startsWith("/api/automations/v1/")) {
					const operation = path.split("/").at(-1);
					let pausedHere = false;
					if (pauseBoundary?.operation === operation) {
						const input = await req.clone().json();
						const f = pauseBoundary.fixture;
						assert.equal(input.automationId, f.id);
						await sql`select customer_operator(${f.w}::uuid,${f.user}::uuid,${f.customer}::uuid,'pause','{"paused":true}')`;
						pausedHere = true;
						pauseBoundary = undefined;
					}
					const response = await callback(req, operation);
					if (pausedHere) {
						assert.equal(
							response.status,
							409,
							"current receiver must deny paused action",
						);
						lifecycleDenials.push({ operation, status: response.status });
					}
					if (!response.ok) evidence.denials++;
					if (
						operation === "result" &&
						response.ok &&
						resultLossArmed &&
						!lostResult
					) {
						lostResult = true;
						if (resultLossFixture === both)
							await control({ op: "withdraw-secondary", fixture: "both" });
						else
							await sql`update customer_agents set policy='{"memory":"disabled","thread":"disabled"}',revision=revision+1,generation=generation+1,paused=true where id=${main.customer}`;
						return new Response(null, { status: 503 });
					}
					return response;
				}
				if (req.headers.get("authorization") !== `Bearer ${supervisor}`)
					return new Response(null, { status: 401 });
				if (path === "/control")
					return Response.json(await control(await req.json()));
				return new Response(null, { status: 404 });
			} catch (error) {
				console.error("Joined fixture failure", path, error.message);
				return Response.json(
					{ error: "Controlled boundary failed" },
					{ status: 500 },
				);
			}
		},
	});
	let child;
	try {
		const fixturePath = join(directory, "fixture.json");
		await writeFile(
			fixturePath,
			JSON.stringify({
				origin: `http://127.0.0.1:${server.port}`,
				supervisor,
				workspaceId: main.w,
				definitions: [main, source, ...(both ? [both] : [])].map(
					(f) => f.request.definition,
				),
				combined,
			}),
			{ mode: 0o600 },
		);
		child = Bun.spawn(
			[
				"node",
				process.env.CYRUS_NATIVE_JOIN_DRIVER,
				directory,
				process.env.CYRUS_NATIVE_JOIN_PREFIX,
			],
			{ env: { ...process.env }, stdout: "inherit", stderr: "inherit" },
		);
		expect(await child.exited).toBe(0);
		const result = JSON.parse(
			await readFile(join(directory, "summary.json"), "utf8"),
		);
		await mkdir(process.env.CYRUS_NATIVE_JOIN_EVIDENCE, { recursive: true });
		await writeFile(
			join(process.env.CYRUS_NATIVE_JOIN_EVIDENCE, "joined-summary.json"),
			JSON.stringify(result, null, 2),
		);
		expect(result.hosted.passed).toBe(true);
	} finally {
		child?.kill();
		server.stop(true);
		await sql.close();
	}
}, 300000);
