import { appendFile, copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/postcss";
import { build } from "esbuild";
import postcss from "postcss";

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
	loader: { ".woff2": "dataurl", ".jpg": "dataurl" },
	plugins: [
		{
			name: "fluid-styles",
			setup(bundler) {
				bundler.onLoad({ filter: /fluid\/theme\.css$/ }, async ({ path }) => {
					const result = await postcss([tailwindcss()]).process(
						await readFile(path, "utf8"),
						{ from: path },
					);
					// Existing board styles are unlayered. Keep component utilities at the
					// same cascade level so legacy element rules cannot override them.
					result.root.walkAtRules("layer", (rule) => {
						if (rule.nodes) rule.replaceWith(...rule.nodes);
						else rule.remove();
					});
					return {
						contents: result.root.toString(),
						loader: "css",
						resolveDir: dirname(path),
					};
				});
			},
		},
	],
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

for (const [name, path] of [
	["Fluid Functionalism", "board/fluid/LICENSE"],
	["Inter Variable", "node_modules/@fontsource-variable/inter/LICENSE"],
]) {
	await appendFile(
		new URL("dist/board/app.js.LEGAL.txt", root),
		`\n${name}\n${await readFile(new URL(path, root), "utf8")}\n`,
	);
}
