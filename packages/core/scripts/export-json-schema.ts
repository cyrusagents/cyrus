#!/usr/bin/env npx tsx
/**
 * Export Zod schemas to JSON Schema files.
 *
 * Pipeline:  Zod (miko-core) → JSON Schema → Go structs (miko-update-server)
 *
 * Run:  npx tsx scripts/export-json-schema.ts
 * Or:   pnpm generate:json-schema
 */

import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	EdgeConfigPayloadSchema,
	EdgeConfigSchema,
	RepositoryConfigPayloadSchema,
	RepositoryConfigSchema,
} from "../src/config-schemas.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemasDir = resolve(__dirname, "../schemas");

const schemas = [
	{ name: "EdgeConfig", schema: EdgeConfigSchema },
	{ name: "EdgeConfigPayload", schema: EdgeConfigPayloadSchema },
	{ name: "RepositoryConfig", schema: RepositoryConfigSchema },
	{ name: "RepositoryConfigPayload", schema: RepositoryConfigPayloadSchema },
] as const;

for (const { name, schema } of schemas) {
	const jsonSchema = schema.toJSONSchema({ target: "draft-2020-12" });

	// Add a top-level $id for consumers that need it
	const output = {
		$id: `https://raw.githubusercontent.com/mikoagents/miko/main/packages/core/schemas/${name}.json`,
		...jsonSchema,
	};

	const filePath = join(schemasDir, `${name}.json`);
	writeFileSync(filePath, `${JSON.stringify(output, null, "\t")}\n`);
	console.log(`Wrote ${filePath}`);
}

console.log("Done — JSON Schema files generated.");
