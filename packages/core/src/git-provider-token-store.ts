import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type GitProvider = "github" | "gitlab";

export interface GitProviderToken {
	provider: GitProvider;
	/** Hostname that owns the token, e.g. github.com or gitlab.example.com */
	host: string;
	/** Owner/group namespace used for path matching when present */
	namespace: string | null;
	/** Optional provider connection identifier from cyrus-hosted */
	connectionId?: string | null;
	/** Access token used for HTTPS git/API calls */
	token: string;
	/** ISO timestamp when the token expires. Null means non-expiring PAT/bot token. */
	expiresAt: string | null;
	/** Username to return to git. GitLab accepts oauth2 for OAuth tokens. */
	username?: string | null;
}

export interface GitProviderTokensFile {
	version: 1;
	updatedAt: string;
	tokens: GitProviderToken[];
}

export const GIT_PROVIDER_TOKENS_FILENAME = "git-provider-tokens.json";

function normalizeHost(host: string): string {
	return host.trim().toLowerCase();
}

function normalizeNamespace(
	namespace: string | null | undefined,
): string | null {
	const value = namespace?.trim().replace(/^\/+|\/+$/g, "");
	return value ? value.toLowerCase() : null;
}

function isExpired(token: GitProviderToken, now: number): boolean {
	if (!token.expiresAt) return false;
	const expiresAt = Date.parse(token.expiresAt);
	return Number.isNaN(expiresAt) || expiresAt <= now;
}

export function extractGitProviderRepoParts(url: string): {
	host: string;
	namespace: string | null;
} | null {
	if (!url || typeof url !== "string") return null;
	const trimmed = url.trim();

	const scpMatch = trimmed.match(/^[\w.-]+@([^:]+):(.+)$/);
	if (scpMatch?.[1] && scpMatch[2]) {
		const segments = scpMatch[2].replace(/\.git$/i, "").split("/");
		segments.pop();
		return {
			host: normalizeHost(scpMatch[1]),
			namespace: normalizeNamespace(segments.join("/")),
		};
	}

	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
		? trimmed
		: `https://${trimmed}`;
	try {
		const parsed = new URL(withScheme);
		const segments = parsed.pathname
			.replace(/\.git$/i, "")
			.split("/")
			.filter(Boolean);
		segments.pop();
		return {
			host: normalizeHost(parsed.hostname),
			namespace: normalizeNamespace(segments.join("/")),
		};
	} catch {
		return null;
	}
}

export class GitProviderTokenStore {
	private cyrusHome: string;
	private cachedTokens: GitProviderToken[] | null = null;
	private cachedMtimeMs: number | null = null;
	private cachedSize: number | null = null;

	constructor(cyrusHome: string) {
		this.cyrusHome = cyrusHome;
	}

	get filePath(): string {
		return join(this.cyrusHome, GIT_PROVIDER_TOKENS_FILENAME);
	}

	save(tokens: GitProviderToken[]): void {
		const file: GitProviderTokensFile = {
			version: 1,
			updatedAt: new Date().toISOString(),
			tokens,
		};
		const target = this.filePath;
		mkdirSync(dirname(target), { recursive: true });
		const tmpPath = `${target}.tmp`;
		writeFileSync(tmpPath, JSON.stringify(file, null, 2), { mode: 0o600 });
		chmodSync(tmpPath, 0o600);
		renameSync(tmpPath, target);
		this.cachedTokens = null;
		this.cachedMtimeMs = null;
		this.cachedSize = null;
	}

	load(): GitProviderToken[] {
		const target = this.filePath;
		if (!existsSync(target)) {
			this.cachedTokens = null;
			this.cachedMtimeMs = null;
			this.cachedSize = null;
			return [];
		}

		try {
			const stat = statSync(target);
			if (
				this.cachedTokens !== null &&
				this.cachedMtimeMs === stat.mtimeMs &&
				this.cachedSize === stat.size
			) {
				return this.cachedTokens;
			}

			const parsed = JSON.parse(
				readFileSync(target, "utf-8"),
			) as Partial<GitProviderTokensFile>;
			const tokens = Array.isArray(parsed.tokens)
				? parsed.tokens.filter(
						(t): t is GitProviderToken =>
							!!t &&
							typeof t === "object" &&
							(t.provider === "github" || t.provider === "gitlab") &&
							typeof t.host === "string" &&
							typeof t.token === "string",
					)
				: [];
			this.cachedTokens = tokens;
			this.cachedMtimeMs = stat.mtimeMs;
			this.cachedSize = stat.size;
			return tokens;
		} catch {
			return [];
		}
	}

	private loadValid(): GitProviderToken[] {
		const now = Date.now();
		return this.load().filter((t) => !isExpired(t, now));
	}

	getTokenForRepoUrl(
		url: string,
		provider?: GitProvider,
	): GitProviderToken | undefined {
		const parts = extractGitProviderRepoParts(url);
		if (!parts) return undefined;
		const host = normalizeHost(parts.host);
		const namespace = normalizeNamespace(parts.namespace);
		const candidates = this.loadValid().filter(
			(t) =>
				normalizeHost(t.host) === host &&
				(!provider || t.provider === provider),
		);

		if (namespace) {
			const match = candidates.find((t) => {
				const tokenNamespace = normalizeNamespace(t.namespace);
				return (
					tokenNamespace !== null &&
					(namespace === tokenNamespace ||
						namespace.startsWith(`${tokenNamespace}/`))
				);
			});
			if (match) return match;
		}

		return candidates.length === 1 ? candidates[0] : undefined;
	}
}
