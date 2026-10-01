// Exact-source seams extend (rather than replace) the existing child assertions.
export function extendChildSuccessor({ test, driver, replaceOnce: r }) {
	if (process.env.CYRUS_NATIVE_JOIN_WORKFLOW_RETRY === "1") {
		test = r(
			test,
			"const server = Bun.serve({",
			"const server = Bun.serve({idleTimeout:60,",
		);
		test = r(
			test,
			'mode.startsWith("operator-recovery") ? 150_000 : 60_000',
			'mode.startsWith("operator-recovery") ? 150_000 : 120_000',
		);
	}
	driver = `import {childSuccessorRuntime} from './child-successor-runtime.mjs';\n${driver}`;
	driver = r(
		driver,
		"const expectedResults =",
		"const successor=childSuccessorRuntime(fixture,nativeFetch,local);\nconst expectedResults =",
	);
	driver = r(
		driver,
		"async next(messages, authority) {",
		"inspectRequest: (request,c)=>successor.inspectRequest(request,c),\n    async next(messages, authority) {\n      const continued=successor.next(messages,authority);if(continued)return continued;",
	);
	driver = r(
		driver,
		'text:"Read the issue from the customer\'s approved mapping."',
		"text:fixture.childContinuation.findings",
	);
	driver = r(
		driver,
		"new ScopedAutomationMcpClient(",
		"successor.tools(new ScopedAutomationMcpClient(",
	);
	driver = r(
		driver,
		"      signal,\n    ),",
		"      signal,\n    ),authority),",
	);
	driver = r(
		driver,
		'  await writeFile(\n    join(directory, "summary.json"),',
		'  const originalResultTransmissions=resultTransmissions;\n  const continuation=await successor.finish(address,request);\n  assert.equal(resultTransmissions,originalResultTransmissions+1);\n  await writeFile(\n    join(directory, "summary.json"),',
	);
	driver = r(
		driver,
		"      resultTransmissions,",
		"      resultTransmissions:originalResultTransmissions,\n      continuation,",
	);
	test = `import {prepareChildSuccessor} from './child-successor-hosted.mjs';\n${test}`;
	test = r(
		test,
		"        let providerCalls = 0;",
		"        const successor=await prepareChildSuccessor(sql,f,initial,supervisor);\n        let providerCalls = 0;",
	);
	test = r(
		test,
		"            return result;\n          },\n          async callback(p)",
		"            return successor.admit(p,result);\n          },\n          async callback(p)",
	);
	test = r(
		test,
		"        const mcp = createCustomerMcpHandler({",
		'        const mcp = createCustomerMcpHandler({\n          protocolAdmission: "current-sql-v1",',
	);
	// Keep all original catalog/provider tool logic; SQL snapshot exposes native
	// context only on the successor admitted by the normal callback handshake.
	test = r(
		test,
		// biome-ignore lint/suspicious/noTemplateCurlyInString: exact frozen source seam, evaluated only in the generated fixture.
		"async preflight(token, session) { return mcpAuthoritySchema.parse((await sql`select customer_mcp_authorize(${token},${session}::uuid,null) as value`)[0].value); }",
		"async preflight(token, session) { return successor.authorize(token,session); }",
	);
	test = r(
		test,
		`          async authorize(token, session, tool) {
            return mcpAuthoritySchema.parse(
              (
                await sql\`select customer_mcp_authorize(\${token},\${session}::uuid,\${tool ?? null}) as value\`
              )[0].value,
            );
          },`,
		`          async authorize(token, session, tool) {
            return successor.authorize(token,session,tool);
          },`,
	);
	test = r(
		test,
		"          async invoke(authority, tool, args, operationKey, context) {",
		'          async invoke(authority, tool, args, operationKey, context) {\n            if(["read_context","remember_context","track_work"].includes(tool))return successor.invoke(tool,args,operationKey,context);',
	);
	test = r(
		test,
		"            const path = new URL(request.url).pathname;",
		'            const path = new URL(request.url).pathname;\n            if(path==="/fixture/child-successor")return successor.dispatch(request);',
	);
	test = r(
		test,
		// biome-ignore lint/suspicious/noTemplateCurlyInString: exact frozen source seam, evaluated only in the generated fixture.
		"            origin: `http://127.0.0.1:${server.port}`,",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: exact frozen source seam, evaluated only in the generated fixture.
		"            childContinuation:successor.config,\n            origin: `http://127.0.0.1:${server.port}`,",
	);
	test = r(
		test,
		"expect(native.requests).toBe(result.modelSteps);",
		"expect(native.requests).toBe(result.modelSteps+1);",
	);
	test = r(
		test,
		"expect(native.opens).toBe(expectedResults);",
		"expect(native.opens).toBe(expectedResults+1);",
	);
	test = r(
		test,
		"expect(timeline).toHaveLength(expectedResults);",
		"expect(timeline).toHaveLength(expectedResults+1);",
	);
	test = r(
		test,
		"            for (const session of timeline) {",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: exact frozen source seam, evaluated only in the generated fixture.
		'            for (const session of timeline) {\n              if(session.id===`automation:${f.id}:${result.continuation.occurrenceId}`){expect(session.status).toBe("complete");expect(session.activities.filter(a=>a.content.type==="action")).toHaveLength(2);expect(session.activities.filter(a=>a.content.type==="response")).toHaveLength(1);continue;}',
	);
	// Original parent and child checks remain; the successor adds one parent reply
	// and completed admission. Native counts explicitly distinguish that extra turn.
	if (test.split(").toBe(childMode ? 1 : expectedResults);").length !== 3)
		throw Error("Child result-count assertions changed");
	test = test.replaceAll(
		").toBe(childMode ? 1 : expectedResults);",
		").toBe(childMode ? 2 : expectedResults);",
	);
	test = r(
		test,
		"          passed = true;",
		"          expect(result.continuation).toMatchObject({productionDispatcher:true,replyCount:1,outboxCount:1,memoryEffects:0,externalReplies:0,nativeWrites:0,nativeReads:1,freshContext:true,exactOriginalConstraints:true,workIdentityPreserved:true,fullNativePrompt:true});\n          passed = true;",
	);
	return { test, driver };
}
