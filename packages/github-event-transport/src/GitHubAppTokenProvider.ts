import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { GitHubInstallationToken } from "miko-core";

export interface GitHubAppTokenProviderConfig {
	appId: string;
	/**
	 * Optional default installation id used when getToken() is called without
	 * an override (e.g. from GITHUB_APP_INSTALLATION_ID). Prefer passing the
	 * webhook payload's installation.id for multi-org self-hosting.
	 */
	installationId?: string;
	privateKeyPath: string;
	/** GitHub API base URL (default: https://api.github.com) */
	apiBaseUrl?: string;
}

interface CachedInstallationToken {
	token: string;
	expiresAt: number;
}

/** A GitHub App installation as returned by GET /app/installations */
export interface GitHubAppInstallationSummary {
	id: string;
	accountLogin: string | null;
	accountType: "Organization" | "User" | null;
}

export interface MintedInstallationToken {
	token: string;
	/** ISO timestamp when the token expires */
	expiresAt: string;
}

/**
 * Mints and caches GitHub App installation tokens for self-hosted users.
 *
 * Uses the App's private key to sign a JWT, then exchanges it for a
 * short-lived installation access token via the GitHub API.
 * Tokens are cached per installation id and refreshed 5 minutes before expiry.
 */
export class GitHubAppTokenProvider {
	private config: GitHubAppTokenProviderConfig;
	private cache = new Map<string, CachedInstallationToken>();
	private privateKeyPromise: Promise<string> | null = null;

	constructor(config: GitHubAppTokenProviderConfig) {
		this.config = config;
	}

	/** Numeric App id from config (operator-defined). */
	get appId(): string {
		return this.config.appId;
	}

	/**
	 * Get a valid installation access token.
	 *
	 * @param installationId - Installation to mint for. Falls back to the
	 *   config default when omitted. Throws if neither is available.
	 */
	async getToken(installationId?: string): Promise<string> {
		const minted = await this.getTokenDetails(installationId);
		return minted.token;
	}

	/**
	 * Mint (or return cached) installation token with its expiry, for
	 * persisting into GitHubTokenStore.
	 */
	async getTokenDetails(
		installationId?: string,
	): Promise<MintedInstallationToken> {
		const resolvedId = installationId ?? this.config.installationId;
		if (!resolvedId) {
			throw new Error(
				"[GitHubAppTokenProvider] No installation id: pass getToken(installationId) or set a default in config",
			);
		}

		const cached = this.cache.get(resolvedId);
		// Refresh 5 minutes before expiry
		if (cached && Date.now() < cached.expiresAt - 5 * 60 * 1000) {
			return {
				token: cached.token,
				expiresAt: new Date(cached.expiresAt).toISOString(),
			};
		}

		const pem = await this.loadPrivateKey();
		const jwt = createAppJwt(this.config.appId, pem);
		const apiBase = this.config.apiBaseUrl ?? "https://api.github.com";

		const response = await fetch(
			`${apiBase}/app/installations/${resolvedId}/access_tokens`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${jwt}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
				},
			},
		);

		if (!response.ok) {
			const body = await response.text();
			throw new Error(
				`[GitHubAppTokenProvider] Failed to create installation token: ${response.status} ${response.statusText} - ${body}`,
			);
		}

		const data = (await response.json()) as {
			token: string;
			expires_at: string;
		};

		this.cache.set(resolvedId, {
			token: data.token,
			expiresAt: new Date(data.expires_at).getTime(),
		});

		return { token: data.token, expiresAt: data.expires_at };
	}

	/**
	 * List all installations of this App (paginated). Used by self-hosted
	 * startup to populate GitHubTokenStore for credential helper / gh.
	 */
	async listInstallations(): Promise<GitHubAppInstallationSummary[]> {
		const apiBase = this.config.apiBaseUrl ?? "https://api.github.com";
		const pem = await this.loadPrivateKey();
		const jwt = createAppJwt(this.config.appId, pem);
		const results: GitHubAppInstallationSummary[] = [];
		let url: string | null = `${apiBase}/app/installations?per_page=100`;

		while (url) {
			const response = await fetch(url, {
				headers: {
					Authorization: `Bearer ${jwt}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
				},
			});
			if (!response.ok) {
				const body = await response.text();
				throw new Error(
					`[GitHubAppTokenProvider] Failed to list installations: ${response.status} ${response.statusText} - ${body}`,
				);
			}
			const page = (await response.json()) as Array<{
				id: number;
				account?: { login?: string; type?: string } | null;
			}>;
			for (const item of page) {
				results.push(summarizeInstallation(item));
			}
			url = nextLink(response.headers.get("link"));
		}

		return results;
	}

	/**
	 * Fetch a single installation by id (account login + type). Useful when
	 * only GITHUB_APP_INSTALLATION_ID is configured.
	 */
	async getInstallation(
		installationId: string,
	): Promise<GitHubAppInstallationSummary> {
		const apiBase = this.config.apiBaseUrl ?? "https://api.github.com";
		const pem = await this.loadPrivateKey();
		const jwt = createAppJwt(this.config.appId, pem);
		const response = await fetch(
			`${apiBase}/app/installations/${installationId}`,
			{
				headers: {
					Authorization: `Bearer ${jwt}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
				},
			},
		);
		if (!response.ok) {
			const body = await response.text();
			throw new Error(
				`[GitHubAppTokenProvider] Failed to get installation ${installationId}: ${response.status} ${response.statusText} - ${body}`,
			);
		}
		const data = (await response.json()) as {
			id: number;
			account?: { login?: string; type?: string } | null;
		};
		return summarizeInstallation(data);
	}

	/**
	 * Mint tokens for every installation of this App and return them in the
	 * GitHubTokenStore shape. When `installationIds` is provided, only those
	 * are minted (still resolving account metadata via the API).
	 */
	async mintInstallationTokens(options?: {
		installationIds?: string[];
	}): Promise<GitHubInstallationToken[]> {
		let installations: GitHubAppInstallationSummary[];
		if (options?.installationIds && options.installationIds.length > 0) {
			installations = [];
			for (const id of options.installationIds) {
				installations.push(await this.getInstallation(id));
			}
		} else {
			installations = await this.listInstallations();
			// If listing returned nothing but a default id is configured, try it.
			if (installations.length === 0 && this.config.installationId) {
				installations = [
					await this.getInstallation(this.config.installationId),
				];
			}
		}

		const tokens: GitHubInstallationToken[] = [];
		for (const installation of installations) {
			const minted = await this.getTokenDetails(installation.id);
			tokens.push({
				installationId: installation.id,
				organization: installation.accountLogin,
				accountType: installation.accountType,
				token: minted.token,
				expiresAt: minted.expiresAt,
			});
		}
		return tokens;
	}

	private loadPrivateKey(): Promise<string> {
		if (!this.privateKeyPromise) {
			this.privateKeyPromise = readFile(this.config.privateKeyPath, "utf-8");
		}
		return this.privateKeyPromise;
	}
}

function summarizeInstallation(item: {
	id: number;
	account?: { login?: string; type?: string } | null;
}): GitHubAppInstallationSummary {
	const accountType =
		item.account?.type === "Organization" || item.account?.type === "User"
			? item.account.type
			: null;
	return {
		id: String(item.id),
		accountLogin: item.account?.login ?? null,
		accountType,
	};
}

/** Parse GitHub's Link header for rel="next". */
function nextLink(header: string | null): string | null {
	if (!header) return null;
	for (const part of header.split(",")) {
		const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
		if (match?.[1]) return match[1];
	}
	return null;
}

/**
 * Create a JWT for GitHub App authentication.
 * Uses Node's native crypto — no external JWT library needed.
 *
 * @see https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
 */
export function createAppJwt(appId: string, privateKey: string): string {
	const now = Math.floor(Date.now() / 1000);
	const header = Buffer.from(
		JSON.stringify({ alg: "RS256", typ: "JWT" }),
	).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({
			iat: now - 60,
			exp: now + 10 * 60,
			iss: appId,
		}),
	).toString("base64url");

	const sign = createSign("RSA-SHA256");
	sign.update(`${header}.${payload}`);
	const signature = sign.sign(privateKey, "base64url");

	return `${header}.${payload}.${signature}`;
}
