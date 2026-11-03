#!/usr/bin/env node
// Fake cloudflared used by CloudflareTunnelClient tests. It makes no network
// calls. Each spawn records itself in FAKE_CLOUDFLARED_DIR and follows the
// behavior listed for its spawn index in plan.json:
//   "connect"              print 4 registered-connection lines, then idle
//   "connect-ignore-sigint" same, but ignore SIGINT (exercises SIGKILL escalation)
//   "connect1"             print only the first of the 4 connection lines
//   "hang"                 never connect
//   "exit:<code>"          exit immediately with <code>
// SIGUSR2 makes a running fake exit with code 11 (the incident's exit code).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_CLOUDFLARED_DIR;
const index = readdirSync(dir).filter((f) => f.startsWith("spawn-")).length;
writeFileSync(
	join(dir, `spawn-${index}.json`),
	JSON.stringify({ pid: process.pid, at: Date.now() }),
);
const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
const behavior = plan[Math.min(index, plan.length - 1)];

process.on("SIGUSR2", () => process.exit(11));
if (behavior.startsWith("exit:")) process.exit(Number(behavior.slice(5)));
if (behavior === "connect-ignore-sigint") process.on("SIGINT", () => {});

if (behavior.startsWith("connect")) {
	// A quick-tunnel style URL line makes the library emit 'url' (-> 'ready')
	process.stderr.write("INF |  https://fake-test.trycloudflare.com  |\n");
	const lines = behavior === "connect1" ? 1 : 4;
	// cloudflared logs one line per registration; the library parses one
	// registration per output chunk, so write them as separate chunks
	for (let i = 0; i < lines; i++) {
		const id = `0000000${i}-0000-4000-8000-00000000000${i}`;
		setTimeout(
			() => {
				process.stderr.write(
					`INF Registered tunnel connection connIndex=${i} connection=${id} event=0 ip=127.0.0.${i + 1} location=test${i} protocol=quic\n`,
				);
			},
			10 * (i + 1),
		);
	}
	// Informational error output after connecting must not trigger a restart
	setTimeout(() => {
		process.stderr.write(
			'ERR failed to fetch features error="lookup failed"\n',
		);
	}, 60);
}
setInterval(() => {}, 1 << 30);
