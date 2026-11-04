import { marked } from "marked";

/**
 * Plane stores descriptions and comments as HTML; Cyrus reads plain text and
 * writes Markdown. Reading is deliberately simple: enough for prompts to read
 * naturally.
 */

const ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#39;": "'",
	"&nbsp;": " ",
};

export function htmlToText(html: string): string {
	if (!html) {
		return "";
	}
	return html
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<li[^>]*>/gi, "- ")
		.replace(/<\/(p|div|li|h[1-6]|blockquote|pre)>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Markdown (what the agent writes) to the HTML Plane stores and renders.
 * GitHub-flavoured, with single line breaks kept. Plane validates the HTML.
 *
 * marked puts a newline after every block tag; Plane's editor turns each of
 * those into an empty paragraph or an empty list item, so they are removed.
 * Code blocks are unaffected: their text is escaped, so no line in them can
 * end with a tag's ">".
 */
export function markdownToHtml(markdown: string): string {
	if (!markdown.trim()) {
		return "";
	}
	return (
		marked.parse(markdown, { async: false, gfm: true, breaks: true }) as string
	)
		.replace(/>\n+/g, ">")
		.trim();
}
