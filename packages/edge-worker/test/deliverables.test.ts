/**
 * Tests for deliverable-file detection helpers (auto-attach feature).
 */

import { describe, expect, it } from "vitest";
import {
	contentTypeForFile,
	DELIVERABLE_EXTENSIONS,
	filterDeliverables,
	parseGitPorcelain,
} from "../src/deliverables.js";

describe("parseGitPorcelain", () => {
	it("extracts added, modified and untracked paths", () => {
		const out = [
			" M src/index.ts",
			"A  docs/spec.md",
			"?? notes/draft.md",
			"M  README.md",
		].join("\n");
		expect(parseGitPorcelain(out)).toEqual([
			"src/index.ts",
			"docs/spec.md",
			"notes/draft.md",
			"README.md",
		]);
	});

	it("skips deletions", () => {
		const out = [" D removed.md", "D  gone.md", "A  kept.md"].join("\n");
		expect(parseGitPorcelain(out)).toEqual(["kept.md"]);
	});

	it("takes the destination path of a rename", () => {
		expect(parseGitPorcelain("R  old/spec.md -> new/spec.md")).toEqual([
			"new/spec.md",
		]);
	});

	it("strips quotes Git adds for special-char paths", () => {
		expect(parseGitPorcelain('?? "weird name.md"')).toEqual(["weird name.md"]);
	});

	it("ignores blank and too-short lines", () => {
		expect(parseGitPorcelain("\n\n M a.md\n")).toEqual(["a.md"]);
	});
});

describe("filterDeliverables", () => {
	it("keeps files with deliverable extensions", () => {
		expect(
			filterDeliverables([
				"docs/spec.md",
				"output/report.pdf",
				"assets/diagram.png",
			]),
		).toEqual(["docs/spec.md", "output/report.pdf", "assets/diagram.png"]);
	});

	it("drops source and config files", () => {
		expect(
			filterDeliverables([
				"src/index.ts",
				"package.json",
				"vite.config.ts",
				"styles.css",
			]),
		).toEqual([]);
	});

	it("drops anything under an excluded directory", () => {
		expect(
			filterDeliverables([
				"node_modules/pkg/readme.md",
				"dist/bundle.md",
				"build/out.pdf",
				"coverage/report.md",
			]),
		).toEqual([]);
	});

	it("drops dotfiles and dot-directories", () => {
		expect(filterDeliverables([".github/notes.md", "docs/.secret.md"])).toEqual(
			[],
		);
	});

	it("drops lockfiles and changelogs even with allowed-ish names", () => {
		expect(
			filterDeliverables([
				"CHANGELOG.md",
				"CHANGELOG.internal.md",
				"docs/CHANGELOG.md",
			]),
		).toEqual([]);
	});

	it("de-duplicates repeated paths", () => {
		expect(filterDeliverables(["a.md", "a.md", "b.pdf"])).toEqual([
			"a.md",
			"b.pdf",
		]);
	});

	it("is case-insensitive on the extension", () => {
		expect(filterDeliverables(["Report.MD", "Slides.PDF"])).toEqual([
			"Report.MD",
			"Slides.PDF",
		]);
	});
});

describe("contentTypeForFile", () => {
	it("maps known deliverable extensions", () => {
		expect(contentTypeForFile("spec.md")).toBe("text/markdown");
		expect(contentTypeForFile("report.pdf")).toBe("application/pdf");
		expect(contentTypeForFile("diagram.png")).toBe("image/png");
		expect(contentTypeForFile("photo.JPG")).toBe("image/jpeg");
	});

	it("falls back to octet-stream for unknown extensions", () => {
		expect(contentTypeForFile("mystery.xyz")).toBe("application/octet-stream");
		expect(contentTypeForFile("noext")).toBe("application/octet-stream");
	});
});

describe("DELIVERABLE_EXTENSIONS", () => {
	it("includes documents and images, excludes code", () => {
		expect(DELIVERABLE_EXTENSIONS.has(".md")).toBe(true);
		expect(DELIVERABLE_EXTENSIONS.has(".pdf")).toBe(true);
		expect(DELIVERABLE_EXTENSIONS.has(".png")).toBe(true);
		expect(DELIVERABLE_EXTENSIONS.has(".ts")).toBe(false);
		expect(DELIVERABLE_EXTENSIONS.has(".json")).toBe(false);
	});
});
