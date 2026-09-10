/**
 * UserCredentialService — provisioning of per-Linear-user execution
 * credentials for multi-user self-hosted Cyrus (CYPACK-1502).
 *
 * Responsibilities:
 *   - store each user's secrets in owner-only files under
 *     `<cyrusHome>/user-credentials/<linearUserId>/` (0700 dir, 0600 files)
 *   - write ONLY references (`{ file: … }` / `{ env: … }`) into config.json
 *   - verify the GitHub token against the GitHub API (actor login/name/email)
 *   - resolve a Linear user by email or ID through the workspace token
 *   - optionally run a real Claude round-trip with the user's credential
 *
 * Secrets are never logged or returned in error messages; only 8-char
 * SHA-256 fingerprints are surfaced so operators can tell credentials apart.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	type CredentialRef,
	credentialFingerprint,
	type EdgeConfig,
	type LinearUserConfig,
	readCredentialRef,
	resolvePath,
} from "cyrus-core";

/** Directory (under cyrusHome) holding one sub-directory per Linear user. */
export const USER_CREDENTIALS_DIR = "user-credentials";
export const CLAUDE_OAUTH_TOKEN_FILE = "claude-oauth-token";
export const CLAUDE_API_KEY_FILE = "claude-api-key";
export const GITHUB_TOKEN_FILE = "github-token";

export type ClaudeCredentialKind = "oauthToken" | "apiKey";

/**
 * Classify a Claude credential by its well-known prefix.
 * - `sk-ant-oat01-…` is a Claude Code OAuth token (`claude setup-token`)
 * - `sk-ant-api03-…` (and other `sk-ant-api…`) is a console API key
 * Anything else is unknown and the caller must ask.
 */
export function detectClaudeCredentialKind(
	secret: string,
): ClaudeCredentialKind | undefined {
	if (/^sk-ant-oat\d*-/i.test(secret)) return "oauthToken";
	if (/^sk-ant-api\d*-/i.test(secret)) return "apiKey";
	return undefined;
}

export interface GitHubActor {
	login: string;
	id: number;
	name: string | null;
	email: string | null;
	/** `<id>+<login>@users.noreply.github.com` — the address GitHub links to the account. */
	noreplyEmail: string;
	/** Token type hint from the response headers (fine-grained tokens have no scopes header). */
	tokenScopes: string | null;
}

export interface LinearUserLookup {
	id: string;
	name: string;
	displayName: string;
	email: string;
	active: boolean;
}

export interface StoredUserCredentialRefs {
	claude: { kind: ClaudeCredentialKind; ref: CredentialRef };
	github: { ref: CredentialRef };
}

export class UserCredentialService {
	constructor(private readonly cyrusHome: string) {}

	// ---------------------------------------------------------------------
	// Storage
	// ---------------------------------------------------------------------

	userDir(linearUserId: string): string {
		return join(this.cyrusHome, USER_CREDENTIALS_DIR, sanitizeId(linearUserId));
	}

	/**
	 * Write a secret to `<userDir>/<fileName>` with owner-only permissions and
	 * return a `{ file }` reference for config.json.
	 */
	storeSecretFile(
		linearUserId: string,
		fileName: string,
		secret: string,
	): CredentialRef {
		const dir = this.userDir(linearUserId);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
		const path = join(dir, fileName);
		writeFileSync(path, `${secret.trim()}\n`, { mode: 0o600 });
		chmodSync(path, 0o600);
		return { file: path };
	}

	/** Remove every stored secret for a user (no-op when nothing is stored). */
	removeStoredSecrets(linearUserId: string): boolean {
		const dir = this.userDir(linearUserId);
		if (!existsSync(dir)) return false;
		rmSync(dir, { recursive: true, force: true });
		return true;
	}

	/**
	 * Merge a user entry into the config's `linearUsers` map. Returns the new
	 * config object (caller persists it).
	 */
	static upsertUser(
		config: EdgeConfig,
		linearUserId: string,
		entry: LinearUserConfig,
	): EdgeConfig {
		return {
			...config,
			linearUsers: { ...(config.linearUsers ?? {}), [linearUserId]: entry },
		};
	}

	static removeUser(
		config: EdgeConfig,
		linearUserId: string,
	): { config: EdgeConfig; removed: boolean } {
		const users = { ...(config.linearUsers ?? {}) };
		const removed = linearUserId in users;
		delete users[linearUserId];
		const next: EdgeConfig = { ...config, linearUsers: users };
		if (Object.keys(users).length === 0) {
			delete next.linearUsers;
		}
		return { config: next, removed };
	}

	// ---------------------------------------------------------------------
	// Verification
	// ---------------------------------------------------------------------

	/**
	 * Verify a GitHub token by asking GitHub who it belongs to. Works for
	 * fine-grained and classic PATs. Throws a secret-free error on failure.
	 */
	static async verifyGitHubToken(
		token: string,
		fetchImpl: typeof fetch = fetch,
	): Promise<GitHubActor> {
		const response = await fetchImpl("https://api.github.com/user", {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "cyrus-cli",
			},
		});
		if (response.status === 401) {
			throw new Error(
				"GitHub rejected the token (401 Unauthorized). Check that it is a valid, unexpired personal access token.",
			);
		}
		if (!response.ok) {
			throw new Error(
				`GitHub token verification failed: HTTP ${response.status}`,
			);
		}
		const body = (await response.json()) as {
			login: string;
			id: number;
			name: string | null;
			email: string | null;
		};
		return {
			login: body.login,
			id: body.id,
			name: body.name ?? null,
			email: body.email ?? null,
			noreplyEmail: `${body.id}+${body.login}@users.noreply.github.com`,
			tokenScopes: response.headers.get("x-oauth-scopes"),
		};
	}

	/**
	 * Resolve a Linear user by ID or email using the workspace's OAuth token.
	 * Throws a secret-free error when no single active match exists.
	 */
	static async lookupLinearUser(
		linearToken: string,
		query: { id?: string; email?: string },
		fetchImpl: typeof fetch = fetch,
	): Promise<LinearUserLookup> {
		const body = query.id
			? {
					query:
						"query($id: String!) { user(id: $id) { id name displayName email active } }",
					variables: { id: query.id },
				}
			: {
					query:
						"query($email: String!) { users(filter: { email: { eq: $email } }) { nodes { id name displayName email active } } }",
					variables: { email: query.email },
				};
		const response = await fetchImpl("https://api.linear.app/graphql", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: linearToken,
			},
			body: JSON.stringify(body),
		});
		const json = (await response.json()) as {
			data?: {
				user?: LinearUserLookup | null;
				users?: { nodes: LinearUserLookup[] };
			};
			errors?: Array<{ message: string }>;
		};
		if (json.errors?.length) {
			throw new Error(
				`Linear lookup failed: ${json.errors[0]?.message ?? "unknown error"}`,
			);
		}
		const candidates = query.id
			? json.data?.user
				? [json.data.user]
				: []
			: (json.data?.users?.nodes ?? []);
		if (candidates.length === 0) {
			throw new Error(
				`No Linear user found for ${query.id ? `id ${query.id}` : `email ${query.email}`}`,
			);
		}
		if (candidates.length > 1) {
			throw new Error(
				`Linear returned ${candidates.length} users for ${query.email}; pass --linear-user-id instead`,
			);
		}
		return candidates[0]!;
	}

	// ---------------------------------------------------------------------
	// Inspection (list / check)
	// ---------------------------------------------------------------------

	/**
	 * Secret-free status of one mapped user: whether each reference resolves
	 * and a fingerprint of the resolved value (for telling users apart).
	 */
	static inspectUser(
		linearUserId: string,
		entry: LinearUserConfig,
	): {
		linearUserId: string;
		displayName: string;
		claude:
			| {
					kind: ClaudeCredentialKind;
					ref: string;
					ok: true;
					fingerprint: string;
			  }
			| {
					kind: ClaudeCredentialKind | "missing";
					ref: string;
					ok: false;
					error: string;
			  };
		github:
			| { ref: string; ok: true; fingerprint: string; login?: string }
			| { ref: string; ok: false; error: string; login?: string };
	} {
		const claudeRef = entry.claude?.oauthToken ?? entry.claude?.apiKey;
		const claudeKind: ClaudeCredentialKind | "missing" = entry.claude
			?.oauthToken
			? "oauthToken"
			: entry.claude?.apiKey
				? "apiKey"
				: "missing";
		let claude: ReturnType<typeof UserCredentialService.inspectUser>["claude"];
		if (!claudeRef || claudeKind === "missing") {
			claude = {
				kind: "missing",
				ref: "—",
				ok: false,
				error: "no Claude credential reference",
			};
		} else {
			const read = readCredentialRef(claudeRef);
			claude =
				"value" in read
					? {
							kind: claudeKind,
							ref: describeRef(claudeRef),
							ok: true,
							fingerprint: credentialFingerprint(read.value),
						}
					: {
							kind: claudeKind,
							ref: describeRef(claudeRef),
							ok: false,
							error: read.error,
						};
		}

		let github: ReturnType<typeof UserCredentialService.inspectUser>["github"];
		if (!entry.github?.token) {
			github = { ref: "—", ok: false, error: "no GitHub token reference" };
		} else {
			const read = readCredentialRef(entry.github.token);
			github =
				"value" in read
					? {
							ref: describeRef(entry.github.token),
							ok: true,
							fingerprint: credentialFingerprint(read.value),
							login: entry.github.login,
						}
					: {
							ref: describeRef(entry.github.token),
							ok: false,
							error: read.error,
							login: entry.github.login,
						};
		}

		return {
			linearUserId,
			displayName: entry.displayName || linearUserId,
			claude,
			github,
		};
	}

	/** Read a stored secret back (for `check-users --live`). */
	static readSecret(ref: CredentialRef): string | undefined {
		const read = readCredentialRef(ref);
		return "value" in read ? read.value : undefined;
	}

	/** Is a file ref inside this service's managed directory? */
	isManagedFile(ref: CredentialRef): boolean {
		if (!("file" in ref)) return false;
		return resolvePath(ref.file).startsWith(
			join(this.cyrusHome, USER_CREDENTIALS_DIR),
		);
	}

	/** Read a secret from a file path (used for --*-token-file inputs). */
	static readSecretFromFile(path: string): string {
		const value = readFileSync(resolvePath(path), "utf-8").trim();
		if (!value) throw new Error(`${path} is empty`);
		return value;
	}
}

function sanitizeId(id: string): string {
	return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

function describeRef(ref: CredentialRef): string {
	return "env" in ref ? `env:${ref.env}` : `file:${ref.file}`;
}
