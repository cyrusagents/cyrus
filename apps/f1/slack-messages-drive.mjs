// Installed production runtime/SDK/native containment; controlled provider/model.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [prefixArg, sourceSha, evidenceArg] = process.argv.slice(2);
assert.ok(prefixArg && evidenceArg);
assert.match(sourceSha ?? "", /^[a-f0-9]{40}$/);
assert.match(process.env.CYRUS_F1_CODEX_IMAGE ?? "", /^sha256:[a-f0-9]{64}$/);
const modules = join(resolve(prefixArg), "lib/node_modules");
const evidence = resolve(evidenceArg);
await mkdir(evidence);
for (const name of ["cyrus-edge-worker", "cyrus-codex-runner"]) {
	const pkg = JSON.parse(await readFile(join(modules, name, "package.json")));
	assert.equal(pkg.cyrusLocalTestArtifact.sourceSha, sourceSha);
}
const source = await readFile(
	new URL("./automation-drive.mjs", import.meta.url),
	"utf8",
);
const driver = join(evidence, "installed-drive.mjs");
await writeFile(
	driver,
	source
		.replaceAll("../../packages/edge-worker/", `${modules}/cyrus-edge-worker/`)
		.replaceAll(
			"../../packages/codex-runner/",
			`${modules}/cyrus-codex-runner/`,
		),
);
const { runAutomationDrive } = await import(pathToFileURL(driver));
const result = await runAutomationDrive({ slackMessagesOnly: true });
delete result.directory;
const summary = {
	...result,
	sourceSha,
	driverSha256: createHash("sha256").update(source).digest("hex"),
};
await writeFile(
	join(evidence, "summary.json"),
	JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
