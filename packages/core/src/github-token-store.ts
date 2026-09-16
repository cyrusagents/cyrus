import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
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

/** A locally owned PAT, or a rotating environment reference. null revokes it. */
export type GitHubPersonalToken = { token: string } | { env: string };

function isPersonalToken(entry: unknown): entry is GitHubPersonalToken {
	if (!entry || typeof entry !== "object") return false;
	const e = entry as Record<string, unknown>;
	return (
		(typeof e.token === "string" &&
			!!e.token.trim() &&
			!/[\r\n]/.test(e.token.trim()) &&
			e.env === undefined) ||
		(typeof e.env === "string" &&
			/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.env) &&
			e.token === undefined)
	);
}

/**
 * On-disk shape of `<cyrusHome>/github-tokens.json`.
 */
export interface GitHubTokensFile {
	version: 1;
	updatedAt: string;
	tokens: GitHubInstallationToken[];
	personalTokens?: Record<string, GitHubPersonalToken | null>;
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

	/** Replace only hosted-owned installation tokens; preserve local PATs. */
	save(tokens: GitHubInstallationToken[]): void {
		this.update((file) => {
			file.tokens = tokens;
		});
	}

	/** Explicit provisioning is the only operation that can replace a revocation. */
	setPersonalToken(userId: string, credential: GitHubPersonalToken): void {
		if (!userId || !isPersonalToken(credential))
			throw new Error("Invalid personal GitHub credential");
		this.update((file) => {
			file.personalTokens = { ...file.personalTokens, [userId]: credential };
		});
	}

	/** Keep a tombstone so stale legacy config cannot re-import removed credentials. */
	removePersonalToken(userId: string): void {
		this.update((file) => {
			file.personalTokens = { ...file.personalTokens, [userId]: null };
		});
	}

	/** Import once, under the same lock as refresh/removal. Never overwrite a pin. */
	importPersonalToken(
		userId: string,
		credential: () => GitHubPersonalToken,
	): void {
		this.update((file) => {
			if (!Object.hasOwn(file.personalTokens ?? {}, userId)) {
				const imported = credential();
				if (!isPersonalToken(imported))
					throw new Error("Invalid personal GitHub credential");
				file.personalTokens = { ...file.personalTokens, [userId]: imported };
			}
		});
	}

	getPersonalEntry(userId: string): GitHubPersonalToken | undefined {
		const entries = this.readFile().personalTokens ?? {};
		return Object.hasOwn(entries, userId)
			? (entries[userId] ?? undefined)
			: undefined;
	}

	getPersonalToken(
		userId: string,
		env: NodeJS.ProcessEnv = process.env,
	): string | undefined {
		const entry = this.getPersonalEntry(userId);
		if (!entry) return undefined;
		return (
			("token" in entry ? entry.token : env[entry.env])?.trim() || undefined
		);
	}

	personalEnvNames(): string[] {
		return Object.values(this.readFile().personalTokens ?? {}).flatMap(
			(entry) => (entry && "env" in entry ? [entry.env] : []),
		);
	}

	/** Strict reads for mutation/personal selection. Never reset a corrupt store. */
	private readFile(): GitHubTokensFile {
		let text: string;
		try {
			text = readFileSync(this.filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return { version: 1, updatedAt: new Date().toISOString(), tokens: [] };
			}
			throw new Error(
				"GitHub token store is unreadable; no credentials were changed",
			);
		}
		try {
			const file = JSON.parse(text);
			if (file?.version !== 1 || !Array.isArray(file.tokens)) throw new Error();
			if (
				file.personalTokens !== undefined &&
				(!file.personalTokens ||
					typeof file.personalTokens !== "object" ||
					Array.isArray(file.personalTokens) ||
					Object.values(file.personalTokens).some(
						(entry) => entry !== null && !isPersonalToken(entry),
					))
			)
				throw new Error();
			return file;
		} catch {
			throw new Error(
				"GitHub token store is invalid; restore it before retrying (no credentials were changed)",
			);
		}
	}

	/** Cross-process exclusive lock + unique, fsynced 0600 temp + atomic rename.
	 * Do not guess that an old lock is stale: a suspended writer may still own it.
	 * On interruption operators must stop writers before removing the .lock file.
	 */
	private update(mutate: (file: GitHubTokensFile) => void): void {
		mkdirSync(dirname(this.filePath), { recursive: true });
		const lockPath = `${this.filePath}.lock`;
		const deadline = Date.now() + 5000;
		let lock: number;
		for (;;) {
			try {
				lock = openSync(lockPath, "wx", 0o600);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
					throw new Error(
						"Cannot lock GitHub token store; no credentials were changed",
					);
				}
				if (Date.now() >= deadline)
					throw new Error(
						"GitHub token store is locked; stop all writers before removing a stale github-tokens.json.lock",
					);
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
			}
		}
		const tmpPath = `${this.filePath}.${randomUUID()}.tmp`;
		try {
			const file = this.readFile();
			mutate(file);
			file.updatedAt = new Date().toISOString();
			const fd = openSync(tmpPath, "wx", 0o600);
			try {
				writeFileSync(fd, JSON.stringify(file, null, 2));
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			chmodSync(tmpPath, 0o600);
			renameSync(tmpPath, this.filePath);
			this.cachedTokens = null;
			this.cachedMtimeMs = null;
			this.cachedSize = null;
		} finally {
			try {
				unlinkSync(tmpPath);
			} catch {
				/* renamed, or not created */
			}
			closeSync(lock);
			unlinkSync(lockPath);
		}
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
