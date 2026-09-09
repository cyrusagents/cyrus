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

/**
 * A short-lived GitHub App installation token pushed by cyrus-hosted.
 * One entry per GitHub App installation (org or user account) the team
 * has attached.
 */
export interface GitHubInstallationToken {
	/** GitHub App installation ID this token was minted for */
	installationId: string;
	/** Org/user login the installation belongs to (e.g. "ceedaragents") */
	organization: string | null;
	/** GitHub account type of the installation target */
	accountType: "Organization" | "User" | null;
	/** Short-lived installation access token */
	token: string;
	/** ISO timestamp when the token expires */
	expiresAt: string;
}

/**
 * On-disk shape of `<cyrusHome>/github-tokens.json`.
 */
export interface GitHubTokensFile {
	version: 1;
	updatedAt: string;
	tokens: GitHubInstallationToken[];
}

/** Filename of the token store inside the Cyrus home directory */
export const GITHUB_TOKENS_FILENAME = "github-tokens.json";

/**
 * Extract the owner (org or user login) from a GitHub repository URL.
 * Supports:
 *   - https://github.com/owner/name and https://github.com/owner/name.git
 *   - git@github.com:owner/name.git
 *   - ssh://git@github.com/owner/name.git
 *   - github.com/owner/name (no scheme)
 *
 * Returns null for non-GitHub hosts or unparseable URLs.
 */
export function extractOwnerFromGitHubUrl(url: string): string | null {
	if (!url || typeof url !== "string") return null;
	const trimmed = url.trim();

	// SCP-like SSH form: git@github.com:owner/name.git
	const scpMatch = trimmed.match(/^[\w.-]+@github\.com:(.+)$/i);
	if (scpMatch?.[1]) {
		const owner = scpMatch[1].split("/")[0];
		return owner ? owner : null;
	}

	// URL forms (https://, ssh://, or scheme-less)
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
		? trimmed
		: `https://${trimmed}`;
	try {
		const parsed = new URL(withScheme);
		if (parsed.hostname.toLowerCase() !== "github.com") return null;
		const segments = parsed.pathname.split("/").filter(Boolean);
		const owner = segments[0];
		return owner ? owner : null;
	} catch {
		return null;
	}
}

/**
 * Returns true when the token is missing an expiry, the expiry is
 * unparseable, or the expiry is in the past.
 */
function isExpired(token: GitHubInstallationToken, now: number): boolean {
	const expiresAt = Date.parse(token.expiresAt);
	return Number.isNaN(expiresAt) || expiresAt <= now;
}

/**
 * Persistent store for per-installation GitHub App tokens, keyed by org.
 *
 * Tokens are pushed by cyrus-hosted via the `/api/update/github-tokens`
 * ConfigUpdater route and consumed lazily by the EdgeWorker (token
 * resolution, session env) and by the git credential helper script.
 *
 * Reads are cached on file mtime+size, so frequent lookups don't re-parse
 * the JSON while still picking up writes from the ConfigUpdater handler
 * (which runs in the same process but writes via this class too) or any
 * external writer.
 */
export class GitHubTokenStore {
	private cyrusHome: string;
	private cachedTokens: GitHubInstallationToken[] | null = null;
	private cachedMtimeMs: number | null = null;
	private cachedSize: number | null = null;

	constructor(cyrusHome: string) {
		this.cyrusHome = cyrusHome;
	}

	/** Absolute path of the token store file */
	get filePath(): string {
		return join(this.cyrusHome, GITHUB_TOKENS_FILENAME);
	}

	/**
	 * Atomically persist the given tokens (write to a temp file, then rename)
	 * with owner-only permissions (0600).
	 */
	save(tokens: GitHubInstallationToken[]): void {
		const file: GitHubTokensFile = {
			version: 1,
			updatedAt: new Date().toISOString(),
			tokens,
		};
		const target = this.filePath;
		mkdirSync(dirname(target), { recursive: true });
		const tmpPath = `${target}.tmp`;
		writeFileSync(tmpPath, JSON.stringify(file, null, 2), { mode: 0o600 });
		// writeFileSync `mode` only applies on creation — enforce on overwrite too
		chmodSync(tmpPath, 0o600);
		renameSync(tmpPath, target);
		// Invalidate the read cache so the next load reflects this write even
		// if the rename lands within the same mtime granularity window.
		this.cachedTokens = null;
		this.cachedMtimeMs = null;
		this.cachedSize = null;
	}

	/**
	 * Load all tokens from disk (including expired ones). Returns an empty
	 * array when the file is missing or unreadable/corrupt.
	 */
	load(): GitHubInstallationToken[] {
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
			) as Partial<GitHubTokensFile>;
			const tokens = Array.isArray(parsed.tokens)
				? parsed.tokens.filter(
						(t): t is GitHubInstallationToken =>
							!!t && typeof t === "object" && typeof t.token === "string",
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

	/**
	 * All non-expired tokens currently on disk.
	 */
	private loadValid(): GitHubInstallationToken[] {
		const now = Date.now();
		return this.load().filter((t) => !isExpired(t, now));
	}

	/**
	 * Return the non-expired token for the given org (case-insensitive),
	 * or undefined when no installation matches.
	 */
	getTokenForOrg(org: string): string | undefined {
		if (!org) return undefined;
		const lowered = org.toLowerCase();
		const match = this.loadValid().find(
			(t) =>
				typeof t.organization === "string" &&
				t.organization.toLowerCase() === lowered,
		);
		return match?.token;
	}

	/**
	 * Return the non-expired token for the owner of the given GitHub
	 * repository URL (https or ssh form), or undefined when the URL is not
	 * a GitHub URL or no installation matches the owner.
	 */
	getTokenForRepoUrl(url: string): string | undefined {
		const owner = extractOwnerFromGitHubUrl(url);
		if (!owner) return undefined;
		return this.getTokenForOrg(owner);
	}

	/**
	 * When exactly one non-expired token exists, return it (covers
	 * single-installation teams where the org name may not match, e.g.
	 * user-account installs). Otherwise undefined.
	 */
	getFallbackToken(): string | undefined {
		const valid = this.loadValid();
		return valid.length === 1 ? valid[0]?.token : undefined;
	}
}
