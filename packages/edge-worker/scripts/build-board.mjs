import { appendFile, copyFile, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = new URL("../", import.meta.url);
await mkdir(new URL("dist/board/", root), { recursive: true });
await build({
	absWorkingDir: fileURLToPath(root),
	entryPoints: ["board/frontend.js"],
	bundle: true,
	jsx: "automatic",
	minify: true,
	format: "esm",
	target: ["es2022"],
	outfile: "dist/board/app.js",
	define: { "process.env.NODE_ENV": '"production"' },
	legalComments: "linked",
});
for (const name of ["@hugeicons/react", "@hugeicons/core-free-icons"]) {
	const license = await readFile(
		new URL(`node_modules/${name}/LICENSE.md`, root),
		"utf8",
	);
	await appendFile(
		new URL("dist/board/app.js.LEGAL.txt", root),
		`\n${name}\n${license}\n`,
	);
}
await copyFile(
	new URL("board/index.html", root),
	new URL("dist/board/index.html", root),
);
await copyFile(
	new URL("node_modules/@melloware/react-logviewer/LICENSE", root),
	new URL("dist/board/react-logviewer-LICENSE.txt", root),
);
