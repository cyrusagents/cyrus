/**
 * Pure helpers for detecting agent "deliverable" files in a git worktree.
 *
 * When an issue-bound agent session completes, these identify the files worth
 * surfacing on the Linear issue (the `.md` spec it wrote, a generated `.pdf`,
 * etc.) — as opposed to code, config, and build noise — so they can be
 * uploaded and attached without the user digging through git or a PR.
 *
 * Factored out of GitService so the filtering logic is unit-testable without
 * a real worktree.
 */

import { extname } from "node:path";

/**
 * File extensions treated as deliverables. Lower-case, including the dot.
 * Deliberately narrow — documents and images an agent produces as output,
 * not source code or config.
 */
export const DELIVERABLE_EXTENSIONS: ReadonlySet<string> = new Set([
	".md",
	".markdown",
	".pdf",
	".docx",
	".doc",
	".csv",
	".xlsx",
	".pptx",
	".png",
	".jpg",
	".jpeg",
	".svg",
]);

/**
 * Path segments / filenames that disqualify a file regardless of extension —
 * dependency trees, build output, lockfiles, and repo-standard docs an agent
 * might touch incidentally.
 */
const EXCLUDED_SEGMENTS: ReadonlySet<string> = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	".next",
	"out",
	"coverage",
	".turbo",
	".cache",
]);

const EXCLUDED_FILENAMES: ReadonlySet<string> = new Set([
	"changelog.md",
	"changelog.internal.md",
	"pnpm-lock.yaml",
	"package-lock.json",
	"yarn.lock",
]);

/**
 * Parse `git status --porcelain` output into a list of repo-relative paths
 * that currently exist on disk (added / modified / untracked / renamed-to).
 *
 * Porcelain v1 format: 2 status columns, a space, then the path. Renames are
 * `R  old -> new` — we take `new`. Deletions (`D`) are skipped. Paths Git
 * quotes (when they contain unusual chars) are left as-is and will simply
 * fail the later existence check rather than being mis-handled.
 */
export function parseGitPorcelain(output: string): string[] {
	const paths: string[] = [];
	for (const rawLine of output.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (line.length < 4) continue;
		const status = line.slice(0, 2);
		// Skip pure deletions.
		if (status === " D" || status === "D " || status === "DD") continue;
		let pathPart = line.slice(3);
		// Renames / copies: "old -> new" — keep the destination.
		const arrow = pathPart.indexOf(" -> ");
		if (arrow !== -1) {
			pathPart = pathPart.slice(arrow + 4);
		}
		// Strip surrounding quotes Git adds for paths with special chars.
		if (pathPart.startsWith('"') && pathPart.endsWith('"')) {
			pathPart = pathPart.slice(1, -1);
		}
		pathPart = pathPart.trim();
		if (pathPart) paths.push(pathPart);
	}
	return paths;
}

/**
 * Keep only paths that look like agent deliverables: extension in
 * {@link DELIVERABLE_EXTENSIONS}, and no excluded path segment, dotfile, or
 * excluded filename anywhere in the path.
 */
export function filterDeliverables(paths: string[]): string[] {
	const seen = new Set<string>();
	const kept: string[] = [];
	for (const p of paths) {
		if (seen.has(p)) continue;
		seen.add(p);

		const segments = p.split("/");
		const filename = segments[segments.length - 1] ?? "";

		// Excluded directory segments anywhere in the path.
		if (segments.some((seg) => EXCLUDED_SEGMENTS.has(seg))) continue;
		// Dotfiles / dot-directories anywhere in the path.
		if (segments.some((seg) => seg.startsWith("."))) continue;
		// Explicitly excluded filenames (case-insensitive).
		if (EXCLUDED_FILENAMES.has(filename.toLowerCase())) continue;
		// Extension allowlist.
		if (!DELIVERABLE_EXTENSIONS.has(extname(filename).toLowerCase())) continue;

		kept.push(p);
	}
	return kept;
}

/** Minimal extension → MIME map for the deliverable types we upload. */
const CONTENT_TYPES: Record<string, string> = {
	".md": "text/markdown",
	".markdown": "text/markdown",
	".pdf": "application/pdf",
	".docx":
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".doc": "application/msword",
	".csv": "text/csv",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".pptx":
		"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".svg": "image/svg+xml",
};

/** Best-effort MIME type for a deliverable filename. */
export function contentTypeForFile(filename: string): string {
	return (
		CONTENT_TYPES[extname(filename).toLowerCase()] ?? "application/octet-stream"
	);
}
