import type { APIRoute } from "astro";

import { absoluteUrl, indexablePaths } from "../data/site";

export const prerender = true;

export const GET: APIRoute = ({ site }) => {
	if (!site) {
		return new Response("Site URL is not configured.\n", { status: 500 });
	}
	const urls = indexablePaths
		.map(
			(path) => `  <url>\n    <loc>${absoluteUrl(site, path)}</loc>\n  </url>`,
		)
		.join("\n");
	const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
	return new Response(body, {
		headers: { "Content-Type": "application/xml; charset=utf-8" },
	});
};
