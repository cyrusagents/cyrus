import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getCyrusAppUrl } from "cyrus-cloudflare-tunnel-client";
import { EdgeConfigPayloadSchema, getDefaultWorktreesDir } from "cyrus-core";
import dotenv from "dotenv";
import { z } from "zod";
import { loadRuntimeEnv } from "../utils/loadRuntimeEnv.js";

const managedNames = [
	"CYRUS_TEAM_ID",
	"ANTHROPIC_API_KEY",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"GEMINI_API_KEY",
	"OPENAI_API_KEY",
	"CODEX_API_KEY",
	"CURSOR_API_KEY",
	"SLACK_BOT_TOKEN",
] as const;
const value = z
	.string()
	.max(32768)
	.regex(/^[^\r\n\0]*$/);
const environment = z
	.object(
		Object.fromEntries(managedNames.map((name) => [name, value.optional()])),
	)
	.strict();
const schema = z
	.object({
		success: z.literal(true),
		bootstrap: z
			.object({
				contractVersion: z.literal(1),
				teamId: z.string().uuid(),
				cyrusConfig: EdgeConfigPayloadSchema.strict(),
				environment,
			})
			.strict(),
	})
	.strict();

async function privateWrite(path: string, text: string) {
	const temporary = `${path}.${randomUUID()}.tmp`;
	const file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(text);
		await file.sync();
	} finally {
		await file.close();
	}
	try {
		await rename(temporary, path);
		const directory = await open(dirname(path), "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} finally {
		await unlink(temporary).catch(() => {});
	}
}
async function readEnvironment(path: string): Promise<Record<string, string>> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await file.stat();
		if (
			!stat.isFile() ||
			stat.size > 1_000_000 ||
			stat.uid !== process.getuid?.()
		)
			throw new Error("Unsafe environment file");
		return dotenv.parse(await file.readFile());
	} finally {
		await file.close();
	}
}
async function boundedJson(response: Response) {
	if (!response.body) throw new Error("Missing bootstrap");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 2_000_000) throw new Error("Bootstrap exceeds limit");
			chunks.push(value);
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

/** Complete pending paired setup before starting any worker. Existing configured
 * and unpaired workflows retain their startup behavior. No workspace selector,
 * credential rotation, tunnel mutation, or model readiness override is provided. */
export async function ensureRuntimeBootstrap(
	cyrusHome: string,
): Promise<boolean> {
	const teamId = process.env.CYRUS_TEAM_ID;
	const apiKey = process.env.CYRUS_API_KEY;
	const configPath = join(cyrusHome, "config.json");
	if (!teamId || !apiKey || !process.env.CLOUDFLARE_TOKEN) return false;
	if (existsSync(configPath) && process.env.CYRUS_SETUP_PENDING !== "true")
		return false;
	try {
		const origin = new URL(getCyrusAppUrl());
		if (
			origin.protocol !== "https:" ||
			origin.username ||
			origin.password ||
			origin.pathname !== "/" ||
			origin.search ||
			origin.hash
		)
			throw new Error("Invalid bootstrap origin");
		const response = await fetch(`${origin.origin}/api/config/runtime`, {
			headers: { Authorization: `Bearer ${apiKey}`, "X-Cyrus-Team-Id": teamId },
			redirect: "error",
			signal: AbortSignal.timeout(15000),
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error("Bootstrap denied");
		}
		const { bootstrap } = schema.parse(await boundedJson(response));
		if (
			bootstrap.teamId !== teamId ||
			bootstrap.environment.CYRUS_TEAM_ID !== teamId ||
			process.env.CYRUS_TEAM_ID !== teamId ||
			process.env.CYRUS_API_KEY !== apiKey ||
			getCyrusAppUrl() !== origin.origin
		)
			throw new Error("Pairing changed");
		await mkdir(cyrusHome, { recursive: true, mode: 0o700 });
		const envPath = join(cyrusHome, ".env");
		const previous = await readEnvironment(envPath);
		if (
			previous.CYRUS_API_KEY !== apiKey ||
			(previous.CYRUS_TEAM_ID && previous.CYRUS_TEAM_ID !== teamId)
		)
			throw new Error("Persisted pairing differs");
		const encode = (values: Record<string, string>) => {
			const encoded = `${Object.entries(values)
				.map(([name, text]) => {
					const quote = ["'", '"', "`"].find((q) => !text.includes(q));
					if (!quote)
						throw new Error("Environment cannot be represented safely");
					return `${name}=${quote}${text}${quote}`;
				})
				.join("\n")}\n`;
			const parsed = dotenv.parse(encoded);
			if (Object.entries(values).some(([k, v]) => parsed[k] !== v))
				throw new Error("Environment encoding changed a value");
			return encoded;
		};
		// Recovery marker is persisted before either config/env changes. A crash
		// between files forces the same authenticated bootstrap on the next start.
		await privateWrite(
			envPath,
			encode({ ...previous, CYRUS_SETUP_PENDING: "true" }),
		);
		const config = {
			...bootstrap.cyrusConfig,
			repositories: bootstrap.cyrusConfig.repositories.map((repo) => ({
				...repo,
				workspaceBaseDir:
					repo.workspaceBaseDir || getDefaultWorktreesDir(cyrusHome),
			})),
		};
		await privateWrite(configPath, JSON.stringify(config, null, 2));
		const next = { ...previous };
		for (const name of managedNames) delete next[name];
		Object.assign(next, bootstrap.environment, {
			CYRUS_APP_URL: origin.origin,
		});
		delete next.CYRUS_SETUP_PENDING;
		await privateWrite(envPath, encode(next));
		for (const name of managedNames) delete process.env[name];
		delete process.env.CYRUS_SETUP_PENDING;
		loadRuntimeEnv(envPath);
		return true;
	} catch {
		// Zod, network and filesystem errors may contain configured secrets.
		throw new Error(
			"Registered runtime bootstrap failed; existing pairing retained. Verify workspace configuration at the selected Cyrus origin.",
		);
	}
}
