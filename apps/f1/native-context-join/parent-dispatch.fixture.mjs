import { expect, mock, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SQL } from "bun";
import { createSessionDeliveryHandler } from "../agent-sessions/delivery-handler.ts";
import { occurrenceDigest } from "./automation-contract.ts";
import { publishMcpEngineeringUsing } from "./engineering-mcp-handler.ts";
import { publishEngineeringUsing } from "./engineering-publication.ts";
import { engineeringMcpAuthoritySchema } from "./mcp-contract.ts";
import { createCustomerMcpHandler } from "./mcp-server.ts";
import { nativeAuthoritySchema } from "./native-context-contract";
import { sqlAdapter } from "./sql-adapter.mjs";

mock.module("server-only", () => ({}));
const hash = (s) => createHash("sha256").update(s).digest("hex");
test("production dispatcher delivers scoped engineering result to native parent", async () => {
	const sql = new SQL(process.env.CUSTOMER_AGENTS_TEST_DATABASE_URL, {
		max: 4,
	});
	const client = sqlAdapter(sql);
	const checked = (r) => {
		if (r.error) throw Error(r.error.message);
		if (r.data === null || r.data === undefined)
			throw Error("Missing fixture result");
		return r.data;
	};
	mock.module("./store", () => ({
		db: () => client,
		checked,
		checkedVoid: (r) => {
			if (r.error) throw Error(r.error.message);
		},
		json: (v) => JSON.parse(JSON.stringify(v)),
	}));
	mock.module("@/lib/sentry", () => ({ captureError: () => {} }));
	let runtimeOrigin,
		workspace,
		parentId,
		_assignmentId,
		dispatches = 0,
		deliveries = 0,
		wakes = 0,
		lostOccurrence = false;
	const sent = new Map();
	const nativeFetch = globalThis.fetch;
	const send = async (w, path, body) => {
		assert.equal(w, workspace);
		assert.ok(runtimeOrigin);
		const response = await nativeFetch(
			new URL(`/api/automations/v1/${path}`, runtimeOrigin),
			{
				method: body === undefined ? "GET" : "POST",
				headers: {
					authorization: "Bearer registration",
					"content-type": "application/json",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(8000),
			},
		);
		assert.ok(
			response.ok,
			`registered route ${path} returned ${response.status}`,
		);
		const ack = await response.json();
		if (path === "occurrences" && body.automationId === parentId) {
			const old = sent.get(body.eventId);
			if (old) assert.deepEqual(old, body);
			else sent.set(body.eventId, body);
			if (!lostOccurrence) {
				lostOccurrence = true;
				throw Error("Controlled lost occurrence ACK");
			}
		}
		return ack;
	};
	mock.module("./automation-transport", () => ({
		registeredAutomationRequest: send,
		customerAutomationReadiness: async (w) => {
			const c = await send(w, "capabilities");
			assert.equal(c.available, true);
			return {
				available: true,
				engineering: c.capabilities.engineering,
				target: c.target,
			};
		},
	}));
	mock.module("@/lib/sessions/auth", () => ({
		authenticateAgentRequest: async (r) =>
			r.headers.get("authorization") === "Bearer registration"
				? { teamId: workspace }
				: { error: "denied", status: 401 },
	}));
	mock.module("./connected-event-delivery", () => ({
		wakeConnectedCustomerWork: async (w) => {
			assert.equal(w, workspace);
			wakes++;
		},
	}));
	const { automationCallback } = await import("./automation-callback");
	const { deliverCustomerAutomations } = await import("./automation-dispatch");
	const { deliverEngineeringAutomations } = await import(
		"./engineering-automation-dispatch"
	);
	const native = async (h, s, t) =>
		(
			await sql`select customer_native_mcp_authorize(${h},${s}::uuid,${t ?? null}) v`
		)[0].v;
	const authority = async (h, s, t) => {
		const n = await native(h, s, t);
		if (n) return { ...nativeAuthoritySchema.parse(n), kind: "native" };
		return engineeringMcpAuthoritySchema.parse(
			(
				await sql`select engineering_mcp_authorize(${h},${s}::uuid,${t ?? null}) v`
			)[0].v,
		);
	};
	async function fixture(bind = true) {
		const w = crypto.randomUUID();
		const user = crypto.randomUUID();
		const c = crypto.randomUUID();
		const other = crypto.randomUUID();
		const github = crypto.randomUUID();
		const assignment = crypto.randomUUID();
		const thread = crypto.randomUUID();
		await sql`insert into teams(id) values(${w})`;
		await sql`insert into auth.users(id) values(${user})`;
		await sql`insert into customer_agents(id,workspace_id,name) values(${c},${w},'PRIVATE CUSTOMER A'),(${other},${w},'PRIVATE CUSTOMER B')`;
		await sql`insert into customer_threads(id,workspace_id,customer_id,objective) values(${thread},${w},${c},'PRIVATE SUPPORT')`;
		await sql`insert into customer_connections(id,workspace_id,provider,account_id,label,secret_encrypted,verified_at) values(${github},${w},'github','fixture','fixture','PRIVATE CREDENTIAL',now())`;
		await sql`insert into customer_engineering_assignments(id,workspace_id,sponsor_customer_id,github_connection_id,repository,base_sha,base_branch,head_branch,environment,technical_brief,synthetic_reproduction,files,allowed_paths,reviewed_by) values(${assignment},${w},${c},${github},'fixture/repo',${"a".repeat(40)},'main','cyrus/test','preview','Reviewed product defect','Synthetic input','{"index.ts":"export const n=1"}',array['index.ts'],${user})`;
		await sql`insert into customer_engineering_links(workspace_id,customer_id,thread_id,assignment_id,defect_evidence,verified_by) values(${w},${c},${thread},${assignment},'PRIVATE DEFECT PROVENANCE',${user})`;
		if (!bind) return { w, user, c, other, github, assignment, thread };
		const binding = (
			await sql`select engineering_automation_bind(${w}::uuid,${assignment}::uuid,'{"harness":"codex","model":"gpt-5.5"}') b`
		)[0].b;
		expect(binding.occurrence_id).toBe(
			occurrenceDigest([w, assignment, 1, "instruction", binding.event_id]),
		);
		const request = {
			contractVersion: 1,
			instanceId: crypto.randomUUID(),
			automationId: assignment,
			revision: 1,
			occurrenceId: binding.occurrence_id,
			attemptId: crypto.randomUUID(),
			fence: 1,
			definition: binding.definition,
			phase: "admit",
			occurrence: {
				id: binding.occurrence_id,
				trigger: "instruction",
				scheduledAt: null,
				input: "Execute reviewed engineering assignment",
			},
		};
		const admit = async (changes = {}, token = "token-a", workspace = w) =>
			(
				await sql`select engineering_automation_admit(${workspace}::uuid,${changes.instanceId ?? request.instanceId}::uuid,${hash("registration")},${{ ...request, ...changes }}::jsonb,${hash(assignment + token)}) result`
			)[0].result;
		return {
			w,
			user,
			c,
			other,
			github,
			assignment,
			thread,
			binding,
			request,
			admit,
		};
	}
	async function connected(f, provider) {
		const clients = [];
		const publicationGateway = {
			async authorize(h, e) {
				return (
					await sql`select customer_engineering_authorize(${h},${e}::uuid,'operation') v`
				)[0].v;
			},
			async prepare(h, e, k, p) {
				return (
					await sql`select customer_engineering_prepare(${h},${e}::uuid,${k},${p}::jsonb) v`
				)[0].v;
			},
			async begin(h, e, id) {
				await sql`select customer_engineering_begin(${h},${e}::uuid,${id}::uuid)`;
			},
			async checkpoint(h, e, id, p) {
				await sql`select customer_engineering_checkpoint(${h},${e}::uuid,${id}::uuid,${p}::jsonb)`;
			},
			async finish(id, status, result, error) {
				await sql`select customer_engineering_finish(${id}::uuid,${status},${result}::jsonb,${error ?? null})`;
			},
			async request(w, c, path, options) {
				expect(w).toBe(f.w);
				expect(c).toBe(f.github);
				return provider(path, options);
			},
		};
		const mcp = createCustomerMcpHandler({
			async preflight(h, s) {
				return authority(h, s);
			},
			async authorize(h, s, t) {
				return authority(h, s, t);
			},
			async open(h, p) {
				if (await native(h, null))
					return (
						await sql`select customer_native_mcp_session(${h},'open',null,${p}) id`
					)[0].id;
				return (
					await sql`select engineering_mcp_session(${h},'open',null,${p}) id`
				)[0].id;
			},
			async close(h, s) {
				if (await native(h, null)) {
					await sql`select customer_native_mcp_session(${h},'close',${s}::uuid,null)`;
					return;
				}
				await sql`select engineering_mcp_session(${h},'close',${s}::uuid,null)`;
			},
			async invoke(_a, tool, args, key, context) {
				if (_a.kind === "native") {
					expect(tool).toBe("read_context");
					return (
						await sql`select customer_native_invoke(${context.tokenHash},${context.sessionId}::uuid,${tool},${args}::jsonb,${key ?? null},'{}'::uuid[]) v`
					)[0].v;
				}
				expect(tool).toBe("publish_artifact");
				return publishMcpEngineeringUsing(
					{
						async authorize(hash, session) {
							return (
								await sql`select engineering_mcp_publication(${hash},${session}::uuid) v`
							)[0].v;
						},
						publish: (h, input) =>
							publishEngineeringUsing(publicationGateway, h, input),
						async receipt(assignment, run, key) {
							return (
								await sql`select x.id,x.status,a.repository from customer_engineering_actions x join customer_engineering_assignments a on a.id=x.assignment_id where x.assignment_id=${assignment} and x.run_id=${run} and x.idempotency_key=${key}`
							)[0];
						},
					},
					args,
					key,
					context,
				);
			},
		});
		const callback = async (request, operation) => {
			const body = await request.clone().json();
			const response = await automationCallback(request, operation);
			console.error(
				JSON.stringify({
					fixtureCallback: operation,
					status: response.status,
					phase: body.phase,
					engineering: body.automationId === f.assignment,
				}),
			);
			return response;
		};
		const deliver = createSessionDeliveryHandler({
			async authenticate(r) {
				return r.headers.get("authorization") === "Bearer registration"
					? { teamId: f.w }
					: { error: "denied", status: 401 };
			},
			async deliver(a) {
				deliveries++;
				if (a.p_request.automationId === parentId)
					return (
						await sql`select customer_session_deliver(${a.p_workspace}::uuid,${a.p_credential_hash},${a.p_request}::jsonb,${a.p_digest}) v`
					)[0].v;
				return (
					await sql`select engineering_session_deliver(${a.p_workspace}::uuid,${a.p_credential_hash},${a.p_request}::jsonb,${a.p_digest}) v`
				)[0].v;
			},
		});
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const path = new URL(request.url).pathname;
				if (path === "/fixture/dispatch") return dispatchControl(request);
				return path === "/mcp"
					? mcp(request)
					: path === "/api/agent-sessions/v1/deliver"
						? deliver(request)
						: callback(request, path.split("/").pop());
			},
		});
		async function authorize(changes = {}, headers = {}) {
			return fetch(new URL("/authorize", server.url), {
				method: "POST",
				headers: {
					authorization: "Bearer registration",
					"x-cyrus-engineering": "1",
					"x-cyrus-session-delivery": "1",
					...headers,
				},
				body: JSON.stringify({ ...f.request, ...changes }),
			});
		}
		async function connect(token) {
			const client = new Client({ name: "engineering-fixture", version: "1" });
			clients.push(client);
			const transport = new StreamableHTTPClientTransport(
				new URL("/mcp", server.url),
				{
					requestInit: { headers: { Authorization: `Bearer ${token}` } },
					reconnectionOptions: { maxRetries: 0 },
				},
			);
			await client.connect(transport);
			return { client, transport };
		}
		return {
			origin: server.url.toString(),
			authorize,
			connect,
			async close() {
				for (const c of clients) await c.close().catch(() => {});
				server.stop(true);
			},
		};
	}

	const f = await fixture();
	workspace = f.w;
	_assignmentId = f.assignment;
	parentId = crypto.randomUUID();
	const parentDefinition = {
		id: parentId,
		workspaceId: f.w,
		ownerId: f.w,
		namespace: f.c,
		scopeRef: f.c,
		revision: 1,
		state: "enabled",
		role: "coordinator",
		instruction: "Receive scoped engineering findings and cite their evidence.",
		schedule: null,
		target: { harness: "codex", model: "gpt-5.5" },
	};
	await sql`insert into customer_automation_bindings(id,workspace_id,customer_id,revision,customer_revision,definition,connection_id,object_type,external_id,resource) values(${parentId},${f.w},${f.c},1,1,${parentDefinition}::jsonb,null,'conversation',${f.c},'{}')`;
	const foreign = crypto.randomUUID(),
		foreignParentId = crypto.randomUUID();
	await sql`insert into customer_agents(id,workspace_id,name) values(${foreign},${f.w},'FOREIGN_CUSTOMER_SENTINEL')`;
	await sql`insert into customer_automation_bindings(id,workspace_id,customer_id,revision,customer_revision,definition,connection_id,object_type,external_id,resource) values(${foreignParentId},${f.w},${foreign},1,1,${{ ...parentDefinition, id: foreignParentId, namespace: foreign, scopeRef: foreign }}::jsonb,null,'conversation',${foreign},'{}')`;
	const proof = {
		productionDispatcher: true,
		occurrenceAckLost: false,
		duplicateDispatchDeduplicated: false,
		foreignCustomerDenied: false,
		withdrawnSponsorDenied: false,
		pausedCustomerDenied: false,
		publications: 0,
	};
	let negativeChecked = false;
	async function dispatchControl(request) {
		if (request.headers.get("authorization") !== "Bearer registration")
			return new Response(null, { status: 401 });
		const input = await request.json(),
			u = new URL(input.origin);
		assert.equal(u.hostname, "127.0.0.1");
		assert.equal(u.protocol, "http:");
		assert.equal(u.pathname, "/");
		assert.equal(u.username + u.password + u.search + u.hash, "");
		if (runtimeOrigin) assert.equal(runtimeOrigin, u.href);
		runtimeOrigin = u.href;
		dispatches++;
		await deliverEngineeringAutomations(f.w);
		const events =
			await sql`select * from customer_events where workspace_id=${f.w} and topic='engineering.result'`;
		if (!events.some((e) => e.payload.findings))
			return Response.json({
				...proof,
				done: false,
				parentEventCount: events.length,
			});
		if (!negativeChecked) {
			await sql`update customer_agents set paused=true where id=${f.c}`;
			await deliverCustomerAutomations(f.w, f.c);
			assert.equal(
				(
					await sql`select count(*)::int n from customer_automation_outbox where binding_id=${parentId}`
				)[0].n,
				0,
			);
			proof.pausedCustomerDenied = true;
			await sql`update customer_agents set paused=false where id=${f.c}`;
			await sql`update customer_engineering_links set withdrawn=true where assignment_id=${f.assignment}`;
			await deliverCustomerAutomations(f.w, f.c);
			assert.equal(
				(
					await sql`select count(*)::int n from customer_automation_outbox where binding_id=${parentId}`
				)[0].n,
				0,
			);
			proof.withdrawnSponsorDenied = true;
			await sql`update customer_engineering_links set withdrawn=false where assignment_id=${f.assignment}`;
			await deliverCustomerAutomations(f.w, foreign);
			assert.equal(
				events.every((e) => e.customer_id === f.c && e.thread_id === f.thread),
				true,
			);
			assert.equal(
				(
					await sql`select count(*)::int n from customer_automation_outbox where binding_id=${foreignParentId}`
				)[0].n,
				0,
			);
			proof.foreignCustomerDenied = true;
			negativeChecked = true;
		}
		// Preserve the dispatcher's actual bounded retry interval after a lost ACK.
		await deliverCustomerAutomations(f.w, f.c);
		await deliverCustomerAutomations(f.w, f.c);
		const rows =
			await sql`select * from customer_automation_outbox where binding_id=${parentId}`;
		assert.equal(new Set(rows.map((r) => r.event_id)).size, rows.length);
		for (const row of rows) {
			assert.equal(
				row.input,
				JSON.stringify({
					topic: "engineering.result",
					thread: f.thread,
					event: events.find((e) => e.id === row.event_id).payload,
				}),
			);
		}
		proof.occurrenceAckLost = lostOccurrence;
		proof.duplicateDispatchDeduplicated =
			rows.some((r) => r.attempts === 2) && rows.every((r) => r.attempts <= 2);
		proof.publications = creates;
		const findings = events.some((e) => e.payload.findings);
		const done =
			findings &&
			rows.length === events.length &&
			rows.every((r) => r.delivered_at) &&
			wakes > 0;
		return Response.json({ ...proof, done, parentEventCount: events.length });
	}
	const head = "b".repeat(40);
	let creates = 0;
	let pr;
	let publicationReads = 0;
	const gateway = await connected(f, async (path, options) => {
		if (path.endsWith("/git/ref/heads/main"))
			return { object: { sha: "a".repeat(40) } };
		if (path.endsWith(`/git/commits/${"a".repeat(40)}`))
			return { tree: { sha: "c".repeat(40) } };
		if (path.endsWith("/git/trees")) {
			expect(options.body.tree).toEqual([
				{
					path: "index.ts",
					mode: "100644",
					type: "blob",
					content: "export const n=2",
				},
			]);
			return { sha: "d".repeat(40) };
		}
		if (path.endsWith("/git/commits")) return { sha: head };
		if (path.endsWith("/git/refs")) {
			expect(
				(
					await sql`select result from customer_engineering_actions where run_id=${f.binding.run_id}`
				)[0].result.headSha,
			).toBe(head);
			return {};
		}
		if (path.endsWith("/pulls")) {
			creates++;
			pr = {
				number: 7,
				html_url: "https://github.com/fixture/repo/pull/7",
				body: options.body.body,
				head: {
					sha: head,
					ref: "cyrus/test",
					repo: { full_name: "fixture/repo" },
				},
				base: { ref: "main", repo: { full_name: "fixture/repo" } },
				merged_at: null,
			};
			throw new Error("Lost committed PR response");
		}
		if (path.includes("/pulls?")) {
			publicationReads++;
			return { items: [pr] };
		}
		throw new Error("Unexpected fixture route");
	});

	const directory = await mkdtemp(join(tmpdir(), "cyrus-parent-native-"));
	console.error(JSON.stringify({ privateFixtureDirectory: directory }));
	try {
		await writeFile(
			join(directory, "fixture.json"),
			JSON.stringify({
				origin: gateway.origin,
				supervisor: "registration",
				definition: f.binding.definition,
				parentDefinition,
				runtimeSha: process.env.CYRUS_NATIVE_JOIN_RUNTIME_SHA,
				findingsMarker: "SCOPED_ENGINEERING_FINDINGS",
				image: process.env.CYRUS_F1_CODEX_IMAGE,
				dockerPath: process.env.CYRUS_TEST_DOCKER_PATH,
				dockerHost: process.env.CYRUS_TEST_DOCKER_HOST,
			}),
			{ mode: 0o600 },
		);
		const processChild = Bun.spawn(
			[
				"node",
				process.env.CYRUS_PARENT_DRIVER,
				directory,
				process.env.CUSTOMER_AUTOMATION_RUNTIME_MODULES,
			],
			{
				env: {
					PATH: process.env.PATH,
					CYRUS_F1_CODEX_IMAGE: process.env.CYRUS_F1_CODEX_IMAGE,
					CYRUS_TEST_DOCKER_PATH: process.env.CYRUS_TEST_DOCKER_PATH,
					CYRUS_TEST_DOCKER_HOST: process.env.CYRUS_TEST_DOCKER_HOST,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [exit, out, err] = await Promise.all([
			processChild.exited,
			new Response(processChild.stdout).text(),
			new Response(processChild.stderr).text(),
		]);
		await writeFile(join(directory, "private-output.log"), out + err, {
			mode: 0o600,
		});
		await writeFile(
			join(process.env.CYRUS_NATIVE_JOIN_EVIDENCE, "hosted-partial.json"),
			JSON.stringify(
				{
					hostedSha: process.env.CYRUS_NATIVE_JOIN_HOSTED_SHA,
					runtimeSha: process.env.CYRUS_NATIVE_JOIN_RUNTIME_SHA,
					childExit: exit,
					proof,
					dispatches,
					wakes,
					deliveries,
					engineeringCompleted: (
						await sql`select count(*)::int n from engineering_automation_admissions where assignment_id=${f.assignment} and completed_at is not null`
					)[0].n,
					parentAdmissions: (
						await sql`select count(*)::int n from customer_automation_admissions where binding_id=${parentId}`
					)[0].n,
					parentOutbox: (
						await sql`select count(*)::int n from customer_automation_outbox where binding_id=${parentId}`
					)[0].n,
					publications: creates,
					publicationReconciliations: publicationReads,
				},
				null,
				2,
			),
		);
		assert.equal(exit, 0, `Private diagnostics: ${directory}`);
		const summary = JSON.parse(
			await readFile(join(directory, "summary.json"), "utf8"),
		);
		assert.equal(summary.passed, true);
		assert.equal(creates, 1);
		assert.equal(publicationReads, 1);
		const messages =
			await sql`select body from customer_messages where customer_id=${f.c}`;
		assert.ok(
			messages.some((m) => m.body.includes("SCOPED_ENGINEERING_FINDINGS")),
		);
		assert.ok(
			messages.some((m) =>
				m.body.includes("https://github.com/fixture/repo/pull/7"),
			),
		);
		assert.equal(
			(
				await sql`select count(*)::int n from customer_messages where customer_id=${foreign}`
			)[0].n,
			0,
		);
		const sessions =
			await sql`select id,status from cyrus_agent_sessions where workspace_id=${f.w}`;
		assert.ok(sessions.every((s) => s.status === "complete"));
		const nativeSummary = JSON.parse(
			await readFile(join(directory, "native-summary.json"), "utf8"),
		);
		assert.equal(nativeSummary.opens, nativeSummary.closes);
		await writeFile(
			join(process.env.CYRUS_NATIVE_JOIN_EVIDENCE, "parent-summary.json"),
			JSON.stringify(
				{
					runtime: summary,
					native: nativeSummary,
					dispatches,
					wakes,
					deliveries,
					hostedSha: process.env.CYRUS_NATIVE_JOIN_HOSTED_SHA,
					runtimeSha: process.env.CYRUS_NATIVE_JOIN_RUNTIME_SHA,
					limits: [
						"Production dispatch/callback/SQL/installed native real; registered-target routing and Workflow wake transport controlled",
						"GitHub transport/model synthetic; no live provider/UI proof",
					],
				},
				null,
				2,
			),
		);
	} finally {
		await gateway.close();
		await sql.close();
	}
}, 120_000);
