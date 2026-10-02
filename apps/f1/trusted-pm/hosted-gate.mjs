// Reuse frozen Hosted PM fixtures/production adapters and its installed driver.
// Overlays affect only a disposable archive; no Hosted checkout or product edits.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [
	checkoutArg,
	hostedSha,
	prefixArg,
	runtimeSha,
	evidenceArg,
	selectedCases,
] = process.argv.slice(2);
assert.match(hostedSha ?? "", /^[a-f0-9]{40}$/);
assert.match(runtimeSha ?? "", /^[a-f0-9]{40}$/);
assert.ok(checkoutArg && prefixArg && evidenceArg);
const checkout = resolve(checkoutArg),
	prefix = resolve(prefixArg),
	evidence = resolve(evidenceArg);
const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
	await readFile(
		join(prefix, "lib/node_modules/cyrus-ai/package.json"),
		"utf8",
	),
);
assert.equal(
	manifest.cyrusLocalTestArtifact?.sourceSha ??
		manifest.cyrusTestRelease?.sourceSha,
	runtimeSha,
);
const allCases = [
	"initial-off",
	"queued-withdrawal",
	"active-withdrawal",
	"terminal-recovery",
];
const cases = selectedCases ? selectedCases.split(",") : allCases;
assert.ok(cases.length > 0 && cases.every((value) => allCases.includes(value)));
assert.equal(new Set(cases).size, cases.length);
const work = await mkdtemp(join(tmpdir(), "cyrus-pm-team-gate-"));
await mkdir(evidence);
const run = (command, args, options = {}) =>
	execFileSync(command, args, { stdio: "inherit", ...options });
const replace = (source, before, after) => {
	assert.equal(
		source.split(before).length,
		2,
		`Frozen fixture anchor must occur once: ${before.slice(0, 90)}`,
	);
	return source.replace(before, after);
};
try {
	const archive = join(work, "source.tar"),
		frozen = join(work, "hosted");
	await mkdir(frozen);
	run("git", [
		"-C",
		checkout,
		"archive",
		"--format=tar",
		`--output=${archive}`,
		hostedSha,
	]);
	run("tar", ["-xf", archive, "-C", frozen]);
	for (const path of ["node_modules", "apps/app/node_modules"])
		await symlink(join(checkout, path), join(frozen, path));
	const testPath =
		"apps/app/src/lib/customer-agents/native-mcp.integration.test.mjs";
	const original = await readFile(join(frozen, testPath), "utf8");
	const between = (start, end) => {
		const a = original.indexOf(start),
			b = original.indexOf(end, a);
		assert.ok(a >= 0 && b > a, `Missing frozen fixture helper ${start}`);
		return original.slice(a, b);
	};
	const helpers =
		original.slice(
			0,
			original.indexOf('  test("automatic context read authority'),
		) +
		between("  async function enablePm(", '  test("one-way PM submission') +
		between(
			"  async function pmFixture()",
			'  test("PM admission is workspace-owned',
		);
	let test = original.slice(
		original.indexOf(
			"      const p = await pmFixture();",
			original.indexOf("  (process.env.CUSTOMER_PM_RUNTIME_PREFIX"),
		),
		original.lastIndexOf("    },\n    90000,"),
	);
	assert.ok(test.startsWith("      const p"));
	test = replace(
		test,
		"      let delivered = 0;",
		`      let delivered = 0;
      let progress = 0, denied = 0, configReads = 0, resultIdentity = null, afterTerminal = null;
      const deliveryAttempts = [];
      const journalSnapshot = async () => (await sql.unsafe('select status,last_sequence,(select count(*)::int from cyrus_agent_session_receipts r where r.workspace_id=s.workspace_id and r.session_id=s.id) receipts from cyrus_agent_sessions s where workspace_id=$1 and id=$2', [p.f.w, 'pm:' + p.pm + ':' + p.binding.occurrence_id]))[0];
      let finishDispatch;
      const dispatched = new Promise(resolve => { finishDispatch = resolve; });
      const setGate = enabled => sql.unsafe('update teams set is_admin_team=$1 where id=$2', [enabled, p.f.w]);
`,
	);
	test = replace(
		test,
		"        configuration: async (workspace) =>\n          (",
		"        configuration: async (workspace) =>\n          (configReads++,",
	);
	test = replace(
		test,
		'          if (args.p_operation === "result") transmissions++;',
		`          if (args.p_operation === 'result') {
            transmissions++;
            const identity = {key:args.p_request.idempotencyKey,text:args.p_request.text};
            if (resultIdentity) expect(identity).toEqual(resultIdentity);
            else resultIdentity = identity;
          }
          if (args.p_operation === 'progress') progress++;`,
	);
	test = replace(
		test,
		"            return Response.json({ occurrenceId: p.binding.occurrence_id });",
		"            finishDispatch();\n            return Response.json({ occurrenceId: p.binding.occurrence_id });",
	);
	test = replace(
		test,
		'          if (path.endsWith("/deliver")) return session(request);',
		`          if (path === '/fixture/withdraw') {
            if ('error' in (await authenticate(request))) return new Response(null, {status:401});
            await setGate(false);
            return Response.json({withdrawn:true});
          }
          if (path.endsWith('/authorize') && gateMode === 'initial-off') {
            await dispatched;
            await setGate(false);
          }
          if (path.endsWith('/deliver')) {
            const envelope = await request.clone().json();
            const response = await session(request);
            deliveryAttempts.push({fence:envelope.fence,kind:envelope.item.kind,sequence:envelope.item.sequence,itemDigest:hash(JSON.stringify(envelope.item)),status:response.status,afterTerminal:!!afterTerminal});
            return response;
          }`,
	);
	test = replace(
		test,
		'          if (path.endsWith("/result") && response.ok && !dropped) {',
		`          if (!response.ok) denied++;
          if (path.endsWith('/authorize') && response.ok && dropped) {
            const authority = await response.clone().json();
            expect(authority.authority.phase).toBe('reconcile');
            expect(authority.mcp).toBeUndefined();
          }
          if (path.endsWith("/result") && response.ok && !dropped) {`,
	);
	test = replace(
		test,
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal source in the frozen fixture overlay.
		"            await sql`update repositories set is_active=false where team_id=${p.f.w}`;",
		"            await setGate(false);\n            afterTerminal = {progress, delivered, configReads, journal:await journalSnapshot()};",
	);
	test = replace(
		test,
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal source in the frozen fixture overlay.
		"            origin: `http://127.0.0.1:${server.port}`,",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal source in the frozen fixture overlay.
		"            gateMode,\n            origin: `http://127.0.0.1:${server.port}`,",
	);
	const checksStart = test.indexOf(
		"        expect(summary.normalRunnerOpens).toBe(1);",
	);
	const checksEnd = test.indexOf("        passed = true;", checksStart);
	assert.ok(checksStart > 0 && checksEnd > checksStart);
	const existingChecks = test.slice(checksStart, checksEnd);
	test =
		test.slice(0, checksStart) +
		`        if (gateMode === 'terminal-recovery') {
${existingChecks}
          expect(progress).toBe(afterTerminal.progress);
          expect(await journalSnapshot()).toEqual(afterTerminal.journal);
          const cleanup = deliveryAttempts.filter(item => item.afterTerminal);
          expect(cleanup).toHaveLength(1);
          expect(cleanup[0]).toMatchObject({fence:2,kind:'session',sequence:1,status:200});
          const originalSession = deliveryAttempts.find(item => !item.afterTerminal && item.kind === 'session' && item.sequence === 1);
          expect(cleanup[0].itemDigest).toBe(originalSession.itemDigest);
          expect(configReads).toBe(afterTerminal.configReads);
        } else {
          expect(transmissions).toBe(0);
          expect(denied).toBeGreaterThan(0);
          const rows = await sql.unsafe('select completed_at from customer_pm_admissions where submission_id=$1', [p.receipt.submissionId]);
          expect(rows.every(row => row.completed_at === null)).toBe(true);
          if (gateMode === 'initial-off') expect(rows.length).toBe(0);
        }
        const fanout = await sql.unsafe("select count(*)::int n from customer_events where customer_id=$1 and topic in ('engineering.result','automation.pm.result')", [p.f.customer]);
        expect(fanout[0].n).toBe(0);
        await writeFile(join(process.env.CUSTOMER_PM_GATE_EVIDENCE, gateMode + '.json'), JSON.stringify({...summary, hostedSha: process.env.CUSTOMER_PM_GATE_HOSTED_SHA, runtimeSha: process.env.CUSTOMER_PM_GATE_RUNTIME_SHA, sql: {admissions, delivered, progress, denied, transmissions, configReads, afterTerminal, deliveryAttempts}, noCustomerFanout: true}, null, 2));
` +
		test.slice(checksEnd);
	const gateTest =
		helpers +
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal source in the frozen fixture overlay.
		"\n  for (const gateMode of CASES_PLACEHOLDER) test(`installed PM team gate: ${gateMode}`, async () => {\n" +
		test +
		"\n    }, 90000);\n});\n";
	await writeFile(
		join(frozen, "apps/app/src/lib/customer-agents/cypack-pm-gate.test.mjs"),
		gateTest.replace("CASES_PLACEHOLDER", JSON.stringify(cases)),
	);

	let driver = await readFile(
		join(frozen, "tooling/customer-pm-runtime-drive.mjs"),
		"utf8",
	);
	driver = replace(
		driver,
		"let opens = 0,\n  results = 0;",
		"let opens = 0, starts = 0, tools = 0, completed = 0, results = 0;",
	);
	driver = replace(
		driver,
		"await copyFile(appServerFixture, binary);",
		`await copyFile(appServerFixture, binary);
if (f.gateMode === 'active-withdrawal') {
  const source = await readFile(binary, 'utf8');
  const marker = 'if (JSON.stringify(params.input).includes("WAIT_REVOCATION")) continue;';
  assert.ok(source.includes(marker));
  await writeFile(binary, source.replace(marker, 'continue; // Controlled active turn waits for real gate withdrawal.'));
}`,
	);
	driver = replace(
		driver,
		"const slots = new SessionSemaphore(1);",
		'const slots = new SessionSemaphore(1);\nif (f.gateMode === "queued-withdrawal") await slots.acquire();',
	);
	driver = replace(
		driver,
		`    return capRunnerStarts(
      new CodexRunner({
        ...config,
        codexPath: binary,
        codexHome: join(home, "controlled-codex"),
      }),
      slots,
      beforeStart,
    );`,
		`    const runner = new CodexRunner({
      ...config,
      onMessage: message => {
        if (message.type === 'assistant') tools += (message.message?.content ?? []).filter(item => item.type === 'tool_use').length;
        if (message.type === 'result' && message.subtype === 'success') completed++;
        return config.onMessage?.(message);
      },
      codexPath: binary,
      codexHome: join(home, 'controlled-codex'),
    });
    const start = runner.start.bind(runner);
    runner.start = async prompt => { starts++; return start(prompt); };
    return capRunnerStarts(runner, slots, beforeStart);`,
	);
	driver = replace(
		driver,
		"  const deadline = Date.now() + 45000;",
		`  const waitFor = async predicate => {
    const end = Date.now() + 45000;
    while (!predicate()) {
      assert.ok(Date.now() < end, 'PM gate stage timeout');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  if (f.gateMode === 'queued-withdrawal' || f.gateMode === 'active-withdrawal') {
    await waitFor(() => f.gateMode === 'queued-withdrawal' ? slots.waiting === 1 : tools > 0);
    const withdrawn = await fetchLocal(new URL('/fixture/withdraw', origin), {method:'POST', headers});
    assert.equal(withdrawn.status, 200);
    if (f.gateMode === 'queued-withdrawal') slots.release();
  }
  const deadline = Date.now() + 45000;`,
	);
	driver = replace(
		driver,
		'runtime.status(f.definition.id).occurrences[0]?.status !== "completed"',
		'runtime.status(f.definition.id).occurrences[0]?.status !== (f.gateMode === "terminal-recovery" ? "completed" : "blocked")',
	);
	driver = replace(
		driver,
		"  assert.equal(opens, 1);\n  assert.equal(results, 2);",
		`  assert.equal(opens, f.gateMode === 'initial-off' ? 0 : 1);
  assert.equal(starts, ['active-withdrawal', 'terminal-recovery'].includes(f.gateMode) ? 1 : 0);
  assert.equal(results, f.gateMode === 'terminal-recovery' ? 2 : 0);
  assert.equal(completed, f.gateMode === 'terminal-recovery' ? 1 : 0);
  assert.equal(tools, ['active-withdrawal', 'terminal-recovery'].includes(f.gateMode) ? 1 : 0);`,
	);
	driver = replace(
		driver,
		"        normalRunnerOpens: opens,",
		"        gateMode: f.gateMode,\n        normalRunnerOpens: opens,\n        nativeStarts: starts,\n        toolCalls: tools,\n        nativeCompletions: completed,",
	);
	await writeFile(
		join(frozen, "tooling/customer-pm-runtime-drive.mjs"),
		driver,
	);
	await writeFile(
		join(evidence, "inputs.json"),
		JSON.stringify(
			{
				hostedSha,
				runtimeSha,
				cases,
				limits: [
					"Frozen Hosted helper and production adapter reuse; controlled app-server/model/provider; no live work",
				],
			},
			null,
			2,
		),
	);
	run("bun", ["--no-env-file", "tooling/test-customer-agents.mjs"], {
		cwd: frozen,
		env: {
			...process.env,
			CUSTOMER_TEST_FILE: "cypack-pm-gate.test.mjs",
			CUSTOMER_PM_RUNTIME_PREFIX: prefix,
			CUSTOMER_PM_APP_SERVER_FIXTURE: join(here, "app-server.fixture.mjs"),
			CUSTOMER_PM_GATE_EVIDENCE: evidence,
			CUSTOMER_PM_GATE_HOSTED_SHA: hostedSha,
			CUSTOMER_PM_GATE_RUNTIME_SHA: runtimeSha,
		},
	});
} finally {
	await rm(work, { recursive: true, force: true });
}
