import { fileURLToPath } from "node:url";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

const dist = fileURLToPath(new URL("./dist", import.meta.url));

// Assets-only Worker: Astro's static build is uploaded as-is. Workers Builds
// runs `pnpm --filter @miko/web build` before `alchemy deploy`, so this stack
// does not invoke a second build.
export default Alchemy.Stack(
	"miko-web",
	{
		providers: Cloudflare.providers(),
		state: Cloudflare.state(),
	},
	Effect.gen(function* () {
		const { stage } = yield* Alchemy.Stack;
		const site = yield* Cloudflare.Worker("Website", {
			name: stage === "production" ? "miko-web" : undefined,
			workersDev: true,
			compatibility: { date: "2026-09-25" },
			assets: {
				directory: dist,
				htmlHandling: "auto-trailing-slash",
				notFoundHandling: "404-page",
			},
		});
		return { url: site.url };
	}),
);
