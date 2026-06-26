import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(packageRoot, "dist");

mkdirSync(dist, { recursive: true });

cpSync(
	resolve(packageRoot, "label-prompt-template.md"),
	resolve(dist, "label-prompt-template.md"),
);

rmSync(resolve(dist, "prompts"), { recursive: true, force: true });
cpSync(resolve(packageRoot, "prompts"), resolve(dist, "prompts"), {
	recursive: true,
});

rmSync(resolve(dist, "cyrus-skills-plugin"), { recursive: true, force: true });
cpSync(
	resolve(packageRoot, "cyrus-skills-plugin"),
	resolve(dist, "cyrus-skills-plugin"),
	{ recursive: true, dereference: true },
);
