import type { APIRoute } from "astro";

import { absoluteUrl } from "../data/site";

export const prerender = true;

export const GET: APIRoute = ({ site }) => {
	if (!site) {
		return new Response("Site URL is not configured.\n", { status: 500 });
	}
	const body = [
		"# Search engines may index this site. AI answers may quote it. Model training is not granted.",
		"User-agent: *",
		"Content-Signal: search=yes, ai-input=yes, ai-train=no",
		"Allow: /",
		"",
		`Sitemap: ${absoluteUrl(site, "/sitemap.xml")}`,
		"",
	].join("\n");
	return new Response(body, {
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
};
