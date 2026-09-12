import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

// Exercise the real Worker -> SDK -> shell subprocess boundary with an offline
// SDK fixture. This proves env/lifecycle wiring, not provider authentication.
it("isolates concurrent Cursor tool environments, preserves auth, resumes and stops", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cursor-personal-env-"));
	try {
		writeFileSync(
			join(dir, "register.mjs"),
			`import { register } from 'node:module'; register('./loader.mjs', import.meta.url);`,
		);
		writeFileSync(
			join(dir, "loader.mjs"),
			`export async function resolve(specifier, context, next) {
   if (specifier === '@cursor/sdk') return { url: new URL('./sdk.mjs', import.meta.url).href, shortCircuit: true };
   return next(specifier, context);
  }`,
		);
		writeFileSync(
			join(dir, "sdk.mjs"),
			`
   import { execFileSync } from 'node:child_process';
   import { writeFileSync, readFileSync } from 'node:fs';
   import { join } from 'node:path';
   function agent(options, resumed) {
    const cwd = options.local.cwd[0];
    const child = JSON.parse(execFileSync(process.execPath, ['-e', "process.stdout.write(JSON.stringify({gh:process.env.GH_TOKEN,github:process.env.GITHUB_TOKEN,author:process.env.GIT_AUTHOR_NAME,other:process.env.OTHER_USER_TOKEN,claude:process.env.CLAUDE_CODE_OAUTH_TOKEN,cursor:process.env.CURSOR_API_KEY}))"], { encoding: 'utf8' }));
    const agentId = resumed || 'agent-' + child.gh;
    if (resumed && readFileSync(join(cwd, 'session-id'), 'utf8') !== resumed) throw new Error('Unknown fixture session');
    writeFileSync(join(cwd, 'session-id'), agentId);
    writeFileSync(join(cwd, resumed ? 'captured-resumed.json' : 'captured.json'), JSON.stringify({ child, apiKey: options.apiKey, resumed }));
    let cancel;
    const stopped = new Promise(resolve => { cancel = resolve; });
    return { agentId: resumed || 'agent-' + child.gh, async [Symbol.asyncDispose]() { writeFileSync(join(cwd, 'closed'), 'yes'); }, async send(prompt) {
     if (prompt === 'fail') throw new Error('fixture failure');
     return { async *stream() {
      if (prompt === 'stop') await stopped;
      else await new Promise(resolve => setTimeout(resolve, 80));
     }, async cancel() { writeFileSync(join(cwd, 'canceled'), 'yes'); cancel(); } };
    }};
   }
   export const Agent = { create: options => agent(options, null), resume: (id, options) => agent(options, id) };
  `,
		);
		const runnerUrl = new URL("../dist/CursorRunner.js", import.meta.url).href;
		writeFileSync(
			join(dir, "test.mjs"),
			`
   import { CursorRunner } from ${JSON.stringify(runnerUrl)};
   import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
   import { join } from 'node:path';
   const dir = ${JSON.stringify(dir)};
   const make = (user, extra = {}) => {
    const workingDirectory = join(dir, user); mkdirSync(workingDirectory, { recursive: true });
    return new CursorRunner({ cyrusHome: workingDirectory, workingDirectory,
     additionalEnv: { GH_TOKEN: user, GITHUB_TOKEN: user, GIT_AUTHOR_NAME: user },
     omitEnv: ['OTHER_USER_TOKEN'], ...extra });
   };
   const a = make('ada'), b = make('bob');
   let messages = 0, completed = 0;
   a.on('message', () => messages++); a.on('complete', () => completed++);
   const sessions = await Promise.all([a.start('test'), b.start('test')]);
   const resume = make('ada', { resumeSessionId: sessions[0].sessionId });
   let resumeCompleted = 0; resume.on('complete', () => resumeCompleted++);
   const resumedSession = await resume.start('test');
   const c = make('cancel'); const stopping = c.start('stop');
   while (!existsSync(join(dir, 'cancel', 'captured.json'))) await new Promise(resolve => setTimeout(resolve, 10));
   c.stop(); await stopping;
   const d = make('failure'); let errors = 0, errorCompleted = 0; d.on('complete', () => errorCompleted++);
   d.on('error', () => errors++); await d.start('fail');
   writeFileSync(join(dir, 'result.json'), JSON.stringify({ sessions, resumedSession, resumeCompleted, messages, completed, errors, errorCompleted, stoppedRunning: c.isRunning(), failedRunning: d.isRunning(),
    failed: d.getMessages().at(-1).is_error,
    parent: { gh: process.env.GH_TOKEN, other: process.env.OTHER_USER_TOKEN },
   }));
  `,
		);
		await promisify(execFile)(
			process.execPath,
			["--import", join(dir, "register.mjs"), join(dir, "test.mjs")],
			{
				timeout: 15000,
				env: {
					PATH: process.env.PATH,
					HOME: dir,
					GH_TOKEN: "host-placeholder",
					GITHUB_TOKEN: "host-placeholder",
					OTHER_USER_TOKEN: "other-placeholder",
					CURSOR_API_KEY: "model-placeholder",
					CLAUDE_CODE_OAUTH_TOKEN: "existing-claude-placeholder",
				},
			},
		);
		for (const user of ["ada", "bob"]) {
			const capture = JSON.parse(
				readFileSync(join(dir, user, "captured.json"), "utf8"),
			);
			expect(capture).toEqual({
				child: {
					gh: user,
					github: user,
					author: user,
					cursor: "model-placeholder",
					claude: "existing-claude-placeholder",
				},
				apiKey: "model-placeholder",
				resumed: null,
			});
		}
		const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
		expect(result.parent).toEqual({
			gh: "host-placeholder",
			other: "other-placeholder",
		});
		expect(
			result.sessions.map((s: { sessionId: string; isRunning: boolean }) => [
				s.sessionId,
				s.isRunning,
			]),
		).toEqual([
			["agent-ada", false],
			["agent-bob", false],
		]);
		expect(result.messages).toBeGreaterThan(0);
		expect(result.completed).toBe(1);
		for (const user of ["ada", "bob", "cancel", "failure"]) {
			expect(readFileSync(join(dir, user, "closed"), "utf8")).toBe("yes");
		}
		expect(result.resumedSession).toMatchObject({
			sessionId: "agent-ada",
			isRunning: false,
		});
		expect(result.resumeCompleted).toBe(1);
		expect(
			JSON.parse(
				readFileSync(join(dir, "ada", "captured-resumed.json"), "utf8"),
			),
		).toMatchObject({
			resumed: "agent-ada",
			child: { gh: "ada", github: "ada" },
		});
		expect(result.stoppedRunning).toBe(false);
		expect(result.failedRunning).toBe(false);
		expect(result.errorCompleted).toBe(1);
		expect(result.errors).toBe(1);
		expect(result.failed).toBe(true);
		expect(readFileSync(join(dir, "cancel", "canceled"), "utf8")).toBe("yes");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 20000);
