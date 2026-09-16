import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

const root = process.env.FAKE_RELEASE_ROOT;
const config = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
const tool = basename(process.argv[1]);
const args = process.argv.slice(2);
const clock = Number(readFileSync(join(root, "clock"), "utf8"));
function event(extra = {}) {
	appendFileSync(
		join(root, "events"),
		`${JSON.stringify({ command: tool, args, clock, ...extra })}\n`,
	);
}
function count(key) {
	const path = join(root, key);
	const next = (existsSync(path) ? Number(readFileSync(path, "utf8")) : 0) + 1;
	writeFileSync(path, String(next));
	return next;
}
function fail(code) {
	process.stdout.write(JSON.stringify({ error: { code } }));
	process.exit(1);
}
if (tool === "npm") {
	const name =
		args[0] === "publish"
			? basename(args[1]).replace("-1.2.3.tgz", "")
			: args[1].split("@")[0];
	const index = config.names.indexOf(name);
	const present = join(root, `published-${name}`);
	if (args[0] === "publish") {
		event({ name });
		if (config.rejectedPublish) fail("E503");
		writeFileSync(present, "yes");
		if (config.publishError) fail("EPUBLISHCONFLICT");
		process.exit(0);
	}
	if (args[0] !== "view") throw new Error(`Unexpected npm command ${args}`);
	const view = count(`view-${name}`);
	const published = existsSync(present);
	event({ name, published });
	if (config.preflightError && view === 1) fail("E503");
	if (config.permanentError) fail("E503");
	if (config.finalError && published && count(`final-${name}`) === 1)
		fail("E503");
	if (!published && !config.existing?.includes(index)) fail("E404");
	if (
		config.missing === index ||
		(published && clock < (config.delays?.[index] || 0))
	)
		fail("E404");
	const bytes = readFileSync(join(root, `registry-${name}.tgz`));
	const uploadedAll = config.names.every(
		(n, i) =>
			config.existing?.includes(i) || existsSync(join(root, `published-${n}`)),
	);
	const wrongTag =
		config.wrongTag === index || (config.tagDrift === index && uploadedAll);
	process.stdout.write(
		JSON.stringify({
			name,
			version: "1.2.3",
			"dist-tags": { latest: wrongTag ? "1.2.2" : "1.2.3" },
			dist: {
				tarball: `https://registry.npmjs.org/${name}/-/${name}-1.2.3.tgz`,
				integrity:
					config.wrongIntegrity === index
						? "sha512-wrong"
						: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
			},
		}),
	);
} else if (tool === "curl") {
	const name = args.at(-1).split("/")[3];
	event({ name });
	if (config.curlError && count(`curl-${name}`) === 1) process.exit(22);
	process.stdout.write(readFileSync(join(root, `registry-${name}.tgz`)));
} else if (tool === "git") {
	event();
	if (args[0] === "rev-parse") process.exit(config.existingGitTag ? 0 : 1);
} else if (tool === "gh") {
	event();
} else {
	throw new Error(`Unexpected command ${tool}`);
}
