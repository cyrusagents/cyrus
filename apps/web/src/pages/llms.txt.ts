import type { APIRoute } from "astro";

import { llmsText } from "../data/site";

export const prerender = true;

export const GET: APIRoute = ({ site }) => {
	if (!site) {
		return new Response("Site URL is not configured.\n", { status: 500 });
	}
	return new Response(llmsText(site), {
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
};
