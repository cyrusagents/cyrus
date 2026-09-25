import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// Canonical origin for sitemap, robots.txt, Open Graph, and JSON-LD.
// Set SITE_URL when the production hostname changes.
const site = (
	process.env.SITE_URL ?? "https://miko-web.nexmoe.workers.dev"
).replace(/\/$/, "");

if (!/^https?:\/\//.test(site)) {
	throw new Error("SITE_URL must be an absolute http(s) URL");
}

export default defineConfig({
	site,
	output: "static",
	vite: { plugins: [tailwindcss()] },
	devToolbar: { enabled: false },
});
